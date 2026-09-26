import { afterEach, describe, expect, it, vi } from "vitest";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import {
  OPENCODE_EXPECTED_MAJOR_VERSION_ENV_KEY,
  assertOpenCodeEngineVersion,
  parseOpenCodeVersion,
  probeOpenCodeEngineVersion,
  resolveExpectedOpenCodeMajorVersion,
} from "./engine.js";

type ProbeResult = Partial<{
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

function mockProbe(result: ProbeResult, error?: Error) {
  return vi.spyOn(serverUtils, "runChildProcess").mockImplementation(
    (async () => {
      if (error) throw error;
      return { timedOut: false, exitCode: 0, stdout: "", stderr: "", ...result };
    }) as unknown as typeof serverUtils.runChildProcess,
  );
}

function collectLog() {
  const lines: string[] = [];
  return {
    lines,
    onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
      lines.push(chunk);
    },
  };
}

const baseInput = { command: "opencode", cwd: "/tmp", env: {} as Record<string, string> };

describe("openCode engine version", () => {
  afterEach(() => {
    delete process.env[OPENCODE_EXPECTED_MAJOR_VERSION_ENV_KEY];
    vi.restoreAllMocks();
  });

  describe("parseOpenCodeVersion", () => {
    it("parses the bare form printed by v1", () => {
      expect(parseOpenCodeVersion("1.18.32")).toEqual({
        raw: "1.18.32",
        major: 1,
        minor: 18,
        patch: 32,
      });
    });

    it("parses the prefixed form printed by v2", () => {
      expect(parseOpenCodeVersion("opencode v2.0.14")).toEqual({
        raw: "opencode v2.0.14",
        major: 2,
        minor: 0,
        patch: 14,
      });
    });

    it("ignores a pre-release or build suffix", () => {
      expect(parseOpenCodeVersion("1.19.0-beta.3")?.major).toBe(1);
      expect(parseOpenCodeVersion("1.19.0+9f2c1ab")?.minor).toBe(19);
    });

    it("returns null for output with no version in it", () => {
      expect(parseOpenCodeVersion("")).toBeNull();
      expect(parseOpenCodeVersion("command not found")).toBeNull();
    });
  });

  describe("resolveExpectedOpenCodeMajorVersion", () => {
    it("is null when nothing is configured (upstream default: log, do not pin)", () => {
      expect(resolveExpectedOpenCodeMajorVersion({})).toBeNull();
    });

    it("reads a numeric adapterConfig value", () => {
      expect(
        resolveExpectedOpenCodeMajorVersion({ config: { expectedMajorVersion: 1 } }),
      ).toBe(1);
    });

    it("reduces a full version string to its major, so a pasted --version still works", () => {
      expect(
        resolveExpectedOpenCodeMajorVersion({ config: { expectedMajorVersion: "1.18.32" } }),
      ).toBe(1);
      expect(
        resolveExpectedOpenCodeMajorVersion({ config: { expectedMajorVersion: "v2" } }),
      ).toBe(2);
    });

    it("reads the environment variable, so an operator can pin from a systemd drop-in", () => {
      expect(
        resolveExpectedOpenCodeMajorVersion({
          env: { [OPENCODE_EXPECTED_MAJOR_VERSION_ENV_KEY]: "1" },
        }),
      ).toBe(1);
    });

    it("prefers adapterConfig over the environment", () => {
      expect(
        resolveExpectedOpenCodeMajorVersion({
          config: { expectedMajorVersion: 2 },
          env: { [OPENCODE_EXPECTED_MAJOR_VERSION_ENV_KEY]: "1" },
        }),
      ).toBe(2);
    });

    it("ignores a value that is not a version", () => {
      expect(
        resolveExpectedOpenCodeMajorVersion({ config: { expectedMajorVersion: "latest" } }),
      ).toBeNull();
    });
  });

  describe("probeOpenCodeEngineVersion", () => {
    it("reports the resolved path and parsed version on success", async () => {
      mockProbe({ stdout: "1.18.32\n" });
      const probe = await probeOpenCodeEngineVersion({
        ...baseInput,
        resolvedPath: "/opt/v1/bin/opencode",
      });
      expect(probe.resolvedPath).toBe("/opt/v1/bin/opencode");
      expect(probe.version).toMatchObject({ major: 1, minor: 18, patch: 32 });
      expect(probe.probeError).toBeUndefined();
    });

    it("falls back to stderr for an engine that prints its banner there", async () => {
      mockProbe({ stdout: "", stderr: "opencode v2.0.14\n" });
      const probe = await probeOpenCodeEngineVersion(baseInput);
      expect(probe.version).toMatchObject({ major: 2 });
    });

    it("reports a non-zero exit instead of throwing", async () => {
      mockProbe({ exitCode: 127, stderr: "opencode: not found" });
      const probe = await probeOpenCodeEngineVersion(baseInput);
      expect(probe.version).toBeNull();
      expect(probe.probeError).toContain("exited 127");
      expect(probe.probeError).toContain("not found");
    });

    it("reports a timeout instead of throwing", async () => {
      mockProbe({ timedOut: true });
      const probe = await probeOpenCodeEngineVersion(baseInput);
      expect(probe.version).toBeNull();
      expect(probe.probeError).toContain("timed out");
    });

    it("reports a spawn failure instead of throwing", async () => {
      mockProbe({}, new Error("ENOENT"));
      const probe = await probeOpenCodeEngineVersion(baseInput);
      expect(probe.version).toBeNull();
      expect(probe.probeError).toContain("ENOENT");
    });

    it("reports unparseable output instead of throwing", async () => {
      mockProbe({ stdout: "hello\n" });
      const probe = await probeOpenCodeEngineVersion(baseInput);
      expect(probe.version).toBeNull();
      expect(probe.probeError).toContain("no recognisable version");
    });
  });

  describe("assertOpenCodeEngineVersion", () => {
    it("logs the resolved engine on every run when no major is pinned", async () => {
      mockProbe({ stdout: "1.18.32\n" });
      const log = collectLog();
      await assertOpenCodeEngineVersion({
        ...baseInput,
        resolvedCommand: "/opt/v1/bin/opencode",
        onLog: log.onLog,
      });
      expect(log.lines.join("")).toContain("/opt/v1/bin/opencode");
      expect(log.lines.join("")).toContain("opencode 1.18.32");
    });

    it("passes when the resolved engine matches the pinned major", async () => {
      mockProbe({ stdout: "1.18.32\n" });
      const log = collectLog();
      await expect(
        assertOpenCodeEngineVersion({
          ...baseInput,
          resolvedCommand: "/opt/v1/bin/opencode",
          config: { expectedMajorVersion: 1 },
          onLog: log.onLog,
        }),
      ).resolves.toMatchObject({ version: { major: 1 } });
      expect(log.lines.join("")).toContain("major 1 pinned");
    });

    it("fails with the resolved path and both versions on a major mismatch", async () => {
      // The exact fleet outage this exists to catch: PATH order handed the run
      // the v2 binary while the deployment was pinned to v1.
      mockProbe({ stdout: "opencode v2.0.14\n" });
      await expect(
        assertOpenCodeEngineVersion({
          ...baseInput,
          resolvedCommand: "/home/u/.opencode/bin/opencode",
          config: { expectedMajorVersion: 1 },
          onLog: async () => {},
        }),
      ).rejects.toThrow(
        /resolved to \/home\/u\/\.opencode\/bin\/opencode.*opencode 2\.0\.14.*major 1 is required/s,
      );
    });

    it("names the two ways to fix a mismatch in the error", async () => {
      mockProbe({ stdout: "opencode v2.0.14\n" });
      const error = await assertOpenCodeEngineVersion({
        ...baseInput,
        resolvedCommand: "/home/u/.opencode/bin/opencode",
        config: { expectedMajorVersion: 1 },
        onLog: async () => {},
      }).then(
        () => new Error("expected a mismatch to reject"),
        (err: unknown) => err as Error,
      );
      expect(error.message).toContain("adapterConfig.command");
      expect(error.message).toContain(OPENCODE_EXPECTED_MAJOR_VERSION_ENV_KEY);
    });

    it("reads the pin from the environment when adapterConfig omits it", async () => {
      mockProbe({ stdout: "opencode v2.0.14\n" });
      await expect(
        assertOpenCodeEngineVersion({
          ...baseInput,
          resolvedCommand: "/home/u/.opencode/bin/opencode",
          env: { [OPENCODE_EXPECTED_MAJOR_VERSION_ENV_KEY]: "1" },
          onLog: async () => {},
        }),
      ).rejects.toThrow("major version mismatch");
    });

    it("does not fail the run when the probe cannot run, even with a pin set", async () => {
      mockProbe({ exitCode: 127, stderr: "not found" });
      const log = collectLog();
      await expect(
        assertOpenCodeEngineVersion({
          ...baseInput,
          config: { expectedMajorVersion: 1 },
          onLog: log.onLog,
        }),
      ).resolves.toMatchObject({ version: null });
      const text = log.lines.join("");
      expect(text).toContain("Engine version could not be read");
      expect(text).toContain("Expected major 1");
      expect(text).toContain("Continuing");
    });

    it("does not fail the run on a probe timeout, even with a pin set", async () => {
      mockProbe({ timedOut: true });
      await expect(
        assertOpenCodeEngineVersion({
          ...baseInput,
          config: { expectedMajorVersion: 1 },
          onLog: async () => {},
        }),
      ).resolves.toMatchObject({ version: null });
    });

    it("treats major 0 as a real pin rather than an absent one", async () => {
      mockProbe({ stdout: "1.18.32\n" });
      const log = collectLog();
      await expect(
        assertOpenCodeEngineVersion({
          ...baseInput,
          config: { expectedMajorVersion: 0 },
          onLog: log.onLog,
        }),
      ).rejects.toThrow("major version mismatch");
      expect(log.lines.join("")).toBe("");
    });
  });
});
