/**
 * The throwaway-unit probe this file exists for, as a program instead of a
 * shell session. It is the automated form of an investigation that first
 * reproduced the signature by hand on a `systemd-run --user` unit; the
 * measurement table it produced is in `tools/service-stop-attribution/README.md`.
 *
 * A `Type=notify` unit whose process sends its own `STOPPING=1` and then does not
 * exit is billed the full `TimeoutStopSec` and SIGKILLed cgroup-wide, with no
 * signal ever delivered and no `Stopping <unit>` job line ever logged. That
 * signature is what this reproduces and what the fix has to remove, so the
 * harness runs the *real* shutdown path from `server/src/shutdown.ts` and
 * `server/src/services/systemd-notify.ts` rather than a stand-in for them.
 *
 * `mode` selects which half of the path to hang:
 *
 * - `notify` — the pre-fix unbounded `execFile`. A notification child that never
 *   exits, so the very first await in `shutdown()` never settles.
 * - `scheduler` — an execution-control sweep that never settles, which is what a
 *   query on a database that is going away looks like. The harness prints the
 *   abandoned labels so the test can assert they were named.
 * - `drain` — an in-flight agent run that never finishes, i.e. the
 *   3600 s `adapter_config.timeoutSec` case against a 300 s stop budget.
 *
 * The process exits 0 when the bounded path works. The test asserts systemd
 * recorded a clean exit rather than a timeout, which is the difference the fix
 * makes.
 *
 * Run through `node --import tsx`, so the probe exercises the TypeScript source
 * rather than whatever the last `dist/` build happened to produce.
 *
 * Usage: node --import tsx shutdown-hang-harness.mjs <mode> [stopTimeoutSec]
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const {
  coordinateHeartbeatSchedulerShutdown,
  drainWithDeadline,
  resolveHeartbeatDrainBudgetMs,
  resolveShutdownWatchdogMs,
  startShutdownExitWatchdog,
  waitForTrackedSchedulerWork,
} = await import(pathToFileURL(path.join(here, "../../shutdown.ts")).href);
const { createSystemdNotifier } = await import(
  pathToFileURL(path.join(here, "../../services/systemd-notify.ts")).href
);

/** A dependency that never settles: a query on a database that is going away. */
const neverSettles = () => new Promise(() => undefined);

const mode = process.argv[2] ?? "notify";
const stopTimeoutSec = Number(process.argv[3] ?? "10");
const unit = process.env.PAPERCLIP_PROBE_UNIT ?? null;

const logger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: "info", msg, ...obj })),
  warn: (obj, msg) => console.log(JSON.stringify({ level: "warn", msg, ...obj })),
  error: (obj, msg) => console.log(JSON.stringify({ level: "error", msg, ...obj })),
};

/**
 * The real budget arithmetic, scaled to the probe's own stop budget so the
 * relations under test — drain < stop, watchdog > both drains, watchdog < stop —
 * hold exactly as they do at 300 s. Scaling the *numbers* rather than replacing
 * the formula is the point: a probe that picked its own independent timeouts
 * would pass with the production arithmetic deleted.
 */
const probeStopBudgetMs = stopTimeoutSec * 1000;
const probeReserveMs = Math.max(1000, Math.floor(probeStopBudgetMs * 0.4));
const probeDrainBudgetMs = resolveHeartbeatDrainBudgetMs({
  stopBudgetMs: probeStopBudgetMs,
  reserveMs: probeReserveMs,
});
const probeWatchdogMs = resolveShutdownWatchdogMs({
  stopBudgetMs: probeStopBudgetMs,
  reserveMs: probeReserveMs,
});
const probeSchedulerBudgetMs = Math.max(
  250,
  Math.min(probeReserveMs, probeWatchdogMs - probeDrainBudgetMs),
);

const exitWith = (code, reason) => {
  console.log(JSON.stringify({ level: "info", msg: "harness exit", code, reason }));
  process.exit(code);
};

// Two notifiers, and the split is the whole measurement. The start datagram has
// to reach systemd for real — a `Type=notify` unit that never sends `READY=1`
// fails the start protocol (`Result=protocol`) and the probe would then be
// reporting a failed start as a stop result. Only the *stopping* datagram is
// allowed to hang, and only in the `notify` arm, because that is the production
// signature: the unit started correctly, then the process's own `STOPPING=1`
// never completed.
const readyNotify = createSystemdNotifier({ timeoutMs: 500 });

/**
 * The site-1 signature, and it has a shape that matters.
 *
 * The naive stub — a `run` that simply never settles — is not the production
 * failure. It also swallows the `STOPPING=1` datagram, so systemd never begins
 * the stop, never starts counting `TimeoutStopSec`, and the unit sits there
 * running while the app's own backstop eventually rescues it. The probe then
 * "passes" for a reason that has nothing to do with systemd.
 *
 * What actually goes wrong is narrower and worse: the datagram goes out, and the
 * *caller* never comes back. So the real binary is spawned and left un-awaited,
 * which is exactly a hung `execFile` with no `timeout` — the datagram lands,
 * systemd starts the stop clock, and the pre-fix shutdown waits forever against
 * a budget that is already running.
 */
const spawnNotifierWithoutWaiting = (binary, args, env) => {
  execFile(binary, args, { env }, () => undefined);
  return neverSettles();
};

const stoppingNotify =
  mode === "notify"
    ? createSystemdNotifier({ run: spawnNotifierWithoutWaiting, timeoutMs: 500 })
    : readyNotify;

const buildSchedulerIdleWait = () => {
  if (mode !== "scheduler") return async () => ({ idled: true, abandoned: [] });
  // Labels are the six DB-backed execution-control sweeps from
  // `server/src/index.ts`. The drain that gives up has to name them.
  const tracked = new Map([
    ["execution_control:finalization", neverSettles()],
    ["execution_control:status_delivery", neverSettles()],
  ]);
  return () =>
    waitForTrackedSchedulerWork({
      tracked,
      timeoutMs: probeSchedulerBudgetMs,
      signal: "SIGTERM",
      log: logger,
    });
};

const runDrain = mode === "drain" ? () => neverSettles() : async () => ({ interrupted: 0 });

const clearWatchdog = startShutdownExitWatchdog({
  signal: "SIGTERM",
  // Inside the unit's own stop budget, so an exit produced here is this
  // process's clean `exit(0)` and not a cgroup SIGKILL.
  timeoutMs: probeWatchdogMs,
  log: logger,
  exit: (code) => exitWith(code, "watchdog"),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle),
});

// READY=1 first, and wait for systemd to agree the unit is `active`: a
// `Type=notify` unit must be up before its own `STOPPING=1` means anything, and
// a stop that races the start protocol measures something else entirely.
const ready = await readyNotify(["--ready", "--status=Probe ready"]);
if (!ready) {
  console.error("harness could not send READY=1; the start protocol never completed");
  exitWith(1, "ready failed");
}
await waitForUnitActive();

// The stop begins here. Everything below is what `shutdown()` does after this
// point, in the same order. In the `notify` arm this await is the one that never
// returns — the datagram is already on the socket, so systemd is counting
// `TimeoutStopSec` while the process sits here.
const stoppingDelivered = await stoppingNotify([
  "--stopping",
  "--status=Stopping after SIGTERM",
]);
if (mode !== "notify" && !stoppingDelivered) {
  console.error("harness could not send STOPPING=1; the stop clock never started");
  exitWith(1, "stopping notify failed");
}

const coordinated = await coordinateHeartbeatSchedulerShutdown({
  signal: "SIGTERM",
  prepareHotRestartShutdown: async () => ({ skipDrain: false }),
  waitForHeartbeatSchedulerIdle: buildSchedulerIdleWait(),
  log: logger,
});

const drained = await drainWithDeadline({
  drain: runDrain,
  timeoutMs: probeDrainBudgetMs,
  signal: "SIGTERM",
  log: logger,
  timedOutMessage: "graceful heartbeat run drain exceeded its share of the stop budget",
});

console.log(
  JSON.stringify({
    level: "info",
    msg: "harness result",
    mode,
    drainOutcome: drained.outcome,
    abandonedSchedulerSweeps: coordinated.abandonedSchedulerSweeps,
    budget: {
      stopBudgetMs: probeStopBudgetMs,
      schedulerBudgetMs: probeSchedulerBudgetMs,
      drainBudgetMs: probeDrainBudgetMs,
      watchdogMs: probeWatchdogMs,
    },
  }),
);

clearWatchdog();
exitWith(0, "ordered shutdown completed");

/**
 * Poll this unit's own state, so the stop never races the start protocol.
 *
 * A failure here is loud rather than a fall-through. If the unit never reaches
 * `active`, everything measured afterwards is a failed start reported as a stop
 * result — which is exactly the false pass this probe has to not have.
 */
async function waitForUnitActive() {
  if (!unit) return;
  const deadline = Date.now() + probeStopBudgetMs / 2;
  while (Date.now() < deadline) {
    if (await isUnitActive(unit)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.error(`harness: ${unit} never became active; probe is not measuring a stop`);
  exitWith(1, "unit never became active");
}

function isUnitActive(name) {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", "is-active", "--quiet", name], (error) => {
      resolve(!error);
    });
  });
}
