#!/usr/bin/env node
/**
 * service-stop-attribution — a durable per-stop ledger for a systemd user unit.
 *
 *   report    read the journal and print one line per stop, with its trigger class
 *   record    the same, but append anything new to the ledger
 *   watch     record, then follow the journal and record as stops land
 *   install   materialise the systemd-notify shim and print the PATH line to use
 *   uninstall remove the shim directory
 *
 * `--unit` defaults to paperclipai.service. `--since` defaults to "1 day ago",
 * which on this host is enough to cover a full day of control-plane stops.
 *
 * Nothing here sends a notification, stops a unit, or writes to the unit. It
 * only reads the journal and the ledger, plus one append-only file the shim
 * writes.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TRIGGER_JOB,
  TRIGGER_NOTIFY,
  TRIGGER_SILENT,
  classifyStops,
} from "../lib/classify.mjs";
import { appendStop, newStops, readLedger } from "../lib/ledger.mjs";
import { probeEnv, readUnitRecords } from "../lib/journal.mjs";
import { attachNotifySenders, readTrace } from "../lib/notify-trace.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = resolve(HERE, "..");

function parseArgs(argv) {
  const opts = {
    unit: "paperclipai.service",
    since: "1 day ago",
    ledger: join(
      process.env.PAPERCLIP_HOME ?? "/home/petrouil/.paperclip",
      "instances",
      "default",
      "stop-attribution",
      "stops.jsonl",
    ),
    trace: null,
    shimDir: null,
    json: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--unit") opts.unit = argv[++i];
    else if (arg === "--since") opts.since = argv[++i];
    else if (arg === "--ledger") opts.ledger = argv[++i];
    else if (arg === "--trace") opts.trace = argv[++i];
    else if (arg === "--shim-dir") opts.shimDir = argv[++i];
    else if (arg === "--json") opts.json = true;
    else rest.push(arg);
  }
  opts.rest = rest;
  return opts;
}

/** The notify socket a unit's manager exposes, read from the manager itself. */
function unitSocket(unit) {
  const result = spawnSync(
    "systemctl",
    ["--user", "show", unit, "-p", "MainPID"],
    {
      encoding: "utf8",
      env: probeEnv(),
    },
  );
  if (result.status !== 0) return null;
  const mainPid = (result.stdout.match(/MainPID=(\d+)/) ?? [])[1];
  if (!mainPid || mainPid === "0") return null;
  // NOTIFY_SOCKET is set by systemd for the unit's own processes, so the unit's
  // environment is where its notify address is discoverable. Read it directly:
  // the value is NUL-delimited and NUL cannot cross argv.
  try {
    const environ = readFileSync(`/proc/${mainPid}/environ`, "latin1");
    const match = environ.match(/NOTIFY_SOCKET=([^\0\n]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function collect(opts) {
  const records = await readUnitRecords(opts.unit, { since: opts.since });
  let stops = classifyStops(records, { unit: opts.unit });
  const tracePath = opts.trace ?? defaultTracePath(opts);
  const socket = unitSocket(opts.unit);
  if (existsSync(tracePath)) {
    stops = attachNotifySenders(stops, readTrace(tracePath), {
      socketFor: () => socket,
    });
  }
  return { stops, socket, tracePath };
}

function defaultTracePath(opts) {
  return join(dirname(opts.ledger), "notify-senders.jsonl");
}

/**
 * Local wall time with the offset, not UTC.
 *
 * The journal prints local time and every operator reading this output is
 * comparing it against `journalctl` by eye, so a UTC column next to an EEST
 * journal is a column people misread by three hours.
 */
function isoAt(ms) {
  if (ms === null || ms === undefined) return "-";
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    ` UTC${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

function renderTable(stops) {
  if (stops.length === 0) {
    process.stdout.write("no stops in the window\n");
    return;
  }
  const header = [
    "when",
    "trigger",
    "result",
    "victims",
    "refusals",
    "sender",
    "note",
  ];
  const rows = stops.map((stop) => {
    const senders = stop.notifySenders ?? [];
    const sender = senders.length
      ? `${senders.length} traced${senders.some((s) => s.sendsStopping) ? ", STOPPING=1" : ""}`
      : "-";
    return [
      isoAt(stop.detectedAtMs).slice(0, 23),
      stop.trigger,
      stop.result ?? "-",
      String(stop.sigkillVictimCount),
      String(stop.stoppingRefusalCount),
      sender,
      stop.unresolvedReason ?? "",
    ];
  });
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  process.stdout.write(`${line(header)}\n`);
  process.stdout.write(`${widths.map((w) => "-".repeat(w)).join("  ")}\n`);
  for (const row of rows) process.stdout.write(`${line(row).trimEnd()}\n`);
  const unresolved = stops.filter((s) => s.trigger === TRIGGER_SILENT);
  process.stdout.write(
    `\n${stops.length} stop(s); ${stops.filter((s) => s.trigger === TRIGGER_JOB).length} job, ` +
      `${stops.filter((s) => s.trigger === TRIGGER_NOTIFY).length} notify-confirmed, ` +
      `${unresolved.length} silent (no stop job, no STOPPING=1 evidence).\n`,
  );
  for (const stop of unresolved) {
    process.stdout.write(
      `  silent: ${isoAt(stop.detectedAtMs)} ${stop.attribution.reason}\n`,
    );
  }
  for (const stop of stops) {
    for (const sender of stop.notifySenders ?? []) {
      if (!sender.sendsStopping) continue;
      process.stdout.write(
        `  traced STOPPING=1: ${isoAt(sender.atMs)} pid=${sender.pid} ppid=${sender.ppid} ` +
          `run=${sender.run?.runId ?? "-"} agent=${sender.run?.agentId ?? "-"} ` +
          `task=${sender.run?.taskId ?? "-"} cwd=${sender.cwd ?? "-"}\n`,
      );
    }
  }
}

async function cmdReport(opts) {
  const { stops } = await collect(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(stops, null, 2)}\n`);
    return 0;
  }
  renderTable(stops);
  return 0;
}

async function cmdRecord(opts) {
  const { stops } = await collect(opts);
  const fresh = newStops(readLedger(opts.ledger), stops);
  for (const stop of fresh) appendStop(opts.ledger, stop);
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ appended: fresh.length, ledger: opts.ledger }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `appended ${fresh.length} new stop(s) to ${opts.ledger}\n`,
    );
  }
  return 0;
}

/**
 * Records completed stops by following the journal, not by polling it.
 *
 * The naive shape — re-read the whole window every tick — is not affordable
 * here: the unit's journal for a day is six figures of records, and a 15s poll
 * of that on a host already at 12G and climbing is a way to cause the problem
 * this ticket is about. So `watch` holds one `journalctl --follow` child and
 * keeps only a bounded tail in memory.
 *
 * The tail is re-classified on every record and the ledger's `unit:invocationId`
 * dedupe decides what is new. That makes the tail length the only thing that has
 * to be right: a stop is fully described by a few hundred records (its refusal
 * lines, its state line, its SIGKILL sweep, its terminal line), so a tail of a few
 * thousand cannot miss one, and a stop split across a tail boundary is still
 * emitted once its terminal line arrives.
 */
async function cmdWatch(opts) {
  const tailLimit = 4000;
  let tail = [];
  const ledgerPath = opts.ledger;
  const tracePath = opts.trace ?? defaultTracePath(opts);
  const socket = unitSocket(opts.unit);

  process.stdout.write(
    `watching ${opts.unit}; ledger ${ledgerPath}; trace ${tracePath}\n`,
  );

  // Backfill first, so a watcher started after the fact still captures the stops
  // it missed.
  const backfill = await collect(opts);
  for (const stop of newStops(readLedger(ledgerPath), backfill.stops)) {
    appendStop(ledgerPath, stop);
    process.stdout.write(
      `recorded ${isoAt(stop.detectedAtMs)} ${stop.trigger}\n`,
    );
  }

  let running = true;
  let child = null;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      running = false;
      child?.kill("SIGTERM");
    });
  }

  child = spawn(
    "journalctl",
    [
      "--user",
      "--follow",
      "--output",
      "json",
      `USER_UNIT=${opts.unit}`,
      "_COMM=systemd",
    ],
    { env: probeEnv(), stdio: ["ignore", "pipe", "inherit"] },
  );

  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      tail.push(record);
      if (tail.length > tailLimit) tail = tail.slice(-tailLimit);
      if (record.__REALTIME_TIMESTAMP === undefined) continue;
      // Only the terminal lines change a stop's class, so there is no point
      // re-classifying on the hundreds of SIGKILL lines in between.
      const message = typeof record.MESSAGE === "string" ? record.MESSAGE : "";
      if (
        !/Failed with result|Scheduled restart job|^Starting |^Started /.test(
          message,
        )
      )
        continue;
      let stops = classifyStops(tail, { unit: opts.unit });
      if (existsSync(tracePath)) {
        stops = attachNotifySenders(stops, readTrace(tracePath), {
          socketFor: () => socket,
        });
      }
      for (const stop of newStops(readLedger(ledgerPath), stops)) {
        appendStop(ledgerPath, stop);
        process.stdout.write(
          `recorded ${isoAt(stop.detectedAtMs)} ${stop.trigger} ` +
            `victims=${stop.sigkillVictimCount} senders=${stop.notifySenders.length}\n`,
        );
      }
    }
  });

  await new Promise((resolve) => child.on("exit", resolve));
  if (running) {
    // The journal child died. Exit non-zero so the unit's Restart= policy
    // restarts the watcher rather than leaving the ledger silently unwatched.
    process.exitCode = 1;
  }
  return 0;
}

function realSystemdNotify() {
  const which = spawnSync("sh", ["-c", "command -v systemd-notify"], {
    encoding: "utf8",
    env: probeEnv(),
  });
  const found = (which.stdout ?? "").trim();
  if (!found) {
    throw new Error(
      "systemd-notify is not on PATH; this tool only runs on a systemd host",
    );
  }
  return found;
}

function cmdInstall(opts) {
  const shimDir =
    opts.shimDir ?? join(dirname(opts.ledger), "notify-shim", "bin");
  const tracePath = opts.trace ?? defaultTracePath(opts);
  const real = realSystemdNotify();
  const shimSource = join(TOOL_ROOT, "bin", "systemd-notify-shim.mjs");
  if (!existsSync(shimSource))
    throw new Error(`shim source missing: ${shimSource}`);

  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, "systemd-notify");
  // A tiny launcher rather than a symlink to the .mjs: a symlink's argv[1] and
  // its module resolution both depend on the link target, and the target is a
  // path inside a git worktree that may be pruned.
  //
  // `export` is load-bearing. Without it these are shell variables of the
  // launcher, the exec'd node process does not see them, and the shim refuses to
  // run — which is the correct fail-loud behaviour, but it means a send that
  // would have worked now fails and the unit never gets its READY=1. The
  // self-check below is what keeps that from shipping.
  writeFileSync(
    shimPath,
    [
      "#!/bin/sh",
      "# Installed by tools/service-stop-attribution. Records the invocation,",
      "# then forwards it to the real systemd-notify unchanged.",
      `export PAPERCLIP_NOTIFY_TRACE_PATH='${tracePath}'`,
      `export PAPERCLIP_NOTIFY_REAL_BINARY='${real}'`,
      `exec '${process.execPath}' '${join(TOOL_ROOT, "bin", "systemd-notify-shim.mjs")}' "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(shimPath, 0o755);
  mkdirSync(dirname(tracePath), { recursive: true });
  if (!existsSync(tracePath)) writeFileSync(tracePath, "", { mode: 0o600 });

  // Self-check: the shim has to resolve to the real binary from its own
  // directory, with the shim first on PATH. A shim that cannot do that is worse
  // than no shim, because it turns every notification into a failure.
  const selfCheck = spawnSync(
    "sh",
    ["-c", `PATH='${shimDir}':"$PATH" systemd-notify --print-real`],
    {
      encoding: "utf8",
      env: probeEnv(),
    },
  );
  const resolved = (selfCheck.stdout ?? "").trim();
  if (selfCheck.status !== 0 || resolved !== real) {
    throw new Error(
      `shim self-check failed: \`systemd-notify --print-real\` from ${shimDir} returned ` +
        `${JSON.stringify(resolved)} (status ${selfCheck.status}), expected ${real}`,
    );
  }

  process.stdout.write(`shim installed: ${shimPath}\n`);
  process.stdout.write(`real binary:   ${real}\n`);
  process.stdout.write(`trace file:    ${tracePath}\n`);
  process.stdout.write(`self-check:    ok (resolves to the real binary)\n`);
  process.stdout.write(
    `\nPut the shim first on the PATH of anything that may send a notification:\n` +
      `  export PATH='${shimDir}':"$PATH"\n` +
      `Paperclip run processes do not need this: they inherit no NOTIFY_SOCKET once\n` +
      `the run-IPC fix (#147) is deployed, and the shim is for the window before that.\n`,
  );
  return 0;
}

function cmdUninstall(opts) {
  const shimDir =
    opts.shimDir ?? join(dirname(opts.ledger), "notify-shim", "bin");
  rmSync(shimDir, { recursive: true, force: true });
  process.stdout.write(`removed ${shimDir}\n`);
  return 0;
}

const COMMANDS = {
  report: cmdReport,
  record: cmdRecord,
  watch: cmdWatch,
  install: cmdInstall,
  uninstall: cmdUninstall,
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const name = opts.rest[0];
  const handler = COMMANDS[name];
  if (!handler) {
    process.stderr.write(
      `usage: service-stop-attribution <${Object.keys(COMMANDS).join("|")}> [options]\n`,
    );
    return 2;
  }
  return await handler(opts);
}

process.exitCode = await main();
