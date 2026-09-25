import fsSync from "node:fs";
import path from "node:path";

/**
 * The live embedded PostgreSQL is the one process in a run's descendant tree
 * that must never be signalled, along with every process that supervises it.
 *
 * On 2026-09-25 a `paperclipai run` instance left in a terminal tab owned the
 * company's database as a direct child, and the whole agent fleet was talking
 * to a *second* server that had adopted it. A reaper that judges candidates by
 * "is a leaked `paperclipai run` tree" would have classified that instance as
 * an orphan and taken the production database down with it. Proving a tree
 * leaked requires knowing it belongs to a dead run; the one fact that
 * distinguishes a healthy owner from a leak is that it holds the database.
 *
 * Two mechanisms carry the database, and they fail differently:
 *
 *  - The run's recorded process group. `process.kill(-pgid)` has no opt-out, so
 *    if any protected pid is a member of that group the *whole* group kill has
 *    to be refused. There is no partial group signal.
 *  - The scratch-directory sweep, which is per-pid. It cannot reach the
 *    postmaster today because `@embedded-postgres` spawns it with a scrubbed
 *    environment (`LC_MESSAGES` only), but that is an implementation detail of
 *    a dependency, so the pids are excluded explicitly rather than relied upon
 *    not matching.
 *
 * Adoption of a healthy orphan is deliberately still allowed. When a previous
 * server is killed without stopping the database, the postmaster is reparented
 * to `systemd --user` and the next server legitimately reclaims it. The guard
 * therefore protects the postmaster and its *ancestors* rather than demanding
 * that this process be the parent: a reparented postmaster has no surviving
 * `paperclipai run` ancestor, while a split instance's postmaster is still
 * parented to the other server.
 */

/** Ancestor walk bound. The deepest real chain (init -> login -> scope -> tab ->
 *  server -> postmaster) is 5; 64 leaves room while keeping a cycle from
 *  spinning. */
const MAX_ANCESTOR_DEPTH = 64;

export interface InstanceDatabaseGuard {
  /** The live postmaster, as recorded in `<dataDir>/postmaster.pid`. */
  postmasterPid: number;
  /**
   * The postmaster followed by each of its ancestors, nearest parent first.
   * Every entry is refused by the reaper: signalling the supervisor of the
   * database kills the database just as surely as signalling the postmaster.
   */
  protectedPids: number[];
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another uid. It is alive, and
    // refusing to signal it is the safe answer either way.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * `/proc/<pid>/stat` field 4 is the parent pid. `comm` is parenthesised and may
 * contain spaces, so the fields after it are located from the last ')' rather
 * than by index.
 */
function readParentPid(pid: number): number | null {
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const ppid = Number.parseInt(stat.slice(close + 1).trim().split(/\s+/)[1] ?? "", 10);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Read `<dataDir>/postmaster.pid` and return the live postmaster plus its
 * ancestor chain, or null when there is no database to protect.
 *
 * Returns null for: no pid file, an unreadable pid file, a pid file whose
 * recorded data directory is not `dataDir`, a dead pid, and a `dataDir` that
 * does not exist. A stale or foreign pid file must not disable the guard's
 * callers, so each of those is a deliberate "nothing to protect" rather than a
 * throw -- and the caller keeps its existing behaviour in that case.
 */
export function resolveInstanceDatabaseGuard(
  dataDir: string | null | undefined,
): InstanceDatabaseGuard | null {
  const dir = dataDir?.trim();
  if (!dir) return null;

  let contents: string;
  try {
    contents = fsSync.readFileSync(path.resolve(dir, "postmaster.pid"), "utf8");
  } catch {
    return null;
  }

  const [pidLine, recordedDir] = contents.split("\n");
  const postmasterPid = Number.parseInt(pidLine?.trim() ?? "", 10);
  if (!Number.isInteger(postmasterPid) || postmasterPid <= 0) return null;
  // Same identity rule as embeddedPostgresOwnerPort: a pid file naming another
  // data directory is not this instance's database, so it protects nothing.
  if (!recordedDir?.trim() || path.resolve(recordedDir.trim()) !== path.resolve(dir)) {
    return null;
  }
  if (!isPidRunning(postmasterPid)) return null;

  const protectedPids = [postmasterPid];
  const seen = new Set(protectedPids);
  let current = postmasterPid;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const parent = readParentPid(current);
    // pid 1 (init) has ppid 0, which readParentPid reports as null. Stop there
    // so the guard never grows to cover unrelated system processes.
    if (parent === null || seen.has(parent)) break;
    protectedPids.push(parent);
    seen.add(parent);
    current = parent;
  }

  return { postmasterPid, protectedPids };
}

export const __testing = {
  readParentPid,
  isPidRunning,
  MAX_ANCESTOR_DEPTH,
};
