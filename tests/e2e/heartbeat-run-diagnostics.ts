import type { APIRequestContext } from "@playwright/test";

/**
 * Why a heartbeat run the harness invoked never became issue-bound.
 *
 * Split out of `signoff-policy.spec.ts` so it can be imported by a test. The
 * behaviour these helpers implement is what that spec's failure message is for,
 * and a spec cannot assert on its own helpers: Playwright collects a spec's
 * top-level bindings, so importing the spec from a test would re-register every
 * case in it. A module both sides import is the only shape that lets the
 * terminal-status set and the retry decision be asserted directly.
 */

/**
 * A heartbeat run the harness looked at while waiting for an issue-bound one,
 * reduced to the fields that explain why it was not accepted.
 */
export interface ObservedRun {
  id: string;
  agentId: string | null;
  status: string | null;
  errorCode: string | null;
  executionStage: string | null;
  boundIssueId: string | null;
}

/**
 * Statuses a run cannot leave. A run in one of these will never become issue-bound.
 *
 * `HEARTBEAT_RUN_STATUSES` is `queued`, `scheduled_retry`, `running`, then these
 * five, so this is the complement of the statuses a run can still leave. A
 * `timed_out` run is terminal: the watchdog ended it, and nothing downstream can
 * bind an issue to it. A set that omits `timed_out` makes a timed-out run
 * invisible to the failure report and silently withholds the retry, which is
 * how a `timed_out` run was once misread as a harness timeout.
 *
 * Hand-listed rather than derived from `HEARTBEAT_RUN_STATUSES` on purpose: this
 * set answers "can this run still bind", which is a statement about the run
 * lifecycle and not a mechanical `!HEARTBEAT_RUN_STATUSES.slice(0, 3)`. The
 * other two hand-written sets are the drift risk, and they are tracked
 * separately; the tests here are what keep this one honest.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

/**
 * How long to wait for an issue-bound run.
 *
 * The run has to be admitted, leased, and snapshot its context before it is
 * bound, and under the load these self-hosted runners already carry that is not
 * always fast. A 3s window turned ordinary slowness into a hard shard failure,
 * so the default is generous; the override exists for reproducing the old bound.
 */
export const ISSUE_BOUND_WAIT_MS = Number(process.env.PAPERCLIP_E2E_ISSUE_BOUND_WAIT_MS ?? 15_000);

/**
 * Reads the error-level entries out of a run's run log.
 *
 * The run row records that a run ended, but not why it ended during setup: a
 * run cancelled by a lost legacy controller lease carries no `errorCode`, so
 * the only trace of the cause is the run log entry. Used on the failure path
 * only, so a wrong guess here costs a request and never a passing run.
 */
export async function readRunLogFailure(
  board: APIRequestContext,
  baseUrl: string,
  runId: string,
): Promise<string | null> {
  const res = await board.get(
    `${baseUrl}/api/heartbeat-runs/${runId}/events?afterSeq=0&limit=200`,
  );
  if (!res.ok()) return null;
  const events = await res.json();
  const failures = (Array.isArray(events) ? events : [])
    .filter((event) => event?.level === "error" && typeof event.message === "string")
    .map((event) => `${event.message} ${JSON.stringify(event.payload ?? null)}`.trim());
  return failures.length > 0 ? failures.join(" | ") : null;
}

/**
 * True when every run this agent owns is already terminal.
 *
 * That is the signature of the server taking the run away rather than the
 * harness being too impatient: a run that is still queued or running can still
 * become issue-bound, so re-invoking would only add a second run to race for the
 * same issue lock. A terminal run never will, so re-invoking is the only way to
 * get an issue-bound run at all.
 */
export function everyObservedRunIsTerminal(
  observations: Map<string, ObservedRun>,
  agentId: string,
): boolean {
  const own = [...observations.values()].filter((observed) => observed.agentId === agentId);
  return own.length > 0 && own.every((observed) => TERMINAL_RUN_STATUSES.has(observed.status ?? ""));
}

/** Render every candidate the wait looked at, so the report names the real cause. */
export function describeObservedRuns(
  observations: Map<string, ObservedRun>,
  agentId: string,
): string {
  const own = [...observations.values()].filter((observed) => observed.agentId === agentId);
  if (own.length === 0) return "  (no run of this agent was ever visible)";
  return own
    .map((observed) => {
      const fields = [
        `status=${observed.status ?? "unknown"}`,
        `errorCode=${observed.errorCode ?? "none"}`,
        `issueId=${observed.boundIssueId ?? "none"}`,
      ];
      if (observed.executionStage) fields.push(`stage=${observed.executionStage}`);
      return `  run ${observed.id}: ${fields.join(" ")}`;
    })
    .join("\n");
}

/**
 * Build the failure for a wait that never found an issue-bound run.
 *
 * The old message named only the harness, so every occurrence was a search
 * through the WebServer log to find out which of the two sides had failed. Name
 * the runs, and name the run-log entry that explains a run the server ended.
 */
export async function noIssueBoundRunError(
  board: APIRequestContext,
  baseUrl: string,
  agentId: string,
  issueId: string,
  observations: Map<string, ObservedRun>,
  waitMs: number = ISSUE_BOUND_WAIT_MS,
): Promise<Error> {
  const lines: string[] = [
    `No issue-bound heartbeat run became available for agent ${agentId} on issue ${issueId} within ${waitMs}ms.`,
    "Candidate runs observed:",
    describeObservedRuns(observations, agentId),
  ];
  for (const observed of observations.values()) {
    if (observed.agentId !== agentId) continue;
    if (TERMINAL_RUN_STATUSES.has(observed.status ?? "") && observed.boundIssueId === null) {
      const failure = await readRunLogFailure(board, baseUrl, observed.id).catch(() => null);
      if (failure) lines.push(`  run ${observed.id} run log: ${failure}`);
    }
  }
  if (everyObservedRunIsTerminal(observations, agentId)) {
    lines.push(
      "Every run of this agent reached a terminal status without binding the issue, so the server ended it before setup finished. If the run log above names a lost legacy controller lease, that server defect is the cause and this test is a bystander; otherwise the invoke path itself is at fault.",
    );
  } else {
    lines.push(
      "At least one run of this agent was still live at the deadline, so the window was too short rather than the server having ended the run.",
    );
  }
  return new Error(lines.join("\n"));
}

/**
 * Invoke, and invoke again only when the server demonstrably ended every run.
 *
 * One invoke plus its wait is `invokeOnce`, which records the runs it saw into
 * `observations` and returns the run id to use, or `null` when no issue-bound
 * run appeared. The second invoke is the only way to get a usable run when the
 * first was taken away during setup: a terminal run never becomes issue-bound.
 * A still-live run can, so it is not retried, because a second invoke would put
 * two runs in a race for one issue lock. Observations from both attempts are
 * kept, because two cancelled runs read very differently from one.
 *
 * The wait itself is injected so the retry decision can be asserted without a
 * server. `signoff-policy.spec.ts` supplies the real one.
 */
export async function invokeHeartbeatWithRetry(
  board: APIRequestContext,
  baseUrl: string,
  agentId: string,
  issueId: string,
  observations: Map<string, ObservedRun>,
  invokeOnce: () => Promise<string | null>,
  waitMs: number = ISSUE_BOUND_WAIT_MS,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const invoked = await invokeOnce();
    if (invoked !== null) return invoked;
    if (attempt > 0 || !everyObservedRunIsTerminal(observations, agentId)) break;
  }

  throw await noIssueBoundRunError(board, baseUrl, agentId, issueId, observations, waitMs);
}
