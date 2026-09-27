import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  issueWatchdogs,
  type Db,
} from "@paperclipai/db";
import { ISSUE_EXECUTION_MONITOR_LIVE_STATUSES } from "@paperclipai/shared";

/**
 * The identity of an execution-recovery decision is `(runId, issueId)` — never
 * the recovery action row.
 *
 * `issue_recovery_actions.id` is a per-attempt receipt. A sweep that re-mints a
 * fresh action for the same dead run mints a *new id* every time, so any dedup
 * keyed on `recoveryActionId` is vacuous: the key is new on every comparison and
 * nothing is ever recognised as already decided. That is the whole re-mint loop.
 *
 * Two durable places carry the real identity, and both sides of the loop read
 * them:
 *
 *  1. the run's own `resultJson.executionRecoveryDisposition`, written by the
 *     settle so the sweeper stops selecting a consumed run, and
 *  2. the `evidence.automaticRecovery` receipt on the action that recorded the
 *     settlement, which is what a later minter reads to decide "already settled".
 */

export const EXECUTION_RECOVERY_DISPOSITION_KEY = "executionRecoveryDisposition";

/**
 * `automaticRecovery.replay` values that mean "this recovery is decided; do not
 * re-decide it". `blocked` is the preserve-without-replay settle,
 * `conversation_continuation` is the conversation-hold fold, and
 * `verified_safe_replacement` is a replacement proven safe and handed off.
 */
export const SETTLED_AUTOMATIC_RECOVERY_REPLAYS = [
  "blocked",
  "conversation_continuation",
  "verified_safe_replacement",
] as const;

export type ExecutionRecoverySettlementOutcome = "blocked" | "cancelled";

/**
 * The issue fields a settlement decision is a function of. Two settlements of
 * the same `(runId, issueId)` that observed the same values are the same
 * decision; a different owner, execution, checkout or status is a different
 * decision and is allowed to be recorded again.
 */
export type ExecutionRecoveryObservedIssueState = {
  status: string;
  assigneeAgentId: string | null;
  executionRunId: string | null;
  checkoutRunId: string | null;
};

export type ExecutionRecoveryDisposition = {
  runId: string;
  issueId: string;
  outcome: ExecutionRecoverySettlementOutcome;
  recoveryActionId: string;
  /** False when the settlement changed no issue state: the receipt exists, the activity feed stays clean. */
  changedIssueState: boolean;
  settledAt: string;
  observed: ExecutionRecoveryObservedIssueState;
};

type RecoveryIssueState = {
  status: string;
  assigneeAgentId?: string | null;
  executionRunId?: string | null;
  checkoutRunId?: string | null;
};

export function observeIssueForRecovery(
  issue: RecoveryIssueState,
): ExecutionRecoveryObservedIssueState {
  return {
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    executionRunId: issue.executionRunId ?? null,
    checkoutRunId: issue.checkoutRunId ?? null,
  };
}

export function readExecutionRecoveryDisposition(
  resultJson: unknown,
): ExecutionRecoveryDisposition | null {
  const value =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? (resultJson as Record<string, unknown>)[EXECUTION_RECOVERY_DISPOSITION_KEY]
      : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const observed = record.observed;
  if (
    typeof record.runId !== "string" ||
    typeof record.issueId !== "string" ||
    (record.outcome !== "blocked" && record.outcome !== "cancelled") ||
    !observed ||
    typeof observed !== "object" ||
    Array.isArray(observed) ||
    typeof (observed as Record<string, unknown>).status !== "string"
  )
    return null;
  const state = observed as Record<string, unknown>;
  return {
    runId: record.runId,
    issueId: record.issueId,
    outcome: record.outcome,
    recoveryActionId:
      typeof record.recoveryActionId === "string" ? record.recoveryActionId : "",
    changedIssueState: record.changedIssueState === true,
    settledAt: typeof record.settledAt === "string" ? record.settledAt : "",
    observed: {
      status: state.status as string,
      assigneeAgentId: typeof state.assigneeAgentId === "string" ? state.assigneeAgentId : null,
      executionRunId: typeof state.executionRunId === "string" ? state.executionRunId : null,
      checkoutRunId: typeof state.checkoutRunId === "string" ? state.checkoutRunId : null,
    },
  };
}

/**
 * True when this `(runId, issueId)` is already consumed and the live issue state
 * has not drifted, so the recorded decision is still the decision this sweep
 * would make. Any drift in an owner-bearing field makes the receipt stale and
 * the next settlement is a genuinely new decision.
 */
export function isExecutionRecoveryAlreadySettled(input: {
  disposition: ExecutionRecoveryDisposition | null;
  runId: string;
  issueId: string;
  issue: RecoveryIssueState;
}): boolean {
  const { disposition, runId, issueId, issue } = input;
  if (!disposition) return false;
  if (disposition.runId !== runId || disposition.issueId !== issueId) return false;
  const observed = observeIssueForRecovery(issue);
  return (
    disposition.observed.status === observed.status &&
    disposition.observed.assigneeAgentId === observed.assigneeAgentId &&
    disposition.observed.executionRunId === observed.executionRunId &&
    disposition.observed.checkoutRunId === observed.checkoutRunId
  );
}

/**
 * A settled action row for the same `(runId, issueId)`, whatever cause minted it.
 *
 * This replaces the guard that only recognised an operator reconciliation or a
 * `restore_unsafe_archive` hold. That guard missed the generic
 * `preserve_without_replay_v1` receipt every settle writes, so a dead run
 * re-minted a fresh action — and therefore a fresh `recoveryActionId` — on every
 * sweep.
 */
export function settledExecutionRecoveryActionCondition(runId: string) {
  return and(
    eq(issueRecoveryActions.status, "resolved"),
    sql`(
      ${issueRecoveryActions.evidence}->'automaticRecovery'->>'runId' = ${runId}
      or ${issueRecoveryActions.evidence}->'executionReconciliation'->>'runId' = ${runId}
    )`,
    sql`coalesce(
      ${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay',
      ${issueRecoveryActions.evidence}->'executionReconciliation'->>'actorId',
      ''
    ) <> ''`,
  );
}

export async function hasSettledExecutionRecoveryAction(
  dbOrTx: Db,
  input: { companyId: string; issueId: string; runId: string },
): Promise<boolean> {
  const rows = await dbOrTx
    .select({ id: issueRecoveryActions.id })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, input.companyId),
        eq(issueRecoveryActions.sourceIssueId, input.issueId),
        settledExecutionRecoveryActionCondition(input.runId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The durable merge that records a settlement on the run it belongs to. */
export function executionRecoveryDispositionMerge(
  disposition: ExecutionRecoveryDisposition,
) {
  return sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
    [EXECUTION_RECOVERY_DISPOSITION_KEY]: disposition,
  })}::jsonb`;
}

/**
 * The evidence key that lifts the no-replay *pin* while keeping the no-replay
 * *receipt*.
 *
 * `automaticRecovery.replay = "blocked"` currently means two things at once: do
 * not replay this dead run's actions, and refuse to admit new execution for the
 * issue. The first is a safety property about the dead run and never changes.
 * The second is right for an ordinary stranded ticket and wrong for a ticket
 * that is demonstrably still being watched — there the pin silently stops a live
 * monitor, and `check-now` answers 409 with nothing that explains why.
 *
 * So the two are separated. `replay` keeps its `blocked` value and every reader
 * of it is unchanged. An exempt settlement adds this key, and only the execution
 * hold and the `blocked` status write read it.
 */
export const LIVE_WATCH_EXEMPT_KEY = "liveWatchExempt";

/**
 * True when the issue carries an active task watchdog and a monitor that has not
 * been cleared, and is in a status its monitor can actually run from.
 *
 * That combination is the liveness evidence the sweeper needs: someone armed a
 * watchdog, a recurring check exists, and the ticket is in a runnable status.
 * The sweeper is reacting to one dead run, and it must not answer by pinning a
 * ticket that is visibly still live.
 *
 * Two deliberate narrowings keep the exemption from becoming a hole:
 *
 *  - `executionState.monitor.status = 'cleared'` counts as no monitor. A ticket
 *    whose watch was actually torn down is stranded in the ordinary sense and
 *    still wants the block. The live set is
 *    {@link ISSUE_EXECUTION_MONITOR_LIVE_STATUSES}, not a copy of it.
 *  - Only `in_progress` / `in_review` qualify, which is exactly the set
 *    `triggerIssueMonitor` and `tickDueIssueMonitors` will dispatch from. From
 *    `todo` or an already-`blocked` issue a monitor cannot run anyway, so the
 *    pin costs nothing there and is left in place.
 */
export async function hasLiveMonitoredWatch(
  dbOrTx: Db,
  input: { companyId: string; issueId: string },
): Promise<boolean> {
  const rows = await dbOrTx
    .select({ id: issueWatchdogs.id })
    .from(issueWatchdogs)
    .innerJoin(
      issues,
      and(
        eq(issues.id, issueWatchdogs.issueId),
        eq(issues.companyId, issueWatchdogs.companyId),
      ),
    )
    .where(
      and(
        eq(issueWatchdogs.companyId, input.companyId),
        eq(issueWatchdogs.issueId, input.issueId),
        eq(issueWatchdogs.status, "active"),
        // A scheduled check, or one that has just fired and is waiting to be
        // rescheduled. The `monitorNextCheckAt` pointer is nulled at trigger
        // time and re-armed when the monitor is rescheduled, so reading only
        // the pointer would miss the sweep that lands in that window.
        or(
          isNotNull(issues.monitorNextCheckAt),
          inArray(sql`${issues.executionState}->'monitor'->>'status'`, [
            ...ISSUE_EXECUTION_MONITOR_LIVE_STATUSES,
          ] as [string, ...string[]]),
        ),
        inArray(issues.status, ["in_progress", "in_review"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** SQL form of the {@link LIVE_WATCH_EXEMPT_KEY} carve-out. */
export function liveWatchExemptCondition() {
  // `sql.raw` is load-bearing: a key name interpolated into a `sql` template
  // becomes a bound parameter, and `->> $1` is not valid for Postgres to infer.
  // The key is a module constant, so inlining it is safe.
  return sql`coalesce(${issueRecoveryActions.evidence}->'automaticRecovery'->>${sql.raw(`'${LIVE_WATCH_EXEMPT_KEY}'`)}, 'false') = 'true'`;
}
