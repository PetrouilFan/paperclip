import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPreflightActiveRunIds, writeHotRestartIntent } from "../commands/service.js";
import type { ServiceStatus } from "../services/service-manager.js";

let previousPaperclipHome: string | undefined;
let instanceRoot: string;

beforeEach(() => {
  previousPaperclipHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-restart-intent-"));
  instanceRoot = path.join(process.env.PAPERCLIP_HOME, "instances", "default");
});

afterEach(() => {
  if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousPaperclipHome;
});

const activeStatus: ServiceStatus = {
  platform: "systemd",
  serviceName: "paperclipai.service",
  installed: true,
  active: true,
  enabled: true,
  pid: 4242,
};

const healthyProbe = async () => ({
  ok: true,
  serverVersion: "2026.916.1",
  serverStartedAt: "2026-09-25T00:31:04.000Z",
});

async function readIntent(): Promise<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(instanceRoot, "hot-restart-intent.json"), "utf8"));
}

describe("hot-restart intent written by the CLI restart path", () => {
  it("records the preflight active-run set instead of an empty one", async () => {
    const query = vi.fn(async () => ["run-1", "run-2"]);

    const result = await writeHotRestartIntent(activeStatus, "default", false, { query, probe: healthyProbe });

    expect(result.preflightActiveRunIds).toEqual(["run-1", "run-2"]);
    const intent = await readIntent();
    expect(intent.preflightActiveRunIds).toEqual(["run-1", "run-2"]);
    expect(intent.previousServerPid).toBe(4242);
    expect(intent.previousServerVersion).toBe("2026.916.1");
    expect(intent.previousServerIdentity).toBe("2026-09-25T00:31:04.000Z");
    expect(intent.drainRequired).toBe(false);
    expect(query).toHaveBeenCalledOnce();
  });

  it("skips the database read when a drain is required", async () => {
    const query = vi.fn(async () => ["run-1"]);

    const result = await writeHotRestartIntent(activeStatus, "default", true, { query, probe: healthyProbe });

    expect(result.preflightActiveRunIds).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect((await readIntent()).preflightActiveRunIds).toEqual([]);
  });

  it("fails closed instead of writing an intent with an unknown preflight set", async () => {
    const query = vi.fn(async () => {
      throw new Error("connection refused");
    });

    await expect(
      writeHotRestartIntent(activeStatus, "default", false, { query, probe: healthyProbe }),
    ).rejects.toThrow(/Refusing to restart: could not record the preflight active-run set/);

    // Nothing may be written: an intent without the preflight set makes the
    // server report a vacuous adoption pass with empty arrays.
    expect(fs.existsSync(path.join(instanceRoot, "hot-restart-intent.json"))).toBe(false);
    expect(fs.existsSync(path.join(instanceRoot, "hot-restart-report.json"))).toBe(false);
  });

  it("refuses to restart without a supervisor-reported server pid", async () => {
    await expect(
      writeHotRestartIntent({ ...activeStatus, pid: null }, "default", false, {
        query: async () => [],
        probe: healthyProbe,
      }),
    ).rejects.toThrow("supervisor did not report a server pid");
  });

  it("exposes the preflight reader for reuse and wraps query failures", async () => {
    await expect(readPreflightActiveRunIds({ query: async () => ["run-9"] })).resolves.toEqual(["run-9"]);
    await expect(
      readPreflightActiveRunIds({
        query: async () => {
          throw new Error("database is down");
        },
      }),
    ).rejects.toThrow(/could not record the preflight active-run set for the hot-restart intent \(database is down\)/);
  });
});
