/**
 * Classification of systemd service stop events, from the user manager's own
 * journal records.
 *
 * The problem this exists for: for a `Type=notify` unit, the difference between
 * "an operator ran `systemctl --user stop`" and "a process inside the unit
 * sent STOPPING=1" is not recorded anywhere in a form an observer can read. The
 * journal keeps the *consequence* (`Result=timeout`, the SIGKILL flood) and, for
 * the explicit case only, a `Stopping <description>...` job line. Everything
 * else has to be inferred from which lines happen to be present, which is why
 * real stops end up unattributable.
 *
 * This module turns the journal into one record per stop with an explicit
 * trigger class, so "unattributable" becomes a named state with a stated reason
 * rather than a gap a reader has to notice.
 *
 * Measured signatures (systemd 261, user manager, throwaway `systemd-run`
 * units with `Type=notify`, `NotifyAccess=all`, `TimeoutStopSec=3`):
 *
 *   trigger                     | JOB_TYPE=stop | "Stopping ..." | refusal lines | Result
 *   ----------------------------|---------------|----------------|---------------|---------
 *   `systemctl --user stop`     | yes           | yes            | no            | success
 *   process sends STOPPING=1    | no            | no             | see below     | timeout
 *   main process killed by a
 *   signal, then stop job runs  | no            | no             | no            | signal
 *
 * The refusal lines are `Service must stop after STOPPING=1 notification,
 * refusing attempted transition to READY=1.` systemd emits them only when a
 * STOPPING=1 was already received AND a later READY=1 attempt arrives. A
 * STOPPING=1 that is never followed by a READY=1 attempt therefore logs
 * nothing at all, so their absence is NOT evidence that no STOPPING=1 arrived.
 * `trigger: "silent"` is the honest label for that case and it is deliberately
 * not folded into either of the two known classes.
 */

/** A `STOPPING=1` was received and later contradicted by a READY=1 attempt. */
export const TRIGGER_NOTIFY = "notify";
/** A stop job was enqueued through the manager (an explicit `stop` request). */
export const TRIGGER_JOB = "job";
/** The unit went down with no stop job and no STOPPING=1 evidence at all. */
export const TRIGGER_SILENT = "silent";

const STOPPING_REFUSAL = "Service must stop after STOPPING=1 notification";
const STATE_LINE = /^paperclipai\.service: State '(.+)'/;
const KILL_LINE = /Killing process (\d+) \(([^)]*)\) with signal (\w+)/;
const MAIN_EXIT = /Main process exited, code=(\w+), status=(.+)/;
const START_JOB = /^Starting /;
const STOP_JOB = /^Stopping /;
const STARTED_JOB = /^Started /;
const RESULT = /Failed with result '(.+)'\./;
const RESTART_SCHEDULED = "Scheduled restart job";
const MAX_RECORDED_VICTIMS = 200;

function recordTimeUs(record) {
  return Number(record.__REALTIME_TIMESTAMP);
}

function messageOf(record) {
  return typeof record.MESSAGE === "string" ? record.MESSAGE : "";
}

/**
 * True for the records the user manager itself emitted about the unit, as
 * opposed to the unit's own stdout. The unit's application logs land in the
 * same journal, and a `Starting ...` line from application code would
 * otherwise be indistinguishable from a job message.
 */
function isManagerRecord(record) {
  return (
    record.SYSLOG_IDENTIFIER === "systemd" && record.CODE_FUNC !== undefined
  );
}

class OpenStop {
  constructor(unit) {
    this.unit = unit;
    this.invocationId = null;
    this.stopJobAtUs = null;
    this.refusalTimesUs = [];
    this.stateLines = [];
    this.kills = [];
    this.mainExit = null;
    this.result = null;
    this.restartScheduled = false;
  }

  observe(record, atUs) {
    this.invocationId ??= record.USER_INVOCATION_ID ?? null;
  }
}

/**
 * Build the stop records for one unit from a flat list of journal records.
 *
 * `records` is `journalctl -o json` output for the unit; the function sorts by
 * timestamp itself, so a caller that concatenates several `journalctl`
 * invocations does not have to.
 *
 * Stops are detected as "the unit stopped being healthy", which is the only
 * moment every trigger class shares. A stop window opens on a stop job, on a
 * STOPPING=1 refusal, or on the first stop-state line with nothing else to
 * attribute it to, and closes on the terminal `Failed with result` /
 * `Scheduled restart job` pair, or on the next start.
 */
export function classifyStops(records, options = {}) {
  const unit = options.unit ?? "paperclipai.service";
  const ordered = [...records].sort(
    (a, b) => recordTimeUs(a) - recordTimeUs(b),
  );

  /** @type {OpenStop[]} */
  let open = [];
  /** @type {Record<string, unknown>[]} */
  const stops = [];

  const close = (target, terminalAtUs, note) => {
    stops.push(finish(target, terminalAtUs, note));
    open = open.filter((o) => o !== target);
  };
  const openWindow = () => {
    const started = new OpenStop(unit);
    open.push(started);
    return started;
  };

  for (const record of ordered) {
    if (!isManagerRecord(record)) continue;
    const message = messageOf(record);
    const atUs = recordTimeUs(record);
    const active = open[open.length - 1] ?? null;

    if (START_JOB.test(message)) {
      // A fresh start closes out anything still open: the unit is back up. The
      // records between the stop and the start belong to that stop, not to the
      // start, so they are already folded into the open window.
      for (const pending of open)
        close(pending, null, "the unit started again before a terminal line");
      continue;
    }

    if (message.includes(STOPPING_REFUSAL)) {
      if (active) {
        active.refusalTimesUs.push(atUs);
        active.observe(record, atUs);
      } else {
        // The STOPPING=1 itself moved the unit out of running before systemd had
        // a job to announce, so this line opens the window.
        const started = openWindow();
        started.refusalTimesUs.push(atUs);
        started.observe(record, atUs);
      }
      continue;
    }

    if (STOP_JOB.test(message)) {
      // A second stop request is a second stop. The first window never reached
      // a terminal line, so close it out rather than merge the two into one
      // record that describes neither.
      for (const pending of open)
        close(pending, atUs, "superseded by a later stop job");
      const started = new OpenStop(unit);
      started.stopJobAtUs = atUs;
      started.observe(record, atUs);
      open.push(started);
      continue;
    }

    // A stop-state line or a SIGKILL sweep is itself proof that a stop is in
    // progress, so either can open a window. They have to: the 11:06 stop's
    // first surviving line is its own `State 'stop-sigterm' timed out`, five
    // minutes after the stop began, because a STOPPING=1 that is never
    // contradicted by a READY=1 logs nothing at all.
    const stateMatch = message.match(STATE_LINE);
    if (stateMatch) {
      const target = active ?? openWindow();
      target.stateLines.push({ state: stateMatch[1], atUs });
      target.observe(record, atUs);
      continue;
    }

    const killMatch = message.match(KILL_LINE);
    if (killMatch) {
      const target = active ?? openWindow();
      target.kills.push({
        pid: Number(killMatch[1]),
        comm: killMatch[2],
        signal: killMatch[3],
        atUs,
      });
      target.observe(record, atUs);
      continue;
    }

    // A main-process exit does NOT open a window. Under `Restart=always` a
    // crash-restart produces the same `Main process exited` line and no stop at
    // all, and counting that as a stop would put a phantom in the ledger on
    // every crash. It attaches to a window when one is already open.
    const exitMatch = message.match(MAIN_EXIT);
    if (exitMatch && active) {
      active.mainExit = { code: exitMatch[1], status: exitMatch[2], atUs };
      active.observe(record, atUs);
      continue;
    }

    const resultMatch = message.match(RESULT);
    if (resultMatch && active) {
      active.result = resultMatch[1];
      close(active, atUs, null);
      continue;
    }

    if (message.includes(RESTART_SCHEDULED) && active) {
      active.restartScheduled = true;
      close(active, atUs, null);
      continue;
    }

    if (STARTED_JOB.test(message)) {
      for (const pending of open)
        close(pending, null, "the unit started again before a terminal line");
    }
  }

  // A stop that never reached a terminal line is still a stop. Recording it as
  // unresolved rather than dropping it is the point: the gap is the finding.
  for (const pending of open)
    close(pending, null, "no terminal journal line in the records read");

  stops.sort((a, b) => a.detectedAtMs - b.detectedAtMs);
  return stops;
}

function finish(acc, terminalAtUs, note) {
  const trigger = pickTrigger(acc);
  const terminalUs = terminalAtUs ?? lastSignalUs(acc);
  const killed = acc.kills.filter((k) => k.signal === "SIGKILL");
  return {
    unit: acc.unit,
    // A stop is dated by the last journal line that proves it, because that is
    // the only timestamp present in every trigger class.
    detectedAtMs: Math.round(terminalUs / 1000),
    windowStartMs: firstSignalUs(acc),
    trigger,
    attribution: attributionFor(trigger, note),
    invocationId: acc.invocationId,
    result: acc.result,
    stopJobAtMs:
      acc.stopJobAtUs === null ? null : Math.round(acc.stopJobAtUs / 1000),
    firstStoppingRefusalAtMs:
      acc.refusalTimesUs.length === 0
        ? null
        : Math.round(acc.refusalTimesUs[0] / 1000),
    stoppingRefusalCount: acc.refusalTimesUs.length,
    stopState:
      acc.stateLines.length === 0
        ? null
        : acc.stateLines[acc.stateLines.length - 1].state,
    mainProcessExit: acc.mainExit
      ? {
          code: acc.mainExit.code,
          status: acc.mainExit.status,
          atMs: Math.round(acc.mainExit.atUs / 1000),
        }
      : null,
    sigkillVictimCount: killed.length,
    sigkillVictims: killed
      .slice(0, MAX_RECORDED_VICTIMS)
      .map((k) => ({ pid: k.pid, comm: k.comm })),
    sigkillVictimsTruncated: killed.length > MAX_RECORDED_VICTIMS,
    restartScheduled: acc.restartScheduled,
    unresolvedReason: note,
    /** Filled in by attachNotifySenders() when a sender-side trace exists. */
    notifySenders: [],
  };
}

function firstSignalUs(acc) {
  const candidates = [
    acc.stopJobAtUs,
    ...acc.refusalTimesUs,
    ...acc.stateLines.map((s) => s.atUs),
  ]
    .filter((v) => typeof v === "number")
    .sort((a, b) => a - b);
  return candidates.length === 0 ? null : Math.round(candidates[0] / 1000);
}

function lastSignalUs(acc) {
  const candidates = [
    acc.stopJobAtUs,
    ...acc.stateLines.map((s) => s.atUs),
    acc.mainExit?.atUs ?? null,
    ...acc.kills.map((k) => k.atUs),
    ...acc.refusalTimesUs,
  ].filter((v) => typeof v === "number");
  return candidates.length === 0 ? Date.now() * 1000 : Math.max(...candidates);
}

/**
 * The three classes, and nothing else. `silent` is a real class rather than a
 * fallback: it is the state today's 11:06 and 01:07 stops are actually in, and
 * naming it is what stops them being reported as benign.
 */
function pickTrigger(acc) {
  if (acc.stopJobAtUs !== null) return TRIGGER_JOB;
  if (acc.refusalTimesUs.length > 0) return TRIGGER_NOTIFY;
  return TRIGGER_SILENT;
}

/**
 * Whether the trigger class carries the identity of whoever caused it.
 *
 * Measured on systemd 261, three independent ways, for ask #1 of the ticket
 * ("the unit's stop events are recorded with the requesting PID"):
 *
 *   1. The journal at info level. A `Stopping ...` job line names the unit, not
 *      the requester.
 *   2. The journal with the user manager's `LogLevel` property raised to
 *      `debug` at runtime through `busctl set-property`. The manager logs
 *      `Got message type=method_call ... member=StopUnit` and prints
 *      `sender=n/a` — the calling connection is not recorded.
 *   3. Bus monitoring, new-style and with `eavesdrop=true`. Only signals are
 *      delivered on the systemd user bus; no method call is ever visible.
 *
 * So a job-triggered stop is attributable to "something asked the manager over
 * the bus" and to nothing finer, and a notify-triggered stop is attributable
 * only from the sender's own side. That is why this tool pairs the ledger with
 * a sender-side trace instead of reconstructing the requester here.
 */
function attributionFor(trigger, note) {
  if (trigger === TRIGGER_JOB) {
    return {
      requesterKnown: false,
      reason:
        "A stop job was enqueued, so an explicit request reached the user manager. " +
        "systemd does not record the requesting PID and it is not visible on the bus, " +
        "so the requester cannot be named from outside.",
    };
  }
  if (trigger === TRIGGER_NOTIFY) {
    return {
      requesterKnown: false,
      reason:
        "A STOPPING=1 datagram was received and systemd confirmed it by refusing a later " +
        "READY=1. The sender is not named by systemd, so the identity has to come from " +
        "the sender-side systemd-notify trace.",
    };
  }
  return {
    requesterKnown: false,
    reason:
      "The unit went down with no stop job and no STOPPING=1 evidence. Consistent with an " +
      "unlogged STOPPING=1, with a signal-driven exit, or with any trigger that leaves no " +
      "journal line." +
      (note ? ` (${note})` : ""),
  };
}
