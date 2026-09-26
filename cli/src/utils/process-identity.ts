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
  const { stdout } = await execFileAsync(file, args, { timeout: 5_000 });
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
 * It returns `null` instead of throwing, because every caller here is a
 * best-effort fallback for a value the health probe may already have supplied.
 * A caller that cannot do without an identity must refuse rather than proceed
 * without one -- see `writeHotRestartIntent`.
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
