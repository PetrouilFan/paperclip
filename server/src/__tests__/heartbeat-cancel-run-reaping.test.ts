import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";

import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { prepareHeartbeatRunScratch } from "../services/run-scratch.js";

/**
 * PET-109 acceptance criterion 3: a clean cancel reaps descendants too.
 *
 * The process-lost and shutdown teardown paths call the reaper; the cancel paths
 * did not, and a cancel is just as terminal. This drives the real
 * `heartbeatService(db).cancelRun` against a real database and the real 2026-09-25
 * leak shape: a direct child that dies while its own child keeps a port bound,
 * with only the run's scratch directory left as an ownership anchor.
 *
 * Criterion 4 is asserted at the same time -- a cancelled run skips the
 * clean-finish scratch removal, so the directory is the only thing that can
 * clean it.
 */

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("cancelling a run reaps its descendant process tree", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  const spawned: ChildProcess[] = [];
  const tempDirs: string[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("cancel-reaper-");
    db = createDb(database.connectionString);
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  afterEach(async () => {
    for (const child of spawned) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    spawned.length = 0;
    await Promise.all(
      tempDirs
        .map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
    );
    tempDirs.length = 0;
  });

  const SERVER_SOURCE = `
const net = require("node:net");
const { port } = JSON.parse(process.argv[2]);
net.createServer((socket) => socket.end()).listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`;

  /** Starts the port-holding grandchild, reports its pid, then exits: the run's
   *  direct child dying while its own child keeps running. */
  const SPAWNER_SOURCE = `
const { spawn } = require("node:child_process");
const { serverScript, scratchDir, port } = JSON.parse(process.argv[2]);
const child = spawn(
  process.execPath,
  [serverScript, JSON.stringify({ port })],
  { stdio: "ignore", env: { ...process.env, PAPERCLIP_RUN_SCRATCH_DIR: scratchDir } },
);
process.stdout.write(String(child.pid) + "\\n");
child.unref();
process.exit(0);
`;

  function readLine(child: ChildProcess, timeoutMs = 15_000): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for child output: ${JSON.stringify(buffer)}`)),
        timeoutMs,
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          clearTimeout(timer);
          resolve(buffer.slice(0, newline).trim());
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`child exited early with code ${code}: ${JSON.stringify(buffer)}`));
      });
    });
  }

  /** Liveness as "still holding resources": an unref'd killed child stays a
   *  zombie until something reaps it, and `kill(pid, 0)` still succeeds. */
  async function isAlive(pid: number) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
      return state !== "Z";
    } catch {
      return false;
    }
  }

  function portIsBound(port: number) {
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(2_000, () => done(false));
    });
  }

  async function waitForPortBound(port: number, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await portIsBound(port)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async function waitForPortFree(port: number, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await portIsBound(port)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      return true;
    }
    return false;
  }

  async function reserveFreePort() {
    return new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const port = typeof address === "object" && address ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
  }

  async function makeTempDir(prefix: string) {
    const dir = await fs.mkdtemp(path.join(process.env.PAPERCLIP_TEST_TMPDIR ?? "/tmp", prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function seedRunningRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cancel reaper test",
      issuePrefix: `R${companyId.slice(0, 7)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
      role: "general",
      adapterType: "claude_local",
      status: "idle",
    });
    const [queued] = await db.insert(heartbeatRuns).values({ companyId, agentId }).returning();
    const [run] = await db
      .update(heartbeatRuns)
      .set({ status: "running", executionStage: "dispatching" })
      .where(eq(heartbeatRuns.id, queued.id))
      .returning();
    return { companyId, agentId, run };
  }

  it(
    "reaps a port-holding descendant and removes the run scratch on cancel",
    async () => {
      const { companyId, agentId, run } = await seedRunningRun();
      // The scratch directory is created under the real run id, so the cancel
      // path resolves it from the marker exactly as a production run would.
      const scratch = await prepareHeartbeatRunScratch({ companyId, agentId, runId: run.id });
      tempDirs.push(scratch.dir);

      const helperDir = await makeTempDir("cancel-reaper-helper-");
      const serverScript = path.join(helperDir, "server.cjs");
      const spawnerScript = path.join(helperDir, "spawner.cjs");
      await fs.writeFile(serverScript, SERVER_SOURCE);
      await fs.writeFile(spawnerScript, SPAWNER_SOURCE);

      const port = await reserveFreePort();
      const child = spawn(
        process.execPath,
        [
          spawnerScript,
          JSON.stringify({ serverScript, scratchDir: scratch.dir, port }),
        ],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      spawned.push(child);
      const grandchildPid = Number.parseInt(await readLine(child), 10);
      child.unref();

      // The leak precondition: the grandchild outlived the direct child and is
      // still holding the port.
      expect(await isAlive(grandchildPid)).toBe(true);
      expect(await waitForPortBound(port)).toBe(true);

      const result = await heartbeatService(db).cancelRun(run.id, "cancelled by test");

      expect(result.status).toBe("cancelled");
      // Criterion 1 for the cancel path: no descendant survives, no port held.
      expect(await isAlive(grandchildPid)).toBe(false);
      expect(await waitForPortFree(port)).toBe(true);
      // Criterion 4: scratch is removed on this terminal path too, not only on
      // the clean-finish path.
      await expect(fs.stat(scratch.dir)).rejects.toThrow();
    },
    90_000,
  );

  it(
    "leaves an unrelated process holding a port untouched",
    async () => {
      const { companyId, agentId, run } = await seedRunningRun();
      const scratch = await prepareHeartbeatRunScratch({ companyId, agentId, runId: run.id });
      tempDirs.push(scratch.dir);

      const helperDir = await makeTempDir("cancel-reaper-bystander-");
      const serverScript = path.join(helperDir, "server.cjs");
      await fs.writeFile(serverScript, SERVER_SOURCE);

      // A port-holding process that references no run scratch directory.
      const bystanderPort = await reserveFreePort();
      const bystander = spawn(
        process.execPath,
        [serverScript, JSON.stringify({ port: bystanderPort })],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      spawned.push(bystander);
      bystander.stdout?.resume();
      bystander.unref();
      expect(await waitForPortBound(bystanderPort)).toBe(true);

      await heartbeatService(db).cancelRun(run.id, "cancelled by test");

      // Criterion 2: bounded. The sweep matches the run's scratch anchor, not
      // every process on the host.
      expect(await isAlive(bystander.pid as number)).toBe(true);
      expect(await portIsBound(bystanderPort)).toBe(true);
    },
    90_000,
  );
});
