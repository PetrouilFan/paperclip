import { and, asc, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { STANDING_WATCH_HOST_ISSUE_STATUS_SET } from "@paperclipai/shared";

/**
 * The single definition of "which issues is this heartbeat run bound to".
 *
 * Two callers must never disagree about that set, and before this module they
 * did. `GET /api/heartbeat-runs/{runId}/issues` reported whatever the run had
 * merely *touched* (an `activity_log` row, or its context snapshot), while the
 * cross-issue influence guard in `cross-issue-influence-limit.ts` honoured four
 * sources — context, checkout/execution stamp, standing-watch host, and
 * (per-target) the caller's own assigned ticket. An agent that read the read
 * endpoint to answer "am I bound to anything?" therefore got a wrong answer in
 * three of the guard's four cases, and a wrong answer that is indistinguishable
 * from a run bound to nothing: that is the state the guard refuses with
 * `cross_issue_influence_run_context_required`.
 *
 * The two directions of disagreement were both live:
 *
 *   - Over-report. A run that attached a file to an issue and never checked it
 *     out got that issue back from the read endpoint, so the binding looked
 *     real while the guard saw nothing to attribute a cross-issue write to.
 *   - Under-report. A run that checked an issue out and then wrote nothing —
 *     crashed, or only touched the board — had a binding the guard honoured
 *     while the endpoint listed no issues at all.
 *
 * The reads live here so both callers run the same predicates. The projections
 * stay with the callers: the guard needs ids inside its run-locked transaction,
 * the endpoint needs visible rows with a title and a status.
 */

/**
 * A finished run's checkout/execution stamp can linger on the issue row until
 * cleanup runs. Such a binding must not buy a *later* write an exemption, so
 * the binding fallback only trusts a run that is still live.
 */
export const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

/** Which of the guard's sources put an issue in a run's binding set. */
export type RunIssueBindingKind = "context" | "checkout" | "standing_watch";

export type RunIssueBinding = {
  issueId: string;
  kind: RunIssueBindingKind;
};

/** A run's own source issue, from its wake-time context snapshot. */
export function readRunContextSourceIssueId(contextSnapshot: unknown): string | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * The issue a watch role's timer wake is charged to, stamped by the scheduler
 * from `runtimeConfig.heartbeat.standingWatchIssueId` at enqueue time.
 *
 * Read as its own key rather than as `contextSnapshot.issueId` on purpose: the
 * standing host is a *source of attribution*, not the issue the run is working
 * on. Folding it into `issueId` would make the wake issue-scoped, which drags
 * in the tree-hold deferral, the workspace binding, and the
 * `skipTimerWhenNoActionableWork` short-circuit — none of which a board-wide
 * watch should inherit from one issue.
 */
export function readRunStandingWatchIssueId(contextSnapshot: unknown): string | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  const candidate = context.standingWatchIssueId;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTransaction = Db | DbTransaction;

/**
 * Issues stamped onto the run by `POST /checkout` (`checkout_run_id`) or by the
 * legacy execution lock (`execution_run_id`).
 *
 * A run can legitimately hold more than one issue, so the default order is by
 * ascending id: the guard picks one of them to name as the audit source and
 * must pick the same one for the same state on every call.
 */
export async function findRunCheckoutBoundIssueIds(
  executor: DbOrTransaction,
  input: { companyId: string; runId: string; limit?: number },
): Promise<string[]> {
  const query = executor
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      or(
        eq(issues.checkoutRunId, input.runId),
        eq(issues.executionRunId, input.runId),
      ),
    ))
    .orderBy(asc(issues.id));
  const rows = await (input.limit ? query.limit(input.limit) : query);
  return rows.map((row) => row.id);
}

/**
 * The standing-watch host, re-validated against current state rather than
 * trusted from the run's snapshot: the config is operator-editable, the run
 * outlives the config, and both callers sit on the write path where an
 * unattributed cross-issue write would be let through. A host that is not in
 * this company, not assigned to this agent, or no longer in a host status is
 * ignored, and the run falls back to its other sources exactly as before.
 */
export async function resolveStandingWatchHostIssue(
  executor: DbOrTransaction,
  input: { companyId: string; agentId: string; standingWatchIssueId: string },
): Promise<{ id: string } | null> {
  return executor
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
    .from(issues)
    .where(and(
      eq(issues.id, input.standingWatchIssueId),
      eq(issues.companyId, input.companyId),
    ))
    .then((rows) => {
      const host = rows[0] ?? null;
      if (
        !host ||
        host.assigneeAgentId !== input.agentId ||
        !STANDING_WATCH_HOST_ISSUE_STATUS_SET.has(host.status)
      ) {
        return null;
      }
      return { id: host.id };
    });
}

/**
 * The run's full binding set, resolved with the guard's own precedence.
 *
 * Precedence matters and is not incidental: a run whose context names a source
 * keeps master semantics and ignores its mutable checkout stamps, because
 * letting a checkout short-circuit a context-ful run would let it check its way
 * past the per-run write cap. A terminal run binds to nothing regardless of the
 * stamps left on the issue rows.
 *
 * Deliberately absent: the guard's per-target exemption for the caller's own
 * assigned ticket. That is a decision about one target, not a claim the run
 * holds the issue, and folding it in here would let a run read as bound to
 * every ticket it is assigned.
 */
export async function resolveRunIssueBindings(
  executor: DbOrTransaction,
  input: {
    companyId: string;
    runId: string;
    agentId: string;
    contextSnapshot: unknown;
    /** A finished run's leftover stamps are not a binding. */
    runStatus: string;
  },
): Promise<RunIssueBinding[]> {
  const contextSourceIssueId = readRunContextSourceIssueId(input.contextSnapshot);
  if (contextSourceIssueId) return [{ issueId: contextSourceIssueId, kind: "context" }];

  if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(input.runStatus)) return [];

  const bindings: RunIssueBinding[] = (
    await findRunCheckoutBoundIssueIds(executor, {
      companyId: input.companyId,
      runId: input.runId,
    })
  ).map((issueId) => ({ issueId, kind: "checkout" as const }));

  const standingWatchIssueId = readRunStandingWatchIssueId(input.contextSnapshot);
  if (standingWatchIssueId) {
    const host = await resolveStandingWatchHostIssue(executor, {
      companyId: input.companyId,
      agentId: input.agentId,
      standingWatchIssueId,
    });
    if (host && !bindings.some((binding) => binding.issueId === host.id)) {
      bindings.push({ issueId: host.id, kind: "standing_watch" });
    }
  }

  return bindings;
}
