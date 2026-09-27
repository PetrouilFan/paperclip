import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_KEEP,
  TrackedSetUnavailableError,
  planPrune,
  pruneMigrationSnapshots,
  readTrackedSnapshotNames,
} from "./prune-migration-snapshots.js";

// `pnpm db:generate` used to end in a prune that kept the five newest
// snapshots and deleted the rest. Master tracks more than five, so the
// documented migration workflow deleted committed files, and in a migration
// commit those deletions sit beside the added migration and read as
// deliberate. Nothing failed: the files were simply gone.
//
// Two invariants are pinned here. The generate chain must not reach a prune at
// all, and a prune that is run on purpose must not delete anything git tracks.

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

const snapshot = (idx: number) => `${String(idx).padStart(4, "0")}_snapshot.json`;

describe("migration snapshot prune wiring", () => {
  it("does not run a prune as part of generating a migration", () => {
    expect(
      packageJson.scripts.generate,
      "`generate` must not delete files; pruning is a separate command a contributor names on purpose",
    ).not.toMatch(/prune/);
  });

  it("routes prune:snapshots at the script that respects the tracked set", () => {
    expect(packageJson.scripts["prune:snapshots"]).toContain("prune-migration-snapshots.ts");
  });
});

describe("planPrune", () => {
  it("keeps the keep window, newest first", () => {
    const plan = planPrune({
      snapshotFiles: [snapshot(1), snapshot(2), snapshot(3)],
      tracked: new Set([snapshot(2), snapshot(3)]),
      keep: 2,
    });
    expect(plan.kept).toEqual([snapshot(3), snapshot(2)]);
    expect(plan.removable).toEqual([snapshot(1)]);
  });

  it("never places a tracked file in the removable set, whatever the keep window", () => {
    // Everything is tracked and everything falls outside a window of one.
    const tracked = new Set([snapshot(1), snapshot(2), snapshot(3)]);
    const plan = planPrune({ snapshotFiles: [...tracked], tracked, keep: 1 });
    expect(plan.removable).toEqual([]);
    expect(plan.trackedKept).toHaveLength(2);
  });

  it("reports a tracked file that falls outside the window instead of deleting it", () => {
    const tracked = new Set([snapshot(1), snapshot(2), snapshot(3), snapshot(4)]);
    const plan = planPrune({ snapshotFiles: [...tracked], tracked, keep: 2 });
    expect(plan.removable).toEqual([]);
    expect([...plan.trackedKept].sort()).toEqual([snapshot(1), snapshot(2)]);
  });

  it("deletes an untracked file outside the window", () => {
    // 0002 is the only untracked one, so it is the only removable one.
    const tracked = new Set([snapshot(1), snapshot(3), snapshot(4), snapshot(5), snapshot(6), snapshot(7)]);
    const plan = planPrune({
      snapshotFiles: [...tracked, snapshot(2)],
      tracked,
      keep: 5,
    });
    expect(plan.removable).toEqual([snapshot(2)]);
  });

  it("leaves an under-full window alone", () => {
    const tracked = new Set([snapshot(1), snapshot(2)]);
    const plan = planPrune({ snapshotFiles: [...tracked], tracked, keep: 5 });
    expect(plan.removable).toEqual([]);
    expect(plan.trackedKept).toEqual([]);
    expect(plan.kept).toEqual([snapshot(2), snapshot(1)]);
  });

  it("defaults to a keep window of five", () => {
    expect(DEFAULT_KEEP).toBe(5);
  });
});

describe("pruneMigrationSnapshots against a real git worktree", () => {
  let repo = "";
  let metaDir = "";

  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  const snapshotsInTree = async () =>
    (await readdir(metaDir)).filter((file) => file.endsWith("_snapshot.json")).sort();

  /**
   * A worktree holding `total` snapshots of which the lowest `trackedCount` are
   * committed. The rest are leftovers from an abandoned branch — the only files
   * a prune is ever entitled to remove.
   */
  const makeRepo = async (total: number, trackedCount: number) => {
    repo = await mkdtemp(path.join(tmpdir(), "snapshot-prune-"));
    metaDir = path.join(repo, "packages", "db", "src", "migrations", "meta");
    await mkdir(metaDir, { recursive: true });
    git("init", "--quiet");
    git("config", "user.email", "prune@example.test");
    git("config", "user.name", "Prune Test");
    for (let idx = 1; idx <= total; idx += 1) {
      await writeFile(
        path.join(metaDir, snapshot(idx)),
        JSON.stringify({ version: "7", dialect: "postgresql", tables: {} }),
      );
    }
    if (trackedCount > 0) {
      const tracked = Array.from({ length: trackedCount }, (_, i) =>
        path.join("packages", "db", "src", "migrations", "meta", snapshot(i + 1)),
      );
      git("add", ...tracked);
      git("commit", "--quiet", "-m", "snapshots");
    }
  };

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("leaves every tracked snapshot in place, where the old command deleted two", async () => {
    // Mirrors master: 7 committed snapshots against a keep window of 5.
    await makeRepo(7, 7);
    const result = await pruneMigrationSnapshots({ metaDir, keep: 5 });

    expect(result.removable).toEqual([]);
    expect(result.deleted).toEqual([]);
    // Exactly what `ls ... | sort -r | tail -n +6 | xargs rm -f` would have removed.
    expect([...result.trackedKept].sort()).toEqual([snapshot(1), snapshot(2)]);
    expect(await snapshotsInTree()).toHaveLength(7);
    expect(git("status", "--porcelain").trim()).toBe("");
  });

  it("removes untracked leftovers outside the window and keeps every tracked file", async () => {
    // 0001-0003 committed; 0004-0007 are an abandoned branch's leftovers.
    await makeRepo(7, 3);
    const result = await pruneMigrationSnapshots({ metaDir, keep: 2 });

    expect(result.removable).toEqual([snapshot(5), snapshot(4)]);
    expect(result.deleted).toEqual([snapshot(5), snapshot(4)]);
    expect([...result.trackedKept].sort()).toEqual([snapshot(1), snapshot(2), snapshot(3)]);

    const remaining = await snapshotsInTree();
    expect(remaining).toEqual([snapshot(1), snapshot(2), snapshot(3), snapshot(6), snapshot(7)]);
    // The survivors that are still untracked are leftovers by design; what must
    // hold is that no tracked file was removed or modified.
    expect(git("status", "--porcelain", "--untracked-files=no").trim()).toBe("");
  });

  it("leaves the tree untouched on a dry run", async () => {
    await makeRepo(7, 3);
    const result = await pruneMigrationSnapshots({ metaDir, keep: 2, dryRun: true });

    expect(result.removable).toEqual([snapshot(5), snapshot(4)]);
    expect(result.deleted).toEqual([]);
    expect(await snapshotsInTree()).toHaveLength(7);
  });

  it("never touches _journal.json", async () => {
    await makeRepo(7, 7);
    const journal = JSON.stringify({ version: "7", dialect: "postgresql", entries: [] });
    await writeFile(path.join(metaDir, "_journal.json"), journal);
    git("add", "-f", path.join(metaDir, "_journal.json"));
    git("commit", "--quiet", "-m", "journal");

    const result = await pruneMigrationSnapshots({ metaDir, keep: 1 });
    expect(result.removable).not.toContain("_journal.json");
    expect(await readFile(path.join(metaDir, "_journal.json"), "utf8")).toBe(journal);
  });

  it("resolves the same tracked set regardless of the directory it is called from", async () => {
    // The tracked set must not depend on where the command was invoked from: an
    // earlier revision derived a repo root by counting path segments, and being
    // off by one produced an empty set with a zero exit status — indistinguishable
    // from a repository that tracks nothing, which is the direction that deletes.
    await makeRepo(5, 5);
    const fromMeta = readTrackedSnapshotNames(metaDir);
    const fromPackage = readTrackedSnapshotNames(path.join(repo, "packages", "db"));
    const fromSrc = readTrackedSnapshotNames(path.join(repo, "packages", "db", "src"));

    expect(fromMeta).toBeInstanceOf(Set);
    expect(fromPackage).toEqual(fromMeta);
    expect(fromSrc).toEqual(fromMeta);
    expect(fromMeta!.size).toBe(5);
  });

  it("reports a directory outside the worktree as unknown rather than empty", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "snapshot-prune-outside-"));
    try {
      // A real repository, and a meta directory that is not in it. An empty set
      // here would authorise deleting every snapshot in that directory.
      await makeRepo(5, 5);
      expect(readTrackedSnapshotNames(outside)).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("treats an empty tracked set as empty, not as unknown", async () => {
    // A worktree with nothing committed: every snapshot is genuinely untracked,
    // so the prune is entitled to remove the ones outside the window.
    await makeRepo(3, 0);
    expect(readTrackedSnapshotNames(metaDir)).toEqual(new Set());

    const result = await pruneMigrationSnapshots({ metaDir, keep: 1 });
    expect(result.deleted).toEqual([snapshot(2), snapshot(1)]);
    expect(await snapshotsInTree()).toEqual([snapshot(3)]);
  });

  it("raises rather than deleting when the tracked set cannot be read", async () => {
    // The unknown case. Every candidate would look untracked, so the command
    // must stop rather than delete committed files on a guess.
    const notARepo = await mkdtemp(path.join(tmpdir(), "snapshot-prune-none-"));
    try {
      const notAMeta = path.join(notARepo, "meta");
      await mkdir(notAMeta);
      await writeFile(path.join(notAMeta, snapshot(1)), "{}");
      await writeFile(path.join(notAMeta, snapshot(2)), "{}");

      const originalPath = process.env.PATH;
      process.env.PATH = path.join(notARepo, "empty-bin");
      try {
        await expect(
          pruneMigrationSnapshots({ metaDir: notAMeta, keep: 1 }),
        ).rejects.toBeInstanceOf(TrackedSetUnavailableError);
      } finally {
        process.env.PATH = originalPath;
      }
      expect(await readdir(notAMeta)).toHaveLength(2);
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});

describe("the committed tree survives a real prune", () => {
  it("deletes nothing from this package's own meta directory", async () => {
    // The regression in its own shape: run the command against the tree the
    // repository actually ships, and assert no tracked file is removed.
    const realMeta = fileURLToPath(new URL("./migrations/meta", import.meta.url));
    const before = (await readdir(realMeta)).filter((file) => file.endsWith("_snapshot.json")).sort();

    const result = await pruneMigrationSnapshots({ metaDir: realMeta, dryRun: true });

    // Nothing is removable, and the two files the old `tail -n +6` command would
    // have destroyed are named as tracked so the protection is visible.
    expect(result.removable).toEqual([]);
    expect(result.trackedKept.length).toBeGreaterThan(0);
    for (const file of result.trackedKept) expect(before).toContain(file);

    const after = (await readdir(realMeta)).filter((file) => file.endsWith("_snapshot.json")).sort();
    expect(after).toEqual(before);
  });
});
