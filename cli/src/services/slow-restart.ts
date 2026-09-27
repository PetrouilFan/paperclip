import fs from "node:fs/promises";
import path from "node:path";

/**
 * AC4's floor: an end-to-end restart that takes the service down longer than
 * this has to raise something a human will actually see. It is a floor for the
 * criterion, not a target, and the two are not the same number -- see
 * `SLOW_RESTART_THRESHOLD_MS`'s note on severity for why a threshold that fires
 * on every restart is not the same as no signal at all.
 */
export const SLOW_RESTART_THRESHOLD_MS = 30_000;

/**
 * How far past the threshold a restart has to be before it is reported as
 * `severe` rather than `slow`.
 *
 * The measured routine restart on this host took 520s (2026-09-27,
 * `journalctl --user -u paperclipai.service`, `Starting` 01:07:04 to `Started`
 * 01:15:44, against `TimeoutStartSec=600`). A single undifferentiated "slow"
 * verdict covers a 31s blip and a 520s restart that consumed 87% of the unit's
 * entire start budget, and an operator cannot tell from that which one they are
 * looking at. The exact milliseconds are recorded either way; severity only
 * decides how loudly the same fact is stated.
 */
export const SLOW_RESTART_SEVERE_MULTIPLIER = 4;

export type RestartSeverity = "ok" | "slow" | "severe";

export type ServiceRestartOutcome = {
  serviceName: string;
  platform: "systemd" | "launchd";
  requestedAt: string;
  completedAt: string;
  elapsedMs: number;
  thresholdMs: number;
  severity: RestartSeverity;
  /**
   * Whether the platform reported the unit back as running before the
   * measurement closed. `systemctl restart` blocks on the whole start job, so
   * this is `true` by construction there. `launchctl kickstart -k` is
   * asynchronous -- it returns once the job is submitted, not once the agent is
   * up -- so the launchd manager polls and this is the honest answer to
   * "did we measure a settled restart or a submitted one".
   */
  settled: boolean;
};

export type SlowRestartRecord = ServiceRestartOutcome & {
  version: 1;
  instanceId: string;
  previousServerPid: number | null;
  previousServerStartedAt: string | null;
};

/**
 * `ok` below the threshold, `slow` at or above it, `severe` at
 * `threshold * SLOW_RESTART_SEVERE_MULTIPLIER`.
 *
 * A non-finite elapsed is `ok` rather than `severe`: a clock that did not
 * measure anything has not observed a slow restart, and reporting it as one
 * would put an unmeasured restart into the durable record as a fact.
 */
export function classifyRestartDowntime(
  elapsedMs: number,
  thresholdMs: number = SLOW_RESTART_THRESHOLD_MS,
): RestartSeverity {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(thresholdMs)) return "ok";
  if (elapsedMs < thresholdMs) return "ok";
  return elapsedMs >= thresholdMs * SLOW_RESTART_SEVERE_MULTIPLIER ? "severe" : "slow";
}

export function slowRestartRecordPath(instanceRoot: string): string {
  return path.join(instanceRoot, "service-restart-slow.json");
}

export function formatSlowRestartMessage(record: SlowRestartRecord, instanceRoot = "<instance root>"): string {
  const seconds = (record.elapsedMs / 1000).toFixed(record.elapsedMs < 10_000 ? 2 : 1);
  const threshold = record.thresholdMs < 10_000
    ? (record.thresholdMs / 1000).toFixed(2)
    : String(Math.round(record.thresholdMs / 1000));
  const settled = record.settled ? "" : " (the platform never reported the service running again before the measurement closed)";
  return `${record.severity === "severe" ? "SEVERE" : "SLOW"} RESTART: ${record.serviceName} was down for ${seconds}s, `
    + `over the ${threshold}s threshold${settled}. `
    + `Requested ${record.requestedAt}, back up ${record.completedAt}. `
    + `Every run in flight for that window was lost to process_lost, and no human was told. `
    + `Recorded at ${slowRestartRecordPath(instanceRoot)} -- run \`paperclipai doctor\` to see it.`;
}

export async function writeSlowRestartRecord(instanceRoot: string, record: SlowRestartRecord): Promise<void> {
  await fs.mkdir(instanceRoot, { recursive: true, mode: 0o700 });
  const target = slowRestartRecordPath(instanceRoot);
  const temporary = path.join(instanceRoot, `.service-restart-slow.json.tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readSlowRestartRecord(instanceRoot: string): Promise<SlowRestartRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(slowRestartRecordPath(instanceRoot), "utf8")) as Partial<SlowRestartRecord>;
    if (typeof parsed?.elapsedMs !== "number" || typeof parsed?.completedAt !== "string") return null;
    return {
      version: 1,
      instanceId: String(parsed.instanceId ?? ""),
      serviceName: String(parsed.serviceName ?? "unknown"),
      platform: parsed.platform === "launchd" ? "launchd" : "systemd",
      requestedAt: String(parsed.requestedAt ?? ""),
      completedAt: parsed.completedAt,
      elapsedMs: parsed.elapsedMs,
      thresholdMs: typeof parsed.thresholdMs === "number" ? parsed.thresholdMs : SLOW_RESTART_THRESHOLD_MS,
      severity: parsed.severity === "severe" || parsed.severity === "slow" ? parsed.severity : classifyRestartDowntime(parsed.elapsedMs),
      settled: parsed.settled !== false,
      previousServerPid: typeof parsed.previousServerPid === "number" ? parsed.previousServerPid : null,
      previousServerStartedAt: typeof parsed.previousServerStartedAt === "string" ? parsed.previousServerStartedAt : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export type SlowRestartEmitDeps = {
  /** Where the durable record goes. */
  instanceRoot: string;
  /** Best-effort platform log append; a failure here must never mask the restart result. */
  runner?: (command: string, args: string[]) => Promise<unknown>;
  /** The unit's own log file, where the platform has one (launchd's stderrPath). */
  logPath?: string | null;
  writeStderr?: (line: string) => void;
};

/**
 * Raise a slow-restart fact on every channel that reaches past this process,
 * and on none that can lose it.
 *
 * The ordering is deliberate: the durable record is written first and
 * synchronously, because it is the only channel that survives this process
 * exiting, a redirected stdout, and a service that never comes back. The
 * platform log append is best-effort and last, because it is the only channel
 * that fails for reasons outside this function's control. Nothing here depends
 * on the Paperclip server being reachable: on this host the server was down for
 * the entire window being reported, so a channel that needs the server to be up
 * is a channel that cannot report the worst case.
 *
 * Rejected on purpose: a systemd `OnFailure=` drop-in. It cannot cover the
 * measured case at all. `OnFailure=` fires when a unit *fails*, and the 520s
 * restart under investigation succeeded -- `ActiveState=active`, journal pair
 * `Starting` then `Started`. A restart only trips `OnFailure=` once it has
 * already exceeded `TimeoutStartSec=600` and been killed, which is a
 * different and much later failure than AC4 asks about. systemd has no
 * "this start was slow" directive; the only way to get one is to compare two
 * timestamps, and the process that has both is the one that waited.
 */
export async function emitSlowRestartSignal(record: SlowRestartRecord, deps: SlowRestartEmitDeps): Promise<void> {
  const message = formatSlowRestartMessage(record, deps.instanceRoot);
  await writeSlowRestartRecord(deps.instanceRoot, record);
  (deps.writeStderr ?? ((line: string) => process.stderr.write(`${line}\n`)))(message);
  if (deps.logPath) {
    await fs.appendFile(deps.logPath, `${message}\n`, { encoding: "utf8" }).catch(() => undefined);
  }
  if (deps.runner) {
    const priority = record.severity === "severe" ? "err" : "warning";
    await deps.runner("systemd-cat", ["-p", priority, "-t", "paperclipai-slow-restart", "--", message]).catch(() => undefined);
  }
}
