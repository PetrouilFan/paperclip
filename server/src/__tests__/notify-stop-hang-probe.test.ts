import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The production signature this suite exists for, automated. The signature was
 * first reproduced by hand on a throwaway `systemd-run --user` unit; see
 * `tools/service-stop-attribution/README.md` for the journal signatures and
 * `scripts/paperclip-unit-guardian.sh` for the operational half.
 *
 * A throwaway `Type=notify` unit sends its own `STOPPING=1` and then hangs. With
 * no external actor, systemd bills the full `TimeoutStopSec` and SIGKILLs the
 * cgroup: the journal shows `Result=timeout`, no `Stopping <unit>` job line, and
 * no signal ever delivered. The fix is supposed to make that impossible from the
 * application side, so the assertion here is not "the unit stopped" — it is that
 * the recorded outcome is an **exit**, not a **timeout**.
 *
 * The unit runs the real shutdown path: `fixtures/shutdown-hang-harness.mjs`
 * imports `server/src/shutdown.ts` and `services/systemd-notify.ts` directly and
 * only replaces one dependency per arm with one that never settles.
 *
 * | arm        | what never settles                       | which fix is load-bearing                   |
 * |------------|------------------------------------------|---------------------------------------------|
 * | `notify`   | the `systemd-notify` child               | site 1, the bounded `execFile`              |
 * | `scheduler`| an execution-control sweep               | site 2, the deadline on the idle wait       |
 * | `drain`    | an in-flight agent run                   | site 3, the deadline below the stop budget  |
 *
 * `TimeoutStopSec=8` keeps the test quick. The *relation* between the drain
 * budget and the real 300 s unit value is asserted separately, against the
 * rendered unit, in `shutdown-stop-budget.test.ts`.
 *
 * `KillMode=control-group` is deliberate: it is the production blast radius the
 * ticket names, and it is what turns a hung stop into a cgroup-wide SIGKILL
 * rather than a single-process kill.
 *
 * This suite needs a systemd user manager. It skips when there is not one, and
 * the skip says so on stderr — a skipped AC4 is an unverified AC4, not a pass.
 */

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const harness = path.join(here, "fixtures/shutdown-hang-harness.mjs");
const serverRoot = path.resolve(here, "../..");

const STOP_TIMEOUT_SEC = 8;
const UNIT_PREFIX = "paperclip-shutdown-probe-";

/**
 * The absolute `tsx` ESM loader, resolved from this package rather than from
 * `cwd`. The unit's working directory is systemd's `$HOME`, not the repo, and a
 * bare `--import tsx` there would fail to resolve — which would make the probe
 * exit 1 on an import error and "pass" for the wrong reason.
 */
const tsxLoader = path.join(
  path.dirname(require.resolve("tsx/package.json")),
  "dist/loader.mjs",
);

async function createProbeUnit(name: string, mode: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "systemd-run",
    [
      "--user",
      `--unit=${name}`,
      "--wait",
      // No `--collect`: it unloads the unit the moment it finishes, taking the
      // very properties this test reads with it.
      "--property=Type=notify",
      "--property=NotifyAccess=all",
      `--property=TimeoutStopSec=${STOP_TIMEOUT_SEC}`,
      "--property=KillMode=control-group",
      "--property=Restart=no",
      "--property=SyslogIdentifier=paperclip-shutdown-probe",
      process.execPath,
      "--import",
      tsxLoader,
      harness,
      mode,
      String(STOP_TIMEOUT_SEC),
    ],
    {
      env: { ...process.env, PAPERCLIP_PROBE_UNIT: `${name}.service` },
      timeout: STOP_TIMEOUT_SEC * 8_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return stdout.trim() || `${name}.service`;
}

/**
 * What systemd recorded for a finished unit.
 *
 * `Result` is the whole point: `success` means the process exited on its own,
 * `timeout` means the stop budget expired and the cgroup was SIGKILLed. Parsed
 * from `key=value` lines rather than `--value`, because `show --value` answers
 * in alphabetical property order rather than the order they were requested in,
 * and this test has read the wrong field that way before.
 */
async function readUnitState(unit: string) {
  const { stdout } = await execFileAsync("systemctl", [
    "--user",
    "show",
    unit,
    "--property=Result",
    "--property=ExecMainCode",
    "--property=ExecMainStatus",
    "--property=SubState",
  ]);
  const state: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) state[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return state;
}

async function systemctlAvailable(): Promise<boolean> {
  // `is-system-running` is the wrong probe: a host with one unrelated failed
  // user unit answers `degraded` and exits 1 while the manager is perfectly able
  // to run transient units. Reading a property off the manager is the check that
  // actually matches what this suite needs.
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["--user", "show", "--property=Version", "--value"],
      { timeout: 5_000 },
    );
    if (stdout.trim().length === 0) return false;
  } catch {
    return false;
  }
  try {
    require.resolve("tsx/package.json");
    return true;
  } catch {
    return false;
  }
}

const available = await systemctlAvailable();

describe.skipIf(!available)(
  "a Type=notify unit that self-sends STOPPING=1 and hangs still exits instead of being SIGKILLed",
  () => {
    const created: string[] = [];

    afterAll(async () => {
      // A probe that failed before it finished should not leave a unit
      // registered against the user bus.
      await Promise.all(
        created.flatMap((unit) => [
          execFileAsync("systemctl", ["--user", "stop", unit], { timeout: 20_000 }).catch(
            () => undefined,
          ),
          execFileAsync("systemctl", ["--user", "reset-failed", unit], { timeout: 20_000 }).catch(
            () => undefined,
          ),
        ]),
      );
    });

    for (const mode of ["notify", "scheduler", "drain"] as const) {
      it(`records an exit, not a TimeoutStopSec kill, when the ${mode} await hangs`, async () => {
        const name = `${UNIT_PREFIX}${mode}-${process.pid}`;
        const unit = await createProbeUnit(name, mode);
        created.push(unit);

        const state = await readUnitState(unit);

        // The assertion the acceptance criteria ask for: the *reason* is exit,
        // not timeout. `Result=timeout` with `SubState=dead` is the cgroup
        // SIGKILL, and it is what the pre-fix path produced on this same probe.
        expect(
          { unit, ...state },
          `unit ${unit} did not exit cleanly after the ${mode} await hung`,
        ).toMatchObject({
          // `Result=timeout` with `SubState=dead` is the cgroup SIGKILL, and it
          // is what the pre-fix path produced on this same probe.
          Result: "success",
          // `ExecMainCode` is a raw `uint32` on the bus, not the `exited`
          // label `systemctl status` prints. 0 is `CLD_EXITED`; a SIGKILLed
          // unit reports 9 (`CLD_KILLED`) with `Result=timeout`.
          ExecMainCode: "0",
          ExecMainStatus: "0",
        });
      }, (STOP_TIMEOUT_SEC + 30) * 1000);
    }
  },
);

if (!available) {
  console.warn(
    "[shutdown-probe] no systemd user manager / tsx loader; the STOPPING=1 throwaway-unit probe did NOT run. " +
      "Acceptance criterion 4 is UNVERIFIED in this environment, not passing.",
  );
}
