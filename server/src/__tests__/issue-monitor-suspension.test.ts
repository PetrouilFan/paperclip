import { describe, expect, it } from "vitest";
import { issueMonitorSuspensionReason } from "@paperclipai/shared";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  projectIssueMonitorSuspension,
} from "../services/issue-execution-policy.ts";

/**
 * A monitor-hosting issue pinned to a status its monitor cannot dispatch from
 * used to keep reading `scheduled` forever: the server refuses to fire the watch
 * from `blocked`, and every read — API, board, recovery sweep — reported a
 * healthy cadence. The absence of a signal was indistinguishable from a healthy
 * watch.
 *
 * The fixture below is a measured instance, taken from a live hourly
 * `external_service` watch: `status=blocked`,
 * `monitorNextCheckAt=2026-09-27T02:40:48Z` read 2h 20m later,
 * `executionState.monitor.status="scheduled"`, `recoveryPolicy="wake_owner"`,
 * `unblockDescriptor=null`.
 */

const agentId = "11111111-1111-4111-8111-111111111111";
const userId = "board-user";
const nextCheckAt = "2026-09-27T06:40:48.436Z";

function monitorState(overrides: Record<string, unknown> = {}) {
  return {
    status: "scheduled",
    nextCheckAt,
    lastTriggeredAt: "2026-09-27T01:40:48.436Z",
    attemptCount: 9,
    notes: "Hourly watch",
    scheduledBy: "assignee",
    kind: "external_service",
    serviceName: "model-liveness-probe",
    externalRef: null,
    timeoutAt: null,
    maxAttempts: 100,
    recoveryPolicy: "wake_owner",
    clearedAt: null,
    clearReason: null,
    ...overrides,
  };
}

function executionStateWith(monitor: Record<string, unknown> | null) {
  return {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor,
  };
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    status: "in_progress",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    monitorNextCheckAt: new Date(nextCheckAt),
    monitorLastTriggeredAt: new Date("2026-09-27T01:40:48.436Z"),
    monitorAttemptCount: 9,
    monitorNotes: "Hourly watch",
    monitorScheduledBy: "assignee",
    executionState: executionStateWith(monitorState()),
    ...overrides,
  } as Parameters<typeof projectIssueMonitorSuspension>[0];
}

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

  it("excludes terminal statuses — those are a cleared monitor, not a suspended one", () => {
    expect(issueMonitorSuspensionReason("done", agentId, null)).toBeNull();
    expect(issueMonitorSuspensionReason("cancelled", agentId, null)).toBeNull();
  });
});

describe("projectIssueMonitorSuspension", () => {
  it("reads a held issue's armed monitor as suspended, not scheduled", () => {
    const projected = parseIssueExecutionState(
      projectIssueMonitorSuspension(issue({ status: "blocked" })),
    );
    expect(projected?.monitor?.status).toBe("suspended");
    expect(projected?.monitor?.suspendedReason).toBe("host_status");
  });

  it("keeps the cadence, so the overdue slot still fires once the issue is runnable", () => {
    const projected = parseIssueExecutionState(
      projectIssueMonitorSuspension(issue({ status: "blocked" })),
    );
    expect(projected?.monitor?.nextCheckAt).toBe(nextCheckAt);
    expect(projected?.monitor?.attemptCount).toBe(9);
    expect(projected?.monitor?.recoveryPolicy).toBe("wake_owner");
    expect(projected?.monitor?.clearReason).toBeNull();
    expect(projected?.monitor?.clearedAt).toBeNull();
  });

  it("self-clears the moment the issue becomes runnable again", () => {
    const stored = issue({ status: "blocked" }).executionState;
    const projected = parseIssueExecutionState(
      projectIssueMonitorSuspension({ ...issue({ status: "in_progress" }), executionState: stored }),
    );
    expect(projected?.monitor?.status).toBe("scheduled");
  });

  it("leaves a runnable issue's scheduled monitor untouched, by identity", () => {
    const runnable = issue();
    expect(projectIssueMonitorSuspension(runnable)).toBe(runnable.executionState);
  });

  it("leaves terminal monitor readings alone", () => {
    for (const status of ["cleared", "triggered"]) {
      const withTerminal = issue({
        status: "blocked",
        executionState: executionStateWith(
          monitorState({ status, nextCheckAt: status === "cleared" ? null : nextCheckAt }),
        ),
      });
      const projected = parseIssueExecutionState(projectIssueMonitorSuspension(withTerminal));
      expect(projected?.monitor?.status).toBe(status);
    }
  });

  it("survives the zod round trip — an unknown status would silently null the whole state", () => {
    const projected = projectIssueMonitorSuspension(issue({ status: "blocked" }));
    expect(projected).not.toBeNull();
    expect(parseIssueExecutionState(projected)).not.toBeNull();
  });

  it("blames the assignee when the issue is in a monitorable status but has no agent", () => {
    const projected = parseIssueExecutionState(
      projectIssueMonitorSuspension(issue({ assigneeAgentId: null, assigneeUserId: userId })),
    );
    expect(projected?.monitor?.status).toBe("suspended");
    expect(projected?.monitor?.suspendedReason).toBe("host_assignee");
  });

  it("passes through an issue with no monitor state at all", () => {
    const none = issue({ executionState: executionStateWith(null) });
    expect(projectIssueMonitorSuspension(none)).toBe(none.executionState);
  });
});

/**
 * PR #126 claimed "a read projection is used rather than a write, so no predicate
 * that reads the stored column changes behaviour". That was false:
 * `derivePersistedMonitorState` computed the same `suspended` value on a *write*
 * path, and `applyMonitorTransition` persisted it whenever a stage transition
 * happened to produce an `executionState` while neither the incoming nor the
 * previous policy carried a monitor. The claim is what three readers of the
 * stored column were entitled to believe, so it is worth a test rather than a
 * commit message.
 */
describe("the stored monitor status", () => {
  const reviewPolicy = normalizeIssueExecutionPolicy({
    stages: [{ type: "review", participants: [{ type: "agent", agentId: "22222222-2222-4222-8222-222222222222" }] }],
  })!;

  /** A stage transition that yields an `executionState` patch, with no monitor in either policy. */
  function stageTransitionOn(heldIssue: Record<string, unknown>) {
    return applyIssueExecutionPolicyTransition({
      issue: {
        ...heldIssue,
        executionPolicy: reviewPolicy,
      } as Parameters<typeof applyIssueExecutionPolicyTransition>[0]["issue"],
      policy: reviewPolicy,
      previousPolicy: reviewPolicy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: agentId },
      commentBody: "The external check came back clean",
    });
  }

  it.each([
    ["host_status", { status: "blocked" }],
    ["host_assignee", { status: "in_progress", assigneeAgentId: null, assigneeUserId: userId }],
  ])("stays `scheduled` for a held issue (%s) while the read projects `suspended`", (reason, held) => {
    const heldIssue = issue(held);
    const { patch } = stageTransitionOn(heldIssue as unknown as Record<string, unknown>);

    // The write path records the cadence. It does not record a second,
    // independently derived copy of the projection.
    const stored = parseIssueExecutionState(patch.executionState as never);
    expect(stored?.monitor?.status).toBe("scheduled");
    expect(stored?.monitor?.suspendedReason).toBeNull();
    // …and the cadence is intact, so the overdue slot still fires.
    expect(stored?.monitor?.nextCheckAt).toBe(nextCheckAt);

    const projected = parseIssueExecutionState(
      projectIssueMonitorSuspension({ ...heldIssue, ...held } as Parameters<typeof projectIssueMonitorSuspension>[0]),
    );
    expect(projected?.monitor?.status).toBe("suspended");
    expect(projected?.monitor?.suspendedReason).toBe(reason);
  });
});
