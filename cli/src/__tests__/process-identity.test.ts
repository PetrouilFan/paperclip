import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readProcessStartedAt } from "../utils/process-identity.js";
// A test may import across the workspace boundary even though the bundle may
// not. That asymmetry is the whole reason the reader is duplicated rather than
// shared, and it is also the only thing that can hold the two copies together.
import {
  readProcessStartedAt as serverReadProcessStartedAt,
  writeHotRestartIntent,
} from "../../../server/src/services/hot-restart.js";

describe("readProcessStartedAt", () => {
  it("reads the inode change time on linux", async () => {
    const stat = async () => ({ ctimeMs: Date.parse("2026-09-25T00:29:58.000Z") });

    await expect(readProcessStartedAt(4242, { platform: "linux", stat })).resolves.toBe(
      "2026-09-25T00:29:58.000Z",
    );
  });

  it("returns null instead of throwing when the pid is gone", async () => {
    const stat = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };

    await expect(readProcessStartedAt(4242, { platform: "linux", stat })).resolves.toBeNull();
  });

  it("parses the ps lstart column on darwin as local time, like the server's reader", async () => {
    // `ps -o lstart=` prints local time with no zone. Both this reader and the
    // server's `asDateString` hand it to `Date.parse`, which reads it as local,
    // so the two agree on the instant -- which is the only property that
    // matters, since the server compares its own reading against this one.
    const local = new Date(2026, 8, 25, 0, 29, 58);
    const runCommand = async () => ({ stdout: "Fri Sep 25 00:29:58 2026\n" });

    await expect(readProcessStartedAt(4242, { platform: "darwin", runCommand })).resolves.toBe(
      local.toISOString(),
    );
  });

  it("returns null when the platform gives an unparseable start time", async () => {
    const runCommand = async () => ({ stdout: "not a date\n" });

    await expect(readProcessStartedAt(4242, { platform: "darwin", runCommand })).resolves.toBeNull();
  });

  it("falls through to pwsh when powershell.exe is absent on windows", async () => {
    const seen: string[] = [];
    const runCommand = async (file: string) => {
      seen.push(file);
      if (file === "powershell.exe") throw new Error("not found");
      return { stdout: "2026-09-25T00:29:58.000Z\n" };
    };

    await expect(readProcessStartedAt(4242, { platform: "win32", runCommand })).resolves.toBe(
      "2026-09-25T00:29:58.000Z",
    );
    expect(seen).toEqual(["powershell.exe", "pwsh.exe"]);
  });

  it("returns null on a platform it cannot read", async () => {
    await expect(readProcessStartedAt(4242, { platform: "aix" as NodeJS.Platform, runCommand: async () => ({ stdout: "" }) }))
      .resolves.toBeNull();
  });
});

// The rest of this file injects a fake `stat` / `runCommand` into each reader
// independently, which is exactly why nothing below this point could notice the
// two copies drifting apart: they each get whatever the test hands them, so any
// divergence whatsoever stays green. These cases drive the real readers against
// a real pid instead.
describe("readProcessStartedAt byte-equality with the server's copy", () => {
  it("agrees with the server on the pid the test itself is running as", async () => {
    // `isObservedHotRestartTargetAlive` compares the recorded start time to the
    // server's own reading of the same pid with `===`. A drift of even 1ms makes
    // that exact comparison miss, and the guard silently degrades to the coarse
    // "started before the request" ordering heuristic that admits a recycled pid.
    // The CLI is the only producer of `previousServerStartedAt` in the tree, so
    // this is the assertion the hot-restart guard actually rests on.
    await expect(readProcessStartedAt(process.pid)).resolves.toBe(
      await serverReadProcessStartedAt(process.pid),
    );
  });

  it("agrees on a second real pid, so the first is not a coincidence of process state", async () => {
    // pid 1 is a different process from this test, and exists on every unix host
    // the CLI supports. One live sample could agree by luck; two independent
    // ones agreeing is a property of the readers rather than of the moment.
    const cli = await readProcessStartedAt(1);
    if (cli === null) return; // Windows without a readable pid 1; nothing to compare.
    await expect(serverReadProcessStartedAt(1)).resolves.toBe(cli);
  });

  it("keeps the one deliberate difference: the CLI resolves null where the server throws", async () => {
    // The two readers are *meant* to fail differently, and this is the only
    // place that says so. The CLI is a best-effort fallback for a value the
    // health probe may already have supplied, so it resolves null; the server's
    // reader feeds a guard that must not proceed on a guess, so it throws.
    // Collapsing either side into the other is a behaviour change, and this
    // case is what would catch it being done silently.
    const absentPid = 0x7ffffffe;
    await expect(readProcessStartedAt(absentPid)).resolves.toBeNull();
    await expect(serverReadProcessStartedAt(absentPid)).rejects.toThrow();
  });

  it("still refuses an intent record with neither identity field", async () => {
    // The refusal the CLI's own refusal mirrors. If this ever stops throwing,
    // the CLI's message about "the server's own intent writer" becomes a lie and
    // the two refusals have silently diverged in the other direction.
    const dir = await mkdtemp(path.join(tmpdir(), "process-identity-"));
    try {
      await expect(writeHotRestartIntent({
        previousServerPid: process.pid,
        homeDir: dir,
        previousServerStartedAt: null,
        previousServerIdentity: null,
      })).rejects.toThrow(/boot identity and operating-system process start time are unavailable/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
