import { describe, expect, it } from "vitest";
import { readProcessStartedAt } from "../utils/process-identity.js";

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
