import { and, eq, isNull, lte, not } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

/**
 * A `queued` heartbeat run with `startedAt IS NULL` has not been claimed by the
 * dispatcher. Dispatch is edge-triggered: `startNextQueuedRunForAgent` runs when a
 * run is queued, when a run finishes, and on the periodic resume sweep. A run
 * whose edge was dropped therefore sits in `queued` with nothing writing to it,
 * and because it is still `queued` it also still satisfies every "does this issue
 * have a live execution path" test.
 *
 * That combination is self-sealing. The stranded run reads as the live path, so
 * stranded-issue recovery concludes the issue is covered and never re-queues; and
 * a fresh recovery run cannot claim the issue while `issues.executionRunId` still
 * points at the stranded run. The issue is then left with no write surface, and
 * the only escape is a board-only force release.
 *
 * `queued` is still a legitimate live path for a bounded admission window, so this
 * predicate only excludes runs that have sat unclaimed past that window. One hour
 * matches `ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS`; measured queue drain on the
 * reporting deployment is well under two minutes, so the window is deliberately far
 * longer than normal contention.
 */
export const NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS = 60 * 60 * 1000;

/** `createdAt` at or before which an unclaimed `queued` run counts as stranded. */
export function neverDispatchedRunCutoff(
  now: Date = new Date(),
  windowMs: number = NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS,
): Date {
  return new Date(now.getTime() - windowMs);
}

/** In-memory form of {@link neverDispatchedQueuedRun}, for row-by-row sweeps. */
export function isNeverDispatchedQueuedRun(
  run: { status: string; startedAt: Date | null; createdAt: Date },
  now: Date = new Date(),
  windowMs: number = NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS,
): boolean {
  return (
    run.status === "queued" &&
    run.startedAt === null &&
    run.createdAt.getTime() <= neverDispatchedRunCutoff(now, windowMs).getTime()
  );
}

/**
 * Drizzle condition matching stranded rows. Use it in the age-out sweep's
 * `where` clause.
 */
export function neverDispatchedQueuedRun(
  now: Date = new Date(),
  windowMs: number = NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS,
) {
  return and(
    eq(heartbeatRuns.status, "queued"),
    isNull(heartbeatRuns.startedAt),
    lte(heartbeatRuns.createdAt, neverDispatchedRunCutoff(now, windowMs)),
  );
}

/**
 * The negation of {@link neverDispatchedQueuedRun}, for the
 * `hasActiveExecutionPath` / `hasExistingExecutionPath` queries. Those select on
 * `EXECUTION_PATH_HEARTBEAT_RUN_STATUSES`, which includes `queued`; adding this
 * clause keeps a stranded run from satisfying them, so the predicate lives in one
 * place for every caller instead of being re-derived per query.
 *
 * Built from Drizzle's own comparators rather than a raw `sql` template so the
 * `created_at` bound parameter is encoded as a timestamp. A raw template binds
 * the `Date` straight to the driver, which rejects it.
 */
export function notNeverDispatchedQueuedRun(
  now: Date = new Date(),
  windowMs: number = NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS,
) {
  // `and` is typed `| undefined` because it drops empty argument lists. All three
  // clauses are always present, so the narrowing here is not a guess.
  return not(
    and(
      eq(heartbeatRuns.status, "queued"),
      isNull(heartbeatRuns.startedAt),
      lte(heartbeatRuns.createdAt, neverDispatchedRunCutoff(now, windowMs)),
    )!,
  );
}
