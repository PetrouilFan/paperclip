type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

type ShutdownLogger = {
  info(obj: object, msg: string): void;
  /**
   * A truncated drain. Deliberately not `info`: a drain that gave up is the
   * difference between an orderly stop and a wedged one, and it is the only
   * line that records which sweeps or runs were still holding the unit.
   */
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export async function drainRunExecutionFinalizersForShutdown(input: {
  signal: "SIGINT" | "SIGTERM";
  drain: (() => Promise<void>) | null;
  timeoutMs?: number;
  log: ShutdownLogger;
}): Promise<"drained" | "timed_out" | "unavailable"> {
  if (!input.drain) return "unavailable";
  const timeoutMs = input.timeoutMs ?? 5_000;
  let timer: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      input.drain().then(() => "drained" as const),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (result === "timed_out") {
      input.log.warn(
        { signal: input.signal, timeoutMs },
        "bounded heartbeat execution finalizer drain timed out",
      );
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ShutdownHttpListener = {
  listening: boolean;
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

/**
 * Stops the HTTP listener from accepting new requests and waits, for at most
 * `timeoutMs`, for the open connections to finish. Idle keep-alive sockets
 * close at once; whatever is still open when the grace period ends is closed
 * forcibly, so the teardown never hangs on a long-lived client. Call this
 * before the database pool ends, so no request can reach a route after
 * `sql.end()` and fail with a connection-ended error.
 */
export async function closeHttpListenerForShutdown(input: {
  server: ShutdownHttpListener;
  signal: "SIGINT" | "SIGTERM";
  timeoutMs?: number;
  log: ShutdownLogger;
}): Promise<"closed" | "timed_out" | "not_listening"> {
  if (!input.server.listening) return "not_listening";
  const timeoutMs = input.timeoutMs ?? 5_000;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      new Promise<"closed">((resolve) => {
        input.server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            input.log.error({ err, signal: input.signal }, "HTTP listener close failed");
          }
          resolve("closed");
        });
        input.server.closeIdleConnections?.();
      }),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => {
          input.log.info(
            { signal: input.signal, timeoutMs },
            "HTTP listener drain timed out; closing the remaining connections",
          );
          input.server.closeAllConnections?.();
          resolve("timed_out");
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs the final, ordered teardown of the server. It awaits the application
 * service cleanup first, so a live setup-token login session stops and releases
 * its sandbox lease before the database and the provider stop. The caller runs
 * `process.exit(0)` only after this helper resolves, so an orderly shutdown
 * never leaves a sandbox lease or confidential login state alive past the
 * process exit.
 *
 * A step that rejects does not stop the teardown. The helper logs the error and
 * continues to the next step. A failed setup-token lease release stays a
 * durable record for the startup reaper; the helper surfaces it in the log
 * instead of blocking the exit path.
 */
export async function finalizeServerShutdown(input: {
  signal: "SIGINT" | "SIGTERM";
  shutdownAppServices: (() => Promise<void>) | undefined;
  /**
   * Stops the HTTP listener and drains its connections (see
   * `closeHttpListenerForShutdown`). Runs first, while every application
   * service is still available to the requests being drained, so no request
   * runs against a half-dismantled service or an ended pool.
   */
  closeHttpListener?: (() => Promise<unknown>) | null;
  /**
   * Waits for every run-failure Sentry report still in flight. Runs after the
   * application services and before the database pool ends, so a report that
   * started just before shutdown still gets its database read and reaches
   * Sentry before `shutdownSentry` flushes and closes the client.
   */
  drainPendingRunFailureReports?: (() => Promise<void>) | null;
  /**
   * Ends the server's PostgreSQL client pools. Runs after the application
   * services (which still need the database) and before the embedded
   * provider stops, so the backends close in order and none outlive the
   * process.
   */
  closeDatabase?: (() => Promise<void>) | null;
  stopEmbeddedPostgres: (() => Promise<void>) | null;
  shutdownInstrumentation: () => Promise<void>;
  shutdownSentry: () => Promise<void>;
  log: ShutdownLogger;
}): Promise<void> {
  const { signal } = input;

  // Stop accepting requests and drain the open ones before any service goes
  // away, so a request that is still in flight sees a fully working server.
  if (input.closeHttpListener) {
    try {
      await input.closeHttpListener();
    } catch (err) {
      input.log.error({ err, signal }, "HTTP listener shutdown failed");
    }
  }

  // Await the application service cleanup, so a live setup-token login session
  // releases its sandbox lease before the database and the provider stop. A
  // rejected cleanup stays durable for the reaper; it does not block the exit.
  try {
    await input.shutdownAppServices?.();
  } catch (err) {
    input.log.error({ err, signal }, "Application service shutdown failed");
  }

  // Wait for every in-flight run-failure Sentry report before the database
  // pool ends. `reportRunFailure` is fire-and-forget: without this wait, a
  // report that started just before shutdown can lose its database read to
  // the pool end below, or lose its Sentry call to the flush further down.
  if (input.drainPendingRunFailureReports) {
    try {
      await input.drainPendingRunFailureReports();
    } catch (err) {
      input.log.error({ err, signal }, "run-failure report drain failed");
    }
  }

  // End the client pools once nothing needs them any more. Without this the
  // process exit leaves the pooled backends to PostgreSQL's own TCP keepalive
  // reaping, and a restart loop can pile up enough of them to hit
  // `max_connections` before the next boot gets a connection.
  if (input.closeDatabase) {
    try {
      await input.closeDatabase();
    } catch (err) {
      input.log.error({ err, signal }, "Database client shutdown failed");
    }
  }

  if (input.stopEmbeddedPostgres) {
    input.log.info({ signal }, "Stopping embedded PostgreSQL");
    try {
      await input.stopEmbeddedPostgres();
    } catch (err) {
      input.log.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
    }
  }

  // Flush buffered OTel spans before the process goes away; without this await
  // the exporter's final batch is dropped on exit.
  await input.shutdownInstrumentation();

  // Flush buffered Sentry events before the process goes away; without this
  // await the last events are dropped on exit.
  await input.shutdownSentry();
}

const COORDINATED_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * The wall-clock budget systemd gives this process to stop, in milliseconds.
 *
 * This mirrors `TimeoutStopSec=300` in the unit rendered by
 * `cli/src/services/service-manager.ts`. It is a mirror, not a channel: the unit
 * is not readable from here, and a server that read the wrong number would be
 * worse than one that reads a stale one. What keeps the two honest is
 * `server/src/__tests__/shutdown-stop-budget.test.ts`, which parses the rendered
 * unit and fails if the drain budget is no longer strictly below it. Lowering
 * `TimeoutStopSec` without lowering this is a test failure, not a silent wedge.
 *
 * The number is load-bearing in the other direction too, which is why
 * `TimeoutStopSec` must not be reduced on its own: the graceful run drain waits
 * for an in-flight agent run, and `adapter_config.timeoutSec` is 3600 on every
 * `opencode_local` agent, raised from 1800 to 3600 on all eight of them. A drain
 * that can wait an hour inside a five-minute stop budget is not a drain, it is a
 * guaranteed cgroup-wide
 * SIGKILL — and it is guaranteed whether or not any of the bugs fixed here are
 * reachable. That is the arithmetic `resolveHeartbeatDrainBudgetMs` exists to
 * close.
 */
export const SHUTDOWN_STOP_BUDGET_MS = 300_000;

/**
 * What the stop budget keeps back for everything that is not the run drain:
 * the notify, the scheduler idle wait, the HTTP listener close, the database
 * pool end, the embedded postmaster stop, and the OTel/Sentry flushes. A stop
 * that spends all 300 s on the drain has no budget left for any of them, and
 * `finalizeServerShutdown` is the code that has to run before `process.exit(0)`.
 */
export const SHUTDOWN_STOP_RESERVE_MS = 60_000;

/**
 * The scheduler idle wait's own ceiling, taken out of the reserve rather than
 * added on top of it, so the two bounded waits still sum to less than the stop
 * budget. Ten seconds is far above a real drain: the six execution-control
 * sweeps are single-flight DB queries, and the wait only has to let an
 * already-running one commit before the run snapshot is taken. It exists to
 * bound a query that never returns, not to be generous.
 */
export const SHUTDOWN_SCHEDULER_IDLE_TIMEOUT_MS = 10_000;

/**
 * The graceful run drain's deadline: the stop budget minus the reserve.
 *
 * Strictly less than `SHUTDOWN_STOP_BUDGET_MS` by construction, and asserted to
 * be so in `shutdown-stop-budget.test.ts` against the *rendered unit* rather
 * than against this file. A run that cannot drain inside it is abandoned; the
 * caller flushes `flushInFlightRunLogMirrors()` immediately afterwards, which is
 * what keeps an abandoned run's output from being lost with the process.
 */
export function resolveHeartbeatDrainBudgetMs(options: {
  stopBudgetMs?: number;
  reserveMs?: number;
} = {}): number {
  const stopBudgetMs = options.stopBudgetMs ?? SHUTDOWN_STOP_BUDGET_MS;
  const reserveMs = options.reserveMs ?? SHUTDOWN_STOP_RESERVE_MS;
  const budget = stopBudgetMs - reserveMs;
  if (budget <= 0) {
    throw new Error(
      `heartbeat drain budget must be positive: stopBudgetMs=${stopBudgetMs} reserveMs=${reserveMs}`,
    );
  }
  return budget;
}

/**
 * Wait for tracked scheduler work, but never longer than `timeoutMs`.
 *
 * This replaces the deadline-free `while (inFlight.size > 0) await
 * Promise.allSettled(...)` loop. That loop is a hang, not a wait: the tracked
 * work is six DB-backed execution-control sweeps plus the environment, GitHub
 * and tool-continuity sweeps, and nothing in a shutdown can force a query that
 * is already in flight on a dying database to return. The loop is also
 * unbounded in *iterations*, because a sweep that settles can immediately hand
 * the set a new tracked promise before the size is read again.
 *
 * What is given up is named, not swallowed. `tracked` maps a still-pending
 * promise to the label of the scheduler tick that started it, so the timeout
 * line is the only record anyone ever gets that a drain was truncated and which
 * sweeps were still holding it. Without the labels the log could say "timed
 * out" and leave the operator to guess between six sweeps and a dozen.
 */
export async function waitForTrackedSchedulerWork(input: {
  tracked: Map<string, Promise<void>>;
  timeoutMs: number;
  signal: "SIGINT" | "SIGTERM";
  log: ShutdownLogger;
}): Promise<{ idled: boolean; abandoned: string[] }> {
  if (input.tracked.size === 0) return { idled: true, abandoned: [] };
  let timer: NodeJS.Timeout | null = null;
  const pending = [...input.tracked.values()];
  try {
    const result = await Promise.race([
      Promise.allSettled(pending).then(() => "idled" as const),
      // Deliberately not `unref`'d. An unreferenced deadline is skipped
      // entirely whenever the event loop would otherwise be empty, which is
      // precisely when a drain that depends on nothing else is most likely to be
      // the thing still holding the process. A deadline that can be skipped is
      // not a deadline.
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), input.timeoutMs);
      }),
    ]);
    if (result === "timed_out") {
      // Read the live set rather than the snapshot: a label that started after
      // the race was armed is also work this wait gave up on.
      const abandoned = [...input.tracked.keys()];
      input.log.warn(
        {
          signal: input.signal,
          timeoutMs: input.timeoutMs,
          abandonedSweeps: abandoned,
          abandonedCount: abandoned.length,
        },
        "heartbeat scheduler drain timed out; continuing shutdown without quiescing the remaining sweeps",
      );
      return { idled: false, abandoned };
    }
    return { idled: true, abandoned: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run a drain with a deadline, and report whether it finished.
 *
 * A drain that is still pending when the deadline arrives is abandoned, not
 * awaited. The caller is already inside a stop budget it cannot extend, and a
 * `TimeoutStopSec` SIGKILL is strictly worse than an abandoned run: it takes
 * the database, every other run in the cgroup, and the unit's own clean-exit
 * record with it. An abandoned run leaves its rows in `running` for the reaper,
 * which is the same place a SIGKILLed run leaves them, and its output reaches
 * the run log through the in-flight mirror flush that follows.
 */
export async function drainWithDeadline<T>(input: {
  drain: (() => Promise<T>) | null;
  timeoutMs: number;
  signal: "SIGINT" | "SIGTERM";
  log: ShutdownLogger;
  timedOutMessage: string;
}): Promise<{ outcome: "drained" | "timed_out" | "unavailable"; value?: T }> {
  if (!input.drain) return { outcome: "unavailable" };
  let timer: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      input.drain().then(
        (value) => ({ outcome: "drained" as const, value }),
        (err: unknown) => ({ outcome: "drained" as const, value: undefined, err }),
      ),
      // Not `unref`'d, for the same reason as the scheduler idle wait above.
      new Promise<{ outcome: "timed_out" }>((resolve) => {
        timer = setTimeout(() => resolve({ outcome: "timed_out" }), input.timeoutMs);
      }),
    ]);
    if (result.outcome === "timed_out") {
      input.log.warn(
        { signal: input.signal, timeoutMs: input.timeoutMs },
        input.timedOutMessage,
      );
    } else if ("err" in result) {
      throw result.err;
    }
    return result as { outcome: "drained" | "timed_out"; value?: T };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ShutdownSignalTarget = {
  rawListeners(eventName: string): Function[];
  removeListener(eventName: string, listener: (...args: any[]) => void): unknown;
};

/**
 * Some dependencies eagerly install process signal handlers as an import side
 * effect. Paperclip must remain the sole owner of SIGINT/SIGTERM ordering: its
 * handler first snapshots live heartbeat runs and only then stops embedded
 * infrastructure. Remove only listeners added by the supplied import, while
 * preserving every listener that was already registered.
 */
export async function loadWithoutCoordinatedShutdownSignalHooks<T>(
  load: () => Promise<T>,
  signalTarget: ShutdownSignalTarget = process,
) {
  const listenersBeforeLoad = new Map(
    COORDINATED_SHUTDOWN_SIGNALS.map((signal) => [
      signal,
      signalTarget.rawListeners(signal),
    ]),
  );

  let loaded: T;
  try {
    loaded = await load();
  } finally {
    for (const signal of COORDINATED_SHUTDOWN_SIGNALS) {
      const remainingBeforeLoad = [...(listenersBeforeLoad.get(signal) ?? [])];
      for (const listener of signalTarget.rawListeners(signal)) {
        const existingIndex = remainingBeforeLoad.indexOf(listener);
        if (existingIndex >= 0) {
          remainingBeforeLoad.splice(existingIndex, 1);
          continue;
        }
        signalTarget.removeListener(signal, listener as (...args: any[]) => void);
      }
    }
  }

  return loaded;
}

/**
 * The backstop's own deadline: the two bounded waits in front of the ordered
 * teardown, plus the reserve.
 *
 * It has to be *larger* than the waits it is guarding. A watchdog armed at the
 * run-drain budget would fire while a legitimate run drain was still counting
 * down, turning a slow stop into the exact cgroup SIGKILL it exists to prevent —
 * so the sum, not either term, is the number. It is still strictly inside the
 * stop budget, which is what makes the exit it produces this process's own clean
 * `exit(0)` rather than systemd's timeout kill.
 */
export function resolveShutdownWatchdogMs(options: {
  stopBudgetMs?: number;
  reserveMs?: number;
} = {}): number {
  return SHUTDOWN_SCHEDULER_IDLE_TIMEOUT_MS + resolveHeartbeatDrainBudgetMs(options);
}

/**
 * The last-resort guarantee that a stop ends.
 *
 * `shutdown()` is `void`-ed from the signal handler, so nothing observes its
 * promise: a rejection, or a step that never settles, means the process stays
 * alive with a stopping unit until `TimeoutStopSec` expires and systemd
 * SIGKILLs the cgroup. That is the wedge in
 * the 2026-09-27 control-plane stops, and the bounded waits above remove the
 * three awaits that were reachable. This is the
 * backstop for the ones that are not known, and for the next one that gets
 * added.
 *
 * The timer is deliberately not `unref`'d. An unreferenced timer is skipped
 * whenever the event loop would otherwise be empty, which is exactly the state a
 * process is in once the HTTP listener has closed and only the teardown is left —
 * so an `unref`'d watchdog is a watchdog that stops watching at the moment it
 * starts to matter. `clearShutdownWatchdog()` is called on the normal path,
 * which is what makes this a backstop and not a policy.
 */
export function startShutdownExitWatchdog(input: {
  signal: "SIGINT" | "SIGTERM";
  timeoutMs?: number;
  log: ShutdownLogger;
  exit: (code: number) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}): () => void {
  const timeoutMs = input.timeoutMs ?? resolveShutdownWatchdogMs();
  const handle = input.setTimer(() => {
    input.log.error(
      { signal: input.signal, timeoutMs },
      "shutdown did not complete inside its budget; exiting anyway rather than waiting for TimeoutStopSec",
    );
    input.exit(0);
  }, timeoutMs);
  return () => input.clearTimer(handle);
}

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: "SIGINT" | "SIGTERM";
  prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<{ idled: boolean; abandoned: string[] } | void>;
  log?: ShutdownLogger;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
  abandonedSchedulerSweeps: string[];
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;
  let abandonedSchedulerSweeps: string[] = [];

  // The signal handler stops the scheduler before entering this coordinator.
  // Quiesce any callback that was already in flight before querying running
  // rows for the shutdown snapshot, otherwise a late queue claim can create a
  // run that is absent from both the snapshot and the selective drain set.
  //
  // A wait that gives up is reported, not thrown. The snapshot is still taken:
  // a run created by a sweep that was still holding the process is a run the
  // reaper picks up, which is the same outcome as a run created a millisecond
  // later, and refusing to snapshot at all would leave every run in the table
  // untouched by a stop that did happen.
  const idle = await input.waitForHeartbeatSchedulerIdle();
  if (idle && idle.idled === false) {
    abandonedSchedulerSweeps = idle.abandoned;
    input.log?.warn(
      { signal: input.signal, abandonedSchedulerSweeps: abandonedSchedulerSweeps },
      "continuing shutdown with execution-control sweeps still in flight",
    );
  }

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle: true,
    abandonedSchedulerSweeps,
  };
}
