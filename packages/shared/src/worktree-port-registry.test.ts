import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCurrentProcessIdentity,
  withWorktreePortRegistryLock,
  withWorktreePortRegistryLockSync,
} from "./worktree-port-registry.js";

const temporaryRoots: string[] = [];
const liveInterferenceOwners: { stop: () => Promise<void> }[] = [];
const liveResponders: { stop: () => Promise<void> }[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-port-registry-lock-"));
  temporaryRoots.push(root);
  return root;
}

/**
 * The ownership probe responder half of a lease holder, on its own thread.
 *
 * It has to be a thread, not a server on the test's own event loop, because
 * production's `probeRegistryLockOwner` waits for the answer with
 * `Atomics.wait` on the calling thread. A responder sharing that thread can
 * never answer, and the probe reads as "no owner responded" no matter how
 * correct the fixture is.
 */
const PROBE_RESPONDER_SOURCE = `
const net = require("node:net");
const { workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.control);
const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  socket.once("error", () => {});
  socket.once("data", (candidate) => {
    socket.end(candidate === workerData.token ? "owned" : "denied");
  });
});
server.once("error", () => {
  Atomics.store(control, 0, -1);
  Atomics.notify(control, 0);
});
server.listen(0, "127.0.0.1", () => {
  Atomics.store(control, 1, server.address().port);
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
});
`;

/**
 * A lock owner that answers its own ownership probe for as long as `stop` has
 * not been called, and never touches a lock directory's mtime. That is what
 * makes the lock in the test below exclusively the test's to age, rewind, and
 * measure.
 */
function startProbeResponder(token: string): { port: number; stop: () => Promise<void> } {
  const control = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(PROBE_RESPONDER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: { control: control.buffer, token },
  });
  Atomics.wait(control, 0, 0, 5_000);
  const port = Atomics.load(control, 0) === 1 ? Atomics.load(control, 1) : 0;
  if (port <= 0) {
    void worker.terminate();
    throw new Error("The probe responder fixture did not bind a loopback port");
  }
  let terminated: Promise<void> | null = null;
  const responder = {
    port,
    // Terminating the thread releases the listening socket, so a later probe is
    // refused rather than answered. Idempotent, because afterEach stops every
    // responder this module still owns.
    stop: () => (terminated ??= worker.terminate().then(() => undefined)),
  };
  liveResponders.push(responder);
  return responder;
}

/**
 * A lock owner whose ownership probe never answers, and that may rewrite its own
 * lock while the reclaim is inside that probe.
 *
 * It has to be a thread, because production's `probeRegistryLockOwner` waits for
 * the answer with `Atomics.wait` on the calling thread. Anything sharing that
 * thread cannot run while a probe is outstanding, so a fixture on the test's own
 * event loop could not act inside the window the three re-checks below guard.
 *
 * The interference fires on the probe connection itself rather than on a timer.
 * Production reads the owner record, then reaches the probe, then reads the
 * record again, so a connection can only arrive after the first read, and the
 * synchronous rewrite here completes before the probe this worker refuses to
 * answer gives up. The reclaim therefore always observes the changed lock
 * between its two reads, with no sleeps to tune.
 */
const INTERFERENCE_OWNER_SOURCE = `
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");

const { interference, lockPath, owner } = workerData;
let generation = 0;
let probePort = 0;
let probes = 0;

function applyInterference() {
  if (interference === "refresh-mtime") {
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
    return;
  }
  if (interference === "replace-owner") {
    generation += 1;
    const contents = JSON.stringify({
      ...owner,
      probePort,
      token: owner.token + "-generation-" + generation,
    }) + "\\n";
    for (const ownerFile of ["owner.json", "owner.backup.json"]) {
      fs.writeFileSync(path.join(lockPath, ownerFile), contents);
    }
    // Writing into the directory refreshes its mtime, and the reclaim reads
    // that mtime too. Rewind it, so the owner-token re-check is the only
    // re-check that can refuse this reclaim.
    const stale = new Date(Date.now() - 10000);
    fs.utimesSync(lockPath, stale, stale);
  }
}

const server = net.createServer((socket) => {
  socket.once("error", () => {});
  socket.once("data", () => {
    probes += 1;
    try {
      applyInterference();
    } catch {
      // The lock is the reclaim's to remove; a failed rewrite only weakens the
      // window, so the probe count is what the test asserts on.
    }
    parentPort.postMessage({ probePort, probes });
  });
});
server.once("error", (error) => parentPort.postMessage({ error: String(error) }));
server.listen(0, "127.0.0.1", () => {
  probePort = server.address().port;
  parentPort.postMessage({ probePort, probes });
});
`;

type Interference = "none" | "refresh-mtime" | "replace-owner";

type LockOwnerRecord = {
  version: 1;
  pid: number;
  processIdentity: string;
  probePort: number;
  token: string;
};

/**
 * Starts the fixture and resolves once it reports its probe port.
 */
async function startInterferenceOwner(options: {
  interference: Interference;
  lockPath: string;
  owner: LockOwnerRecord;
}): Promise<{ probePort: number; probes: () => number; stop: () => Promise<void> }> {
  const worker = new Worker(INTERFERENCE_OWNER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: { ...options },
  });
  let terminated: Promise<void> | null = null;
  const fixture = {
    // Terminating the thread releases the listening socket, so a later probe is
    // refused. Idempotent, because afterEach stops every fixture this module
    // still owns.
    stop: () => (terminated ??= worker.terminate().then(() => undefined)),
  };
  liveInterferenceOwners.push(fixture);
  let probes = 0;
  const probePort = await new Promise<number>((resolve, reject) => {
    worker.on("message", (message: { probePort?: number; probes?: number; error?: string }) => {
      if (message.error) {
        reject(new Error(message.error));
        return;
      }
      probes = message.probes ?? probes;
      if (message.probePort) resolve(message.probePort);
    });
    worker.once("error", reject);
  });
  return { probePort, probes: () => probes, stop: fixture.stop };
}

/**
 * Writes both owner records, so the reclaim reads the same pair production
 * writes, then ages the lock past the reclaim's staleness threshold.
 */
function ageLockForReclaim(lockPath: string, owner: LockOwnerRecord): void {
  fs.mkdirSync(lockPath);
  const contents = `${JSON.stringify(owner)}\n`;
  for (const ownerFile of ["owner.json", "owner.backup.json"]) {
    fs.writeFileSync(path.join(lockPath, ownerFile), contents);
  }
  const oldTimestamp = new Date(Date.now() - 10_000);
  fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);
  // The rewind has to stick, or the re-check this fixture exercises is already
  // satisfied by the first staleness read and the test proves nothing.
  expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeGreaterThan(5_000);
}

afterEach(async () => {
  for (const owner of liveInterferenceOwners.splice(0)) {
    await owner.stop();
  }
  // Release the responder at the end of the test that started it, not at pool
  // teardown. A failing assertion between startProbeResponder() and the test's
  // own stop() would otherwise leave a thread bound to its loopback socket and
  // still answering probes for the rest of the run, so a later test's reclaim
  // decision could be steered by a fixture whose test had already failed.
  for (const responder of liveResponders.splice(0)) {
    await responder.stop();
  }
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("worktree port registry lock", () => {
  it("does not reclaim a stale lock while its fallback ownership probe responds", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const ownerToken = "fallback-probe-owner-token";
    const responder = startProbeResponder(ownerToken);

    // The lock under test belongs to this test rather than to a live holder, so
    // nothing can reset its mtime between the rewind below and the age the
    // reclaim decision reads. Rewinding the mtime of a real holder's lock and
    // then measuring that lock raced the holder's own heartbeat worker, which
    // touches the same mtime, so the measured age depended on runner load.
    fs.mkdirSync(lockPath);
    // Only the redundant record exists, so the reclaim has to read the owner
    // through the same fallback this test's name claims to cover.
    fs.writeFileSync(
      path.join(lockPath, "owner.backup.json"),
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        processIdentity: "unavailable-process-identity",
        probePort: responder.port,
        token: ownerToken,
      })}\n`,
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

    let secondEntered = false;
    const second = withWorktreePortRegistryLock(homeDir, async () => {
      secondEntered = true;
    });
    await delay(100);

    // Still stale on disk, so the hold below is the probe answering rather than
    // a lease that happened to look fresh.
    expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeGreaterThan(5_000);
    expect(secondEntered).toBe(false);

    // Once nothing answers the probe the same stale lock is reclaimed.
    await responder.stop();
    await second;
    expect(secondEntered).toBe(true);
  }, 10_000);

  it("refreshes the lease throughout an async critical section", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");

    await withWorktreePortRegistryLock(homeDir, async () => {
      await delay(5_250);
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(2_000);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  }, 10_000);

  it("reclaims an old lock after its owner process exits", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        processIdentity: "dead-process",
        probePort: 1,
        token: "dead-owner",
      })}\n`,
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

    let entered = false;
    await withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reclaims an old lock when its pid belongs to a different process", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        processIdentity: "reused-pid-owner",
        probePort: 1,
        token: "abandoned-owner",
      })}\n`,
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

    let entered = false;
    await withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("refreshes the lease while a synchronous critical section blocks the main thread", () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const blocker = new Int32Array(new SharedArrayBuffer(4));

    withWorktreePortRegistryLockSync(homeDir, () => {
      const oldTimestamp = new Date(Date.now() - 10_000);
      fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);
      Atomics.wait(blocker, 0, 0, 1_500);
      expect(Date.now() - fs.statSync(lockPath).mtimeMs).toBeLessThan(1_250);
    });

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not reclaim a lock this process still owns when its probe cannot answer", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const currentIdentity = readCurrentProcessIdentity();
    expect(currentIdentity).toBeTruthy();

    const owner = {
      version: 1,
      pid: process.pid,
      processIdentity: currentIdentity ?? "",
      probePort: 0,
      token: "live-owner-with-an-unanswerable-probe",
    } satisfies LockOwnerRecord;
    const fixture = await startInterferenceOwner({ interference: "none", lockPath, owner });
    ageLockForReclaim(lockPath, { ...owner, probePort: fixture.probePort });

    // The recorded identity is this process's own, and the probe accepts the
    // connection but returns no verdict, so the recorded pid alone must not
    // decide the lock is abandoned.
    let entered = false;
    await expect(withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    })).rejects.toThrow(/Timed out waiting for worktree port reservation lock/);

    expect(fixture.probes()).toBeGreaterThan(0);
    expect(entered).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  }, 20_000);

  it("does not reclaim a lock whose owner record is replaced between the reclaim's two reads", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const owner = {
      version: 1,
      pid: process.pid,
      processIdentity: "not-the-identity-this-process-reports",
      probePort: 0,
      token: "replaced-owner-token",
    } satisfies LockOwnerRecord;
    const fixture = await startInterferenceOwner({
      interference: "replace-owner",
      lockPath,
      owner,
    });
    ageLockForReclaim(lockPath, { ...owner, probePort: fixture.probePort });

    // The lock stays stale for the whole window and the probe returns no verdict,
    // so the only thing that can refuse the reclaim is a change to the owner
    // token.
    let entered = false;
    await expect(withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    })).rejects.toThrow(/Timed out waiting for worktree port reservation lock/);

    expect(fixture.probes()).toBeGreaterThan(0);
    expect(entered).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    const currentRecord: { token: string } = JSON.parse(
      fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"),
    );
    expect(currentRecord.token).not.toBe(owner.token);
  }, 20_000);

  it("does not reclaim a lock that is refreshed between the reclaim's two staleness reads", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const owner = {
      version: 1,
      pid: process.pid,
      processIdentity: "not-the-identity-this-process-reports",
      probePort: 0,
      token: "refreshing-owner-token",
    } satisfies LockOwnerRecord;
    const fixture = await startInterferenceOwner({
      interference: "refresh-mtime",
      lockPath,
      owner,
    });
    ageLockForReclaim(lockPath, { ...owner, probePort: fixture.probePort });

    // The owner record never changes here, so the only thing that can refuse the
    // reclaim is the mtime the second staleness read finds.
    let entered = false;
    await expect(withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    })).rejects.toThrow(/Timed out waiting for worktree port reservation lock/);

    expect(fixture.probes()).toBeGreaterThan(0);
    expect(entered).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  }, 20_000);
});
