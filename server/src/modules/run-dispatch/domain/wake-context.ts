// Shared wake-reason and retry-reason constants, and the pure classifiers
// that read them off a run's context snapshot. `heartbeat.ts` and this
// module's own Postgres adapter both decide on the same context snapshot
// shape, so this file is their one shared source for it: a second,
// independently maintained copy in either file could silently drift out of
// sync with the other and change only one of the two gates that read it.

import type { ExecutionContinuationQueueAge } from "@paperclipai/shared";

function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export const MAX_TURN_CONTINUATION_RETRY_REASON = "max_turns_continuation";
export const WORKSPACE_BUSY_RETRY_REASON = "workspace_busy";
export const AI_CONNECTION_BUSY_RETRY_REASON = "ai_connection_busy";
export const INTERACTION_CONTINUATION_INFRA_RETRY_REASON = "interaction_continuation_infra_retry";
export const INTERACTION_CONTINUATION_INFRA_WAKE_REASON = "interaction_continuation_infra_retry";
export const WAKE_COMMENT_IDS_KEY = "wakeCommentIds";
/**
 * Context-snapshot key holding this run's queue-age facts. The snapshot is
 * already the per-run wake envelope that is persisted on the run row, so this is
 * where the enqueue timestamp lives between claim and dispatch.
 */
export const WAKE_QUEUE_AGE_KEY = "wakeQueueAge";
export const RESOLVED_INTERACTION_CONTINUATION_STATUSES = new Set([
  "accepted",
  "answered",
  "cancelled",
  "rejected",
]);

function readTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  const text = readNonEmptyString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

export type WakeQueueAgeInput = {
  /** `heartbeat_runs.createdAt`: when the run entered the dispatch queue. */
  enqueuedAt: Date | string | null | undefined;
  /** `heartbeat_runs.startedAt`: when the dispatcher claimed the run. */
  startedAt: Date | string | null | undefined;
  /** `heartbeat_runs.dispatchSkipCount`. */
  skippedByDispatchCount: number | null | undefined;
};

/**
 * Derives the queue-age facts a woken agent needs to tell a fresh assignment
 * from one that waited. Throws unless both ends of the wait are known: this runs
 * on the claim path, where a run row without both timestamps is a defect rather
 * than a normal state, and silently stamping a partial age would advertise a
 * wait the run did not experience. Reads of an already-stamped snapshot go
 * through `readWakeQueueAge`, which tolerates absence.
 *
 * The wait is measured enqueue to start, not enqueue to now: `now` would report
 * the age of the run row rather than the age the agent experienced, and it would
 * keep growing after dispatch.
 */
export function buildWakeQueueAge(
  input: WakeQueueAgeInput,
): ExecutionContinuationQueueAge {
  const enqueuedAtMs = readTimestampMs(input.enqueuedAt);
  const startedAtMs = readTimestampMs(input.startedAt);
  if (enqueuedAtMs === null || startedAtMs === null) {
    throw new Error("wake_queue_age_requires_both_timestamps");
  }
  return {
    enqueuedAt: toIso(enqueuedAtMs),
    startedAt: toIso(startedAtMs),
    queueAgeSeconds: Math.max(0, Math.round((startedAtMs - enqueuedAtMs) / 1000)),
    skippedByDispatchCount:
      typeof input.skippedByDispatchCount === "number" &&
      Number.isFinite(input.skippedByDispatchCount) &&
      input.skippedByDispatchCount > 0
        ? Math.floor(input.skippedByDispatchCount)
        : 0,
  };
}

/**
 * Reads back a stamped queue age, optionally completed with the bound issue's
 * own staleness. The claim path captures the pre-claim `issues.updatedAt` into
 * the snapshot, because the claim's own execution-binding write immediately
 * stamps that column with "now" — so the `issueUpdatedAt` argument, which every
 * read site can only obtain *after* the claim, would report zero staleness for
 * every run. The captured value therefore wins when present and the argument is
 * only a fallback for a run that predates the field.
 *
 * Returns null for an unstamped or malformed value rather than throwing: a run
 * that predates this field must still wake.
 */
export function readWakeQueueAge(
  contextSnapshot: unknown,
  issueUpdatedAt?: Date | string | null,
): ExecutionContinuationQueueAge | null {
  const value = parseObject(parseObject(contextSnapshot)[WAKE_QUEUE_AGE_KEY]);
  const enqueuedAt = readNonEmptyString(value.enqueuedAt);
  const startedAt = readNonEmptyString(value.startedAt);
  if (!enqueuedAt || !startedAt) return null;
  const startedAtMs = readTimestampMs(startedAt);
  const issueUpdatedAtMs =
    readTimestampMs(value.issueUpdatedAt) ?? readTimestampMs(issueUpdatedAt);
  return {
    enqueuedAt,
    startedAt,
    queueAgeSeconds:
      typeof value.queueAgeSeconds === "number" && Number.isFinite(value.queueAgeSeconds)
        ? value.queueAgeSeconds
        : Math.max(
            0,
            Math.round(
              ((startedAtMs as number) - (readTimestampMs(enqueuedAt) as number)) / 1000,
            ),
          ),
    skippedByDispatchCount:
      typeof value.skippedByDispatchCount === "number" &&
      Number.isFinite(value.skippedByDispatchCount) &&
      value.skippedByDispatchCount > 0
        ? Math.floor(value.skippedByDispatchCount)
        : 0,
    ...(issueUpdatedAtMs === null
      ? {}
      : {
          issueUpdatedAt: toIso(issueUpdatedAtMs),
          // Floored: an issue touched after this run started is not stale
          // evidence, it is just a newer state the agent has not read yet.
          issueStaleSeconds: Math.max(
            0,
            Math.round(((startedAtMs as number) - issueUpdatedAtMs) / 1000),
          ),
        }),
  };
}

/**
 * True for a resource-wait retry whose original run did not
 * execute under assignee-ship (a comment or review-participant wake). Such a
 * retry has an expected assignee mismatch, so the scheduled-retry gate and
 * the queued-run staleness check must not treat it as a reassignment.
 */
export function isNonAssigneeWorkspaceBusyRetry(
  retryReason: string | null | undefined,
  contextSnapshot: Record<string, unknown>,
): boolean {
  return (
    (retryReason === WORKSPACE_BUSY_RETRY_REASON &&
      contextSnapshot.workspaceBusyDeferredWhileAssignee === false) ||
    (retryReason === AI_CONNECTION_BUSY_RETRY_REASON &&
      contextSnapshot.aiConnectionBusyDeferredWhileAssignee === false)
  );
}

export function extractWakeCommentIds(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string[] {
  const raw = contextSnapshot?.[WAKE_COMMENT_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = readNonEmptyString(entry);
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

export function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload?: Record<string, unknown> | null,
): string | null {
  const batchedCommentId = extractWakeCommentIds(contextSnapshot).at(-1);
  return (
    batchedCommentId ??
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

/**
 * `allowedWakeReasons` is the issue-tree-control module's own set of wake
 * reasons that excuse an interaction wake. This file stays free of service
 * imports, so the caller passes the set in rather than this function reading
 * it from the service directly.
 */
export function allowsIssueInteractionWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
  allowedWakeReasons: ReadonlySet<string>,
): boolean {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (!wakeReason || !allowedWakeReasons.has(wakeReason)) return false;
  return Boolean(deriveCommentId(contextSnapshot));
}

export function isResolvedInteractionContinuationWakeContext(contextSnapshot: unknown): boolean {
  const context = parseObject(contextSnapshot);
  const interactionId = readNonEmptyString(context.interactionId);
  const interactionStatus = readNonEmptyString(context.interactionStatus);
  if (!interactionId || !interactionStatus) return false;
  if (!RESOLVED_INTERACTION_CONTINUATION_STATUSES.has(interactionStatus)) return false;

  const mutation = readNonEmptyString(context.mutation);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const retryReason = readNonEmptyString(context.retryReason);
  return (
    (mutation === "interaction" && wakeReason === "issue_commented") ||
    wakeReason === INTERACTION_CONTINUATION_INFRA_WAKE_REASON ||
    retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
  );
}
