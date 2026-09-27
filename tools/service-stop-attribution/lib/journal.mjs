/**
 * Reading the user manager's journal for one unit.
 *
 * Every process this module spawns has NOTIFY_SOCKET removed from its
 * environment before it runs. That is not hygiene for its own sake: the control
 * plane on this host is a `Type=notify` unit with `NotifyAccess=all`, so any
 * process that inherits NOTIFY_SOCKET and runs `systemd-notify --stopping` takes
 * the whole control plane down. The 10:02 outage on 2026-09-27 was caused by
 * exactly that, in a diagnostic harness, which is why this is enforced here
 * rather than left to the caller.
 */

import { execFile } from "node:child_process";

/** A child environment with systemd's IPC handles removed. */
export function probeEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.NOTIFY_SOCKET;
  delete env.LISTEN_PID;
  delete env.LISTEN_FDS;
  delete env.LISTEN_FDNAMES;
  return env;
}

function runJournalctl(args, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "journalctl",
      args,
      { env: probeEnv(), maxBuffer, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `journalctl ${args.join(" ")} failed: ${stderr || error.message}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * All journal records the user manager emitted about `unit`, newest last.
 *
 * The match is on `USER_UNIT` plus `_COMM=systemd` rather than on
 * `_SYSTEMD_UNIT`. For a user unit the manager stamps its own records with
 * `_SYSTEMD_UNIT=user@<uid>.service` and puts the real unit in `USER_UNIT`, so
 * matching on `_SYSTEMD_UNIT=<unit>` silently returns nothing.
 */
export async function readUnitRecords(unit, { since } = {}) {
  const args = ["--user", "-o", "json", `USER_UNIT=${unit}`, "_COMM=systemd"];
  if (since) args.push("--since", since);
  const stdout = await runJournalctl(args);
  const records = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return records;
}
