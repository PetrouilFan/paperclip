import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverPiModels,
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });
});

// The bug this covers is a call-site bug, not a chokepoint bug: `discoverPiModels`
// used to pass `{ ...process.env, ...env }` as `opts.env`, and `runChildProcess`
// spreads `opts.env` over the sanitized inherited base — so the spread put the
// control plane's own `PAPERCLIP_API_KEY` straight back into a child that
// `sanitizeInheritedPaperclipEnv` had just cleaned it out of. A test of
// `runChildProcess` in isolation passes against the unfixed call site, so the
// test has to run the real discovery path and read the environment the real
// child was handed.
describe("pi model discovery child environment", () => {
  const originalApiKey = process.env.PAPERCLIP_API_KEY;
  const originalWakePayload = process.env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  const originalCommand = process.env.PAPERCLIP_PI_COMMAND;
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (originalApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
    else process.env.PAPERCLIP_API_KEY = originalApiKey;
    if (originalWakePayload === undefined) delete process.env.PAPERCLIP_WAKE_PAYLOAD_JSON;
    else process.env.PAPERCLIP_WAKE_PAYLOAD_JSON = originalWakePayload;
    if (originalCommand === undefined) delete process.env.PAPERCLIP_PI_COMMAND;
    else process.env.PAPERCLIP_PI_COMMAND = originalCommand;
    resetPiModelsCacheForTests();
  });

  // A stand-in for `pi` that records the environment it was handed into a file,
  // then prints a model row so discovery succeeds and this exercises the success
  // path rather than an error branch. A file rather than stderr because
  // `discoverPiModels` discards the child's output by design.
  function fakePi(): { command: string; report: string } {
    dir = mkdtempSync(path.join(tmpdir(), "pi-env-probe-"));
    const command = path.join(dir, "pi");
    const report = path.join(dir, "report.env");
    writeFileSync(
      command,
      [
        "#!/bin/sh",
        '{',
        '  echo "API_KEY=${PAPERCLIP_API_KEY:-<absent>}"',
        '  echo "WAKE_PAYLOAD=${PAPERCLIP_WAKE_PAYLOAD_JSON:-<absent>}"',
        '  echo "PATH_SET=${PATH:+yes}"',
        '  echo "HOME=${HOME:-<absent>}"',
        '  echo "PROBE_MARKER=${PAPERCLIP_TEST_PROBE_MARKER:-<absent>}"',
        '} > "$PAPERCLIP_TEST_PROBE_FILE"',
        'echo "xai   grok-4   131072   32768   yes   no" >&2',
      ].join("\n"),
    );
    chmodSync(command, 0o755);
    return { command, report };
  }

  function probeFrom(report: string): Map<string, string> {
    const found = new Map<string, string>();
    for (const line of readFileSync(report, "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at === -1) continue;
      found.set(line.slice(0, at), line.slice(at + 1));
    }
    return found;
  }

  it("does not hand the discovery child the control plane's API key", async () => {
    process.env.PAPERCLIP_API_KEY = "server-process-key";
    process.env.PAPERCLIP_WAKE_PAYLOAD_JSON = '{"companyId":"stale"}';
    const { command, report } = fakePi();

    const models = await discoverPiModels({
      command,
      cwd: dir,
      env: { PAPERCLIP_TEST_PROBE_FILE: report, PAPERCLIP_TEST_PROBE_MARKER: "from-caller" },
    });
    // Proves the probe really ran to completion, so the env assertions below
    // are about a child that started rather than about a failure branch.
    expect(models.map((model) => model.id)).toContain("xai/grok-4");

    const probe = probeFrom(report);
    expect(probe.get("API_KEY")).toBe("<absent>");
    expect(probe.get("WAKE_PAYLOAD")).toBe("<absent>");
    // Non-vacuity, in three parts. The fix drops two keys, not the environment:
    // PATH and HOME still arrive through the inherited base, or discovery would
    // be broken rather than secure. The caller's own keys still arrive through
    // `opts.env`, which is the half the unfixed `{ ...process.env }` spread used
    // to poison — the test would pass against a "strip the whole adapter half"
    // fix, which is the change that silently strips every run's own token.
    expect(probe.get("PATH_SET")).toBe("yes");
    expect(probe.get("HOME")).not.toBe("<absent>");
    expect(probe.get("PROBE_MARKER")).toBe("from-caller");
  });
});
