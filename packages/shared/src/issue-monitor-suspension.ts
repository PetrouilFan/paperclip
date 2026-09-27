import type { IssueExecutionMonitorSuspendedReason } from "./constants.js";

/**
 * The stored `executionState.monitor.status` values that mean a watch is armed
 * and dispatchable.
 *
 * `suspended` is deliberately absent, and that is the load-bearing part of this
 * list. Suspension is a property of the *host issue* ({@link issueAllowsMonitor}
 * below), not of the cadence, so it is a read projection — see
 * `projectIssueMonitorSuspension` in the server. Persisting it would put a
 * fourth vocabulary in front of every reader that asks "is there a live watch
 * here?", and the safe default for such a reader is "no monitor", which is the
 * wrong answer for a held row whose `monitor_next_check_at` is still armed.
 *
 * Readers must not re-spell this set. `externalConversationStateSql`,
 * `hasLiveMonitoredWatch` and `settleSlackConversation` each asked the same
 * question in their own words, and a member added to
 * `ISSUE_EXECUTION_MONITOR_STATE_STATUSES` fell through all three silently.
 */
export const ISSUE_EXECUTION_MONITOR_LIVE_STATUSES = ["scheduled", "triggered"] as const;

/**
 * The stored statuses that mean there is no watch left to wait on. `cleared` is a
 * monitor that was torn down, which is a different claim from `suspended`'s
 * "armed but cannot fire" — see {@link ISSUE_EXECUTION_MONITOR_LIVE_STATUSES}.
 *
 * Together with `LIVE` this is every *stored* member of
 * `ISSUE_EXECUTION_MONITOR_STATE_STATUSES`, minus `suspended`, which is in
 * neither set because it is never stored. `issue-monitor-suspension.test.ts`
 * asserts that partition, so a member added to the enum with no classification
 * fails there rather than silently reading as "no monitor" in every
 * "is there a live watch?" reader.
 */
export const ISSUE_EXECUTION_MONITOR_INACTIVE_STATUSES = ["cleared"] as const;

/**
 * Whether a monitor on an issue in this shape can dispatch at all.
 *
 * This is the single source of that answer for the server, the board and the
 * stranded sweep. The status set is exactly what `triggerIssueMonitor` and
 * `tickDueIssueMonitors` dispatch from, and the assignee terms are the
 * single-assignee invariant: a watch runs for an agent, never for a board user
 * and never for an unassigned issue.
 */
export function issueAllowsMonitor(
  status: string,
  assigneeAgentId: string | null,
  assigneeUserId: string | null,
): boolean {
  return Boolean(assigneeAgentId) && !assigneeUserId && (status === "in_progress" || status === "in_review");
}

/**
 * Why an armed monitor cannot dispatch from the issue's current shape, or null
 * when it can.
 *
 * The set of statuses that qualify is exactly what {@link issueAllowsMonitor}
 * covers. Terminal statuses are excluded because they are a *cleared* monitor,
 * not a suspended one — `monitorClearReasonForIssue` in the server already owns
 * that vocabulary, and calling a torn-down watch "suspended" would make the two
 * indistinguishable.
 *
 * The assignee is checked before the status is blamed because it outranks it. A
 * held issue with no agent to run the watch cannot start by changing status, so
 * blaming the status would name the wrong unblock to whoever reads the banner.
 *
 * `undefined` for both assignee ids means the caller could not see them — a
 * partial read, such as a board row that did not project the assignee. Judged on
 * the status alone, because absence of an assignee on the wire is not evidence
 * that nobody can run the watch. The server always passes concrete values, so it
 * never takes that branch.
 */
export function issueMonitorSuspensionReason(
  status: string,
  assigneeAgentId: string | null | undefined,
  assigneeUserId: string | null | undefined,
): IssueExecutionMonitorSuspendedReason | null {
  if (status === "done" || status === "cancelled") return null;
  if (assigneeAgentId === undefined && assigneeUserId === undefined) {
    return status === "in_progress" || status === "in_review" ? null : "host_status";
  }
  if (issueAllowsMonitor(status, assigneeAgentId ?? null, assigneeUserId ?? null)) return null;
  return assigneeUserId || !assigneeAgentId ? "host_assignee" : "host_status";
}
