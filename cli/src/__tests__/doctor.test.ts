import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor, summarizeChecks } from "../commands/doctor.js";
import { writeConfig } from "../config/store.js";
import { MANAGED_STORE_MARKER, resolveInstallStorePaths } from "../install-store.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function createTempConfig(serverPort: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-doctor-"));
  const configPath = path.join(root, ".paperclip", "config.json");
  const runtimeRoot = path.join(root, "runtime");

  const config: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: "2026-03-10T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(runtimeRoot, "db"),
      embeddedPostgresPort: 55432,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(runtimeRoot, "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(runtimeRoot, "logs"),
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: serverPort,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(runtimeRoot, "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(runtimeRoot, "secrets", "master.key"),
      },
    },
  };

  writeConfig(config, configPath);
  return configPath;
}

describe("doctor", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("re-runs repairable checks so repaired failures do not remain blocking", async () => {
    const configPath = createTempConfig(await availablePort());

    const summary = await doctor({
      config: configPath,
      repair: true,
      yes: true,
    });

    expect(summary.failed).toBe(0);
    expect(summary.warned).toBe(0);
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBeTruthy();
  });

  it("reports no startup-blocking failure when a managed store has no manifest", async () => {
    const configPath = createTempConfig(await availablePort());
    // The background-service family is a diagnostic about another process and
    // would otherwise probe this host's real unit. It is covered hermetically in
    // service-health-check.test.ts.
    process.env.PAPERCLIP_SERVICE_MANAGED = "1";
    const paperclipHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-doctor-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    const storePaths = resolveInstallStorePaths({ paperclipHome });
    fs.mkdirSync(storePaths.cliRoot, { recursive: true });
    fs.writeFileSync(storePaths.markerPath, MANAGED_STORE_MARKER);

    const summary = await doctor({ config: configPath, repair: true, yes: true });

    expect(summary.failed).toBe(0);
    expect(summary.warned).toBeGreaterThan(0);
  });

  it("reports no startup-blocking failure when no managed store exists at all", async () => {
    const configPath = createTempConfig(await availablePort());
    process.env.PAPERCLIP_SERVICE_MANAGED = "1";
    process.env.PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-doctor-home-"));

    const summary = await doctor({ config: configPath, repair: true, yes: true });

    expect(summary.failed).toBe(0);
  });
});

describe("summarizeChecks", () => {
  it("keeps an advisory failure out of the start-up gate", () => {
    expect(
      summarizeChecks([
        { name: "Config file", status: "pass", message: "ok" },
        { name: "Service health", status: "fail", message: "fetch failed", blocking: false },
      ]),
    ).toEqual({ passed: 1, warned: 0, failed: 0, advisory: 1 });
  });

  it("still counts a failure that describes this process as blocking", () => {
    expect(
      summarizeChecks([
        { name: "Config file", status: "fail", message: "invalid" },
        { name: "Server port", status: "fail", message: "in use" },
        { name: "Managed install PATH", status: "warn", message: "not on PATH" },
      ]),
    ).toEqual({ passed: 0, warned: 1, failed: 2, advisory: 0 });
  });

  it("treats a missing blocking flag as blocking", () => {
    expect(summarizeChecks([{ name: "Database", status: "fail", message: "down" }]).failed).toBe(1);
  });
});
