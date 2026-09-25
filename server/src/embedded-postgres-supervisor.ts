export type EmbeddedPostgresExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

/**
 * Why a managed PostgreSQL child exited without being an incident.
 *
 * `shutdown_requested`: this process already decided to shut down, so the exit
 * is the tail of our own teardown. This is also the reason used for an exit
 * that follows a stop this supervisor issued, because every stop path marks the
 * shutdown intent before it stops anything — see `markShutdownIntent`.
 */
export type EmbeddedPostgresControlledExitReason = "shutdown_requested";

export interface SupervisedEmbeddedPostgres {
  start(): Promise<void>;
  stop(): Promise<void>;
  process?: { once(event: "exit", listener: EmbeddedPostgresExitListener): unknown };
}

export interface EmbeddedPostgresSupervisor {
  current(): SupervisedEmbeddedPostgres;
  /**
   * Records that this process is going down, before any awaited teardown step
   * runs. The server must call this as the first statement of its signal
   * handler, because a systemd unit with `KillMode=control-group` SIGTERMs the
   * whole cgroup at once: PostgreSQL starts its smart shutdown immediately and
   * its `exit` event can land seconds before the handler reaches the teardown
   * that stops it. Without the early mark the supervisor reads that exit as a
   * crash, logs it at ERROR, and relaunches the database it is stopping.
   */
  markShutdownIntent(): void;
  shutdown(): Promise<void>;
  waitForRecovery(): Promise<void>;
}

type Options = {
  initialInstance: SupervisedEmbeddedPostgres;
  createInstance: () => SupervisedEmbeddedPostgres;
  beforeRestart?: (attempt: number) => Promise<void> | void;
  restartDelaysMs?: number[];
  delay?: (milliseconds: number) => Promise<void>;
  onUnexpectedExit?: EmbeddedPostgresExitListener;
  /**
   * Reports an exit that this process caused on purpose, so the caller can log
   * a controlled shutdown instead of the "exited unexpectedly" incident line.
   * Fires for every exit that is not handed to recovery.
   */
  onControlledExit?: (reason: EmbeddedPostgresControlledExitReason, code: number | null, signal: NodeJS.Signals | null) => void;
  onRestartAttemptFailed?: (error: unknown, attempt: number) => void;
  onRestarted?: (attempt: number) => void;
  onRecoveryExhausted?: (error: unknown) => void;
};

const defaultDelay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function createEmbeddedPostgresSupervisor(options: Options): EmbeddedPostgresSupervisor {
  const restartDelaysMs = options.restartDelaysMs ?? [0, 250, 1_000];
  const wait = options.delay ?? defaultDelay;
  let activeInstance = options.initialInstance;
  let activeInstanceExited = false;
  // Set as early as the signal handler can reach us, and deliberately separate
  // from `shutdownStarted`: the intent mark must never cancel the teardown.
  let shutdownIntent = false;
  let shutdownStarted = false;
  let recoveryPromise: Promise<void> | null = null;

  const recover = async () => {
    let lastError: unknown = new Error("Embedded PostgreSQL exited unexpectedly");
    for (let index = 0; index < restartDelaysMs.length; index += 1) {
      if (shutdownIntent) return;
      const attempt = index + 1;
      const delayMs = restartDelaysMs[index] ?? 0;
      if (delayMs > 0) await wait(delayMs);
      if (shutdownIntent) return;
      try {
        await options.beforeRestart?.(attempt);
        const replacement = options.createInstance();
        await replacement.start();
        if (shutdownIntent) {
          await replacement.stop();
          return;
        }
        activeInstance = replacement;
        activeInstanceExited = false;
        monitor(replacement);
        options.onRestarted?.(attempt);
        return;
      } catch (error) {
        lastError = error;
        options.onRestartAttemptFailed?.(error, attempt);
      }
    }
    if (!shutdownIntent) options.onRecoveryExhausted?.(lastError);
  };

  const monitor = (instance: SupervisedEmbeddedPostgres) => {
    const child = instance.process;
    if (!child) {
      options.onRecoveryExhausted?.(new Error("Embedded PostgreSQL started without a child process to monitor"));
      return;
    }
    child.once("exit", (code, signal) => {
      if (activeInstance !== instance) return;
      activeInstanceExited = true;
      // Once this process has recorded shutdown intent, every later exit is the
      // tail of our own teardown — including the cgroup SIGTERM, which can land
      // before any local `stop()` call is made. Reporting it as an incident
      // would log "exited unexpectedly" at ERROR and relaunch the database this
      // process is stopping, so it is reported as a controlled exit instead.
      //
      // This is also why there is no separate "we asked this instance to stop"
      // check: `shutdown()` marks the intent before it stops anything, so every
      // stop this supervisor performs is already covered by the branch above.
      if (shutdownIntent) {
        options.onControlledExit?.("shutdown_requested", code, signal);
        return;
      }
      options.onUnexpectedExit?.(code, signal);
      recoveryPromise = recover().finally(() => { recoveryPromise = null; });
    });
  };

  monitor(activeInstance);
  return {
    current: () => activeInstance,
    markShutdownIntent: () => { shutdownIntent = true; },
    waitForRecovery: async () => { await recoveryPromise; },
    shutdown: async () => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      shutdownIntent = true;
      await recoveryPromise;
      if (!activeInstanceExited) await activeInstance.stop();
    },
  };
}
