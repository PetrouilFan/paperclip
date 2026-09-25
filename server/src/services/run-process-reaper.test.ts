import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { prepareHeartbeatRunScratch } from "./run-scratch.js";
import { __testing, reapLostRunProcessTree } from "./run-process-reaper.js";

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
});
