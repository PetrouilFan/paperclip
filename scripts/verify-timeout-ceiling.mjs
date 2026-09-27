#!/usr/bin/env node
// Verifies whether the fleet-wide agent timeout ceiling is still censoring the
// heartbeat_runs duration distribution, and whether the service cgroup is under
// memory pressure that would confound the measurement.
//
// Origin: PET-660. PET-653 raised adapterConfig.timeoutSec 1800 -> 3600 on the
// opencode_local agents on 2026-09-27T11:10Z.
//
// Reads runs through the control-plane API rather than psql: this instance runs
// an embedded postgres whose password is not exported into the agent
// environment, so `$PGURL` is unset for agents and the documented SQL in the
// issue is not runnable as written. The API returns the same heartbeat_runs
// rows (id, status, startedAt, finishedAt, logRef, errorCode).
//
// Usage:
//   PAPERCLIP_API_URL=... PAPERCLIP_API_KEY=... \
//   node scripts/verify-timeout-ceiling.mjs --since 2026-09-27T11:10:00Z
//
// Options:
//   --since <iso>   start of the measured window (default: the PET-653 change)
//   --before <iso>  end of the measured window (default: now)
//   --json          emit machine-readable JSON instead of a text report
//   --no-logs       skip the run-log tool_use scan (it reads every log file)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { argv, env, exit, stdout } from "node:process";

const CHANGE_EPOCH_ISO = "2026-09-27T11:10:00Z";
const COMPANY_ID = "8b153af9-1510-4721-bafb-5f538eac657a";

const instanceId = env.PAPERCLIP_INSTANCE_ID ?? "default";
const paperclipHome = env.PAPERCLIP_HOME ?? join(homedir(), ".paperclip");
const RUN_LOGS_DIR = join(paperclipHome, "instances", instanceId, "data", "run-logs");
// The service runs under a user manager, so the unit lands in
// user@<uid>.service/app.slice/. Resolve the uid rather than hardcoding it.
const CGROUP_DIR = join(
  "/sys/fs/cgroup/user.slice",
  `user-${process.getuid?.() ?? 1000}.slice`,
  `user@${process.getuid?.() ?? 1000}.service`,
  "app.slice",
  "paperclipai.service",
);

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const hasFlag = (name) => argv.includes(`--${name}`);

const apiUrl = env.PAPERCLIP_API_URL;
const apiKey = env.PAPERCLIP_API_KEY;
if (!apiUrl || !apiKey) {
  console.error("PAPERCLIP_API_URL and PAPERCLIP_API_KEY are required");
  exit(2);
}

async function api(path) {
  const res = await fetch(`${apiUrl}${path}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

const secs = (r) =>
  (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000;

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function summarize(runs) {
  const byStatus = new Map();
  for (const r of runs) {
    if (!r.startedAt || !r.finishedAt) continue;
    if (!byStatus.has(r.status)) byStatus.set(r.status, []);
    byStatus.get(r.status).push(secs(r));
  }
  return [...byStatus.entries()]
    .map(([status, list]) => {
      const s = [...list].sort((a, b) => a - b);
      return {
        status,
        n: s.length,
        min: Math.round(s[0]),
        p50: Math.round(quantile(s, 0.5)),
        p99: Math.round(quantile(s, 0.99)),
        max: Math.round(s[s.length - 1]),
      };
    })
    .sort((a, b) => b.n - a.n);
}

// Run logs are NDJSON envelopes: {"ts":..,"stream":..,"chunk":"<escaped json>"}.
// The inner payload is backslash-escaped inside `chunk`, so a literal grep for
// `"type":"tool_use"` matches nothing and reports a false "min: 0" hang signal.
// Decode the envelope and count in the decoded payload.
function countToolUses(logRef) {
  let text;
  try {
    text = readFileSync(`${RUN_LOGS_DIR}/${logRef}`, "utf8");
  } catch {
    return null;
  }
  let n = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let env_;
    try {
      env_ = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof env_.chunk === "string") {
      n += env_.chunk.split('"type":"tool_use"').length - 1;
    }
  }
  return n;
}

function readCgroup() {
  const read = (f) => {
    try {
      return readFileSync(`${CGROUP_DIR}/${f}`, "utf8").trim();
    } catch {
      return null;
    }
  };
  return {
    memoryHigh: read("memory.high"),
    memoryMax: read("memory.max"),
    memoryCurrent: read("memory.current"),
    memoryPeak: read("memory.peak"),
    memoryEvents: read("memory.events"),
    memoryPressure: read("memory.pressure"),
  };
}

function parseKV(block) {
  const out = {};
  for (const line of (block ?? "").split("\n")) {
    const [k, ...v] = line.trim().split(/\s+/);
    if (k) out[k] = v.join(" ");
  }
  return out;
}

const sinceIso = arg("since", CHANGE_EPOCH_ISO);
const beforeIso = arg("before", null);
const since = Date.parse(sinceIso);
const before = beforeIso ? Date.parse(beforeIso) : Date.now();

const all = await api(`/api/companies/${COMPANY_ID}/heartbeat-runs`);
const window = all.filter((r) => {
  if (!r.startedAt) return false;
  const t = Date.parse(r.startedAt);
  return t >= since && t < before;
});
const finished = window.filter((r) => r.startedAt && r.finishedAt);

const stats = summarize(finished);

const atCeiling = {};
for (const status of ["succeeded", "timed_out"]) {
  const list = finished
    .filter((r) => r.status === status)
    .map(secs)
    .sort((a, b) => a - b);
  atCeiling[status] = {
    total: list.length,
    ge_3500: list.filter((d) => d >= 3500).length,
    ge_3580: list.filter((d) => d >= 3580).length,
    ge_3600: list.filter((d) => d >= 3600).length,
  };
}

let toolUses = null;
if (!hasFlag("no-logs")) {
  const refs = finished
    .filter((r) => r.status === "timed_out" && r.logRef)
    .map((r) => r.logRef);
  const counts = refs.map(countToolUses).filter((n) => n !== null).sort((a, b) => a - b);
  if (counts.length) {
    toolUses = {
      n: counts.length,
      min: counts[0],
      p25: Math.round(quantile(counts, 0.25)),
      median: Math.round(quantile(counts, 0.5)),
      max: counts[counts.length - 1],
      under10: counts.filter((n) => n < 10).length,
      zero: counts.filter((n) => n === 0).length,
    };
  }
}

const cg = readCgroup();
const events = parseKV(cg.memoryEvents);
const eventsHigh = events.high ? Number(events.high) : null;
const eventsOom = events.oom_kill ? Number(events.oom_kill) : null;

// A second sample of the cumulative throttle counter, so the report can show
// whether memory.high is being hit continuously or only transiently.
let throttleRatePerSec = null;
if (eventsHigh !== null) {
  await new Promise((r) => setTimeout(r, 5000));
  const second = parseKV(readCgroup().memoryEvents);
  const secondHigh = second.high ? Number(second.high) : null;
  if (secondHigh !== null && secondHigh > eventsHigh) {
    throttleRatePerSec = Math.round((secondHigh - eventsHigh) / 5);
  }
}

const high = cg.memoryHigh && cg.memoryHigh !== "max" ? Number(cg.memoryHigh) : null;
const current = cg.memoryCurrent ? Number(cg.memoryCurrent) : null;
const memoryPinned = high !== null && current !== null && current >= high * 0.98;

const report = {
  window: { since: new Date(since).toISOString(), before: new Date(before).toISOString() },
  elapsedHours: Number(((before - since) / 3.6e6).toFixed(2)),
  runsStarted: window.length,
  runsFinished: finished.length,
  stats,
  atCeiling,
  toolUses,
  cgroup: {
    ...cg,
    throttleEventsTotal: eventsHigh,
    throttleEventsPerSec: throttleRatePerSec,
    oomKills: eventsOom,
    pinnedAtHigh: memoryPinned,
    pinnedPctOfHigh: high && current ? Number(((current / high) * 100).toFixed(2)) : null,
  },
};

if (hasFlag("json")) {
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  exit(0);
}

const L = [];
L.push(`timeout ceiling verification  window ${report.window.since} .. ${report.window.before}`);
L.push(`elapsed ${report.elapsedHours}h   started ${report.runsStarted}   finished ${report.runsFinished}`);
L.push("");
L.push("duration by status (seconds)");
for (const s of stats) {
  L.push(`  ${s.status.padEnd(12)} n=${String(s.n).padEnd(5)} min=${String(s.min).padEnd(7)} p50=${String(s.p50).padEnd(7)} p99=${String(s.p99).padEnd(7)} max=${s.max}`);
}
L.push("");
L.push("censoring test at the new wall");
for (const [status, c] of Object.entries(atCeiling)) {
  L.push(`  ${status.padEnd(12)} total=${String(c.total).padEnd(5)} >=3500:${String(c.ge_3500).padEnd(4)} >=3580:${String(c.ge_3580).padEnd(4)} >=3600:${c.ge_3600}`);
}
L.push("");
if (toolUses) {
  L.push(`timed_out run-log tool_use  n=${toolUses.n} min=${toolUses.min} p25=${toolUses.p25} median=${toolUses.median} max=${toolUses.max} under10=${toolUses.under10} zero=${toolUses.zero}`);
} else {
  L.push("timed_out run-log tool_use  (skipped)");
}
L.push("");
L.push("service cgroup");
L.push(`  memory.high     ${cg.memoryHigh}`);
L.push(`  memory.max      ${cg.memoryMax}`);
L.push(`  memory.current  ${cg.memoryCurrent}${memoryPinned ? "   <-- PINNED at high" : ""}`);
L.push(`  memory.peak     ${cg.memoryPeak}`);
L.push(`  throttle events ${eventsHigh}${throttleRatePerSec !== null ? ` (+${throttleRatePerSec}/sec over a 5s sample)` : ""}`);
L.push(`  oom_kill        ${eventsOom}`);
for (const line of (cg.memoryPressure ?? "").split("\n")) if (line.trim()) L.push(`  pressure        ${line.trim()}`);
L.push("");
L.push("verdict");
const to = atCeiling.timed_out;
const su = atCeiling.succeeded;
if (report.elapsedHours < 24) {
  L.push("  INCONCLUSIVE - window shorter than 24h; a run cannot yet reach the new wall.");
} else if (su.ge_3600 > 0 && to.ge_3600 > 0) {
  L.push("  STILL CENSORING - succeeded runs exceed 3600s; the true tail is past an hour.");
} else if (su.ge_3600 > 0) {
  L.push("  PARTIAL - succeeded runs exceed 3600s even though timed_out no longer pins there.");
} else if (su.ge_3500 > 0 && to.total <= 1) {
  L.push("  SUFFICIENT - runs land in the new band and timed_out has collapsed.");
} else {
  L.push("  AMBIGUOUS - see counts above; timed_out has not collapsed and runs have not entered the new band.");
}
if (memoryPinned) {
  L.push("  MEMORY PRESSURE - cgroup is pinned at memory.high; the duration measurement is confounded by reclaim stall.");
}
stdout.write(`${L.join("\n")}\n`);
