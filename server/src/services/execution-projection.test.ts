import { describe, expect, it } from "vitest";
import { projectExecution } from "./execution-projection.js";

type Run = Parameters<typeof projectExecution>[0];
type Coordinator = NonNullable<Parameters<typeof projectExecution>[1]>;
const now = new Date("2026-09-08T12:00:00Z");
const run = (values: Partial<Run> = {}) =>
  ({
    status: "running",
    runtimeMode: "native",
    errorCode: null,
    nextAction: null,
    lastUsefulActionAt: now,
    lastOutputAt: null,
    startedAt: now,
    scheduledRetryAt: null,
    scheduledRetryAttempt: 1,
    retryOfRunId: null,
    executionControlDeadlineAt: null,
    // The stranded-run branch reads `createdAt` through the shared predicate.
    // Every other branch short-circuits on `status` first, so a default of `now`
    // keeps those fixtures inside the admission window without pinning the value.
    createdAt: now,
    ...values,
  }) as Run;
const coordinator = (values: Partial<Coordinator> = {}) =>
  ({
    phase: "observed",
    attempt: 1,
    failureCode: null,
    failureDetail: {},
    nextAttemptAt: null,
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    controlDeadlineAt: null,
    ...values,
  }) as Coordinator;
const project = (
  r = run(),
  c: Coordinator | undefined = coordinator(),
  pending: { kind: string }[] = [],
) => projectExecution(r, c, pending, undefined, now);

describe("execution truth projection", () => {
  it("keeps cleanup quarantine visible without a coordinator or recovery row", () => {
    const stopped = run({ id: "stopped", status: "failed", errorCode: "native_session_cleanup_quarantined" });
    expect(projectExecution(stopped, undefined, [], undefined, now)).toMatchObject({
      phase: "recovery_needed", cause: "native_session_cleanup_quarantined", recoveryOwner: "board",
      permittedActions: ["inspect_run", "inspect_recovery"],
    });
    expect(projectExecution(stopped, coordinator({ phase: "retryable_failure" }), [], undefined, now).phase).toBe("recovery_needed");
    expect(projectExecution({ ...stopped, finishedAt: now }, coordinator({
      phase: "terminal_failure", failureCode: "native_provider_terminal_failed",
    }), [], undefined, now)).toMatchObject({ phase: "recovery_needed", recoveryOwner: "board" });
    expect(projectExecution({ ...stopped, errorCode: "provider_frame_too_large" }, undefined, [], undefined, now).phase).toBe("failed");
    expect(projectExecution(stopped, undefined, [], { status: "resolved", cause: "native_session_cleanup_quarantined", nextAction: "Verify prior execution",
      evidence: { executionReconciliation: { providerStopped: true }, continuationRunId: "successor" } }, now))
      .toMatchObject({ phase: "completed", successorRunId: "successor", cause: null });
  });
  it("shows subscription contention as a resource wait without failed provider attempts", () => {
    expect(projectExecution(run({ runtimeMode: "legacy", status: "scheduled_retry", scheduledRetryReason: "ai_connection_busy",
      scheduledRetryAttempt: 12, contextSnapshot: { failureRetriesBeforeAiConnectionWait: 0 } }), undefined, [], undefined, now))
      .toMatchObject({ label: "Waiting for AI subscription", phase: "retry_scheduled", attempt: 1, recoveryOwner: null });
  });
  it("shows a workspace wait without presenting its deferral count as failed attempts", () => {
    expect(projectExecution(run({ runtimeMode: "legacy", status: "scheduled_retry", scheduledRetryReason: "workspace_busy",
      scheduledRetryAttempt: 12, contextSnapshot: { failureRetriesBeforeWorkspaceWait: 1 } }), undefined, [], undefined, now))
      .toMatchObject({ label: "Waiting for workspace", phase: "retry_scheduled", attempt: 2, recoveryOwner: null });
  });
  it.each([
    { status: "resolved", previousRunId: "old", nextRunId: "next", continued: true },
    { status: "active", previousRunId: "old", nextRunId: "next", continued: false },
    { status: "resolved", previousRunId: "other", nextRunId: "next", continued: false },
    { status: "resolved", previousRunId: "old", nextRunId: "old", continued: false },
    { status: "resolved", previousRunId: "old", nextRunId: null, continued: false },
  ])("projects the recorded explicit successor without hiding unresolved recovery: $status/$previousRunId/$nextRunId", ({ status, previousRunId, nextRunId, continued }) => {
    const source = run({ id: "old", status: "failed", errorCode: "adapter_failed" });
    expect(projectExecution(source, coordinator({ phase: "terminal_failure" }), [], {
      status,
      cause: "native_continuation_requires_reconciliation",
      nextAction: "Inspect the stopped execution.",
      evidence: {
        automaticRecovery: { policy: "preserve_without_replay_v1" },
        explicitUserContinuation: { previousRunId, runId: nextRunId },
      },
    }, now)).toMatchObject(continued ? {
      phase: "completed", label: "Continued in another run", successorRunId: "next",
      cause: "native_continuation_requires_reconciliation", nextAction: null,
    } : { phase: "recovery_needed", successorRunId: null });
    expect(source.status).toBe("failed");
  });

  it("reports a resolved automatic-recovery row the gate still holds as a board-owned hold", () => {
    const stopped = run({ id: "held", status: "failed", errorCode: "interrupted" });
    const resolvedHold = {
      id: "action-1",
      status: "resolved" as const,
      cause: "legacy_execution_requires_reconciliation",
      nextAction: "Automatic recovery stopped. Recorded work is preserved.",
      evidence: {
        runId: "held",
        automaticRecovery: { replay: "blocked", policy: "preserve_without_replay_v1" },
      },
    };
    // The gate counts this resolved row, so the projection must name an owner and
    // permit recovery inspection rather than reading as having nothing to inspect.
    expect(projectExecution(stopped, undefined, [], resolvedHold, now, new Set(["action-1"])))
      .toMatchObject({
        phase: "recovery_needed",
        label: "Stopped",
        cause: "legacy_execution_requires_reconciliation",
        recoveryOwner: "board",
        permittedActions: ["inspect_run", "inspect_recovery"],
      });
    // Negative control: the same resolved row once the gate stops counting it is
    // closed bookkeeping, so it must claim no owner and no recovery affordance.
    expect(projectExecution(stopped, undefined, [], resolvedHold, now, new Set()))
      .toMatchObject({
        phase: "recovery_needed",
        label: "Stopped",
        recoveryOwner: null,
        permittedActions: ["inspect_run"],
      });
    // A delivered explicit continuation outranks the hold bookkeeping: the user
    // already decided, so the newer attempt must not read as blocked.
    expect(projectExecution(stopped, undefined, [], {
      ...resolvedHold,
      evidence: {
        ...resolvedHold.evidence,
        explicitUserContinuation: { previousRunId: "held", runId: "next" },
      },
    }, now, new Set(["action-1"]))).toMatchObject({
      phase: "completed",
      label: "Continued in another run",
      successorRunId: "next",
    });
  });

  it("shows a reconciled continuation as queued until its durable delivery is recorded", () => {
    const action = {
      cause: "native_session_retry_exhausted",
      nextAction: "Old recovery action",
      status: "resolved" as const,
      evidence: {
        executionReconciliation: { runId: "old" },
        continuationDelivery: "pending",
      },
    };
    expect(
      projectExecution(
        run({ status: "failed" }),
        coordinator({ phase: "terminal_failure" }),
        [],
        action,
        now,
      ),
    ).toMatchObject({
      phase: "queued",
      label: "Continuation queued",
      cause: null,
    });
    expect(
      projectExecution(
        run({ status: "failed" }),
        coordinator({ phase: "terminal_failure" }),
        [],
        {
          ...action,
          evidence: { ...action.evidence, continuationRunId: "next" },
        },
        now,
      ),
    ).toMatchObject({ phase: "completed", successorRunId: "next" });
    expect(
      projectExecution(
        run({ status: "failed" }),
        coordinator({ phase: "terminal_failure" }),
        [],
        {
          ...action,
          evidence: { ...action.evidence, continuationDelivery: "invalidated" },
        },
        now,
      ),
    ).toMatchObject({ phase: "failed", label: "Continuation cancelled" });
  });
  it("requires current execution evidence, without treating output silence as failure", () => {
    expect(project(run({ lastOutputAt: new Date(0) })).phase).toBe("working");
    expect(
      project(run(), coordinator({ leaseExpiresAt: new Date(0) })),
    ).toMatchObject({ phase: "reconnecting", label: "Confirming execution" });
    expect(
      project(
        run({ runtimeMode: "legacy", processPid: process.pid }),
        undefined,
      ).phase,
    ).toBe("working");
  });
  it("distinguishes provider work, finalization and timed retry", () => {
    expect(
      project(
        run({ executionControlDeadlineAt: new Date(now.getTime() + 60_000) }),
      ).phase,
    ).toBe("finishing");
    expect(
      project(
        run({ status: "failed" }),
        coordinator({
          phase: "retryable_failure",
          nextAttemptAt: new Date(now.getTime() + 30_000),
          attempt: 2,
        }),
      ),
    ).toMatchObject({ phase: "retry_scheduled", attempt: 2, maxAttempts: 3 });
    expect(
      project(
        run({ status: "failed" }),
        coordinator({ phase: "retryable_failure", nextAttemptAt: new Date(0) }),
      ).phase,
    ).toBe("reconnecting");
  });
  it("includes the original legacy attempt in the displayed incident budget", () => {
    expect(projectExecution(run({ runtimeMode: "legacy", status: "scheduled_retry", scheduledRetryAttempt: 1 }), undefined, [], undefined, now)).toMatchObject({ attempt: 2, maxAttempts: 3 });
  });
  it("shows pending interaction only after productive work has stopped", () => {
    expect(
      project(run(), coordinator(), [{ kind: "connection_intent" }]).phase,
    ).toBe("working");
    expect(
      project(run({ status: "succeeded" }), undefined, [
        { kind: "connection_intent" },
      ]).phase,
    ).toBe("waiting_for_access");
    expect(
      project(run({ status: "succeeded" }), undefined, [
        { kind: "ask_user_questions" },
      ]).phase,
    ).toBe("waiting_for_answer");
  });
  it("retains replacement lineage and exposes operator-owned failures for legacy runs", () => {
    expect(
      project(
        run({ status: "failed" }),
        coordinator({
          phase: "terminal_failure",
          failureDetail: { successorRunId: "replacement" },
        }),
      ),
    ).toMatchObject({ phase: "completed", successorRunId: "replacement" });
    expect(
      projectExecution(
        run({ runtimeMode: "legacy", status: "failed" }),
        undefined,
        [],
        {
          cause: "uncertain_external_action",
          nextAction: "Reconcile the email delivery.",
        },
        now,
      ),
    ).toMatchObject({
      phase: "recovery_needed",
      recoveryOwner: "board",
      nextAction: "Reconcile the email delivery.",
    });
  });
  it("bounds recovery checking and surfaces its next action if verification never finishes", () => {
    const c = coordinator({
      phase: "terminal_failure",
      failureCode: "native_provider_terminal_failed",
    });
    expect(project(run({ status: "failed", finishedAt: now }), c).label).toBe(
      "Checking recovery",
    );
    expect(
      project(
        run({ status: "failed", finishedAt: new Date(now.getTime() - 60_000) }),
        c,
      ).phase,
    ).toBe("recovery_needed");
    expect(
      project(
        run({ status: "failed", finishedAt: now }),
        coordinator({
          ...c,
          failureDetail: { replacementDenied: "uncertain_provider_action" },
        }),
      ).phase,
    ).toBe("recovery_needed");
  });
  // A `queued` run the dispatcher never claimed still holds its issue's execution
  // lock, so the issue has no write surface at all. Read as a plain `queued` it is
  // indistinguishable from a run one second from dispatch, which is how a wedged
  // `in_progress` issue looks like healthy work in flight on the board.
  describe("a queued run the dispatcher never claimed", () => {
    const windowMs = 12 * 60 * 60 * 1_000;
    const stranded = (values: Partial<Run> = {}) =>
      run({
        id: "stranded",
        status: "queued",
        runtimeMode: "legacy",
        startedAt: null,
        lastUsefulActionAt: null,
        lastOutputAt: null,
        createdAt: new Date(now.getTime() - windowMs - 60_000),
        ...values,
      });

    it("stops reading as an ordinary queued run and grows a recovery affordance", () => {
      expect(projectExecution(stranded(), undefined, [], undefined, now)).toMatchObject({
        phase: "recovery_needed",
        label: "Stuck in queue",
        cause: "never_dispatched_timeout",
        // `agent`, not `board`: the assignee can release their own stranded run
        // through the cancel route, so this is not a board-only stop.
        recoveryOwner: "agent",
        permittedActions: ["inspect_run", "inspect_recovery"],
        lastConfirmedActivityAt: null,
      });
    });

    it("names the release as the next action, because the lock is what is blocking", () => {
      expect(
        projectExecution(stranded(), undefined, [], undefined, now).nextAction,
      ).toMatch(/Cancel this run to release the lock/);
    });

    it("still reads as ordinary queueing inside the admission window", () => {
      // `queued` is a legitimate live state. Reporting a run that is waiting its
      // turn as stranded would be wrong, and the observed queue wait reaches
      // 7.09h, so this boundary is load-bearing.
      expect(
        projectExecution(
          stranded({ createdAt: new Date(now.getTime() - 60_000) }),
          undefined,
          [],
          undefined,
          now,
        ),
      ).toMatchObject({
        phase: "queued",
        label: "Queued",
        recoveryOwner: null,
        permittedActions: ["inspect_run"],
      });
    });

    it("does not misread a claimed-but-slow run as stranded", () => {
      expect(
        projectExecution(
          stranded({ startedAt: new Date(now.getTime() - 60_000) }),
          undefined,
          [],
          undefined,
          now,
        ),
      ).toMatchObject({ phase: "queued", label: "Queued" });
    });

    it("defers to a recovery row that already explains the run", () => {
      // Placement matters: a recovery action is the better explanation of why a
      // run is not progressing than "the dispatcher never claimed it".
      expect(
        projectExecution(stranded(), undefined, [], {
          status: "active",
          cause: "agent_stranded",
          nextAction: "Inspect the stopped agent.",
        }, now),
      ).toMatchObject({
        phase: "recovery_needed",
        cause: "agent_stranded",
        recoveryOwner: "board",
        nextAction: "Inspect the stopped agent.",
      });
    });
  });
});
