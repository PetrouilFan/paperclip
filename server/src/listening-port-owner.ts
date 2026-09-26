import fsSync from "node:fs";

/**
 * Which process is holding a TCP port, read from `/proc`.
 *
 * `detectPort` answers one question -- is this port free -- and returns a
 * number. So when the server had to move to the next port it could only say
 * `requestedPort=3100, selectedPort=3101`, which leaves the operator to go
 * hunting for the process that took 3100. During the split-instance incident
 * those two lines were the only evidence that a second instance existed at all.
 *
 * Naming the pid is worth the read, and the read is worth its cost because it
 * only happens on a collision: parsing the two `/proc/net/tcp{,6}` tables is
 * cheap, and the `/proc/<pid>/fd` sweep only runs when the port is actually
 * held. A pid this cannot prove is reported as unknown rather than guessed --
 * the port is busy either way, and the collision itself is not an error.
 */

const TCP_STATE_LISTEN = "0A";

/** One row of `/proc/net/tcp` or `/proc/net/tcp6`, reduced to what we match on. */
export interface ProcNetListenerRow {
  localPortHex: string;
  state: string;
  /** Socket inode; the only thing that identifies *this* socket. */
  inode: string;
}

/** Parse one `/proc/net/tcp{,6}` table. Exported pure so it can be tested without
 *  a live socket. */
export function parseProcNetTable(content: string): ProcNetListenerRow[] {
  const rows: ProcNetListenerRow[] = [];
  for (const line of content.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 10) continue;
    const [localAddress, localPort] = columns[1]!.split(":");
    if (!localAddress || !localPort) continue;
    rows.push({ localPortHex: localPort, state: columns[3]!, inode: columns[9]! });
  }
  return rows;
}

/**
 * The socket inodes listening on `port` across the given tables.
 *
 * A wildcard IPv4 bind and an IPv6 bind on the same port are two sockets with
 * two inodes, and either one can be the process an operator needs to find, so
 * both are returned rather than a single guess.
 */
export function listeningSocketInodesForPort(
  port: number,
  tables: readonly string[],
): string[] {
  const wantHex = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const table of tables) {
    for (const row of parseProcNetTable(table)) {
      if (row.state !== TCP_STATE_LISTEN) continue;
      if (row.localPortHex.toUpperCase() !== wantHex) continue;
      if (row.inode && row.inode !== "0") inodes.add(row.inode);
    }
  }
  return [...inodes];
}

/**
 * The pids holding any of `inodes`, lowest first.
 *
 * `procRoot` is injectable so the fd sweep can be tested against a synthetic
 * tree; `/proc/<pid>/fd/<n>` reads as `socket:[<inode>]`.
 */
export function pidsHoldingSocketInodes(
  inodes: readonly string[],
  procRoot = "/proc",
): number[] {
  const wanted = new Set(inodes.map((inode) => `socket:[${inode}]`));
  if (wanted.size === 0) return [];

  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const pid = Number.parseInt(entry.name, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let fds: fsSync.Dirent[];
    try {
      fds = fsSync.readdirSync(`${procRoot}/${pid}/fd`, { withFileTypes: true });
    } catch {
      // ESRCH (exited) and EACCES (another uid) both mean "not provable here".
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = fsSync.readlinkSync(`${procRoot}/${pid}/fd/${fd.name}`);
      } catch {
        continue;
      }
      if (wanted.has(target)) {
        pids.push(pid);
        break;
      }
    }
  }
  return pids.sort((left, right) => left - right);
}

/**
 * The lowest pid listening on `port`, or null when the port is free, the
 * listeners belong to another uid, or the tables cannot be read.
 *
 * A null answer is never load-bearing: the caller already knows the port is busy
 * from `detectPort`, and only uses this to name the owner.
 */
export function findListeningPortOwnerPid(port: number): number | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  let tables: string[] = [];
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      tables.push(fsSync.readFileSync(path, "utf8"));
    } catch {
      // Absent (non-Linux) or unreadable: report unknown rather than guessing.
    }
  }
  const [first] = pidsHoldingSocketInodes(listeningSocketInodesForPort(port, tables));
  return first ?? null;
}
