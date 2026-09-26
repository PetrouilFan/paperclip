import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Signoff execution policy flow.
 *
 * Validates the full signoff lifecycle through the API and UI:
 *   1. Create a company with executor + reviewer + approver agents
 *   2. Create an issue with a two-stage execution policy (review → approval)
 *   3. Executor marks done → issue routes to reviewer (in_review)
 *   4. Reviewer approves → issue routes to approver
 *   5. Approver approves → execution completes, issue marked done
 *   6. Verify "changes requested" flow returns to executor
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts webServer env).
 *
 * Agent auth flow:
 *   - Board request (local_trusted auto-auth) handles setup/teardown.
 *   - Agent-specific actions use API keys + heartbeat run IDs.
 *   - Reviewers/approvers invoke heartbeat runs (gets run IDs) then PATCH
 *     directly without checkout (checkout would force in_progress, breaking
 *     the in_review state the signoff policy requires).
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-Signoff-${Date.now()}`;

/**
 * How long `invokeHeartbeat` waits for the invoked run to become issue-bound.
 *
 * The run has to be admitted, take the legacy controller lease, and snapshot its
 * context before the harness can find it. A window that expires first reports a
 * harness failure for a server-side cause, so the default is sized for a loaded
 * CI runner rather than a developer's laptop. Override with
 * `PAPERCLIP_E2E_RUN_BOUND_TIMEOUT_MS` when a run is known to need longer.
 */
const RUN_BOUND_TIMEOUT_MS = Number(process.env.PAPERCLIP_E2E_RUN_BOUND_TIMEOUT_MS ?? 15_000);

/**
 * Terminal states a run can be in without ever becoming issue-bound. These are
 * server-side outcomes the harness cannot fix by waiting, so they are recorded
 * for the failure report instead of silently consuming the whole window.
 */
const TERMINAL_RUN_STATUSES = new Set(["failed", "cancelled", "abandoned", "expired"]);

interface AgentAuth {
  agentId: string;
  token: string;
  keyId: string;
  request: APIRequestContext;
}

interface TestContext {
  companyId: string;
  companyPrefix: string;
  executor: AgentAuth;
  reviewer: AgentAuth;
  approver: AgentAuth;
  boardRequest: APIRequestContext;
  issueIds: string[];
}

interface IssueRunLockState {
  companyId: string;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
}

/** Create an authenticated APIRequestContext for an agent (token set, no run ID yet). */
async function createAgentRequest(token: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/**
 * What the harness saw while it waited. Carried into the thrown message so a
 * failure names the run that actually died and why, rather than only the
 * harness that could not find a run.
 */
interface RunBoundObservations {
  /** Terminal, non-issue-bound runs keyed by run id, most recent last. */
  terminalRuns: Map<string, string>;
  /** Whether the issue lock ever pointed at a run for this agent. */
  sawIssueLock: boolean;
  /** Whether the agent's recent-runs listing ever returned anything. */
  sawRecentRuns: boolean;
}

function describeObservations(
  agentId: string,
  issueId: string,
  attempts: RunBoundObservations[],
): string {
  const lines = [
    `No issue-bound heartbeat run became available for agent ${agentId} on issue ${issueId} within ${RUN_BOUND_TIMEOUT_MS}ms per attempt across ${attempts.length} invoke attempt(s).`,
  ];
  const anyTerminalRun = attempts.some((attempt) => attempt.terminalRuns.size > 0);
  if (anyTerminalRun) {
    lines.push(
      "Candidate runs that reached a terminal state without binding to this issue. These are server-side outcomes, not a harness defect:",
    );
    // The agent's recent-runs listing spans the whole window, so the same dead
    // run is re-observed on every attempt. Report each run once and name the
    // attempts that saw it, or a two-attempt failure lists every run twice.
    const merged = new Map<string, { description: string; attempts: number[] }>();
    attempts.forEach((attempt, index) => {
      for (const [runId, description] of attempt.terminalRuns) {
        const existing = merged.get(runId);
        if (existing) {
          existing.attempts.push(index + 1);
          // The latest observation wins: a run can gain an error code between polls.
          if (description !== existing.description) existing.description = description;
        } else {
          merged.set(runId, { description, attempts: [index + 1] });
        }
      }
    });
    for (const [runId, { description, attempts: seenIn }] of merged) {
      lines.push(`  - run ${runId}: ${description} (seen on attempt ${seenIn.join(", ")})`);
    }
    lines.push(
      "Grep the same run id in the WebServer log for the underlying error. A lost legacy controller lease surfaces here as status=cancelled with no error code.",
    );
  } else {
    lines.push(
      "No candidate run reached a terminal state, so the run never became visible to the harness at all. That points at the invoke path, not at run setup.",
    );
  }
  const sawIssueLock = attempts.some((attempt) => attempt.sawIssueLock);
  const sawRecentRuns = attempts.some((attempt) => attempt.sawRecentRuns);
  lines.push(`Issue lock observed for this agent: ${sawIssueLock ? "yes" : "no"}.`);
  lines.push(`Agent recent-runs listing returned rows: ${sawRecentRuns ? "yes" : "no"}.`);
  return lines.join("\n");
}

/**
 * Invoke a heartbeat run for an agent, returning the run ID.
 *
 * The invoke answers `202` and hands the run off to a background worker, so
 * there are two ways to end without a run id in hand:
 *
 *   1. The run was created but never became issue-bound. That is a server-side
 *      outcome (a lost legacy controller lease, for example), not a harness
 *      defect, and it must not read as one. We re-invoke once and, if that also
 *      fails, report every terminal run we saw with its status and error code.
 *   2. The invoke was skipped because a stage transition already replaced the
 *      previous executor's run with the participant's queued run. That run may
 *      already have released the issue lock, so we recover it by id.
 */
async function invokeHeartbeat(
  board: APIRequestContext,
  agentId: string,
  issueId: string,
): Promise<string> {
  const attempts: RunBoundObservations[] = [];
  const MAX_INVOKE_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_INVOKE_ATTEMPTS; attempt++) {
    const res = await board.post(`${BASE_URL}/api/agents/${agentId}/heartbeat/invoke`, {
      data: {
        reason: "issue_assigned",
        payload: { issueId, taskId: issueId, taskKey: issueId },
      },
    });
    expect(res.ok()).toBe(true);
    const run = await res.json();
    if (typeof run.id === "string" && run.id.length > 0) return run.id;

    const seen = await awaitIssueBoundRun(board, agentId, issueId, run);
    if (typeof seen === "string") return seen;
    attempts.push(seen);

    // Only re-invoke when we positively observed a run that died before
    // binding. Without that evidence the run may still be in flight, and a
    // second invoke would race it for the issue lock rather than fix anything.
    if (seen.terminalRuns.size === 0) break;
  }

  throw new Error(describeObservations(agentId, issueId, attempts));
}

/**
 * Poll until a run bound to `issueId` for `agentId` is visible, or the window
 * expires. Returns the run id, an empty string when the issue is no longer
 * assigned to this agent (the negative-authorization cases), or the
 * observations gathered on expiry.
 */
async function awaitIssueBoundRun(
  board: APIRequestContext,
  agentId: string,
  issueId: string,
  invokeResponse: Record<string, unknown>,
): Promise<string | RunBoundObservations> {
  // A stage transition can already be replacing the previous executor's run
  // with the participant's queued run. If the legacy invoke is skipped and
  // that run has already released the issue lock, recover it from the agent's
  // recent run receipts.
  const seen: RunBoundObservations = {
    terminalRuns: new Map(),
    sawIssueLock: false,
    sawRecentRuns: false,
  };
  const deadline = Date.now() + RUN_BOUND_TIMEOUT_MS;
  do {
    const issueRunLock = await getIssueRunLockState(board, issueId);
    if (issueRunLock.assigneeAgentId !== agentId) {
      // Negative authorization cases intentionally invoke a non-participant.
      // Preserve the server rejection instead of waiting for a run that must
      // never be assigned to that agent.
      return issueRunLock.executionRunId ?? issueRunLock.checkoutRunId ?? "";
    }
    const candidates = new Set<string>([
      typeof invokeResponse.executionRunId === "string" ? invokeResponse.executionRunId : null,
      issueRunLock.executionRunId,
      issueRunLock.checkoutRunId,
    ].filter((candidate): candidate is string => Boolean(candidate)));
    if (issueRunLock.executionRunId || issueRunLock.checkoutRunId) seen.sawIssueLock = true;
    const recentRunsRes = await board.get(
      `${BASE_URL}/api/companies/${issueRunLock.companyId}/heartbeat-runs?agentId=${agentId}&limit=20`,
    );
    if (recentRunsRes.ok()) {
      const recentRuns = await recentRunsRes.json();
      if (Array.isArray(recentRuns) && recentRuns.length > 0) seen.sawRecentRuns = true;
      for (const recentRun of Array.isArray(recentRuns) ? recentRuns : []) {
        if (typeof recentRun.id === "string") candidates.add(recentRun.id);
      }
    }
    for (const candidate of candidates) {
      const runRes = await board.get(`${BASE_URL}/api/heartbeat-runs/${candidate}`);
      if (!runRes.ok()) continue;
      const candidateRun = await runRes.json();
      const context = candidateRun.contextSnapshot ?? {};
      if (
        candidateRun.agentId === agentId &&
        (context.issueId === issueId || context.taskId === issueId)
      ) {
        return candidate;
      }
      // Record why this run is not usable so an expiry reports the server-side
      // cause instead of a bare "not available". Only terminal runs are kept:
      // a run still in flight is the normal case, not a finding.
      const status = typeof candidateRun.status === "string" ? candidateRun.status : "unknown";
      if (TERMINAL_RUN_STATUSES.has(status)) {
        const errorCode =
          typeof candidateRun.errorCode === "string" && candidateRun.errorCode.length > 0
            ? candidateRun.errorCode
            : "no error code recorded";
        const boundIssue = context.issueId ?? context.taskId ?? null;
        const agentMatches = candidateRun.agentId === agentId ? "agent matches" : "DIFFERENT AGENT";
        seen.terminalRuns.set(
          candidate,
          `status=${status} errorCode=${errorCode} issueId=${boundIssue ?? "none"} (${agentMatches})`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  return seen;
}

async function getIssueRunLockState(board: APIRequestContext, issueId: string): Promise<IssueRunLockState> {
  const res = await board.get(`${BASE_URL}/api/issues/${issueId}`);
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  return {
    companyId: issue.companyId,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    checkoutRunId: issue.checkoutRunId ?? null,
    executionRunId: issue.executionRunId ?? null,
  };
}

async function retryAgentPatchWithCurrentLockOnConflict(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  failedRes: Awaited<ReturnType<APIRequestContext["patch"]>>,
  patchData: Record<string, unknown>,
  fallbackRunId: string,
) {
  if (failedRes.status() !== 409) return failedRes;
  let res = failedRes;
  for (let attempt = 0; attempt < 8 && res.status() === 409; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, 50 * 2 ** attempt)));
    const issueRunLock = await getIssueRunLockState(board, issueId);
    if (issueRunLock.assigneeAgentId !== agent.agentId) return res;

    const lockedRunId = issueRunLock.checkoutRunId ?? issueRunLock.executionRunId ?? fallbackRunId;
    res = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
      headers: { "X-Paperclip-Run-Id": lockedRunId },
      data: patchData,
    });
  }
  return res;
}

/**
 * PATCH an issue as an agent, using a freshly invoked heartbeat run.
 *
 * Invoking a heartbeat starts a background run that races this PATCH for the
 * issue's run-lock: the background run may check the issue out (flipping it to
 * `in_progress` under its own run id) a moment before — or after — this PATCH
 * lands, and the server answers the loser with a 409 ("Issue is checked out by
 * another agent"). With `retries: 0` / `workers: 1` a single transient 409
 * fails the whole shard, so we retry a run-lock 409 under the issue's *current*
 * lock, bounded by escalating backoff to cover the race window.
 *
 * The retry is intentionally narrow so the suite's negative paths keep failing
 * for the right reason:
 *   - It only re-PATCHes while the issue is still assigned to the acting agent,
 *     so a non-participant's genuine 409/403 rejection is returned untouched.
 *   - It re-PATCHes under the winning run id (or the invoked run id once the
 *     background run has released its lock), so a real validation error such as
 *     the missing-comment 400 surfaces instead of a masking transient 409.
 */
async function agentPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  data: Record<string, unknown>,
  {
    maxAttempts = 8,
    backoffMs = 50,
    maxBackoffMs = 500,
  }: { maxAttempts?: number; backoffMs?: number; maxBackoffMs?: number } = {},
) {
  const runId = await invokeHeartbeat(board, agent.agentId, issueId);
  const patchWith = (patchRunId: string) =>
    agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
      headers: { "X-Paperclip-Run-Id": patchRunId },
      data,
    });

  let res = await patchWith(runId);
  for (let attempt = 1; attempt < maxAttempts && res.status() === 409; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 1))));
    const issueRunLock = await getIssueRunLockState(board, issueId);
    // A 409 on an issue no longer assigned to us is a genuine rejection, not a
    // run-lock race — leave it for the caller to assert on.
    if (issueRunLock.assigneeAgentId !== agent.agentId) break;
    const retryRunId = issueRunLock.checkoutRunId ?? issueRunLock.executionRunId ?? runId;
    res = await patchWith(retryRunId);
  }
  return res;
}

/** Checkout an issue as an agent, then PATCH it. Used for executor mark-done. */
async function agentCheckoutAndPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  expectedStatuses: string[],
  patchData: Record<string, unknown>,
) {
  const runId = await invokeHeartbeat(board, agent.agentId, issueId);
  const directPatchRes = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: patchData,
  });
  if (directPatchRes.ok()) return directPatchRes;

  // Checkout (sets executionRunId so PATCH is allowed)
  const checkoutRes = await agent.request.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: { agentId: agent.agentId, expectedStatuses },
  });
  if (!checkoutRes.ok()) {
    if (checkoutRes.status() === 409) {
      const res = await retryAgentPatchWithCurrentLockOnConflict(
        board,
        agent,
        issueId,
        checkoutRes,
        patchData,
        runId,
      );
      if (res.ok()) {
        return res;
      }
    }
    // If agent checkout fails (e.g. run expired), fall back to board checkout
    // then PATCH with the agent's identity
    const boardCheckout = await board.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
      data: { agentId: agent.agentId, expectedStatuses },
    });
    if (!boardCheckout.ok()) {
      throw new Error(`Board checkout failed: ${await boardCheckout.text()}`);
    }
    // Board PATCH (executor mark-done triggers signoff regardless of actor)
    const res = await board.patch(`${BASE_URL}/api/issues/${issueId}`, {
      data: patchData,
    });
    return res;
  }
  // PATCH with agent identity
  const res = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: patchData,
  });
  const retried = await retryAgentPatchWithCurrentLockOnConflict(
    board,
    agent,
    issueId,
    res,
    patchData,
    runId,
  );
  if (retried.status() !== 409) return retried;

  // A no-op process adapter can replace and release the executor's lock faster
  // than an agent-authored retry can adopt it. This flow already permits a
  // board fallback when checkout loses that race; apply the same fallback when
  // the post-checkout PATCH exhausts its bounded lock retries.
  const issueRunLock = await getIssueRunLockState(board, issueId);
  if (issueRunLock.assigneeAgentId !== agent.agentId) return retried;
  return board.patch(`${BASE_URL}/api/issues/${issueId}`, { data: patchData });
}

async function setupCompany(boardRequest: APIRequestContext): Promise<TestContext> {
  // Verify server is in local_trusted mode
  const healthRes = await boardRequest.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(
      `Signoff e2e tests require local_trusted deployment mode, ` +
        `but server is in "${health.deploymentMode}" mode. ` +
        `Set PAPERCLIP_DEPLOYMENT_MODE=local_trusted or use the webServer config.`,
    );
  }

  // Create company
  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, {
    data: { name: COMPANY_NAME },
  });
  if (!companyRes.ok()) {
    const errBody = await companyRes.text();
    throw new Error(`POST /api/companies → ${companyRes.status()}: ${errBody}`);
  }
  const company = await companyRes.json();
  const companyId = company.id;
  const companyPrefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";

  // Helper: hire/approve agent + API key + request context
  async function createAgent(name: string, role: string, title: string): Promise<AgentAuth> {
    const agentRes = await boardRequest.post(`${BASE_URL}/api/companies/${companyId}/agent-hires`, {
      data: {
        name,
        role,
        title,
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('done\\n')"],
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const hire = await agentRes.json();
    const agent = hire.agent;
    if (hire.approval) {
      const approvalRes = await boardRequest.post(`${BASE_URL}/api/approvals/${hire.approval.id}/approve`, {
        data: { decisionNote: "Approved for signoff e2e setup." },
      });
      expect(approvalRes.ok()).toBe(true);
    }

    const keyRes = await boardRequest.post(`${BASE_URL}/api/agents/${agent.id}/keys`, {
      data: { name: `e2e-${name.toLowerCase()}` },
    });
    expect(keyRes.ok()).toBe(true);
    const keyData = await keyRes.json();

    return {
      agentId: agent.id,
      token: keyData.token,
      keyId: keyData.id,
      request: await createAgentRequest(keyData.token),
    };
  }

  const executor = await createAgent("Executor", "engineer", "Software Engineer");
  const reviewer = await createAgent("Reviewer", "qa", "QA Engineer");
  const approver = await createAgent("Approver", "cto", "CTO");

  return {
    companyId,
    companyPrefix,
    executor,
    reviewer,
    approver,
    boardRequest,
    issueIds: [],
  };
}

async function createIssueWithPolicy(ctx: TestContext, title: string, stages?: unknown[]) {
  const defaultStages = [
    { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    { type: "approval", participants: [{ type: "agent", agentId: ctx.approver.agentId }] },
  ];
  const res = await ctx.boardRequest.post(`${BASE_URL}/api/companies/${ctx.companyId}/issues`, {
    data: {
      title,
      status: "in_progress",
      assigneeAgentId: ctx.executor.agentId,
      executionPolicy: { stages: stages ?? defaultStages },
    },
  });
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  ctx.issueIds.push(issue.id);
  return issue;
}

test.describe("Signoff execution policy", () => {
  let ctx: TestContext;

  test.beforeAll(async () => {
    const boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });
    ctx = await setupCompany(boardRequest);
  });

  test.afterAll(async () => {
    if (!ctx) return;
    const board = ctx.boardRequest;

    // Dispose agent request contexts
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await agent.request.dispose();
    }

    // Clean up issues, keys, agents, company (best-effort)
    for (const issueId of ctx.issueIds) {
      await board.patch(`${BASE_URL}/api/issues/${issueId}`, {
        data: { status: "cancelled", comment: "E2E test cleanup." },
      }).catch(() => {});
    }
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}/keys/${agent.keyId}`).catch(() => {});
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}`).catch(() => {});
    }
    await board.delete(`${BASE_URL}/api/companies/${ctx.companyId}`).catch(() => {});
    await board.dispose();
  });

  test("happy path: executor → review → approval → done", async ({ page }) => {
    const issue = await createIssueWithPolicy(ctx, "Signoff happy path");
    const issueId = issue.id;

    // Verify policy was saved
    expect(issue.executionPolicy).toBeTruthy();
    expect(issue.executionPolicy.stages).toHaveLength(2);
    expect(issue.executionPolicy.stages[0].type).toBe("review");
    expect(issue.executionPolicy.stages[1].type).toBe("approval");

    // Step 1: Executor marks done → should route to reviewer
    const step1Res = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Implemented the feature, ready for review." },
    );
    expect(step1Res.ok()).toBe(true);
    const step1Issue = await step1Res.json();

    expect(step1Issue.status).toBe("in_review");
    expect(step1Issue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(step1Issue.executionState).toBeTruthy();
    expect(step1Issue.executionState.status).toBe("pending");
    expect(step1Issue.executionState.currentStageType).toBe("review");
    expect(step1Issue.executionState.returnAssignee).toMatchObject({
      type: "agent",
      agentId: ctx.executor.agentId,
    });

    // Step 2: Navigate to issue in UI and verify execution label
    await page.goto(`/${ctx.companyPrefix}/issues/${issue.identifier}`);
    await expect(page.locator("text=Review pending")).toBeVisible({ timeout: 10_000 });

    // Step 3: Reviewer approves → should route to approver
    const step3Res = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "done", comment: "QA signoff complete. Looks good." },
    );
    expect(step3Res.ok()).toBe(true);
    const step3Issue = await step3Res.json();

    expect(step3Issue.status).toBe("in_review");
    expect(step3Issue.assigneeAgentId).toBe(ctx.approver.agentId);
    expect(step3Issue.executionState.status).toBe("pending");
    expect(step3Issue.executionState.currentStageType).toBe("approval");
    expect(step3Issue.executionState.completedStageIds).toHaveLength(1);

    // Step 4: Verify UI shows approval pending
    await page.reload();
    await expect(page.locator("text=Approval pending")).toBeVisible({ timeout: 10_000 });

    // Step 5: Approver approves → should complete
    const step5Res = await agentPatch(
      ctx.boardRequest, ctx.approver, issueId,
      { status: "done", comment: "Approved. Ship it." },
    );
    expect(step5Res.ok()).toBe(true);
    const step5Issue = await step5Res.json();

    expect(step5Issue.status).toBe("done");
    expect(step5Issue.executionState.status).toBe("completed");
    expect(step5Issue.executionState.completedStageIds).toHaveLength(2);
    expect(step5Issue.executionState.lastDecisionOutcome).toBe("approved");
  });

  test("changes requested: reviewer bounces back to executor", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff changes requested");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer requests changes → returns to executor
    const changesRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "in_progress", comment: "Needs another pass on edge cases." },
    );
    expect(changesRes.ok()).toBe(true);
    const changesIssue = await changesRes.json();

    expect(changesIssue.status).toBe("in_progress");
    expect(changesIssue.assigneeAgentId).toBe(ctx.executor.agentId);
    expect(changesIssue.executionState.status).toBe("changes_requested");
    expect(changesIssue.executionState.lastDecisionOutcome).toBe("changes_requested");

    // Executor re-submits → goes back to reviewer (same stage)
    const resubmitRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Fixed the edge cases." },
    );
    expect(resubmitRes.ok()).toBe(true);
    const resubmitIssue = await resubmitRes.json();

    expect(resubmitIssue.status).toBe("in_review");
    expect(resubmitIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(resubmitIssue.executionState.status).toBe("pending");
    expect(resubmitIssue.executionState.currentStageType).toBe("review");
  });

  test("comment required: approval without comment fails", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff comment required");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Done." },
    );
    expect(doneRes.ok()).toBe(true);
    const doneIssue = await doneRes.json();
    expect(doneIssue.status).toBe("in_review");
    expect(doneIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);

    // Reviewer tries to approve without comment → should fail
    const noCommentRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "done" },
    );
    expect(noCommentRes.ok()).toBe(false);
    const errorBody = await noCommentRes.json();
    expect(JSON.stringify(errorBody)).toContain("comment");
  });

  test("non-participant cannot advance stage", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff access control");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Done." },
    );
    expect(doneRes.ok()).toBe(true);

    // Verify issue is in_review with reviewer
    const issueRes = await ctx.boardRequest.get(`${BASE_URL}/api/issues/${issueId}`);
    const inReviewIssue = await issueRes.json();
    expect(inReviewIssue.status).toBe("in_review");
    expect(inReviewIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(inReviewIssue.executionState.currentStageType).toBe("review");

    // Non-participant (approver at this stage) tries to advance → should be rejected
    const advanceRes = await agentPatch(
      ctx.boardRequest, ctx.approver, issueId,
      { status: "done", comment: "I'm the approver, not the reviewer." },
    );
    expect(advanceRes.ok()).toBe(false);
    expect(advanceRes.status()).toBeGreaterThanOrEqual(400);
  });

  test("review-only policy: reviewer approval completes execution", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff review-only", [
      { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    ]);

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issue.id, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer approves → should complete immediately (no approval stage)
    const approveRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issue.id,
      { status: "done", comment: "LGTM." },
    );
    expect(approveRes.ok()).toBe(true);
    const doneIssue = await approveRes.json();
    expect(doneIssue.status).toBe("done");
    expect(doneIssue.executionState.status).toBe("completed");
    expect(doneIssue.executionState.completedStageIds).toHaveLength(1);
  });
});
