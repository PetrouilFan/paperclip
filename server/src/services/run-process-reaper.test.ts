import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { prepareHeartbeatRunScratch } from "./run-scratch.js";
import { reapLostRunProcessTree } from "./run-process-reaper.js";
import { resolveInstanceDatabaseGuard } from "./instance-database-guard.js";

/**
 * These tests reproduce the 2026-09-25 leak shape: a heartbeat run spawns a
 * child, that child spawns a server which binds a port, the run's direct child
 * is then lost, and the server survives reparented to init.
 *
 * Every child is spawned `detached: true` so it gets its own process group,
 * which is what a real run's child gets and what keeps the reaper from
 * signalling this test runner.
 */

const spawned: ChildProcess[] = [];
const tempDirs: string[] = [];

let counter = 0;

function nextRunId() {
  counter += 1;
  return `testrun${counter.toString().padStart(8, "0")}00000000000000000000`;
}

/** Binds a TCP port, then stays alive forever. `scratchDir` is passed in argv
 *  and in the environment, mirroring how a descendant inherits
 *  PAPERCLIP_RUN_SCRATCH_DIR from the run that spawned it. */
const SERVER_SOURCE = `
const net = require("node:net");
const { port } = JSON.parse(process.argv[2]);
const server = net.createServer((socket) => socket.end());
server.listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`;

/** Starts the port-holding grandchild, reports its pid, then exits. This is the
 *  run's direct child dying while its own child keeps running. */
const SPAWNER_SOURCE = `
const { spawn } = require("node:child_process");
const { serverScript, scratchDir, port } = JSON.parse(process.argv[2]);
const child = spawn(
  process.execPath,
  [serverScript, JSON.stringify({ port })],
  {
    stdio: "ignore",
    env: { ...process.env, PAPERCLIP_RUN_SCRATCH_DIR: scratchDir },
  },
);
process.stdout.write(String(child.pid) + "\\n");
child.unref();
process.exit(0);
`;

/** Stands in for the embedded postmaster: writes `<dataDir>/postmaster.pid` in
 *  the real format, binds a port, and stays alive. This is the process a
 *  leaked-tree heuristic must never take down, and the one whose supervisors
 *  must never be taken down either. */
const POSTMASTER_SOURCE = `
const fs = require("node:fs");
const net = require("node:net");
const { dataDir, port } = JSON.parse(process.argv[2]);
fs.writeFileSync(
  dataDir + "/postmaster.pid",
  [
    String(process.pid),
    dataDir,
    String(Math.floor(Date.now() / 1000)),
    String(port),
    "/tmp",
    "localhost",
    "  0    0",
    "ready",
    "",
  ].join("\\n"),
);
const server = net.createServer((socket) => socket.end());
server.listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`;

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function track(child: ChildProcess) {
  spawned.push(child);
  return child;
}

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

/**
 * Liveness as "still holding resources", not "still in the process table".
 *
 * A killed child whose `ChildProcess` handle was `unref`'d stays a zombie until
 * something reaps it, and `kill(pid, 0)` still succeeds for a zombie. A zombie
 * holds no memory and no listening socket, so it is not alive for the purpose
 * of these assertions.
 */
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
    // The pid vanished between the signal probe and the read.
    return false;
  }
}

async function ownProcessGroupId() {
  const stat = await fs.readFile(`/proc/${process.pid}/stat`, "utf8");
  return Number.parseInt(
    stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[2] ?? "",
    10,
  );
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

async function setup() {
  const scratch = await prepareHeartbeatRunScratch({
    companyId: "test-company",
    agentId: "test-agent",
    runId: nextRunId(),
  });
  tempDirs.push(scratch.dir);
  const helperDir = await makeTempDir("reaper-helper-");
  const serverScript = path.join(helperDir, "server.cjs");
  const spawnerScript = path.join(helperDir, "spawner.cjs");
  await fs.writeFile(serverScript, SERVER_SOURCE);
  await fs.writeFile(spawnerScript, SPAWNER_SOURCE);
  return { scratch, serverScript, spawnerScript };
}

/** Spawn a direct child that dies immediately after starting a port-holding
 *  grandchild. Returns the grandchild pid: the process that leaked. */
async function spawnLostRunTree(input: {
  spawnerScript: string;
  serverScript: string;
  scratchDir: string;
  port: number;
}) {
  const child = track(
    spawn(
      process.execPath,
      [
        input.spawnerScript,
        JSON.stringify({
          serverScript: input.serverScript,
          scratchDir: input.scratchDir,
          port: input.port,
        }),
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  const grandchildPid = Number.parseInt(await readLine(child), 10);
  child.unref();
  return { child, grandchildPid };
}

/** A detached process holding a port that references no run scratch dir. */
async function spawnBystander(serverScript: string) {
  const port = await reserveFreePort();
  const child = track(
    spawn(
      process.execPath,
      [serverScript, JSON.stringify({ port })],
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    ),
  );
  child.stdout?.resume();
  child.unref();
  return { child, pid: child.pid as number, port };
}

/**
 * A detached child in its own process group that stands in for a
 * `paperclipai run` instance owning an embedded database: it writes a
 * `postmaster.pid` naming itself and then holds a port.
 *
 * The returned `pid` is both the group's id and the postmaster's, which is
 * exactly the production shape the guard has to refuse: the run's recorded
 * group *is* the database owner's group.
 */
async function spawnDatabaseOwner() {
  const helperDir = await makeTempDir("reaper-dbowner-");
  const script = path.join(helperDir, "postmaster.cjs");
  await fs.writeFile(script, POSTMASTER_SOURCE);
  const dataDir = await makeTempDir("reaper-dbdata-");
  const port = await reserveFreePort();
  const child = track(
    spawn(process.execPath, [script, JSON.stringify({ dataDir, port })], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }),
  );
  child.stdout?.resume();
  const pid = child.pid as number;
  child.unref();
  return { dataDir, port, pid, processGroupId: pid };
}

/**
 * Wait until the stand-in postmaster has published its pid file and the guard
 * can resolve it. The child writes the file as its first action, but the
 * spawn-to-write window is exactly where a fixed `expect(...).not.toBeNull()`
 * becomes a flaky test.
 */
async function waitForPostmaster(dataDir: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const guard = resolveInstanceDatabaseGuard(dataDir);
    if (guard) return guard;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/**
 * Wait until a pid is gone from the process table entirely.
 *
 * `isAlive` treats a zombie as dead, because a zombie holds no resources. A
 * pid file check is not in that position: `kill(pid, 0)` still succeeds for a
 * zombie, so a test that waits on `isAlive` and then expects the guard to find
 * nothing is waiting on the wrong condition.
 */
async function waitForPidGone(pid: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(`/proc/${pid}`);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

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
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
  tempDirs.length = 0;
});

describe("reapLostRunProcessTree", () => {
  it(
    "reaps a port-holding grandchild that outlived its run's direct child",
    async () => {
      const { scratch, serverScript, spawnerScript } = await setup();
      const port = await reserveFreePort();
      const { grandchildPid } = await spawnLostRunTree({
        spawnerScript,
        serverScript,
        scratchDir: scratch.dir,
        port,
      });

      // The leak precondition: the grandchild outlived the direct child and is
      // still holding the port.
      expect(await isAlive(grandchildPid)).toBe(true);
      expect(await waitForPortBound(port)).toBe(true);

      const result = await reapLostRunProcessTree({
        // No process group recorded: this is the shape where the run's
        // descendants were never isolated, so only the scratch anchor can
        // find them.
        processGroupId: null,
        scratchDir: scratch.dir,
        graceMs: 1_000,
      });

      expect(result.matchedPids).toContain(grandchildPid);
      expect(await isAlive(grandchildPid)).toBe(false);
      expect(await waitForPortFree(port)).toBe(true);
    },
    40_000,
  );

  it(
    "is a no-op when re-run after a successful reap",
    async () => {
      const { scratch, serverScript, spawnerScript } = await setup();
      const port = await reserveFreePort();
      const { grandchildPid } = await spawnLostRunTree({
        spawnerScript,
        serverScript,
        scratchDir: scratch.dir,
        port,
      });
      expect(await waitForPortBound(port)).toBe(true);

      const first = await reapLostRunProcessTree({
        processGroupId: null,
        scratchDir: scratch.dir,
        graceMs: 1_000,
      });
      expect(first.matchedPids).toContain(grandchildPid);

      const second = await reapLostRunProcessTree({
        processGroupId: null,
        scratchDir: scratch.dir,
        graceMs: 1_000,
      });
      expect(second.matchedPids).toEqual([]);
      expect(second.signalledPids).toEqual([]);
      expect(second.killedPids).toEqual([]);
    },
    40_000,
  );

  it(
    "never signals a process that does not reference the run's scratch directory",
    async () => {
      const { scratch, serverScript } = await setup();
      const bystander = await spawnBystander(serverScript);
      expect(await waitForPortBound(bystander.port)).toBe(true);

      const result = await reapLostRunProcessTree({
        processGroupId: null,
        scratchDir: scratch.dir,
        graceMs: 1_000,
      });

      expect(result.matchedPids).not.toContain(bystander.pid);
      expect(await isAlive(bystander.pid)).toBe(true);
      expect(await portIsBound(bystander.port)).toBe(true);
    },
    40_000,
  );

  it(
    "reaps a recorded process group even when no scratch directory is known",
    async () => {
      const { serverScript } = await setup();
      const port = await reserveFreePort();
      // A detached child in its own process group, holding the port itself.
      const child = track(
        spawn(
          process.execPath,
          [serverScript, JSON.stringify({ port })],
          { stdio: ["ignore", "pipe", "pipe"], detached: true },
        ),
      );
      child.stdout?.resume();
      const childPid = child.pid as number;
      child.unref();
      expect(await waitForPortBound(port)).toBe(true);

      const result = await reapLostRunProcessTree({
        processGroupId: childPid,
        scratchDir: null,
        graceMs: 1_000,
      });

      expect(result.groupWasAlive).toBe(true);
      expect(result.refusedOwnGroup).toBe(false);
      expect(await isAlive(childPid)).toBe(false);
      expect(await waitForPortFree(port)).toBe(true);
    },
    40_000,
  );

  it(
    "refuses to signal a group that is the caller's own process group",
    async () => {
      // Signalling our own group would kill this test runner, so the reaper
      // must detect and refuse it rather than escalating to SIGKILL.
      // The worker's pid and its process group are not the same thing under a
      // test runner, so resolve the real pgid rather than assuming.
      const ownGroup = await ownProcessGroupId();
      expect(ownGroup).toBeGreaterThan(0);

      const result = await reapLostRunProcessTree({
        processGroupId: ownGroup,
        scratchDir: null,
        graceMs: 200,
      });

      expect(result.refusedOwnGroup).toBe(true);
      expect(result.signalledPids).toEqual([]);
      expect(result.killedPids).toEqual([]);
      expect(await isAlive(process.pid)).toBe(true);
    },
    20_000,
  );

  it(
    "reports no_anchor when there is neither a group nor a scratch dir",
    async () => {
      const result = await reapLostRunProcessTree({
        processGroupId: null,
        scratchDir: null,
      });
      expect(result.skippedReason).toBe("no_anchor");
    },
    20_000,
  );

  it(
    "refuses a recorded group that holds this instance's live database",
    async () => {
      // The 2026-09-25 outage, reduced to its minimum: the recorded group is
      // the database owner's own group, so a group signal would SIGTERM then
      // SIGKILL the postmaster and take the instance's database with it.
      const owner = await spawnDatabaseOwner();
      expect(await waitForPortBound(owner.port)).toBe(true);
      expect((await waitForPostmaster(owner.dataDir))?.postmasterPid).toBe(
        owner.pid,
      );

      const result = await reapLostRunProcessTree({
        processGroupId: owner.processGroupId,
        scratchDir: null,
        databaseDataDir: owner.dataDir,
        graceMs: 1_000,
      });

      expect(result.refusedProtectedGroup).toBe(true);
      expect(result.groupSignalled).toBe(false);
      expect(result.signalledPids).toEqual([]);
      expect(result.killedPids).toEqual([]);
      expect(result.protectedPids[0]).toBe(owner.pid);
      expect(await isAlive(owner.pid)).toBe(true);
      expect(await portIsBound(owner.port)).toBe(true);
    },
    40_000,
  );

  it(
    "still reaps a real orphan while an unrelated database is live",
    async () => {
      // The guard must not become a blanket refusal. PET-109's five leaked
      // servers are still orphans: nothing about them holds a database, so
      // they remain reapable while this instance's own database is up.
      const { scratch, serverScript, spawnerScript } = await setup();
      const owner = await spawnDatabaseOwner();
      expect(await waitForPortBound(owner.port)).toBe(true);
      const port = await reserveFreePort();
      const { grandchildPid } = await spawnLostRunTree({
        spawnerScript,
        serverScript,
        scratchDir: scratch.dir,
        port,
      });
      expect(await waitForPortBound(port)).toBe(true);

      const result = await reapLostRunProcessTree({
        processGroupId: null,
        scratchDir: scratch.dir,
        databaseDataDir: owner.dataDir,
        graceMs: 1_000,
      });

      expect(result.refusedProtectedGroup).toBe(false);
      expect(result.matchedPids).toContain(grandchildPid);
      expect(await isAlive(grandchildPid)).toBe(false);
      expect(await waitForPortFree(port)).toBe(true);
      // The database is untouched by reaping an unrelated tree.
      expect(await isAlive(owner.pid)).toBe(true);
    },
    40_000,
  );

  it(
    "keeps reaping the owner's group when no database is reported",
    async () => {
      // Without a data dir there is nothing to protect, so the reaper behaves
      // as it did before the guard. This pins the guard to being opt-in on
      // real data rather than a change in default behaviour.
      const owner = await spawnDatabaseOwner();
      expect(await waitForPortBound(owner.port)).toBe(true);

      const result = await reapLostRunProcessTree({
        processGroupId: owner.processGroupId,
        scratchDir: null,
        graceMs: 1_000,
      });

      expect(result.protectedPids).toEqual([]);
      expect(result.refusedProtectedGroup).toBe(false);
      expect(result.groupSignalled).toBe(true);
      expect(await isAlive(owner.pid)).toBe(false);
    },
    40_000,
  );
});

describe("resolveInstanceDatabaseGuard", () => {
  it("protects the postmaster and its ancestors", async () => {
    const owner = await spawnDatabaseOwner();
    const guard = await waitForPostmaster(owner.dataDir);
    expect(guard).not.toBeNull();
    expect(guard?.postmasterPid).toBe(owner.pid);
    // Nearest parent first, and the walk must reach past the owner to init.
    expect(guard?.protectedPids[0]).toBe(owner.pid);
    expect(guard!.protectedPids.length).toBeGreaterThan(1);
    expect(guard?.protectedPids).toContain(1);
  });

  it("returns null when the data directory has no pid file", async () => {
    expect(resolveInstanceDatabaseGuard(await makeTempDir("reaper-nodb-"))).toBeNull();
  });

  it("returns null when no data directory is supplied", () => {
    expect(resolveInstanceDatabaseGuard(null)).toBeNull();
    expect(resolveInstanceDatabaseGuard(undefined)).toBeNull();
    expect(resolveInstanceDatabaseGuard("   ")).toBeNull();
  });

  it("returns null for a pid file naming a different data directory", async () => {
    const owner = await spawnDatabaseOwner();
    expect(await waitForPostmaster(owner.dataDir)).not.toBeNull();
    // Same live pid, but the pid file is read as if it belonged elsewhere: a
    // foreign pid file must not be able to either protect or block anything.
    const otherDir = await makeTempDir("reaper-otherdb-");
    expect(resolveInstanceDatabaseGuard(otherDir)).toBeNull();
  });

  it("returns null once the postmaster pid is gone", async () => {
    const owner = await spawnDatabaseOwner();
    expect(await waitForPostmaster(owner.dataDir)).not.toBeNull();
    try {
      process.kill(-owner.pid, "SIGKILL");
    } catch {
      // already gone
    }
    expect(await waitForPidGone(owner.pid)).toBe(true);
    // A stale pid file protects nothing, and must not make the guard throw.
    expect(resolveInstanceDatabaseGuard(owner.dataDir)).toBeNull();
  });
});
