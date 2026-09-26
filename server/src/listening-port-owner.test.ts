import fsSync from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  findListeningPortOwnerPid,
  listeningSocketInodesForPort,
  parseProcNetTable,
  pidsHoldingSocketInodes,
} from "./listening-port-owner.js";

/**
 * The port-owner lookup exists so the busy-port warning can name a process, so
 * these tests care about one thing: never name the wrong one. A wrong pid sends
 * an operator to kill an innocent process, which is worse than the unnamed
 * warning it replaces, so every negative case is asserted as firmly as the
 * positive one.
 */

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TCP_TABLE_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

describe("parseProcNetTable", () => {
  it("keeps only the fields the lookup matches on", () => {
    const rows = parseProcNetTable(
      TCP_TABLE_HEADER +
        "   0: 0100007F:0C35 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000 100 0 0 10 0\n",
    );
    expect(rows).toEqual([{ localPortHex: "0C35", state: "0A", inode: "4242" }]);
  });

  it("ignores the header and short rows", () => {
    expect(parseProcNetTable(TCP_TABLE_HEADER)).toEqual([]);
    expect(parseProcNetTable(TCP_TABLE_HEADER + "   0: broken\n")).toEqual([]);
  });
});

describe("listeningSocketInodesForPort", () => {
  it("returns every socket listening on the port, IPv4 and IPv6 alike", () => {
    const tcp =
      TCP_TABLE_HEADER +
      "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11 1 0000 100 0 0 10 0\n" +
      "   1: 0100007F:1388 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 12 1 0000 100 0 0 10 0\n";
    const tcp6 =
      TCP_TABLE_HEADER +
      "   0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 13 1 0000 100 0 0 10 0\n";
    // 0BB8 is 3000. The row on 0x1388 (5000) is an established connection, not a
    // listener, so it must not be reported as one.
    expect(listeningSocketInodesForPort(3000, [tcp, tcp6])).toEqual(["11", "13"]);
  });

  it("returns nothing for a port nobody is listening on", () => {
    const tcp =
      TCP_TABLE_HEADER +
      "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11 1 0000 100 0 0 10 0\n";
    expect(listeningSocketInodesForPort(3001, [tcp])).toEqual([]);
  });
});

describe("pidsHoldingSocketInodes", () => {
  /** A synthetic /proc: `<root>/<pid>/fd/<n>` is a symlink reading `socket:[i]`. */
  function makeFakeProcRoot(pids: Array<{ pid: number; inodes: number[] }>): string {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "pet167-proc-"));
    for (const { pid, inodes } of pids) {
      const fdDir = path.join(root, String(pid), "fd");
      fsSync.mkdirSync(fdDir, { recursive: true });
      inodes.forEach((inode, index) => {
        fsSync.symlinkSync(`socket:[${inode}]`, path.join(fdDir, String(index + 3)));
      });
    }
    cleanups.push(() => fsSync.rmSync(root, { recursive: true, force: true }));
    return root;
  }

  it("maps a socket inode back to the process holding it", () => {
    const root = makeFakeProcRoot([
      { pid: 900, inodes: [1] },
      { pid: 100, inodes: [77] },
      { pid: 5000, inodes: [2] },
    ]);
    expect(pidsHoldingSocketInodes(["77"], root)).toEqual([100]);
  });

  it("returns every holder, lowest pid first", () => {
    const root = makeFakeProcRoot([
      { pid: 900, inodes: [1, 77] },
      { pid: 100, inodes: [77] },
    ]);
    expect(pidsHoldingSocketInodes(["77", "1"], root)).toEqual([100, 900]);
  });

  it("does not confuse a non-socket descriptor for a socket", () => {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "pet167-proc-"));
    cleanups.push(() => fsSync.rmSync(root, { recursive: true, force: true }));
    const fdDir = path.join(root, "77", "fd");
    fsSync.mkdirSync(fdDir, { recursive: true });
    fsSync.symlinkSync("/tmp/some-file", path.join(fdDir, "3"));
    expect(pidsHoldingSocketInodes(["77"], root)).toEqual([]);
  });

  it("reports nothing for a missing /proc rather than throwing", () => {
    expect(pidsHoldingSocketInodes(["77"], "/nonexistent-proc-root")).toEqual([]);
    expect(pidsHoldingSocketInodes([])).toEqual([]);
  });
});

describe("findListeningPortOwnerPid", () => {
  it("names this process for a port it is listening on", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;

    // This test process is the listener, so the answer is provable rather than
    // merely plausible: the lookup is not allowed to answer for a port that
    // nobody holds.
    expect(findListeningPortOwnerPid(port)).toBe(process.pid);
  });

  it("returns null for a port with no listener", () => {
    const probe = net.createServer();
    const bound = new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () => resolve((probe.address() as net.AddressInfo).port));
    });
    return bound
      .then(async (port) => {
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        expect(findListeningPortOwnerPid(port)).toBeNull();
      });
  });

  it("rejects a port that cannot exist", () => {
    expect(findListeningPortOwnerPid(0)).toBeNull();
    expect(findListeningPortOwnerPid(70000)).toBeNull();
    expect(findListeningPortOwnerPid(1.5)).toBeNull();
  });
});
