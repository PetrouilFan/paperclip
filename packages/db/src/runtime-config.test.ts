import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDatabaseTarget } from "./runtime-config.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveDatabaseTarget", () => {
  it("uses DATABASE_URL from process env first", () => {
    process.env.DATABASE_URL = "postgres://env-user:env-pass@db.example.com:5432/paperclip";

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://env-user:env-pass@db.example.com:5432/paperclip",
      source: "DATABASE_URL",
    });
  });

  it("uses DATABASE_URL from repo-local .paperclip/.env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const projectDir = path.join(tempDir, "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);
    delete process.env.PAPERCLIP_CONFIG;
    writeJson(path.join(projectDir, ".paperclip", "config.json"), {
      database: { mode: "embedded-postgres", embeddedPostgresPort: 54329 },
    });
    writeText(
      path.join(projectDir, ".paperclip", ".env"),
      'DATABASE_URL="postgres://file-user:file-pass@db.example.com:6543/paperclip"\n',
    );

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://file-user:file-pass@db.example.com:6543/paperclip",
      source: "paperclip-env",
    });
  });

  it("uses config postgres connection string when configured", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "postgres",
        connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      source: "config.database.connectionString",
    });
  });

  it("falls back to embedded postgres settings from config", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-runtime-"));
    const configPath = path.join(tempDir, "instance", "config.json");
    process.env.PAPERCLIP_CONFIG = configPath;
    writeJson(configPath, {
      database: {
        mode: "embedded-postgres",
        embeddedPostgresDataDir: "~/paperclip-test-db",
        embeddedPostgresPort: 55444,
      },
    });

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.resolve(os.homedir(), "paperclip-test-db"),
      port: 55444,
      source: "embedded-postgres@55444",
    });
  });

  it("uses the instance root for a fresh default embedded postgres target", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cwd-"));
    process.chdir(cwd);
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.DATABASE_URL;

    const target = resolveDatabaseTarget();

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.join(home, "instances", "default", "db"),
      port: 54329,
      source: "embedded-postgres@54329",
      configPath: path.join(home, "instances", "default", "config.json"),
      envPath: path.join(home, "instances", "default", ".env"),
    });
  });

  it("ignores the ambient DATABASE_URL when resolving a named instance", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cwd-"));
    process.chdir(cwd);
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    // The operator's shell, naming a database this instance never opened.
    process.env.DATABASE_URL = "postgres://someone-else@other.example.com:5432/paperclip";

    const target = resolveDatabaseTarget({ instanceId: "alice" });

    expect(target).toMatchObject({
      mode: "embedded-postgres",
      dataDir: path.join(home, "instances", "alice", "db"),
      source: "embedded-postgres@54329",
      configPath: path.join(home, "instances", "alice", "config.json"),
      envPath: path.join(home, "instances", "alice", ".env"),
    });
    expect(target.mode === "postgres" ? target.connectionString : "").not.toContain("other.example.com");
  });

  it("reads the named instance's own connection string and env file", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cwd-"));
    process.chdir(cwd);
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    process.env.DATABASE_URL = "postgres://shell-user@shell.example.com:5432/paperclip";
    const aliceRoot = path.join(home, "instances", "alice");
    writeJson(path.join(aliceRoot, "config.json"), {
      database: { mode: "postgres", connectionString: "postgres://alice@alice.example.com:5432/paperclip" },
    });
    writeText(path.join(aliceRoot, ".env"), "DATABASE_URL=postgres://alice-env@alice-env.example.com:5432/paperclip\n");

    // The instance's env file outranks its config.json, and both outrank the
    // shell.
    expect(resolveDatabaseTarget({ instanceId: "alice" })).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://alice-env@alice-env.example.com:5432/paperclip",
      source: "paperclip-env",
    });
    // A different instance on the same home is unaffected by alice's files.
    expect(resolveDatabaseTarget({ instanceId: "bob" })).toMatchObject({
      mode: "embedded-postgres",
      source: "embedded-postgres@54329",
    });
  });

  it("keeps the server's own resolution unchanged when no instance is named", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-cwd-"));
    process.chdir(cwd);
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    process.env.DATABASE_URL = "postgres://server-user@server.example.com:5432/paperclip";

    // The server's environment is its own; the precedence the server relies on
    // must not change because the CLI now asks for an instance-scoped answer.
    expect(resolveDatabaseTarget()).toMatchObject({
      mode: "postgres",
      connectionString: "postgres://server-user@server.example.com:5432/paperclip",
      source: "DATABASE_URL",
    });
  });
});
