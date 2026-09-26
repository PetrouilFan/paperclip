import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessStatReader = (target: string) => Promise<{ ctimeMs: number }>;
export type ProcessCommandRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string }>;

export type ReadProcessStartedAtOptions = {
  platform?: NodeJS.Platform;
  stat?: ProcessStatReader;
  runCommand?: ProcessCommandRunner;
};

function asDateString(value: string | null | undefined): string | null {
  const parsed = Date.parse((value ?? "").trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const defaultRunCommand: ProcessCommandRunner = async (file, args) => {
  // Same options as the server's `runProcessCommand` (hot-restart.ts). The
  // value is unaffected -- `promisify(execFile)` already defaults to a utf8
  // string -- but `windowsHide` is the difference between a console flash on
  // every Windows restart and none, and an unexplained 3.3x timeout is not
  // something a file whose purpose is faithful duplication should carry.
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    timeout: 1_500,
    windowsHide: true,
  });
  return { stdout };
};

/**
 * The operating system's start time for a pid, or `null` when it cannot be
 * established.
 *
 * This mirrors the server's `readProcessStartedAt` deliberately: the two must
 * agree on the value, because the server compares its own reading of the same
 * pid against the one a restart intent recorded. The CLI keeps its own copy
 * rather than importing `@paperclipai/server`, whose entry point pulls the
 * whole server into the CLI bundle; the shared extraction is tracked as
 * follow-up work.
 *
 * That agreement is asserted, not assumed: `cli/src/__tests__/process-identity.test.ts`
 * imports the server's reader across the workspace boundary and runs both over
 * the same pid. Editing either side without the other turns that suite red.
 * `isObservedHotRestartTargetAlive` compares the two values with `===`, so even
 * a 1 ms drift silently degrades the hot-restart guard to its coarse ordering
 * heuristic rather than failing anything on its own.
 *
 * It returns `null` instead of throwing, because every caller here is a
 * best-effort fallback for a value the health probe may already have supplied.
 * A caller that cannot do without an identity must refuse rather than proceed
 * without one -- see `writeHotRestartIntent`. That one difference from the
 * server, which throws, is pinned by the same suite.
 */
export async function readProcessStartedAt(
  pid: number,
  options: ReadProcessStartedAtOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const stat = options.stat ?? (fs.stat as ProcessStatReader);
  const runCommand = options.runCommand ?? defaultRunCommand;

  if (platform === "linux") {
    try {
      const processStat = await stat(`/proc/${pid}`);
      return asDateString(new Date(processStat.ctimeMs).toISOString());
    } catch {
      return null;
    }
  }

  if (["darwin", "freebsd", "openbsd", "aix", "sunos"].includes(platform)) {
    try {
      const { stdout } = await runCommand("ps", ["-o", "lstart=", "-p", String(pid)]);
      return asDateString(stdout);
    } catch {
      return null;
    }
  }

  if (platform === "win32") {
    const script = [
      `$process = Get-Process -Id ${pid} -ErrorAction Stop`,
      "$process.StartTime.ToUniversalTime().ToString('o')",
    ].join("; ");
    for (const shell of ["powershell.exe", "pwsh.exe"]) {
      try {
        const { stdout } = await runCommand(shell, [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          script,
        ]);
        const parsed = asDateString(stdout);
        if (parsed) return parsed;
      } catch {
        // Try the next shell.
      }
    }
    return null;
  }

  return null;
}
