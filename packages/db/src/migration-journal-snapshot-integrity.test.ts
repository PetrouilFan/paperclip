import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

// drizzle-kit keeps one snapshot per migration in `src/migrations/meta`, and it
// resolves the snapshot to diff against by reading the newest journal entry and
// opening the file that entry names. The snapshots before 0279 predate the
// convention, so only the newest entry has to resolve: that is the one file
// every `generate` and every drift check reads.
//
// The drift test in this folder already opens the newest snapshot, but it opens
// it to compare it with the schema. When the file is absent the open throws
// first, so the run ends in a bare ENOENT that names a path and not the cause.
// The same missing file then fails every branch built on this base, because the
// journal and the schema are what the check reads. This test isolates the
// precondition instead: it asserts the path resolves, so a break is reported as
// the journal entry that has no snapshot beside it.

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const metaDir = path.join(migrationsDir, "meta");

type JournalEntry = { idx: number; tag: string };

describe("migration journal snapshot integrity", () => {
  it("has a snapshot file for the newest journal entry", async () => {
    const journal = JSON.parse(
      await readFile(path.join(metaDir, "_journal.json"), "utf8"),
    ) as { entries: JournalEntry[] };
    const newest = journal.entries.at(-1);
    expect(newest, "migration journal has no entries").toBeDefined();

    const file = `${String(newest!.idx).padStart(4, "0")}_snapshot.json`;
    const snapshot = await readFile(path.join(metaDir, file), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        throw new Error(
          `The newest journal entry is ${newest!.tag} (idx ${newest!.idx}), but ` +
            `meta/${file} does not exist. drizzle-kit resolves the newest snapshot ` +
            `from that entry, so every generate and every drift check reads a path ` +
            `that is not there. Commit the snapshot for this entry. ` +
            `Cause: ${error.message}`,
        );
      },
    );

    expect(
      () => JSON.parse(snapshot) as unknown,
      `meta/${file} is not valid JSON`,
    ).not.toThrow();
  });
});
