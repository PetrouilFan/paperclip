/**
 * Sender-side trace of `systemd-notify` invocations.
 *
 * This is the only place the identity of a notify-triggered stop can come from.
 * Measured three ways on systemd 261 (see attributionFor() in ./classify.mjs),
 * neither the journal at any log level nor the user bus names the connection
 * that sent STOPPING=1 — the manager logs the datagram's effect, never its
 * sender. So attribution has to be recorded where the sender still exists: in
 * the sender itself, before it hands the datagram to systemd.
 *
 * A PATH shim rather than a patch of the two in-repo call sites, because the
 * sender of the 10:02 outage was an agent's shell running `systemd-notify` as a
 * command, not Paperclip code. A shim sees every sender, including the ones no
 * amount of code review would.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** The trace file's own schema version. */
export const TRACE_VERSION = 1;

/**
 * Which notification fields an argv carries.
 *
 * `systemd-notify --stopping` sends STOPPING=1 and `--ready` sends READY=1; any
 * remaining bare `KEY=VALUE` argument is sent as a field verbatim. Both spellings
 * have to be recognised because a shell that sends STOPPING=1 by hand writes the
 * field directly rather than using the flag.
 */
export function parseNotifyArgs(argv) {
  const fields = {};
  let stopping = false;
  let ready = false;
  for (const arg of argv) {
    if (arg === "--stopping") {
      stopping = true;
      continue;
    }
    if (arg === "--ready") {
      ready = true;
      continue;
    }
    if (arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) fields[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  if (stopping) fields.STOPPING = "1";
  if (ready) fields.READY = "1";
  return fields;
}

/**
 * Build the trace record for one invocation.
 *
 * Everything here is read from the sending process, so it survives the process
 * being SIGKILLed a second later by the `KillMode=control-group` sweep that
 * follows the stop it just caused.
 */
export function buildTraceRecord({ argv, env, cwd, pid, ppid }) {
  const fields = parseNotifyArgs(argv);
  return {
    traceVersion: TRACE_VERSION,
    atMs: Date.now(),
    pid,
    ppid,
    argv,
    cwd,
    fields,
    // The socket is the unit's notify address. It is recorded because the same
    // shim serves every unit on the host's user manager, and a send to a
    // different unit's socket is not an event for this one.
    notifySocket: env.NOTIFY_SOCKET ?? null,
    // The run identity, when the sender is an agent run. These are the
    // variables the harness already puts in a run's environment, so naming them
    // here needs no new plumbing.
    run: {
      runId: env.PAPERCLIP_RUN_ID ?? null,
      agentId: env.PAPERCLIP_AGENT_ID ?? null,
      taskId: env.PAPERCLIP_TASK_ID ?? null,
      runScratchDir:
        env.PAPERCLIP_RUN_SCRATCH_DIR ?? env.PAPERCLIP_SCRATCH_DIR ?? null,
      workspaceCwd: env.PAPERCLIP_WORKSPACE_CWD ?? null,
    },
    cgroup: readCgroup(pid),
    // A STOPPING=1 is the only invocation that costs anything: on a
    // Type=notify unit with NotifyAccess=all it moves the unit to
    // stop-sigterm and, with KillMode=control-group, the SIGKILL that follows
    // takes the database and every in-flight run with it.
    sendsStopping: fields.STOPPING === "1",
  };
}

function readCgroup(pid) {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
  } catch {
    return null;
  }
}

export function appendTrace(tracePath, record) {
  mkdirSync(dirname(tracePath), { recursive: true });
  appendFileSync(tracePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Read a trace file, skipping any trailing partial line. */
export function readTrace(tracePath) {
  if (!existsSync(tracePath)) return [];
  const out = [];
  for (const line of readFileSync(tracePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Attach the senders whose trace records fall inside a stop's window.
 *
 * The window is the one the classifier derived. It is deliberately generous: a
 * STOPPING=1 that systemd refused to act on still sits inside the window of the
 * stop it was trying to cause, and a sender reported here with no stop
 * following it is exactly the case worth knowing about. Correlation is on the
 * socket as well as the time, so a send to another unit is not miscounted.
 */
export function attachNotifySenders(stops, trace, { socketFor } = {}) {
  return stops.map((stop) => {
    const from = stop.windowStartMs ?? stop.detectedAtMs - 5000;
    const to = stop.detectedAtMs + 1000;
    const socket = socketFor ? socketFor(stop.unit) : null;
    return {
      ...stop,
      notifySenders: trace.filter(
        (t) =>
          t.atMs >= from &&
          t.atMs <= to &&
          (socket === null ||
            t.notifySocket === null ||
            t.notifySocket === socket),
      ),
    };
  });
}
