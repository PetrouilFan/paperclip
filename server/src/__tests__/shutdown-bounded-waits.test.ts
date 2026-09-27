import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  coordinateHeartbeatSchedulerShutdown,
  drainWithDeadline,
  startShutdownExitWatchdog,
  waitForTrackedSchedulerWork,
} from "../shutdown.js";
import {
  createSystemdNotifier,
  SYSTEMD_NOTIFY_TIMEOUT_MS,
} from "../services/systemd-notify.js";

/**
 * Three unbounded awaits in one shutdown path, and the production consequence:
 * the process sends `STOPPING=1` to its own unit and then never reaches
 * `process.exit(0)`, so systemd bills the full `TimeoutStopSec` and SIGKILLs the
 * cgroup. The automated throwaway-unit probe that reproduces it end to end is
 * `notify-stop-hang-probe.test.ts`; this file pins the same three fixes at unit
 * granularity, plus the backstop.
 *
 * Every test here is written against a dependency that *never settles*. A test
 * with a slow dependency passes just as well before the fix as after it, so a
 * hang-proof test has to hang without the fix — that is the revert discipline the
 * acceptance criteria ask for, and it is why the pendings below are
 * `new Promise(() => undefined)` rather than a resolved-after-a-tick deferral.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const indexSource = readFileSync(path.join(repoRoot, "server/src/index.ts"), "utf8");

/** A promise that never settles, which is what a query on a dying database is. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function stubLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("site 1: the systemd notify is bounded", () => {
  it("resolves false instead of waiting forever when the notifier never exits", async () => {
    const notify = createSystemdNotifier({
      notifySocket: () => "/run/user/1000/systemd/notify",
      resolveBinary: async () => "/usr/bin/systemd-notify",
      // The shape of the pre-fix `execFile`: no timeout, no abort, a callback
      // that is only ever reached when the child settles.
      run: () => neverSettles<boolean>(),
      timeoutMs: 40,
    });

    const started = Date.now();
    await expect(notify(["--stopping", "--status=Stopping after SIGTERM"])).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("bounds a notifier whose binary resolution itself never settles", async () => {
    // `resolveBinary` is an `fs.stat`/`fs.access` chain on the default path, and
    // it is the other await between `shutdown()` and the datagram. A stalled
    // mount makes `fs.access` wait on the kernel, so this is a real path and not
    // a hypothetical one.
    const notify = createSystemdNotifier({
      notifySocket: () => "/run/user/1000/systemd/notify",
      resolveBinary: () => neverSettles<string>(),
      timeoutMs: 40,
    });

    await expect(notify(["--ready"])).resolves.toBe(false);
  });

  it("passes the ceiling to the notifier child so an execFile timeout can fire", async () => {
    // A bare `Promise.race` would leave the child running; `execFile`'s own
    // `timeout` is what actually signals it. Both are needed and this pins the
    // second one reaching the child.
    const run = vi.fn(async () => true);
    const notify = createSystemdNotifier({
      notifySocket: () => "/run/user/1000/systemd/notify",
      resolveBinary: async () => "/usr/bin/systemd-notify",
      run,
      timeoutMs: 1234,
    });

    await notify(["--ready"]);

    expect(run).toHaveBeenCalledWith(
      "/usr/bin/systemd-notify",
      ["--ready"],
      { NOTIFY_SOCKET: "/run/user/1000/systemd/notify" },
      1234,
    );
  });

  it("bounds the default notifier to a sane ceiling", () => {
    // 2 s against a measured 4 ms. It is a ceiling on a single `sendmsg`, not a
    // margin, and it is far below the smallest stop budget worth having.
    expect(SYSTEMD_NOTIFY_TIMEOUT_MS).toBeGreaterThan(100);
    expect(SYSTEMD_NOTIFY_TIMEOUT_MS).toBeLessThan(10_000);
  });
});

describe("site 1: the scheduler latch goes up before the notify await", () => {
  it("sets heartbeatSchedulerStopped before awaiting the notify, not after", () => {
    // The ordering is the fix. With the latch third, a shutdown that dies in the
    // notify leaves the scheduler enqueueing runs against a unit that is already
    // stopping — the "heartbeat kept ticking while stopping" fingerprint, and a
    // direct consequence of the latch's position rather than of any timeout.
    const latch = indexSource.indexOf("heartbeatSchedulerStopped = true;");
    const notify = indexSource.indexOf('await systemdNotify(["--stopping"');
    expect(latch).toBeGreaterThan(-1);
    expect(notify).toBeGreaterThan(-1);
    expect(latch).toBeLessThan(notify);
  });

  it("no longer has a deadline-free spin loop over the in-flight set", () => {
    // The pre-fix wait was `while (inFlight.size > 0) await
    // Promise.allSettled([...inFlight])`: unbounded in time, and unbounded in
    // iterations because a settling sweep can hand the set a new tracked promise
    // before the size is read again.
    expect(indexSource).not.toMatch(
      /while \(heartbeatSchedulerInFlight\.size > 0\)/,
    );
    expect(indexSource).toContain("waitForTrackedSchedulerWork(");
  });
});

describe("site 2: the scheduler idle wait has a deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns and names the abandoned sweeps when a tracked sweep never settles", async () => {
    const log = stubLogger();
    const finalization = neverSettles<void>();
    const statusDelivery = neverSettles<void>();
    const tracked = new Map<string, Promise<void>>([
      ["execution_control:finalization", finalization],
      ["execution_control:status_delivery", statusDelivery],
    ]);

    const pending = waitForTrackedSchedulerWork({
      tracked,
      timeoutMs: 5_000,
      signal: "SIGTERM",
      log,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual({
      idled: false,
      // The names are the deliverable. A "timed out" line that cannot say which
      // sweeps were holding the process leaves an operator guessing between six
      // DB-backed sweeps and a dozen others.
      abandoned: ["execution_control:finalization", "execution_control:status_delivery"],
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: "SIGTERM",
        timeoutMs: 5_000,
        abandonedSweeps: ["execution_control:finalization", "execution_control:status_delivery"],
        abandonedCount: 2,
      }),
      expect.stringContaining("continuing shutdown"),
    );
  });

  it("completes immediately when nothing is in flight", async () => {
    const log = stubLogger();
    await expect(
      waitForTrackedSchedulerWork({
        tracked: new Map(),
        timeoutMs: 5_000,
        signal: "SIGTERM",
        log,
      }),
    ).resolves.toEqual({ idled: true, abandoned: [] });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("still waits for work that settles inside the deadline", async () => {
    const log = stubLogger();
    let release!: () => void;
    const tracked = new Map<string, Promise<void>>([
      ["execution_control:replacement", new Promise<void>((resolve) => { release = resolve; })],
    ]);

    const pending = waitForTrackedSchedulerWork({
      tracked,
      timeoutMs: 5_000,
      signal: "SIGTERM",
      log,
    });
    await vi.advanceTimersByTimeAsync(100);
    release();
    tracked.clear();

    await expect(pending).resolves.toEqual({ idled: true, abandoned: [] });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps taking the shutdown snapshot after a truncated wait", async () => {
    // Refusing to snapshot at all would leave every running row untouched by a
    // stop that did happen, which is worse than a snapshot taken with a sweep
    // still in flight. A run created by that sweep is the reaper's, either way.
    const log = stubLogger();
    const prepareHotRestartShutdown = vi.fn(async () => ({ skipDrain: false }));
    const tracked = new Map<string, Promise<void>>([
      ["execution_control:reconciliation_delivery", neverSettles<void>()],
    ]);
    const waitForHeartbeatSchedulerIdle = () =>
      waitForTrackedSchedulerWork({ tracked, timeoutMs: 5_000, signal: "SIGTERM", log });

    const pending = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown,
      waitForHeartbeatSchedulerIdle,
      log,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual({
      hotRestart: { skipDrain: false },
      preparationError: null,
      waitedForSchedulerIdle: true,
      abandonedSchedulerSweeps: ["execution_control:reconciliation_delivery"],
    });
    expect(prepareHotRestartShutdown).toHaveBeenCalledOnce();
  });
});

describe("site 3: the graceful run drain is bounded by the stop budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("abandons a run that outruns the budget instead of awaiting it forever", async () => {
    const log = stubLogger();
    const pending = drainWithDeadline({
      // A run with a 3600 s adapter ceiling and a stop budget of 240 s: the
      // shape that makes a healthy shutdown impossible to complete.
      drain: () => neverSettles<{ interrupted: number }>(),
      timeoutMs: 240_000,
      signal: "SIGTERM",
      log,
      timedOutMessage: "graceful heartbeat run drain exceeded its share of the stop budget",
    });

    await vi.advanceTimersByTimeAsync(240_000);

    await expect(pending).resolves.toEqual({ outcome: "timed_out" });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", timeoutMs: 240_000 }),
      "graceful heartbeat run drain exceeded its share of the stop budget",
    );
  });

  it("returns the drain result when it finishes inside the budget", async () => {
    const log = stubLogger();
    const pending = drainWithDeadline({
      drain: async () => ({ interrupted: 2 }),
      timeoutMs: 240_000,
      signal: "SIGTERM",
      log,
      timedOutMessage: "unused",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({
      outcome: "drained",
      value: { interrupted: 2 },
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("rethrows a drain failure rather than reporting it as a clean drain", async () => {
    const log = stubLogger();
    const failure = new Error("drain failed");
    await expect(
      drainWithDeadline({
        drain: () => Promise.reject(failure),
        timeoutMs: 240_000,
        signal: "SIGTERM",
        log,
        timedOutMessage: "unused",
      }),
    ).rejects.toBe(failure);
  });

  it("reports unavailable when there is no drain to run", async () => {
    await expect(
      drainWithDeadline({
        drain: null,
        timeoutMs: 240_000,
        signal: "SIGTERM",
        log: stubLogger(),
        timedOutMessage: "unused",
      }),
    ).resolves.toEqual({ outcome: "unavailable" });
  });
});

describe("backstop: a stop ends even if a step nobody has found hangs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exits before TimeoutStopSec rather than waiting for the cgroup SIGKILL", async () => {
    const log = stubLogger();
    const exit = vi.fn();

    startShutdownExitWatchdog({
      signal: "SIGTERM",
      // Strictly inside the stop budget, so the exit this produces is this
      // process's own and systemd records a clean exit rather than a timeout.
      timeoutMs: 240_000,
      log,
      exit,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    });

    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(239_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(exit).toHaveBeenCalledWith(0);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", timeoutMs: 240_000 }),
      expect.stringContaining("TimeoutStopSec"),
    );
  });

  it("is disarmed once the ordered teardown completes", () => {
    const log = stubLogger();
    const exit = vi.fn();
    const clearTimer = vi.fn();

    const clear = startShutdownExitWatchdog({
      signal: "SIGTERM",
      timeoutMs: 240_000,
      log,
      exit,
      setTimer: () => "handle",
      clearTimer,
    });
    clear();

    // The programmatic `shutdown(signal, false)` caller is a process that is
    // meant to keep running, so a watchdog still armed would exit it.
    expect(clearTimer).toHaveBeenCalledWith("handle");
    expect(exit).not.toHaveBeenCalled();
  });

  it("is wired into shutdown() before the first await and disarmed on the normal path", () => {
    const armedAt = indexSource.indexOf("const clearShutdownWatchdog = startShutdownExitWatchdog(");
    const firstNotify = indexSource.indexOf('await systemdNotify(["--stopping"');
    const clearedAt = indexSource.indexOf("clearShutdownWatchdog();");
    expect(armedAt).toBeGreaterThan(-1);
    expect(clearedAt).toBeGreaterThan(armedAt);
    expect(armedAt).toBeLessThan(firstNotify);
  });
});
