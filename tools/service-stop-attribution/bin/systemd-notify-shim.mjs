#!/usr/bin/env node
/**
 * The `systemd-notify` shim.
 *
 * Installed as an executable named `systemd-notify` at the front of a run's
 * PATH, so every `systemd-notify` invocation made by a run process is recorded
 * and then forwarded to the real binary unchanged. The record is written before
 * the forward, because the invocation this exists to catch is the one that
 * destroys the sending process.
 *
 * The real binary's path is baked in at install time and recorded in
 * `realBinary` in the trace. Resolving it through PATH here would find this
 * shim again and recurse.
 *
 * Run directly (as `systemd-notify`), the shim forwards argv as given. With
 * `--print-real` it prints the baked-in real path and exits, which is how
 * `install` verifies the shim resolves to the shim.
 */

import { appendTrace, buildTraceRecord } from "../lib/notify-trace.mjs";

const TRACE_PATH = process.env.PAPERCLIP_NOTIFY_TRACE_PATH;
const REAL_BINARY = process.env.PAPERCLIP_NOTIFY_REAL_BINARY;

const argv = process.argv.slice(2);

if (argv[0] === "--print-real") {
  process.stdout.write(`${REAL_BINARY ?? ""}\n`);
  process.exit(0);
}

if (!REAL_BINARY) {
  // A shim with no target is worse than no shim: it would swallow the
  // notification the unit is waiting for. Say so and get out of the way.
  process.stderr.write(
    "systemd-notify shim: PAPERCLIP_NOTIFY_REAL_BINARY is not set; refusing to swallow the notification\n",
  );
  process.exit(127);
}

if (TRACE_PATH) {
  try {
    appendTrace(
      TRACE_PATH,
      buildTraceRecord({
        argv,
        env: process.env,
        cwd: process.cwd(),
        pid: process.pid,
        ppid: process.ppid,
      }),
    );
  } catch (error) {
    // The trace is diagnostic. Failing to write it must not stop the
    // notification, or the shim would be an outage of its own.
    process.stderr.write(
      `systemd-notify shim: trace write failed: ${error?.message ?? error}\n`,
    );
  }
}

const { spawnSync } = await import("node:child_process");
const result = spawnSync(REAL_BINARY, argv, { stdio: "inherit" });
if (result.error) {
  process.stderr.write(
    `systemd-notify shim: ${REAL_BINARY} failed: ${result.error.message}\n`,
  );
  process.exit(127);
}
// The shim's own exit status has to match the real binary's, or a caller that
// checks it would read a failure as a success.
process.exit(result.status ?? 0);
