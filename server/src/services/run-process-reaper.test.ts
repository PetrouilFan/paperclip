import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { prepareHeartbeatRunScratch } from "./run-scratch.js";
import { __testing, reapLostRunProcessTree } from "./run-process-reaper.js";
import { resolveInstanceDatabaseGuard } from "./instance-database-guard.js";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** Forks a replacement worker when it is first sent SIGTERM, then ignores every
 *  later signal. This is the shape a single snapshot of the candidate set
 *  cannot see: the worker does not exist until the reaper has already decided
 *  what to signal, and it inherits `dir` from the process that forked it. */
const FORKER_SOURCE = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { serverScript, scratchDir, port, readyFile } = JSON.parse(process.argv[2]);
let forked = false;
process.on("SIGTERM", () => {
  if (forked) return;
  forked = true;
  const child = spawn(process.execPath, [serverScript, JSON.stringify({ port })], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PAPERCLIP_RUN_SCRATCH_DIR: scratchDir },
  });
  child.unref();
  fs.writeFileSync(readyFile, String(child.pid));
  // Stay alive and deaf to every signal after forking, so the reaper has to
  // escalate rather than get its way on the first SIGTERM.
  process.on("SIGTERM", () => {});
});
setInterval(() => {}, 1000);
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
  const forkerScript = path.join(helperDir, "forker.cjs");
  await fs.writeFile(serverScript, SERVER_SOURCE);
  await fs.writeFile(spawnerScript, SPAWNER_SOURCE);
  await fs.writeFile(forkerScript, FORKER_SOURCE);
  return { scratch, serverScript, spawnerScript, forkerScript };
}

/** A detached process holding a port that names the run's scratch dir, so it
 *  both proves and is a member of its own process group. */
async function spawnAnchoredGroupMember(input: {
  serverScript: string;
  scratchDir: string;
  port: number;
}) {
  const child = track(
    spawn(
      process.execPath,
      [input.serverScript, JSON.stringify({ port: input.port })],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env, PAPERCLIP_RUN_SCRATCH_DIR: input.scratchDir },
      },
    ),
  );
  child.stdout?.resume();
  const pid = child.pid as number;
  child.unref();
  return { child, pid };
}

/** Waits for a file the forker writes with the pid of the worker it spawned. */
async function readPidFileWhenPresent(file: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = (await fs.readFile(file, "utf8")).trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for the forker to record a worker pid in ${file}`);
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
async function spawnDatabaseOwner(input: { scratchDir?: string } = {}) {
  const helperDir = await makeTempDir("reaper-dbowner-");
  const script = path.join(helperDir, "postmaster.cjs");
  await fs.writeFile(script, POSTMASTER_SOURCE);
  const dataDir = await makeTempDir("reaper-dbdata-");
  const port = await reserveFreePort();
  const child = track(
    spawn(process.execPath, [script, JSON.stringify({ dataDir, port })], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      // Passing the scratch dir makes this owner a genuine member of an
      // anchored group, which is the precondition for the interaction test.
      env: {
        ...process.env,
        ...(input.scratchDir ? { PAPERCLIP_RUN_SCRATCH_DIR: input.scratchDir } : {}),
      },
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
    "reaps a recorded process group whose ownership the scratch dir still proves",
    async () => {
      const { scratch, serverScript } = await setup();
      const port = await reserveFreePort();
      // A detached child in its own process group, holding the port itself and
      // inheriting the run's scratch dir, so the group is provably this run's.
      const member = await spawnAnchoredGroupMember({
        serverScript,
        scratchDir: scratch.dir,
        port,
      });
      expect(await waitForPortBound(port)).toBe(true);

      const result = await reapLostRunProcessTree({
        processGroupId: member.pid,
        scratchDir: scratch.dir,
        graceMs: 1_000,
      });

      expect(result.groupWasAlive).toBe(true);
      expect(result.refusedOwnGroup).toBe(false);
      expect(result.refusedUnverifiedGroup).toBe(false);
      expect(await isAlive(member.pid)).toBe(false);
      expect(await waitForPortFree(port)).toBe(true);
    },
    40_000,
  );

  it(
    "refuses to signal a recorded group that no scratch dir can prove it owns",
    async () => {
      // A recorded pgid is a bare number the kernel recycles, and the run's own
      // group has already been observed dead by the time the process-loss path
      // gets here. An unrelated group holding that number must survive: this is
      // the only test that can tell "the number was recycled" from "the run's
      // group is still up", and the answer has to be refusal, not a signal.
      const { scratch, serverScript } = await setup();
      const bystander = await spawnBystander(serverScript);
      expect(await waitForPortBound(bystander.port)).toBe(true);

      const result = await reapLostRunProcessTree({
        processGroupId: bystander.pid,
        scratchDir: scratch.dir,
        graceMs: 1_000,
      });

      expect(result.groupWasAlive).toBe(true);
      expect(result.refusedUnverifiedGroup).toBe(true);
      expect(result.groupSignalled).toBe(false);
      expect(await isAlive(bystander.pid)).toBe(true);
      expect(await portIsBound(bystander.port)).toBe(true);
    },
    40_000,
  );

  it(
    "refuses to signal a recorded process group when no scratch directory is known",
    async () => {
      // Without a scratch directory there is no ownership evidence at all, so
      // the group fast path has nothing to stand on and is skipped. The caller
      // already signalled pid and group itself on this path, so nothing that the
      // group path would have reaped is lost.
      const { serverScript } = await setup();
      const port = await reserveFreePort();
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
      expect(result.refusedUnverifiedGroup).toBe(true);
      expect(await isAlive(childPid)).toBe(true);
      expect(await portIsBound(port)).toBe(true);
    },
    40_000,
  );

  it(
    "reaps a worker forked after the sweep started, instead of snapshotting once",
    async () => {
      // The leak this closes: a matched descendant that ignores SIGTERM forks a
      // replacement worker, so the worker's pid did not exist when the candidate
      // set was first taken. It inherits the scratch dir, so it is reapable by
      // the same anchor — it just has to be looked for again.
      const { scratch, serverScript, forkerScript } = await setup();
      const port = await reserveFreePort();
      const readyFile = path.join(scratch.dir, "forked-worker.pid");
      const forker = track(
        spawn(
          process.execPath,
          [forkerScript, JSON.stringify({ serverScript, scratchDir: scratch.dir, port, readyFile })],
          {
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
            env: { ...process.env, PAPERCLIP_RUN_SCRATCH_DIR: scratch.dir },
          },
        ),
      );
      forker.stdout?.resume();
      const forkerPid = forker.pid as number;
      forker.unref();
      await delay(300);

      const result = await reapLostRunProcessTree({
        processGroupId: null,
        scratchDir: scratch.dir,
        graceMs: 2_000,
      });

      // The forker forks on its first SIGTERM, so the worker always exists by
      // the time the reap returns; if it does not, this shape regressed.
      const workerPid = await readPidFileWhenPresent(readyFile);
      expect(result.matchedPids).toContain(forkerPid);
      expect(result.matchedPids).toContain(workerPid);
      expect(result.errors).toEqual([]);
      expect(await isAlive(forkerPid)).toBe(false);
      expect(await isAlive(workerPid)).toBe(false);
      expect(await waitForPortFree(port)).toBe(true);
    },
    40_000,
  );

  it(
    "never claims a process whose uid is not the server's",
    async () => {
      // The sweep is documented as same-uid. Prove the gate rather than the
      // comment: this process references the run's scratch dir for real, and a
      // uid that belongs to nobody on this host must still exclude it.
      const { scratch, serverScript, spawnerScript } = await setup();
      const port = await reserveFreePort();
      const { grandchildPid } = await spawnLostRunTree({
        spawnerScript,
        serverScript,
        scratchDir: scratch.dir,
        port,
      });
      expect(await waitForPortBound(port)).toBe(true);

      const ourUid = process.getuid?.() ?? null;
      expect(ourUid).not.toBeNull();
      expect(__testing.readRealUid(grandchildPid)).toBe(ourUid);
      // 2^22 - 2 is the last uid the kernel hands out and belongs to nothing.
      expect(
        __testing.collectDescendantCandidates({
          dir: scratch.dir,
          protect: new Set(),
          uid: 4194302,
        }),
      ).toEqual([]);
      // The same call with the server's own uid still finds it, so the empty
      // result above is the uid gate and not a broken scan.
      expect(
        __testing.collectDescendantCandidates({
          dir: scratch.dir,
          protect: new Set(),
          uid: ourUid,
        }),
      ).toContain(grandchildPid);
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
    "refuses a group that is both anchored to the run and holds the database",
    async () => {
      // The interaction #1 and the guard have to agree on, and the case that
      // makes ordering matter. Here the group is *provably* the run's: a live
      // member names the run's scratch directory, so the anchoring gate would
      // otherwise wave it through and signal it. That is exactly when a group
      // kill would reach the postmaster, so the database guard has to win.
      //
      // If the two checks were ordered the other way, or if either replaced the
      // other, the postmaster below would be dead at the end of this test.
      const scratch = await prepareHeartbeatRunScratch({
        companyId: "test-company",
        agentId: "test-agent",
        runId: nextRunId(),
      });
      tempDirs.push(scratch.dir);

      // The owner names the run's scratch directory, so its process group is
      // provably the run's: the anchoring gate is satisfied.
      const owner = await spawnDatabaseOwner({ scratchDir: scratch.dir });
      expect(await waitForPortBound(owner.port)).toBe(true);
      expect((await waitForPostmaster(owner.dataDir))?.postmasterPid).toBe(
        owner.pid,
      );

      // Prove the anchoring evidence is real, so this test cannot pass merely
      // because the anchoring gate happened to refuse first.
      const anchored = await reapLostRunProcessTree({
        processGroupId: owner.processGroupId,
        scratchDir: scratch.dir,
        graceMs: 1_000,
      });
      expect(anchored.refusedUnverifiedGroup).toBe(false);
      expect(anchored.refusedProtectedGroup).toBe(false);
      expect(anchored.groupSignalled).toBe(true);
      expect(await isAlive(owner.pid)).toBe(false);
      expect(await portIsBound(owner.port)).toBe(false);

      // Same shape again, but this time the database is reported. The group is
      // still anchored, and the group kill is refused anyway.
      const owner2 = await spawnDatabaseOwner({ scratchDir: scratch.dir });
      expect(await waitForPortBound(owner2.port)).toBe(true);
      expect((await waitForPostmaster(owner2.dataDir))?.postmasterPid).toBe(
        owner2.pid,
      );

      const result = await reapLostRunProcessTree({
        processGroupId: owner2.processGroupId,
        scratchDir: scratch.dir,
        databaseDataDir: owner2.dataDir,
        graceMs: 1_000,
      });

      expect(result.refusedProtectedGroup).toBe(true);
      expect(result.refusedUnverifiedGroup).toBe(false);
      expect(result.groupSignalled).toBe(false);
      expect(result.killedPids).toEqual([]);
      expect(await isAlive(owner2.pid)).toBe(true);
      expect(await portIsBound(owner2.port)).toBe(true);
    },
    60_000,
  );

  it(
    "does not fire the database guard when no database is reported",
    async () => {
      // No `databaseDataDir` means nothing is protected, so the guard must not
      // be what refuses anything here. The group is still refused, but by the
      // recycled-PGID anchoring gate (#1): with no scratch directory there is
      // no evidence the group is the run's, so it is left alone. Asserting the
      // specific refusing reason is what makes this a test of the guard's
      // opt-in-ness rather than a test of the anchoring gate in disguise.
      const owner = await spawnDatabaseOwner();
      expect(await waitForPortBound(owner.port)).toBe(true);

      const result = await reapLostRunProcessTree({
        processGroupId: owner.processGroupId,
        scratchDir: null,
        graceMs: 1_000,
      });

      expect(result.protectedPids).toEqual([]);
      expect(result.refusedProtectedGroup).toBe(false);
      expect(result.refusedUnverifiedGroup).toBe(true);
      expect(result.groupSignalled).toBe(false);
      expect(await isAlive(owner.pid)).toBe(true);
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
