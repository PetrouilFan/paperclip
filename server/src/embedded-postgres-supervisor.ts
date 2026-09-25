export type EmbeddedPostgresExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

/**
 * Why a managed PostgreSQL child exited without being an incident.
 *
 * - `shutdown_requested`: this process already decided to shut down, so the
 *   exit is the tail of our own teardown.
 * - `requested_stop`: we asked this specific instance to stop and it exited
 *   cleanly, so the exit is the documented result of that request.
 */
export type EmbeddedPostgresControlledExitReason = "shutdown_requested" | "requested_stop";

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

/** A process that ran to completion and was not killed reports `code=0` with no
 * signal. PostgreSQL uses exactly that shape for a requested fast/smart
 * shutdown, so this pair means "it stopped" rather than "it broke". */
const exitedCleanly = (code: number | null, signal: NodeJS.Signals | null) => code === 0 && signal === null;

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
  // Instances this supervisor asked to stop, so a clean exit that arrives after
  // a local `stop()` is recognised even when no global shutdown is under way.
  const instancesRequestedToStop = new Set<SupervisedEmbeddedPostgres>();

  const stopInstance = async (instance: SupervisedEmbeddedPostgres) => {
    instancesRequestedToStop.add(instance);
    await instance.stop();
  };

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
          await stopInstance(replacement);
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
      // An exit we asked for is not an incident, so it never reaches recovery.
      // A shutdown we initiated outranks the instance-level check because a
      // cgroup kill arrives before any local `stop()` call can be made.
      if (shutdownIntent) {
        options.onControlledExit?.("shutdown_requested", code, signal);
        return;
      }
      if (instancesRequestedToStop.has(instance) && exitedCleanly(code, signal)) {
        options.onControlledExit?.("requested_stop", code, signal);
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
      if (!activeInstanceExited) await stopInstance(activeInstance);
    },
  };
}
