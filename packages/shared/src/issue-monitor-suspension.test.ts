import { describe, expect, it } from "vitest";
import {
  ISSUE_EXECUTION_MONITOR_INACTIVE_STATUSES,
  ISSUE_EXECUTION_MONITOR_LIVE_STATUSES,
  issueAllowsMonitor,
  issueMonitorSuspensionReason,
} from "./issue-monitor-suspension.js";
import { ISSUE_EXECUTION_MONITOR_STATE_STATUSES } from "./constants.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const userId = "board-user";

describe("issueAllowsMonitor", () => {
  it("admits only an agent-assigned issue in a dispatchable status", () => {
    expect(issueAllowsMonitor("in_progress", agentId, null)).toBe(true);
    expect(issueAllowsMonitor("in_review", agentId, null)).toBe(true);
    expect(issueAllowsMonitor("blocked", agentId, null)).toBe(false);
    expect(issueAllowsMonitor("todo", agentId, null)).toBe(false);
    expect(issueAllowsMonitor("done", agentId, null)).toBe(false);
    expect(issueAllowsMonitor("cancelled", agentId, null)).toBe(false);
  });

  it("refuses a board-assigned or unassigned issue in any status", () => {
    expect(issueAllowsMonitor("in_progress", agentId, userId)).toBe(false);
    expect(issueAllowsMonitor("in_progress", null, userId)).toBe(false);
    expect(issueAllowsMonitor("in_progress", null, null)).toBe(false);
  });
});

describe("issueMonitorSuspensionReason", () => {
  it("reports no suspension for the statuses a monitor dispatches from", () => {
    expect(issueMonitorSuspensionReason("in_progress", agentId, null)).toBeNull();
    expect(issueMonitorSuspensionReason("in_review", agentId, null)).toBeNull();
  });

  it("blames the status for a held issue that still has an agent assignee", () => {
    expect(issueMonitorSuspensionReason("blocked", agentId, null)).toBe("host_status");
    expect(issueMonitorSuspensionReason("todo", agentId, null)).toBe("host_status");
    expect(issueMonitorSuspensionReason("backlog", agentId, null)).toBe("host_status");
  });

  it("blames the assignee when a monitor can never have an agent to run it", () => {
    expect(issueMonitorSuspensionReason("in_progress", null, userId)).toBe("host_assignee");
    expect(issueMonitorSuspensionReason("in_progress", null, null)).toBe("host_assignee");
  });

  it("prefers the assignee over the status when both are wrong", () => {
    // A `todo` issue with nobody assigned cannot be unblocked by moving it to
    // in progress, so the status would be the wrong thing to tell the operator
    // to go and change.
    expect(issueMonitorSuspensionReason("todo", null, userId)).toBe("host_assignee");
    expect(issueMonitorSuspensionReason("blocked", null, null)).toBe("host_assignee");
  });

  it("excludes terminal statuses — those are a cleared monitor, not a suspended one", () => {
    expect(issueMonitorSuspensionReason("done", agentId, null)).toBeNull();
    expect(issueMonitorSuspensionReason("cancelled", agentId, null)).toBeNull();
  });

  it("judges the status alone when the read did not project an assignee", () => {
    // A board row that omits the assignee has not told us the issue is
    // unassigned, and inventing that verdict would suspend a working countdown.
    expect(issueMonitorSuspensionReason("in_progress", undefined, undefined)).toBeNull();
    expect(issueMonitorSuspensionReason("in_review", undefined, undefined)).toBeNull();
    expect(issueMonitorSuspensionReason("blocked", undefined, undefined)).toBe("host_status");
    expect(issueMonitorSuspensionReason("todo", undefined, undefined)).toBe("host_status");
    // A terminal status is still a cleared monitor, not a suspended one.
    expect(issueMonitorSuspensionReason("done", undefined, undefined)).toBeNull();
  });
});

describe("the live/inactive partition", () => {
  /**
   * The defect this guards: a fourth `ISSUE_EXECUTION_MONITOR_STATE_STATUSES`
   * member that nobody classified would be read as "no monitor" by every
   * "is there a live watch?" reader — `externalConversationStateSql`,
   * `hasLiveMonitoredWatch` and `settleSlackConversation` — because all three
   * default to the absence of a watch. Making that failure loud is the point of
   * having the set in one place at all.
   */
  it("classifies every stored member exactly once, and only `suspended` is unclassified", () => {
    const live = new Set<string>(ISSUE_EXECUTION_MONITOR_LIVE_STATUSES);
    const inactive = new Set<string>(ISSUE_EXECUTION_MONITOR_INACTIVE_STATUSES);
    expect([...live].filter((status) => inactive.has(status))).toEqual([]);
    const unclassified = ISSUE_EXECUTION_MONITOR_STATE_STATUSES.filter(
      (status) => !live.has(status) && !inactive.has(status),
    );
    // `suspended` belongs to neither set because it is a read projection, never
    // a stored value. Anything else here is an enum member no reader accounts
    // for, which reads as "no monitor" in all three of them.
    expect(unclassified).toEqual(["suspended"]);
  });

  it("keeps `suspended` out of the stored set, because it is a read projection", () => {
    expect(ISSUE_EXECUTION_MONITOR_LIVE_STATUSES).not.toContain("suspended");
    expect(ISSUE_EXECUTION_MONITOR_INACTIVE_STATUSES).not.toContain("suspended");
    expect(ISSUE_EXECUTION_MONITOR_STATE_STATUSES).toContain("suspended");
  });
});
