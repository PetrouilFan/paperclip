import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TRIGGER_JOB,
  TRIGGER_NOTIFY,
  TRIGGER_SILENT,
  classifyStops,
} from "../lib/classify.mjs";
import { attachNotifySenders, parseNotifyArgs } from "../lib/notify-trace.mjs";
import { newStops, readLedger, appendStop } from "../lib/ledger.mjs";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Build one user-manager journal record. */
function rec(iso, message, extra = {}) {
  return {
    __REALTIME_TIMESTAMP: String(BigInt(new Date(iso).getTime()) * 1000n),
    MESSAGE: message,
    SYSLOG_IDENTIFIER: "systemd",
    CODE_FUNC: "unit_log_failure",
    USER_UNIT: "paperclipai.service",
    ...extra,
  };
}

const P = (pid, comm) =>
  `paperclipai.service: Killing process ${pid} (${comm}) with signal SIGKILL.`;
const STATE = (s) => `paperclipai.service: State '${s}' timed out. Killing.`;
const REFUSAL =
  "paperclipai.service: Service must stop after STOPPING=1 notification, refusing attempted transition to READY=1.";
const FAILED = (r) => `paperclipai.service: Failed with result '${r}'.`;
const RESTART =
  "paperclipai.service: Scheduled restart job immediately on client request, restart counter is at 1.";
const MAIN_KILLED =
  "paperclipai.service: Main process exited, code=killed, status=9/KILL";
const START = "Starting Paperclip AI (default)...";
const STARTED = "Started Paperclip AI (default).";
const STOPPING = "Stopping Paperclip AI (default)...";

test("an explicit stop is classified job, with the stop job timestamped", () => {
  const stops = classifyStops([
    rec("2026-09-27T11:54:19.403+03:00", STOPPING, {
      CODE_FUNC: "job_emit_start_message",
      JOB_TYPE: "stop",
      USER_INVOCATION_ID: "aaa",
    }),
    rec("2026-09-27T11:54:30.000+03:00", MAIN_KILLED, {
      USER_INVOCATION_ID: "aaa",
    }),
    rec("2026-09-27T11:54:31.000+03:00", FAILED("success"), {
      USER_INVOCATION_ID: "aaa",
    }),
  ]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].trigger, TRIGGER_JOB);
  assert.equal(stops[0].result, "success");
  assert.equal(stops[0].invocationId, "aaa");
  assert.equal(
    new Date(stops[0].stopJobAtMs).toISOString(),
    new Date("2026-09-27T08:54:19.403Z").toISOString(),
  );
});

test("a STOPPING=1 refused by a later READY=1 is classified notify", () => {
  const stops = classifyStops([
    rec("2026-09-27T09:33:04.877+03:00", REFUSAL, {
      USER_INVOCATION_ID: "bbb",
    }),
    rec("2026-09-27T09:33:15.212+03:00", REFUSAL, {
      USER_INVOCATION_ID: "bbb",
    }),
    rec("2026-09-27T09:33:38.285+03:00", STATE("stop-sigterm"), {
      CODE_FUNC: "service_dispatch_timer",
      USER_INVOCATION_ID: "bbb",
    }),
    rec("2026-09-27T09:33:38.285+03:00", P(3504249, "node-MainThread"), {
      CODE_FUNC: "log_kill",
      USER_INVOCATION_ID: "bbb",
    }),
    rec("2026-09-27T09:33:38.285+03:00", P(3504560, "postgres"), {
      CODE_FUNC: "log_kill",
      USER_INVOCATION_ID: "bbb",
    }),
    rec("2026-09-27T09:33:38.572+03:00", MAIN_KILLED, {
      USER_INVOCATION_ID: "bbb",
    }),
    rec("2026-09-27T09:33:38.572+03:00", FAILED("timeout"), {
      USER_INVOCATION_ID: "bbb",
    }),
  ]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].trigger, TRIGGER_NOTIFY);
  assert.equal(stops[0].stoppingRefusalCount, 2);
  assert.equal(stops[0].sigkillVictimCount, 2);
  assert.equal(stops[0].stopState, "stop-sigterm");
  assert.equal(stops[0].windowStartMs, Date.parse("2026-09-27T06:33:04.877Z"));
});

test("a stop with neither signature is classified silent, not folded into notify", () => {
  // The 11:06:13 event verbatim in shape: a stop-sigterm timeout with no stop
  // job and no refusal line. The ticket's whole point is that this case is
  // reported as its own state rather than guessed at.
  const stops = classifyStops([
    rec("2026-09-27T11:06:13.285+03:00", STATE("stop-sigterm"), {
      CODE_FUNC: "service_dispatch_timer",
      USER_INVOCATION_ID: "ccc",
    }),
    rec("2026-09-27T11:06:13.285+03:00", P(3504249, "node-MainThread"), {
      CODE_FUNC: "log_kill",
      USER_INVOCATION_ID: "ccc",
    }),
    rec("2026-09-27T11:06:13.285+03:00", P(3504560, "postgres"), {
      CODE_FUNC: "log_kill",
      USER_INVOCATION_ID: "ccc",
    }),
    rec("2026-09-27T11:06:13.521+03:00", MAIN_KILLED, {
      USER_INVOCATION_ID: "ccc",
    }),
    rec("2026-09-27T11:06:13.521+03:00", FAILED("timeout"), {
      USER_INVOCATION_ID: "ccc",
    }),
  ]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].trigger, TRIGGER_SILENT);
  assert.equal(stops[0].stoppingRefusalCount, 0);
  assert.equal(stops[0].stopJobAtMs, null);
  assert.equal(stops[0].attribution.requesterKnown, false);
  assert.match(stops[0].attribution.reason, /unlogged STOPPING=1/);
  assert.equal(stops[0].sigkillVictimCount, 2);
});

test("a start closes an open stop window so two stops are two records", () => {
  const stops = classifyStops([
    rec("2026-09-27T11:54:19.403+03:00", STOPPING, {
      CODE_FUNC: "job_emit_start_message",
      JOB_TYPE: "stop",
      USER_INVOCATION_ID: "d1",
    }),
    rec("2026-09-27T11:54:31.000+03:00", FAILED("success"), {
      USER_INVOCATION_ID: "d1",
    }),
    rec("2026-09-27T12:00:23.584+03:00", START, {
      CODE_FUNC: "job_emit_start_message",
      JOB_TYPE: "start",
      USER_INVOCATION_ID: "d2",
    }),
    rec("2026-09-27T12:00:43.704+03:00", STARTED, {
      CODE_FUNC: "job_emit_done_message",
      USER_INVOCATION_ID: "d2",
    }),
    rec("2026-09-27T12:10:48.626+03:00", REFUSAL, { USER_INVOCATION_ID: "d2" }),
    rec("2026-09-27T12:14:57.421+03:00", STATE("stop-sigterm"), {
      CODE_FUNC: "service_dispatch_timer",
      USER_INVOCATION_ID: "d2",
    }),
    rec("2026-09-27T12:14:57.560+03:00", FAILED("timeout"), {
      USER_INVOCATION_ID: "d2",
    }),
  ]);
  assert.equal(stops.length, 2);
  assert.deepEqual(
    stops.map((s) => s.trigger),
    [TRIGGER_JOB, TRIGGER_NOTIFY],
  );
});

test("a stop that never reached a terminal line is still recorded", () => {
  const stops = classifyStops([
    rec("2026-09-27T01:02:04.241+03:00", MAIN_KILLED, {
      USER_INVOCATION_ID: "e1",
    }),
    rec("2026-09-27T01:07:04.285+03:00", STATE("stop-sigterm"), {
      CODE_FUNC: "service_dispatch_timer",
      USER_INVOCATION_ID: "e1",
    }),
    rec("2026-09-27T01:07:04.289+03:00", FAILED("signal"), {
      USER_INVOCATION_ID: "e1",
    }),
  ]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].trigger, TRIGGER_SILENT);
  assert.equal(stops[0].result, "signal");
});

test("the unit's own stdout is not mistaken for a manager record", () => {
  // The unit logs to the same journal. Without the identifier check a
  // `Starting ...` line from application code would close a stop window.
  const stops = classifyStops([
    rec("2026-09-27T11:54:19.403+03:00", STOPPING, {
      CODE_FUNC: "job_emit_start_message",
      JOB_TYPE: "stop",
      USER_INVOCATION_ID: "f1",
    }),
    rec("2026-09-27T11:54:20.000+03:00", "Starting HTTP server on port 3101", {
      SYSLOG_IDENTIFIER: "node",
      CODE_FUNC: undefined,
      USER_INVOCATION_ID: "f1",
    }),
    rec("2026-09-27T11:54:31.000+03:00", FAILED("success"), {
      USER_INVOCATION_ID: "f1",
    }),
  ]);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].trigger, TRIGGER_JOB);
});

test("a second stop job supersedes an open window instead of merging into it", () => {
  const stops = classifyStops([
    rec("2026-09-27T11:00:00.000+03:00", STOPPING, {
      CODE_FUNC: "job_emit_start_message",
      JOB_TYPE: "stop",
      USER_INVOCATION_ID: "g1",
    }),
    rec("2026-09-27T11:10:00.000+03:00", STOPPING, {
      CODE_FUNC: "job_emit_start_message",
      JOB_TYPE: "stop",
      USER_INVOCATION_ID: "g2",
    }),
    rec("2026-09-27T11:10:05.000+03:00", FAILED("success"), {
      USER_INVOCATION_ID: "g2",
    }),
  ]);
  assert.equal(stops.length, 2);
  assert.match(stops[0].unresolvedReason, /superseded/);
  assert.equal(stops[1].unresolvedReason, null);
});

test("the two STOPPING=1 spellings are both recognised", () => {
  assert.deepEqual(parseNotifyArgs(["--stopping"]), { STOPPING: "1" });
  assert.deepEqual(parseNotifyArgs(["STOPPING=1"]), { STOPPING: "1" });
  assert.deepEqual(parseNotifyArgs(["--ready"]), { READY: "1" });
  assert.deepEqual(parseNotifyArgs(["--ready", "STATUS=hi"]), {
    READY: "1",
    STATUS: "hi",
  });
  assert.deepEqual(parseNotifyArgs([]), {});
});

test("a traced sender inside the stop window is attached to the stop", () => {
  const stop = {
    unit: "paperclipai.service",
    detectedAtMs: Date.parse("2026-09-27T08:06:13.521Z"),
    windowStartMs: Date.parse("2026-09-27T08:01:13.000Z"),
  };
  const trace = [
    {
      atMs: Date.parse("2026-09-27T08:01:10.000Z"),
      sendsStopping: true,
      notifySocket: "/run/user/1000/systemd/notify",
      run: { runId: "other" },
    },
    {
      atMs: Date.parse("2026-09-27T08:01:14.000Z"),
      sendsStopping: true,
      notifySocket: "/run/user/1000/systemd/notify",
      run: { runId: "run-91b2cf34", agentId: "talos", taskId: "TASK-0002" },
    },
    {
      atMs: Date.parse("2026-09-27T08:01:14.500Z"),
      sendsStopping: false,
      notifySocket: "/run/user/1000/systemd/notify",
      run: { runId: "elsewhere" },
    },
    {
      atMs: Date.parse("2026-09-27T09:00:00.000Z"),
      sendsStopping: true,
      notifySocket: "/run/user/1000/systemd/notify",
      run: { runId: "later" },
    },
  ];
  const [withSenders] = attachNotifySenders([stop], trace, {
    socketFor: () => "/run/user/1000/systemd/notify",
  });
  assert.deepEqual(
    withSenders.notifySenders.map((s) => s.run.runId),
    ["run-91b2cf34", "elsewhere"],
  );
});

test("a send to another unit's socket is not attributed to this stop", () => {
  const stop = {
    unit: "paperclipai.service",
    detectedAtMs: Date.parse("2026-09-27T08:06:13.521Z"),
    windowStartMs: Date.parse("2026-09-27T08:01:13.000Z"),
  };
  const trace = [
    {
      atMs: Date.parse("2026-09-27T08:01:14.000Z"),
      sendsStopping: true,
      notifySocket: "/run/user/1000/systemd/notify",
      run: { runId: "run-91b2cf34" },
    },
  ];
  const [withSenders] = attachNotifySenders([stop], trace, {
    socketFor: () => "/run/user/1000/systemd/other",
  });
  assert.deepEqual(withSenders.notifySenders, []);
});

test("silent plus a traced STOPPING=1 is a positively attributed notify stop", () => {
  // The case the tool exists to produce. A STOPPING=1 that is never followed by
  // a READY=1 attempt leaves no journal line at all, so the stop classifies as
  // silent and only the sender-side trace can say who did it. Without the trace
  // the record is unattributable; with it, the run is named.
  const stop = {
    unit: "paperclipai.service",
    detectedAtMs: Date.parse("2026-09-27T08:06:13.521Z"),
    windowStartMs: Date.parse("2026-09-27T08:01:13.000Z"),
    trigger: TRIGGER_SILENT,
    stoppingRefusalCount: 0,
  };
  const trace = [
    {
      atMs: Date.parse("2026-09-27T08:01:14.000Z"),
      sendsStopping: true,
      notifySocket: "/run/user/1000/systemd/notify",
      run: { runId: "run-unattributed", agentId: "talos", taskId: "TASK-0001" },
      cwd: "/home/petrouil",
      pid: 1234,
      ppid: 1200,
    },
  ];
  const [withSenders] = attachNotifySenders([stop], trace, {
    socketFor: () => "/run/user/1000/systemd/notify",
  });
  assert.equal(withSenders.trigger, TRIGGER_SILENT);
  assert.equal(withSenders.stoppingRefusalCount, 0);
  assert.equal(withSenders.notifySenders.length, 1);
  assert.equal(withSenders.notifySenders[0].run.taskId, "TASK-0001");
});

test("the ledger is append-only, tolerates a truncated tail, and dedupes by invocation", () => {
  const dir = mkdtempSync(join(tmpdir(), "stop-attrib-"));
  try {
    const ledgerPath = join(dir, "stops.jsonl");
    const stops = classifyStops([
      rec("2026-09-27T11:06:13.285+03:00", STATE("stop-sigterm"), {
        CODE_FUNC: "service_dispatch_timer",
        USER_INVOCATION_ID: "ccc",
      }),
      rec("2026-09-27T11:06:13.521+03:00", FAILED("timeout"), {
        USER_INVOCATION_ID: "ccc",
      }),
    ]);
    appendStop(ledgerPath, stops[0]);
    assert.equal(readLedger(ledgerPath).length, 1);
    // A re-read of the same journal window must not append the same stop again.
    assert.equal(newStops(readLedger(ledgerPath), stops).length, 0);
    // A second, different stop is new.
    const more = classifyStops([
      ...[],
      rec("2026-09-27T12:14:57.421+03:00", STATE("stop-sigterm"), {
        CODE_FUNC: "service_dispatch_timer",
        USER_INVOCATION_ID: "ddd",
      }),
      rec("2026-09-27T12:14:57.560+03:00", FAILED("timeout"), {
        USER_INVOCATION_ID: "ddd",
      }),
    ]);
    assert.equal(newStops(readLedger(ledgerPath), more).length, 1);
    appendStop(ledgerPath, more[0]);
    // A process killed mid-write leaves a partial line; the readable records
    // still have to be readable.
    appendFileSync(ledgerPath, '{"unit":"paperclipai.service","detec');
    const read = readLedger(ledgerPath);
    assert.equal(read.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger survives a reader that sees a file written by a newer schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "stop-attrib-"));
  try {
    const ledgerPath = join(dir, "stops.jsonl");
    writeFileSync(ledgerPath, '{"ledgerVersion":99,"unit":"x"}\nnot json\n');
    const read = readLedger(ledgerPath);
    assert.equal(read.length, 1);
    assert.equal(newStops(read, [{ unit: "x", invocationId: "y" }]).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
