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
 * predicate only excludes runs that have sat unclaimed past that window.
 *
 * The window is measured, not guessed. Recipe, reproducible in one request against
 * the reporting instance: `GET /api/companies/{companyId}/heartbeat-runs`, keep the
 * rows carrying both `createdAt` and `startedAt`, and difference the two. Over the
 * 2645 such runs on 2026-09-26 the queue wait `startedAt - createdAt` is 0.04 s at
 * p50 and 370 s at p90, but the tail is long: 4059 s at p99 and 25531 s (7.09 h) at
 * the observed maximum. A one-hour window -- the obvious choice, and the value this
 * constant originally shipped with -- would have cancelled 33 of those 2645 runs
 * (1.25%), every one of which went on to start normally, and each of which had an
 * issue execution lock bound to it. That is real work destroyed to fix a rarer
 * fault, so the window is set above the observed maximum with margin: 12 h clears
 * the 7.09 h maximum with ~69% headroom and produced zero false positives over the
 * sample. 8 h would also have produced zero, but with only 12.8% headroom, so it is
 * not a margin anyone should trust.
 *
 * The cost of the conservative window is a slower un-strand: an issue locked by a
 * stranded run stays locked for up to `NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS`
 * after the fault, rather than being cleared within the hour. That is a bounded,
 * measured delay bought against destroying running work, and the motivating case
 * is not delayed by it: the run behind the original report sat unclaimed for
 * 17.5 h, so a 12 h window still clears it. Recovering faster means giving the
 * dispatch attempt priority over the age-out -- `resumeQueuedRuns` currently ages
 * a run out and only afterwards re-drives every queued run, so a
 * slow-but-dispatchable run is cancelled before the sweep ever offers it a slot.
 * Reordering those two blocks would let the sweep dispatch first and reserve the
 * age-out for runs the attempt could not start, which is evidence rather than age.
 * Tracked separately; it changes sweep ordering and its tests, so it does not
 * belong in this fix. Safety wins here: this constant must never cancel a run that
 * would have run.
 */
export const NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS = 12 * 60 * 60 * 1000;

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
