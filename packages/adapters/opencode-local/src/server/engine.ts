import {
  asString,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";

/**
 * Engine identity for the `opencode` CLI that a run is about to spawn.
 *
 * Why this exists. The adapter resolves the CLI by bare name
 * (`asString(config.command, "opencode")`) and spawns it as-is. The only
 * pre-flight guard, `ensureAdapterExecutionTargetCommandResolvable`, proves the
 * name *resolves* — it never checks *which* binary resolved. On a host with two
 * engines installed, the OS picks by PATH order at every spawn, so a launch path
 * with a different PATH silently swaps the engine underneath the fleet.
 *
 * That failure is silent by construction. opencode v2.0.14 and v1.18.32 differ
 * in ways the adapter cannot detect from the outside: v2 never lists an
 * injected user-defined provider in `opencode models` (so the availability gate
 * rejects every run), and v2's managed service can answer `/api/info` with a
 * 500 whose body is otherwise valid — a state v2 treats as terminal, so one
 * wedged interactive service pins every later run on the host with
 * "Background service failed to start" and no respawn. Neither surfaces the
 * engine version that caused it.
 *
 * So: resolve the binary, read its version, and say so out loud. A wrong engine
 * is a configuration fact. It should be one clear line in the run log, not a
 * 32-minute fleet-wide outage reconstructed afterwards from two error strings.
 */

// `opencode --version` is a metadata call, not a generation. Both known engine
// builds answer it in well under a second, so this budget is generous on
// purpose: the probe runs on the critical path of every spawn and must not be
// the thing that adds latency.
const ENGINE_VERSION_PROBE_TIMEOUT_SEC = 10;
// The model-availability probe above treats "could not run" as non-fatal. The
// engine probe does too (see assertOpenCodeEngineVersion), so a hung probe has
// to resolve rather than inherit the spawn's own timeout.
const ENGINE_VERSION_PROBE_GRACE_SEC = 2;

export const OPENCODE_EXPECTED_MAJOR_VERSION_ENV_KEY = "PAPERCLIP_OPENCODE_EXPECTED_MAJOR";

export type OpenCodeEngineVersion = {
  /** The version string exactly as the engine printed it. */
  raw: string;
  major: number;
  minor: number;
  patch: number;
};

export type OpenCodeEngineProbe = {
  /** The binary that actually resolved, or null when the probe could not run. */
  resolvedPath: string | null;
  /** Parsed version, or null when the probe failed or the output was unparseable. */
  version: OpenCodeEngineVersion | null;
  /** Why the probe produced no version. Absent on success. */
  probeError?: string;
};

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/**
 * Parse an `opencode --version` line.
 *
 * Both engine generations are in the wild and they do not agree on a shape:
 *
 *   1.18.32            (v1.18.32, bare)
 *   opencode v2.0.14   (v2.0.14, prefixed)
 *
 * A pre-release or build suffix must not defeat the check, so a trailing
 * `-beta.3` / `+sha` is accepted and ignored. Scanning for the first
 * dotted-numeric token rather than anchoring to the whole line is what makes
 * both of the above work without a per-version special case.
 */
export function parseOpenCodeVersion(raw: string): OpenCodeEngineVersion | null {
  const text = raw.trim();
  if (!text) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return null;
  return {
    raw: text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * The major version this deployment requires, or null when it has not said.
 *
 * Read from `adapterConfig.expectedMajorVersion` first, then the
 * `PAPERCLIP_OPENCODE_EXPECTED_MAJOR` environment variable, so an operator can
 * pin the engine from a systemd drop-in without a per-agent config write.
 *
 * Null means "no opinion", and that is the default on purpose. Upstream cannot
 * know which engine version a given install requires, and failing every run on
 * the next opencode release would be a worse outage than the one this prevents.
 * The probe still runs and still logs in the unpinned case; only the hard stop
 * needs an explicit pin.
 */
export function resolveExpectedOpenCodeMajorVersion(input: {
  config?: unknown;
  env?: Record<string, string> | NodeJS.ProcessEnv;
}): number | null {
  const config = input.config as Record<string, unknown> | undefined;
  const env = input.env ?? {};
  const candidates: unknown[] = [
    config?.expectedMajorVersion,
    env[OPENCODE_EXPECTED_MAJOR_VERSION_ENV_KEY],
    process.env[OPENCODE_EXPECTED_MAJOR_VERSION_ENV_KEY],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const text = candidate.trim().replace(/^v/, "");
      // Accept a full version and reduce it to its major, so an operator who
      // pastes the value they see in `opencode --version` is not silently
      // ignored for having written "1.18.32" where "1" was meant.
      const parsed = parseOpenCodeVersion(text) ?? (/^\d+$/.test(text) ? { major: Number(text) } : null);
      if (parsed && Number.isInteger(parsed.major) && parsed.major >= 0) return parsed.major;
    }
  }
  return null;
}

/**
 * Read the engine's own version. Never throws.
 *
 * A probe that cannot run is reported, not raised, for the same reason the
 * model-availability probe is best-effort: this diagnostic must never be the
 * cause of a failed run.
 */
export async function probeOpenCodeEngineVersion(input: {
  command: string;
  resolvedPath?: string;
  cwd: string;
  env: Record<string, string>;
  onLogError?: (err: unknown, runId: string, message: string) => void;
}): Promise<OpenCodeEngineProbe> {
  const resolvedPath = input.resolvedPath ?? null;
  const label = `opencode-engine-version-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let result: Awaited<ReturnType<typeof runChildProcess>>;
  try {
    const probeEnv: Record<string, string> = {};
    const merged = ensurePathInEnv({ ...process.env, ...input.env });
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value === "string") probeEnv[key] = value;
    }
    result = await runChildProcess(label, input.command, ["--version"], {
      cwd: input.cwd,
      env: probeEnv,
      timeoutSec: ENGINE_VERSION_PROBE_TIMEOUT_SEC,
      graceSec: ENGINE_VERSION_PROBE_GRACE_SEC,
      onLog: async () => {},
      onLogError: input.onLogError,
    });
  } catch (err) {
    return {
      resolvedPath,
      version: null,
      probeError: err instanceof Error ? err.message : String(err),
    };
  }

  if (result.timedOut) {
    return {
      resolvedPath,
      version: null,
      probeError: `\`${input.command} --version\` timed out after ${ENGINE_VERSION_PROBE_TIMEOUT_SEC}s.`,
    };
  }
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    return {
      resolvedPath,
      version: null,
      probeError: detail
        ? `\`${input.command} --version\` exited ${result.exitCode}: ${detail}`
        : `\`${input.command} --version\` exited ${result.exitCode}.`,
    };
  }

  // stdout first, stderr as the fallback: a version banner is metadata, and a
  // CLI that prints it on stderr should still be identified rather than
  // reported as unprobeable.
  const version =
    parseOpenCodeVersion(result.stdout) ?? parseOpenCodeVersion(result.stderr);
  if (!version) {
    return {
      resolvedPath,
      version: null,
      probeError:
        `\`${input.command} --version\` succeeded but printed no recognisable version ` +
        `(stdout: ${JSON.stringify(firstNonEmptyLine(result.stdout))}, ` +
        `stderr: ${JSON.stringify(firstNonEmptyLine(result.stderr))}).`,
    };
  }
  return { resolvedPath, version };
}

/**
 * Log the resolved engine on every run, and fail the run when the resolved
 * engine contradicts an explicit pin.
 *
 * The log line is unconditional. It is the difference between "the fleet
 * reported two unrelated error signatures for 32 minutes" and "the first run
 * after the PATH changed said which engine it got".
 */
export async function assertOpenCodeEngineVersion(input: {
  command: string;
  resolvedCommand?: string;
  config?: unknown;
  cwd: string;
  env: Record<string, string>;
  expectedMajor?: number | null;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onLogError?: (err: unknown, runId: string, message: string) => void;
}): Promise<OpenCodeEngineProbe> {
  const expectedMajor =
    input.expectedMajor === undefined
      ? resolveExpectedOpenCodeMajorVersion({ config: input.config, env: input.env })
      : input.expectedMajor;
  const resolvedCommand =
    input.resolvedCommand && input.resolvedCommand.length > 0
      ? input.resolvedCommand
      : input.command;
  const probe = await probeOpenCodeEngineVersion({
    command: input.command,
    resolvedPath: resolvedCommand,
    cwd: input.cwd,
    env: input.env,
    onLogError: input.onLogError,
  });

  const where = `command=${input.command} resolved=${resolvedCommand}`;
  if (!probe.version) {
    // Not fatal. An engine that will not report its version is not thereby a
    // wrong engine, and refusing to run on that basis would turn a diagnostic
    // into an outage. Recorded so a later reader can see the probe was tried.
    await input.onLog(
      "stderr",
      `[opencode-local] Engine version could not be read (${where}): ${probe.probeError ?? "unknown reason"}` +
        `${expectedMajor === null ? "" : ` Expected major ${expectedMajor}.`} Continuing.\n`,
    );
    return probe;
  }

  const actual = `${probe.version.major}.${probe.version.minor}.${probe.version.patch}`;
  if (expectedMajor === null) {
    await input.onLog(
      "stdout",
      `[opencode-local] Engine: ${resolvedCommand} (opencode ${actual})\n`,
    );
    return probe;
  }

  if (probe.version.major !== expectedMajor) {
    throw new Error(
      `OpenCode engine major version mismatch: \`${input.command}\` resolved to ` +
        `${resolvedCommand}, which reports opencode ${actual}, but major ${expectedMajor} is required. ` +
        `Set \`adapterConfig.command\` to the absolute path of the intended engine, or set ` +
        `\`adapterConfig.expectedMajorVersion\` (or ${OPENCODE_EXPECTED_MAJOR_VERSION_ENV_KEY}) to the ` +
        `major version this deployment actually requires. Refusing to run: an unexpected engine ` +
        `changes the model catalog and the background-service lifecycle, so the run would fail ` +
        `later with an error that does not name the cause.`,
    );
  }

  await input.onLog(
    "stdout",
    `[opencode-local] Engine: ${resolvedCommand} (opencode ${actual}, major ${expectedMajor} pinned)\n`,
  );
  return probe;
}

/** Exported for the adapter's config-schema surface. */
export const openCodeEngineConfigKeyDescription =
  "expectedMajorVersion: require the resolved `opencode` binary to report this major version. " +
  "Omit to only log the resolved engine. Prefer an absolute `command` over a version pin when " +
  "both are possible — the pin detects a wrong engine, the absolute path prevents one.";
