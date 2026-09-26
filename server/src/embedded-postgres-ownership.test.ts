import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decideEmbeddedPostgresReuse, formatDatabaseOwnershipRefusal } from "./embedded-postgres-ownership.js";
import { isPaperclipServerArgv, resolveInstanceDatabaseGuard } from "./services/instance-database-guard.js";

/**
 * These tests reproduce the split-instance process shapes against real `/proc`,
 * because the decision is made entirely from parentage and that is the part a
 * mock cannot prove:
 *
 *  - A split instance: a `paperclipai run` server whose child is the postmaster.
 *  - The supported recovery: the same postmaster after its server was killed
 *    uncleanly, reparented out of every `paperclipai run`.
 *
 * Two details make them faithful rather than merely convenient.
 *
 * The stand-in server is launched through a file named `paperclipai`, because
 * `/proc/<pid>/cmdline` is the only evidence the refusal has.
 *
 * Every stand-in is started by a launcher that exits immediately, so the kernel
 * reparents it to `systemd --user` -- which is what a supervised or a
 * `kill -9`ed server looks like. That matters for correctness of the *test*:
 * a stand-in left parented to the test runner would inherit the test runner's
 * own ancestry, and a test suite running inside a `paperclipai run` would then
 * find a live server above every stand-in it created.
 */

const spawned: ChildProcess[] = [];
const detachedPids: number[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const pid of detachedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const child of spawned.splice(0)) {
    if (child.pid === undefined) continue;
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function track(child: ChildProcess): ChildProcess {
  spawned.push(child);
  return child;
}

function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "object" && address) {
        resolve(address.port);
      } else {
        reject(new Error("no port"));
      }
      probe.close();
    });
  });
}

/** Writes a `postmaster.pid` in the real format, binds a port, then holds both. */
const POSTMASTER_SOURCE = `
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { dataDir, port } = JSON.parse(process.env.POSTMASTER_CONFIG);
const server = net.createServer((socket) => socket.end());
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(
    path.join(dataDir, "postmaster.pid"),
    [process.pid, dataDir, Date.now(), port, 0, dataDir, "", "", ""].join("\\n") + "\\n",
  );
  process.stdout.write("postmaster-ready\\n");
});
setInterval(() => {}, 1000);
`;

/**
 * Starts a detached process, reports its pid, then exits without waiting for it:
 * the kernel reparents the child to the nearest subreaper, which on a systemd
 * host is `systemd --user`.
 */
const RELAUNCHER_SOURCE = `
const { spawn } = require("node:child_process");
const { command, args, env, label } = JSON.parse(process.env.RELAUNCHER_CONFIG);
const child = spawn(command, args, {
  stdio: "ignore",
  detached: true,
  env: { ...process.env, ...env },
});
child.unref();
process.stdout.write(label + "=" + child.pid + "\\n");
process.exit(0);
`;

/** Stands in for a live `paperclipai run` server that owns the database. */
const SERVER_SOURCE = `
const { spawn } = require("node:child_process");
const { script, config } = JSON.parse(process.env.SERVER_CONFIG);
const child = spawn(process.execPath, [script], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, POSTMASTER_CONFIG: JSON.stringify(config) },
});
process.stdout.write("postmaster-pid=" + process.pid + "\\n");
child.on("error", (err) => {
  process.stderr.write(String(err) + "\\n");
  process.exit(1);
});
setInterval(() => {}, 1000);
`;

async function writeScript(name: string, source: string): Promise<string> {
  const file = path.join(await makeTempDir("pgown-scripts-"), name);
  await fs.writeFile(file, source, "utf8");
  return file;
}

function readPidLine(child: ChildProcess, prefix: string, timeoutMs = 15_000): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`no ${prefix} line within ${timeoutMs}ms`)), timeoutMs);
    // Deliberately not `resume()`d first: a resumed stream discards the chunk
    // that lands before this listener is attached, and these children print
    // their pid as their first act.
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const match = buffered.match(new RegExp(`${prefix}=(\\d+)`));
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.stderr?.resume();
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited before ${prefix} (code=${code})`));
    });
  });
}

/** Start a detached process through an exiting launcher; returns its pid. */
async function relaunch(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  label: string;
}): Promise<{ pid: number; launcherPid: number }> {
  const launcher = await writeScript("relauncher.cjs", RELAUNCHER_SOURCE);
  const child = track(
    spawn(process.execPath, [launcher], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RELAUNCHER_CONFIG: JSON.stringify({
          command: input.command,
          args: input.args,
          env: input.env ?? {},
          label: input.label,
        }),
      },
    }),
  );
  const pid = await readPidLine(child, input.label);
  const launcherPid = child.pid as number;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return { pid, launcherPid };
}

/** The postmaster is only a `paperclipai run` child once it has published its
 *  pid file, and the pid file is only trusted once the guard resolves it. */
async function waitForPostmaster(dataDir: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const guard = resolveInstanceDatabaseGuard(dataDir);
    if (guard) return guard;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/** Wait until a pid has left the process table, so its children are reparented. */
async function waitForPidGone(pid: number, timeoutMs = 15_000): Promise<boolean> {
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

interface SplitInstance {
  dataDir: string;
  port: number;
  postmasterPid: number;
  serverPid: number;
}

/** A `paperclipai run` server with the postmaster as its direct child. */
async function spawnSplitInstance(): Promise<SplitInstance> {
  const binDir = await makeTempDir("pgown-bin-");
  const bin = path.join(binDir, "paperclipai");
  await fs.writeFile(bin, SERVER_SOURCE, "utf8");
  const postmasterScript = await writeScript("postmaster.cjs", POSTMASTER_SOURCE);
  const dataDir = await makeTempDir("pgown-db-");
  const port = await reserveFreePort();

  const { pid: serverPid } = await relaunch({
    command: process.execPath,
    args: [bin, "run", "--instance", "other"],
    env: {
      SERVER_CONFIG: JSON.stringify({
        script: postmasterScript,
        config: { dataDir, port },
      }),
    },
    label: "server-pid",
  });
  detachedPids.push(serverPid);
  const guard = await waitForPostmaster(dataDir);
  if (!guard) throw new Error("stand-in postmaster never published a resolvable pid file");
  return { dataDir, port, postmasterPid: guard.postmasterPid, serverPid };
}

interface OrphanDatabase {
  dataDir: string;
  port: number;
  postmasterPid: number;
}

/**
 * A postmaster with no `paperclipai run` above it: started by a launcher that
 * exited, so the kernel reparented it to `systemd --user` exactly as it does
 * after a supervised server is `kill -9`ed and the database outlives it.
 */
async function spawnOrphanedDatabase(): Promise<OrphanDatabase> {
  const postmasterScript = await writeScript("postmaster.cjs", POSTMASTER_SOURCE);
  const dataDir = await makeTempDir("pgown-orphan-db-");
  const port = await reserveFreePort();
  const { pid: postmasterPid } = await relaunch({
    command: process.execPath,
    args: [postmasterScript],
    env: { POSTMASTER_CONFIG: JSON.stringify({ dataDir, port }) },
    label: "postmaster-pid",
  });
  detachedPids.push(postmasterPid);
  const guard = await waitForPostmaster(dataDir);
  if (!guard) throw new Error("orphaned stand-in postmaster never published a resolvable pid file");
  return { dataDir, port, postmasterPid: guard.postmasterPid };
}

describe("isPaperclipServerArgv", () => {
  it("accepts a server behind a node wrapper", () => {
    expect(
      isPaperclipServerArgv(["/usr/bin/node", "/usr/local/bin/paperclipai", "run", "--instance", "default"]),
    ).toBe(true);
  });

  it("accepts the shim invoked directly", () => {
    expect(isPaperclipServerArgv(["/usr/local/bin/paperclipai", "run"])).toBe(true);
  });

  it("accepts a js entrypoint", () => {
    expect(isPaperclipServerArgv(["node", "/usr/local/bin/paperclipai.js", "run"])).toBe(true);
  });

  it("accepts a development checkout launched by its built entrypoint", () => {
    expect(
      isPaperclipServerArgv(["node", "/home/u/dev/paperclipai/server/dist/index.js", "run", "--port", "3100"]),
    ).toBe(true);
  });

  it("rejects the utility subcommands", () => {
    expect(isPaperclipServerArgv(["node", "/usr/local/bin/paperclipai", "doctor"])).toBe(false);
    expect(isPaperclipServerArgv(["node", "/usr/local/bin/paperclipai", "service", "status"])).toBe(false);
  });

  it("rejects `heartbeat run`, which exits instead of serving", () => {
    expect(isPaperclipServerArgv(["node", "/usr/local/bin/paperclipai", "heartbeat", "run"])).toBe(false);
  });

  it("rejects an agent that merely mentions the bin", () => {
    expect(isPaperclipServerArgv(["node", "/srv/app.js", "run", "--target", "/usr/local/bin/paperclipai"])).toBe(
      false,
    );
  });

  it("rejects a different binary with a `run` subcommand", () => {
    expect(isPaperclipServerArgv(["opencode", "run", "--model", "local-zenfree/default"])).toBe(false);
  });
});

describe("decideEmbeddedPostgresReuse", () => {
  it("starts a database when the caller found no live postmaster", () => {
    expect(
      decideEmbeddedPostgresReuse({ dataDir: "/tmp/does-not-exist", postmasterPid: null }),
    ).toEqual({ action: "start", postmasterPid: null, liveServerOwner: null, message: null });
  });

  it("refuses a database owned by another live server, naming pid, cgroup and port", async () => {
    const split = await spawnSplitInstance();
    const outcome = decideEmbeddedPostgresReuse({
      dataDir: split.dataDir,
      postmasterPid: split.postmasterPid,
      port: split.port,
    });

    expect(outcome.action).toBe("refuse");
    if (outcome.action !== "refuse") throw new Error("expected a refusal");
    expect(outcome.liveServerOwner.pid).toBe(split.serverPid);
    expect(outcome.liveServerOwner.cgroup).toBeTruthy();
    expect(outcome.message).toContain(`pid=${split.serverPid}`);
    expect(outcome.message).toContain(`port=${split.port}`);
    expect(outcome.message).toContain(outcome.liveServerOwner.cgroup!);
  });

  it("still adopts a database this process started itself", async () => {
    const split = await spawnSplitInstance();
    const outcome = decideEmbeddedPostgresReuse({
      dataDir: split.dataDir,
      postmasterPid: split.postmasterPid,
      port: split.port,
      // The server that owns the database is this process as far as the
      // decision is concerned: a postmaster we started is not a collision, and
      // its remaining ancestry is this host's, not another instance's.
      selfPid: split.serverPid,
    });
    expect(outcome.action).toBe("adopt");
  });

  it("still adopts an orphaned postmaster with no live server above it", async () => {
    const orphan = await spawnOrphanedDatabase();
    const guard = resolveInstanceDatabaseGuard(orphan.dataDir);
    expect(guard).not.toBeNull();
    // The walk really did run and really did find no server, so this is the
    // recovery shape and not a test that passes because nothing was inspected.
    expect(guard!.protectedPids.length).toBeGreaterThan(0);
    expect(guard!.protectedPids).toContain(orphan.postmasterPid);

    const outcome = decideEmbeddedPostgresReuse({
      dataDir: orphan.dataDir,
      postmasterPid: orphan.postmasterPid,
      port: orphan.port,
    });
    expect(outcome).toEqual({
      action: "adopt",
      postmasterPid: orphan.postmasterPid,
      liveServerOwner: null,
      message: null,
    });
  });

  it("does not downgrade an owned database to a port move when a port is busy", async () => {
    const split = await spawnSplitInstance();
    // A busy port with a free alternative is what the old code turned into a
    // second instance: it moved to the next port and carried on with the
    // borrowed database.
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    try {
      const busyPort = (blocker.address() as net.AddressInfo).port;
      const outcome = decideEmbeddedPostgresReuse({
        dataDir: split.dataDir,
        postmasterPid: split.postmasterPid,
        port: split.port,
      });
      expect(outcome.action).toBe("refuse");
      if (outcome.action !== "refuse") throw new Error("expected a refusal");
      // A refusal never offers to move to another port, and never reports the
      // busy port as the thing that went wrong.
      expect(outcome.message).not.toContain("next free port");
      expect(outcome.message).not.toContain(String(busyPort));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("the refusal is not silently downgraded by a later port move", () => {
  it("refuses in the database block, which runs before the listen port is chosen", async () => {
    // The combination this ticket exists for -- a borrowed database *and* a
    // busy HTTP port -- is only safe if the refusal happens before the port
    // collision can be logged as a warning the operator is meant to act on.
    // `index.ts` is not importable here (it starts a server), so the ordering
    // is asserted on the source instead.
    const source = await fs.readFile(
      new URL("./index.ts", import.meta.url),
      "utf8",
    );
    const refusalAt = source.indexOf("decideEmbeddedPostgresReuse({ dataDir, postmasterPid: runningPid, port })");
    const throwAt = source.indexOf("throw new Error(reuse.message);", refusalAt);
    const portChoiceAt = source.indexOf("const listenPort = await detectPort(");
    const portWarnAt = source.indexOf("Requested port is busy;", throwAt);

    expect(refusalAt).toBeGreaterThan(-1);
    expect(throwAt).toBeGreaterThan(refusalAt);
    expect(portChoiceAt).toBeGreaterThan(throwAt);
    expect(portWarnAt).toBeGreaterThan(portChoiceAt);
  });
});

describe("formatDatabaseOwnershipRefusal", () => {
  it("says the pid, the cgroup and the port", () => {
    const message = formatDatabaseOwnershipRefusal({
      dataDir: "/home/u/.paperclip/instances/default/db",
      port: 54329,
      owner: { pid: 4242, cgroup: "/user.slice/paperclipai.service", cmdline: "paperclipai run" },
    });
    expect(message).toContain("/home/u/.paperclip/instances/default/db");
    expect(message).toContain("pid=4242");
    expect(message).toContain("cgroup=/user.slice/paperclipai.service");
    expect(message).toContain("port=54329");
  });

  it("degrades an unreadable cgroup to unknown rather than omitting the field", () => {
    const message = formatDatabaseOwnershipRefusal({
      dataDir: "/data",
      port: null,
      owner: { pid: 7, cgroup: null, cmdline: "paperclipai run" },
    });
    expect(message).toContain("cgroup=unknown");
    expect(message).toContain("port=unknown");
  });
});
