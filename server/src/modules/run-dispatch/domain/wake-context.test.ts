import { describe, expect, it } from "vitest";
import {
  allowsIssueInteractionWake,
  buildWakeQueueAge,
  deriveCommentId,
  extractWakeCommentIds,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
  readWakeQueueAge,
  WAKE_QUEUE_AGE_KEY,
  WORKSPACE_BUSY_RETRY_REASON,
} from "./wake-context.js";

describe("wake context", () => {
  it("requires the subscription-specific non-assignee receipt for a subscription wait", () => {
    expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", {
      aiConnectionBusyDeferredWhileAssignee: false,
    })).toBe(true);
    for (const context of [ {}, { aiConnectionBusyDeferredWhileAssignee: true }, { workspaceBusyDeferredWhileAssignee: false } ]) {
      expect(isNonAssigneeWorkspaceBusyRetry("ai_connection_busy", context)).toBe(false);
    }
    expect(isNonAssigneeWorkspaceBusyRetry("transient_failure", { aiConnectionBusyDeferredWhileAssignee: false })).toBe(false);
  });
  it("recognizes only workspace-busy retries deferred outside assignee-ship", () => {
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(true);
    expect(isNonAssigneeWorkspaceBusyRetry(WORKSPACE_BUSY_RETRY_REASON, {
      workspaceBusyDeferredWhileAssignee: true,
    })).toBe(false);
    expect(isNonAssigneeWorkspaceBusyRetry("another_reason", {
      workspaceBusyDeferredWhileAssignee: false,
    })).toBe(false);
  });

  it("keeps ordered, unique, non-empty wake comment ids", () => {
    expect(extractWakeCommentIds({
      wakeCommentIds: ["comment-1", "", null, "comment-2", "comment-1"],
    })).toEqual(["comment-1", "comment-2"]);
    expect(extractWakeCommentIds({ wakeCommentIds: "comment-1" })).toEqual([]);
    expect(extractWakeCommentIds(undefined)).toEqual([]);
  });

  it.each([
    [{ wakeCommentIds: ["batch-1", "batch-2"], wakeCommentId: "wake" }, {}, "batch-2"],
    [{ wakeCommentId: "wake", commentId: "context" }, {}, "wake"],
    [{ commentId: "context" }, { commentId: "payload" }, "context"],
    [{}, { commentId: "payload" }, "payload"],
    [{ wakeCommentId: "  " }, { commentId: "  " }, null],
  ])("derives comment ids by canonical precedence", (context, payload, expected) => {
    expect(deriveCommentId(context, payload)).toBe(expected);
  });

  it("allows interaction wakes only for an allowed reason with a comment id", () => {
    const allowed = new Set(["issue_commented"]);
    expect(allowsIssueInteractionWake({
      wakeReason: "issue_commented",
      wakeCommentId: "comment-1",
    }, allowed)).toBe(true);
    expect(allowsIssueInteractionWake({
      wakeReason: "timer",
      wakeCommentId: "comment-1",
    }, allowed)).toBe(false);
    expect(allowsIssueInteractionWake({ wakeReason: "issue_commented" }, allowed)).toBe(false);
  });

  it.each(["accepted", "answered", "cancelled", "rejected"])(
    "recognizes %s issue-comment interaction continuations",
    (interactionStatus) => {
      expect(isResolvedInteractionContinuationWakeContext({
        interactionId: "interaction-1",
        interactionStatus,
        mutation: "interaction",
        wakeReason: "issue_commented",
      })).toBe(true);
    },
  );

  it.each(["accepted", "answered", "cancelled", "rejected"])(
    "recognizes %s infrastructure continuations and rejects incomplete contexts",
    (interactionStatus) => {
      const base = { interactionId: "interaction-1", interactionStatus };
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        wakeReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({
        ...base,
        retryReason: "interaction_continuation_infra_retry",
      })).toBe(true);
      expect(isResolvedInteractionContinuationWakeContext({ ...base, interactionStatus: "pending" })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext({ interactionStatus })).toBe(false);
      expect(isResolvedInteractionContinuationWakeContext(null)).toBe(false);
    },
  );
});

describe("wake queue age", () => {
  // The measured failure this covers: a probe enqueued 2026-09-26T22:29:57.943Z
  // and dispatched at 2026-09-27T05:30:14.014Z after 17 dispatch decisions
  // passed over it, with the wake contract carrying nothing that said so.
  const STALE_WAIT = {
    enqueuedAt: new Date("2026-09-26T22:29:57.943Z"),
    startedAt: new Date("2026-09-27T05:30:14.014Z"),
  };

  it("reports the 7h00m16s wait and the fresher runs that went first", () => {
    expect(buildWakeQueueAge({ ...STALE_WAIT, skippedByDispatchCount: 17 })).toEqual({
      enqueuedAt: "2026-09-26T22:29:57.943Z",
      startedAt: "2026-09-27T05:30:14.014Z",
      queueAgeSeconds: 25216,
      skippedByDispatchCount: 17,
    });
  });

  it("accepts the row's own ISO strings as well as Date values", () => {
    expect(buildWakeQueueAge({
      enqueuedAt: "2026-09-26T22:29:57.943Z",
      startedAt: "2026-09-27T05:30:14.014Z",
      skippedByDispatchCount: 0,
    })).toMatchObject({ queueAgeSeconds: 25216, skippedByDispatchCount: 0 });
  });

  it("never advertises an age it cannot support", () => {
    for (const input of [
      { enqueuedAt: STALE_WAIT.enqueuedAt, startedAt: null },
      { enqueuedAt: null, startedAt: STALE_WAIT.startedAt },
      { enqueuedAt: undefined, startedAt: undefined },
      { enqueuedAt: "not-a-date", startedAt: STALE_WAIT.startedAt },
    ]) {
      expect(() => buildWakeQueueAge({ ...input, skippedByDispatchCount: 0 }))
        .toThrow("wake_queue_age_requires_both_timestamps");
    }
  });

  it("floors a clock skew that would report a negative wait", () => {
    expect(buildWakeQueueAge({
      enqueuedAt: new Date("2026-09-27T05:30:14.014Z"),
      startedAt: new Date("2026-09-27T05:29:57.943Z"),
      skippedByDispatchCount: 0,
    })).toMatchObject({ queueAgeSeconds: 0 });
  });

  it("normalizes a missing, negative, or non-numeric skip count to zero", () => {
    for (const skippedByDispatchCount of [null, undefined, 0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildWakeQueueAge({ ...STALE_WAIT, skippedByDispatchCount }).skippedByDispatchCount).toBe(0);
    }
    expect(buildWakeQueueAge({ ...STALE_WAIT, skippedByDispatchCount: 3.9 }).skippedByDispatchCount).toBe(3);
  });

  it("reads a stamped snapshot back and completes it with the issue's staleness", () => {
    const stamped = {
      [WAKE_QUEUE_AGE_KEY]: buildWakeQueueAge({ ...STALE_WAIT, skippedByDispatchCount: 17 }),
    };
    expect(readWakeQueueAge(stamped, new Date("2026-09-26T23:05:22.000Z"))).toEqual({
      enqueuedAt: "2026-09-26T22:29:57.943Z",
      startedAt: "2026-09-27T05:30:14.014Z",
      queueAgeSeconds: 25216,
      skippedByDispatchCount: 17,
      // The six sibling cancellations landed 6h30m before the dispatch.
      issueUpdatedAt: "2026-09-26T23:05:22.000Z",
      issueStaleSeconds: 23092,
    });
  });

  it("reports no issue staleness when the issue row is unknown", () => {
    const stamped = { [WAKE_QUEUE_AGE_KEY]: buildWakeQueueAge({ ...STALE_WAIT, skippedByDispatchCount: 0 }) };
    for (const issueUpdatedAt of [null, undefined, "not-a-date"]) {
      const read = readWakeQueueAge(stamped, issueUpdatedAt as null);
      expect(read).not.toBeNull();
      expect(read).not.toHaveProperty("issueStaleSeconds");
    }
  });

  it("does not report an issue touched after this run started as stale", () => {
    const stamped = { [WAKE_QUEUE_AGE_KEY]: buildWakeQueueAge({ ...STALE_WAIT, skippedByDispatchCount: 0 }) };
    expect(readWakeQueueAge(stamped, new Date("2026-09-27T09:00:00.000Z")))
      .toMatchObject({ issueStaleSeconds: 0 });
  });

  it("prefers the claim's pre-claim capture over a post-claim issue read", () => {
    // The claim's execution-binding write stamps `issues.updatedAt` with "now",
    // so every read site can only see a post-claim value. Letting that argument
    // win would report zero staleness for every run in the fleet, which is the
    // exact blindness this field exists to remove.
    const captured = "2026-09-26T23:05:22.000Z";
    const stamped = {
      [WAKE_QUEUE_AGE_KEY]: {
        ...buildWakeQueueAge({ ...STALE_WAIT, skippedByDispatchCount: 17 }),
        issueUpdatedAt: captured,
      },
    };
    const postClaimRead = new Date("2026-09-27T05:30:14.500Z");
    expect(readWakeQueueAge(stamped, postClaimRead)).toMatchObject({
      issueUpdatedAt: captured,
      issueStaleSeconds: 23092,
    });
    // The argument is still the fallback for a run with no capture at all.
    expect(readWakeQueueAge(
      { [WAKE_QUEUE_AGE_KEY]: buildWakeQueueAge({ ...STALE_WAIT, skippedByDispatchCount: 0 }) },
      new Date(captured),
    )).toMatchObject({ issueUpdatedAt: captured, issueStaleSeconds: 23092 });
  });

  it("lets a run that predates the field wake with no queue age at all", () => {
    for (const context of [
      null,
      undefined,
      {},
      { [WAKE_QUEUE_AGE_KEY]: null },
      { [WAKE_QUEUE_AGE_KEY]: "queued" },
      { [WAKE_QUEUE_AGE_KEY]: { enqueuedAt: "2026-09-26T22:29:57.943Z" } },
      { [WAKE_QUEUE_AGE_KEY]: { startedAt: "2026-09-27T05:30:14.014Z" } },
      { [WAKE_QUEUE_AGE_KEY]: { enqueuedAt: "", startedAt: "" } },
    ]) {
      expect(readWakeQueueAge(context, new Date("2026-09-26T23:05:22.000Z"))).toBeNull();
    }
  });

  it("recomputes the wait when a snapshot carries timestamps without a derived age", () => {
    expect(readWakeQueueAge({
      [WAKE_QUEUE_AGE_KEY]: {
        enqueuedAt: "2026-09-26T22:29:57.943Z",
        startedAt: "2026-09-27T05:30:14.014Z",
      },
    })).toMatchObject({ queueAgeSeconds: 25216, skippedByDispatchCount: 0 });
  });
});
