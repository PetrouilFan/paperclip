import { readdir, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// drizzle-kit writes one ~1.3 MB snapshot per migration into
// `src/migrations/meta`. Those files are the only record of the schema as it
// stood at each migration, and this repository tracks them.
//
// An earlier version of this ran as the last step of `pnpm db:generate`:
//
//   ls src/migrations/meta/*_snapshot.json | sort -r | tail -n +6 | xargs rm -f
//
// `tail -n +6` keeps the five newest and removes the rest, so the documented
// migration workflow deleted tracked files. In a migration commit the deletions
// sit next to the added migration and read as deliberate, and a reviewer has no
// signal that the command was the cause. The floor was already below the
// tracked set (7 snapshots on master), so every generate moved the window.
//
// Two things changed as a result:
//
// 1. `generate` no longer calls this at all. Pruning is not a side effect of
//    generating a migration.
// 2. When a contributor does run it on purpose, it will not delete a file git
//    tracks. It only reclaims snapshots that no longer belong to any commit,
//    which is what the command was ever useful for.

const SNAPSHOT_PATTERN = /^(\d+)_snapshot\.json$/;

export const DEFAULT_KEEP = 5;

export type PrunePlan = {
  /** Snapshot basenames that are untracked and outside the keep window. */
  readonly removable: readonly string[];
  /** Snapshot basenames that survive, newest first. */
  readonly kept: readonly string[];
  /** Candidates the prune refused to touch because git tracks them. */
  readonly trackedKept: readonly string[];
};

export class TrackedSetUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(
      `Refusing to prune migration snapshots: ${reason}. ` +
        `Without the tracked set every candidate would look untracked, so the ` +
        `command would delete committed files.`,
    );
    this.name = "TrackedSetUnavailableError";
  }
}

function git(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/**
 * Snapshots git tracks, as basenames, or null when the tracked set cannot be
 * read. Null is not an empty set: it means "unknown", and the caller must not
 * delete on an unknown. The two are kept distinct because the failure this
 * command guards against is deleting committed files, and a pathspec that
 * silently matches nothing turns a tracked file into a deletable one.
 *
 * Resolution is anchored on the worktree top level rather than on a relative
 * guess: a guess that is off by a level yields an empty result with a zero exit
 * status, which is indistinguishable from a repository that tracks nothing.
 */
export function readTrackedSnapshotNames(metaDir: string): Set<string> | null {
  const topLevel = git(["rev-parse", "--show-toplevel"], metaDir);
  if (topLevel === null) return null;

  const root = topLevel.trim();
  if (!root) return null;

  const relative = path.relative(root, path.resolve(metaDir));
  // A meta directory outside the worktree has no tracked set to speak of.
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  // `--full-name` reports paths relative to the top level regardless of cwd, and
  // the pathspec is handed to git from the top level, so neither depends on where
  // the caller happened to run from.
  const output = git(["ls-files", "-z", "--full-name", "--", relative], root);
  if (output === null) return null;
  return basenames(output);
}

function basenames(lsFilesOutput: string): Set<string> {
  const names = new Set<string>();
  for (const entry of lsFilesOutput.split("\0")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    names.add(path.basename(trimmed));
  }
  return names;
}

/**
 * Which candidates fall outside the keep window, and which of those are
 * tracked. Tracked files are never in `removable`; they are reported in
 * `trackedKept` so a caller can see the window is below the committed set.
 */
export function planPrune(options: {
  readonly snapshotFiles: readonly string[];
  readonly tracked: ReadonlySet<string>;
  readonly keep?: number;
}): PrunePlan {
  const keep = options.keep ?? DEFAULT_KEEP;
  const ordered = [...options.snapshotFiles].sort((a, b) => snapshotIndex(b) - snapshotIndex(a));
  const inWindow = ordered.slice(0, keep);
  const candidates = ordered.slice(keep);
  const removable: string[] = [];
  const trackedKept: string[] = [];
  for (const file of candidates) {
    if (options.tracked.has(file)) trackedKept.push(file);
    else removable.push(file);
  }
  return { removable, kept: inWindow, trackedKept };
}

function snapshotIndex(file: string): number {
  const match = SNAPSHOT_PATTERN.exec(file);
  if (!match) return -1;
  return Number.parseInt(match[1]!, 10);
}

export function isSnapshotFile(file: string): boolean {
  return SNAPSHOT_PATTERN.test(file);
}

export type PruneResult = PrunePlan & { readonly deleted: readonly string[]; readonly dryRun: boolean };

/**
 * Delete the snapshots outside the keep window that git does not track.
 * `metaDir` defaults to this package's own `src/migrations/meta`.
 */
export async function pruneMigrationSnapshots(options: {
  readonly metaDir?: string;
  readonly keep?: number;
  readonly dryRun?: boolean;
} = {}): Promise<PruneResult> {
  const metaDir = options.metaDir ?? fileURLToPath(new URL("./migrations/meta", import.meta.url));
  const tracked = readTrackedSnapshotNames(metaDir);
  if (tracked === null) {
    throw new TrackedSetUnavailableError("git could not list the tracked files");
  }

  const snapshotFiles = (await readdir(metaDir)).filter(isSnapshotFile).sort();
  const plan = planPrune({ snapshotFiles, tracked, keep: options.keep });

  const deleted: string[] = [];
  if (!options.dryRun) {
    for (const file of plan.removable) {
      await unlink(path.join(metaDir, file));
      deleted.push(file);
    }
  }
  return { ...plan, deleted, dryRun: options.dryRun === true };
}

function report(result: PruneResult): void {
  const verb = result.dryRun ? "would delete" : "deleted";
  for (const file of result.deleted) console.log(`prune: ${verb} ${file}`);
  for (const file of result.trackedKept) {
    console.log(
      `prune: kept ${file} — outside the keep window but tracked by git, so it is not this command's to remove`,
    );
  }
  if (result.deleted.length === 0 && result.trackedKept.length === 0) {
    console.log("prune: nothing to do");
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const keepArg = process.argv.find((arg) => arg.startsWith("--keep="));
  const keep = keepArg ? Number.parseInt(keepArg.slice("--keep=".length), 10) : undefined;
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
    console.error("prune: --keep must be an integer >= 1");
    process.exit(2);
  }
  const dryRun = process.argv.includes("--dry-run");
  try {
    report(await pruneMigrationSnapshots({ keep, dryRun }));
  } catch (error) {
    console.error(`prune: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
