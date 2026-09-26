import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, environmentLeases, heartbeatRuns, issues, issueRecoveryActions, issueThreadInteractions, nativeRunResults, statusDecisions, workAssessments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", async () => {
  const actual = await vi.importActual<typeof import("../sentry.js")>("../sentry.js");
  return {
    ...actual,
    captureRunFailure: mockCaptureRunFailure,
  };
});

import { reconcileAbandonedExecutionControl, resolveProviderOwnership } from "./execution-control-reconciliation.js";
import {
  beginFinalizationStep,
  beginRunFinalization,
  clearRunFinalizationTimeline,
  readRunFinalizationTimeline,
  renewExecutionControlDeadline,
  resetRunFinalizationTimelines,
} from "./execution-finalization-timeline.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("reconcileAbandonedExecutionControl reports a genuine failed transition", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("execution-control-reconciliation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAbandonedRunFixture(
    overrides: Partial<typeof heartbeatRuns.$inferInsert> = {},
  ) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const pastDeadline = new Date(Date.now() - 60_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Execution Control Reconciliation",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Stuck worker",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      executionControlDeadlineAt: pastDeadline,
      contextSnapshot: { issueId },
      ...overrides,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Abandoned execution control fixture",
      status: "in_progress",
      assigneeAgentId: agentId,
      executionRunId: runId,
      checkoutRunId: runId,
    });

    return { companyId, agentId, issueId, runId };
  }

  it("reports exactly one Sentry event for a genuine finalization-deadline failure", async () => {
    const { runId } = await seedAbandonedRunFixture();
    const captureCallsBefore = mockCaptureRunFailure.mock.calls.length;

    const result = await reconcileAbandonedExecutionControl(db);

    expect(result.surfaced).toBe(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("execution_finalization_deadline_exceeded");

    await vi.waitFor(() => {
      expect(mockCaptureRunFailure.mock.calls.slice(captureCallsBefore)).toHaveLength(1);
    }, { timeout: 5_000 });
    const newCaptures = mockCaptureRunFailure.mock.calls.slice(captureCallsBefore);
    expect(newCaptures[0]?.[0]).toMatchObject({
      runId,
      runStatus: "failed",
      errorCode: "execution_finalization_deadline_exceeded",
    });
  });

  it("reports zero events for a repeated sweep over the same already-failed run", async () => {
    const { runId } = await seedAbandonedRunFixture();
    await reconcileAbandonedExecutionControl(db);
    // The first report is fire-and-forget. Observe it before taking the
    // second sweep's baseline, so a late first report is not a duplicate.
    await vi.waitFor(() => {
      expect(mockCaptureRunFailure.mock.calls.filter(([event]) => event.runId === runId)).toHaveLength(1);
    }, { timeout: 5_000 });
    // The first sweep already cleared executionControlDeadlineAt and moved the
    // run to "failed". Restore the deadline to simulate a second sweep still
    // observing the same run as a candidate.
    await db
      .update(heartbeatRuns)
      .set({ executionControlDeadlineAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, runId));

    const captureCallsBefore = mockCaptureRunFailure.mock.calls.length;
    const result = await reconcileAbandonedExecutionControl(db);

    // The run is already terminal ("failed"), so the early terminal-status
    // guard applies and no second "failed" write happens.
    expect(result.surfaced).toBe(1);
    expect(mockCaptureRunFailure.mock.calls.slice(captureCallsBefore)).toHaveLength(0);
  });

  it("keeps a run's own errorCode when the deadline sweep fires", async () => {
    // The regression this issue was filed for: a run that already recorded its
    // own outcome must not be relabelled `execution_finalization_deadline_exceeded`
    // with no trace of the former.
    const { companyId, runId } = await seedAbandonedRunFixture({
      errorCode: "adapter_failed",
      error: "The provider exited with code 1",
    });

    await reconcileAbandonedExecutionControl(db);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("adapter_failed");
    expect(run?.error).toContain("The provider exited with code 1");
    // The deadline fact is still recorded, in resultJson and in the recovery
    // action, so the sweep is not silently lost either.
    const record = (run?.resultJson as Record<string, any> | null)
      ?.executionFinalizationDeadline;
    expect(record).toMatchObject({
      code: "execution_finalization_deadline_exceeded",
      originalErrorCode: "adapter_failed",
    });
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    expect(action?.evidence).toMatchObject({
      originalErrorCode: "adapter_failed",
      originalError: "The provider exited with code 1",
    });
  });

  it("keeps the deadline code when the run recorded no outcome of its own", async () => {
    const { runId } = await seedAbandonedRunFixture();

    await reconcileAbandonedExecutionControl(db);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.errorCode).toBe("execution_finalization_deadline_exceeded");
  });

  it("keeps the instruction out of `error` and names the fault instead", async () => {
    const { runId } = await seedAbandonedRunFixture();

    await reconcileAbandonedExecutionControl(db);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.error).not.toBe(run?.nextAction);
    expect(run?.error).toContain("abandoned mid-finalization");
    expect(run?.nextAction).toContain("verify its provider has stopped");
  });

  it("names the finalization step that was in flight when the budget expired", async () => {
    const { runId } = await seedAbandonedRunFixture();
    beginRunFinalization(runId, { companyId: "unused", providerThrew: false });
    // A step that completed, then one that never returns.
    beginFinalizationStep(runId, "run_log_finalize")();
    beginFinalizationStep(runId, "issue_release");

    await reconcileAbandonedExecutionControl(db);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const record = (run?.resultJson as Record<string, any> | null)
      ?.executionFinalizationDeadline;
    expect(record).toMatchObject({
      finalizationInFlight: true,
      pendingFinalizationStep: "issue_release",
    });
    expect(record?.error).toBeUndefined();
    expect(run?.error).toContain('"issue_release"');
    clearRunFinalizationTimeline(runId);
  });

  it("records an abandoned run as having no live finalization chain", async () => {
    const { runId } = await seedAbandonedRunFixture();

    await reconcileAbandonedExecutionControl(db);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(
      (run?.resultJson as Record<string, any> | null)
        ?.executionFinalizationDeadline,
    ).toMatchObject({
      finalizationInFlight: false,
      pendingFinalizationStep: null,
    });
  });

  it("establishes provider ownership instead of leaving it unverified", async () => {
    // A PID that is certainly not running.
    const deadPid = 2 ** 22 - 1;
    const { companyId, runId } = await seedAbandonedRunFixture({ processPid: deadPid });

    await reconcileAbandonedExecutionControl(db);

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    expect(action?.evidence).toMatchObject({
      providerOwnership: "stopped",
      providerPid: deadPid,
    });
    expect((action?.evidence as Record<string, any>).providerOwnershipDetail).toContain(
      "is gone from this host",
    );
  });

  it("reports a live provider rather than claiming it stopped", async () => {
    const { companyId, runId } = await seedAbandonedRunFixture({
      processPid: process.pid,
    });

    await reconcileAbandonedExecutionControl(db);

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    expect(action?.evidence).toMatchObject({
      providerOwnership: "still_running",
      providerPid: process.pid,
    });
  });

  it("does not guess ownership for a run that recorded no PID", async () => {
    const { companyId, runId } = await seedAbandonedRunFixture();

    await reconcileAbandonedExecutionControl(db);

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.companyId, companyId));
    expect(action?.evidence).toMatchObject({
      providerOwnership: "not_recorded",
      providerPid: null,
    });
  });
});

describeEmbeddedPostgres("resolveProviderOwnership", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("provider-ownership-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  it("reports a remote lease provider as not inspectable rather than guessing", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Remote ownership", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Remote worker", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", processPid: process.pid });
    await db.insert(environmentLeases).values({
      id: randomUUID(),
      companyId,
      heartbeatRunId: runId,
      provider: "daytona",
    });

    const finding = await resolveProviderOwnership(
      db,
      (
        await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))
      )[0]!,
    );

    expect(finding.ownership).toBe("remote_not_inspectable");
    expect(finding.detail).toContain("daytona");
  });
});

describeEmbeddedPostgres("renewExecutionControlDeadline", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("finalization-deadline-renewal-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seedRun(status: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Renewal",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status, executionControlDeadlineAt: null,
    });
    return { companyId, agentId, runId };
  }

  it("re-arms the budget for a still-running run", async () => {
    const { runId } = await seedRun("running");
    const before = new Date();
    await renewExecutionControlDeadline(db, runId, { now: before });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.executionControlDeadlineAt).not.toBeNull();
    expect(run!.executionControlDeadlineAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime() + 60_000 - 1_000,
    );
  });

  it("never resurrects a deadline on a run the sweep already terminalized", async () => {
    // This is what makes it safe to call from the post-terminal chain: the
    // renewal is guarded on status, so a run the sweep failed stays failed with
    // a null deadline instead of being re-armed into a second sweep.
    const { runId } = await seedRun("failed");
    await renewExecutionControlDeadline(db, runId);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.executionControlDeadlineAt).toBeNull();
  });

  it("does not throw when the write fails, so a lost renewal cannot fail its step", async () => {
    const { runId } = await seedRun("running");
    const brokenDb = {
      update: () => ({ set: () => ({ where: () => Promise.reject(new Error("connection lost")) }) }),
    } as unknown as Parameters<typeof renewExecutionControlDeadline>[0];
    await expect(renewExecutionControlDeadline(brokenDb, runId)).resolves.toBeUndefined();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
  });
});

describe("finalization timeline", () => {
  beforeEach(() => resetRunFinalizationTimelines());
  afterEach(() => resetRunFinalizationTimelines());

  it("returns null for a run no chain owns, so absent is distinguishable from idle", () => {
    expect(readRunFinalizationTimeline("no-such-run")).toBeNull();
  });

  it("reports the in-flight step and the elapsed time spent in it", () => {
    const runId = randomUUID();
    beginRunFinalization(runId, { companyId: randomUUID(), providerThrew: true });
    beginFinalizationStep(runId, "terminal_status_write");
    const view = readRunFinalizationTimeline(runId)!;
    expect(view.providerThrew).toBe(true);
    expect(view.pendingStep?.step).toBe("terminal_status_write");
    expect(view.completedSteps).toHaveLength(0);
  });

  it("keeps completed step timings so the slow step is identifiable from data", () => {
    const runId = randomUUID();
    beginRunFinalization(runId, { companyId: randomUUID(), providerThrew: false });
    beginFinalizationStep(runId, "continuation_summary")();
    beginFinalizationStep(runId, "run_log_finalize")();
    const view = readRunFinalizationTimeline(runId)!;
    expect(view.completedSteps.map((step) => step.step)).toEqual([
      "continuation_summary",
      "run_log_finalize",
    ]);
    expect(view.slowestStepMs).toBeGreaterThanOrEqual(0);
    expect(view.pendingStep).toBeNull();
  });

  it("clears on request and ignores an end callback for an untracked run", () => {
    const runId = randomUUID();
    expect(() => beginFinalizationStep("untracked", "agent_status")()).not.toThrow();
    beginRunFinalization(runId, { companyId: randomUUID(), providerThrew: false });
    clearRunFinalizationTimeline(runId);
    expect(readRunFinalizationTimeline(runId)).toBeNull();
  });
});

describeEmbeddedPostgres("native review execution reconciliation admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("execution-control-review-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  it.each([true, false])("only releases the exact admitted review (admitted=%s)", async (admitted) => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const sourceRunId = randomUUID();
    const decisionId = randomUUID();
    const interactionId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Reviewer recovery", issuePrefix: admitted ? "RRA" : "RRN" });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Worker", adapterType: "codex_local", status: "idle" },
      { id: reviewerId, companyId, name: "Reviewer", adapterType: "codex_local", status: "running" },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: reviewerId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, executionControlDeadlineAt: new Date(now.getTime() - 60_000),
      contextSnapshot: { issueId, ...(admitted ? { nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId } : {}) },
    });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: workerId, status: "succeeded", runtimeMode: "native", nativeIssueId: issueId });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Review task", status: "in_review", statusVersion: 1,
      lastStatusDecisionId: decisionId, assigneeAgentId: workerId, executionRunId: runId, checkoutRunId: runId,
    });
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "1", policyVersion: "test", risk: "low", completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: randomUUID(), createdByActorType: "agent", createdByActorId: workerId });
    await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, sourceRunId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: sourceRunId, completionContractId: contractId, serverFingerprint: randomUUID(), schemaStatus: "valid", resultJson: {}, canonicalSha256: randomUUID() });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: sourceRunId, contractId, resultId, triggerKind: "test", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "test", assessmentJson: {}, inputDigest: randomUUID() });
    await db.insert(statusDecisions).values({
      id: decisionId, companyId, issueId, runId: sourceRunId, assessmentId: assessmentId, decisionVersion: 1,
      policyVersion: "test", fromStatus: "in_progress", toStatus: "in_review", reasonCode: "completion_review",
      decisionJson: { projectedStatusVersion: 1 }, decisionDigest: randomUUID(), applicationState: "applied",
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId, kind: "request_confirmation", status: "pending",
      continuationPolicy: "wake_assignee", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
      resolverPolicyProvenance: "inherited", sourceRunId: sourceRunId, addresseeAgentId: reviewerId,
      payload: { version: 1, prompt: "Review", target: { type: "custom", key: "native_completion_review", revisionId: decisionId } },
    });
    await reconcileAbandonedExecutionControl(db, now);
    await reconcileAbandonedExecutionControl(db, now);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [review] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(updatedIssue).toMatchObject({ assigneeAgentId: workerId, executionRunId: admitted ? null : runId, checkoutRunId: admitted ? null : runId });
    const recovery = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    expect(recovery).toHaveLength(admitted ? 1 : 0);
    if (admitted) expect(recovery[0]).toMatchObject({ maxAttempts: 3, wakePolicy: null, returnOwnerAgentId: workerId });
    expect(updatedRun?.status).toBe("failed");
    expect(review?.status).toBe("pending");
  });
});
