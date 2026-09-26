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
 *
 * That same distinction is what the startup refusal is built on, so the ancestry
 * walk lives here rather than in the server entrypoint: `resolveLiveServerOwner`
 * answers "is a *different* live `paperclipai run` server the parent of this
 * database?", which is the one fact that separates a supported recovery from a
 * split instance.
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

  const protectedPids = [postmasterPid, ...readProcessAncestry(postmasterPid)];

  return { postmasterPid, protectedPids };
}

/**
 * The live ancestors of `pid`, nearest parent first.
 *
 * pid 1 (init) has ppid 0, which `readParentPid` reports as null, so the walk
 * stops there and never grows to cover unrelated system processes. A `seen` set
 * bounds a kernel-level cycle as well as the depth bound.
 */
export function readProcessAncestry(pid: number): number[] {
  const ancestors: number[] = [];
  const seen = new Set<number>([pid]);
  let current = pid;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const parent = readParentPid(current);
    if (parent === null || seen.has(parent)) break;
    ancestors.push(parent);
    seen.add(parent);
    current = parent;
  }
  return ancestors;
}

/**
 * The `paperclipai` bin however it was reached: the shim itself, or a `.js`
 * entrypoint behind a node wrapper (`node /usr/local/bin/paperclipai run`).
 * A development checkout is launched as `node <checkout>/server/dist/index.js
 * run`, so the name can also appear as a path segment rather than a basename.
 */
const PAPERCLIP_BIN_PATTERN = /^paperclipai(\.(c|m)?js)?$/;

function isPaperclipBinToken(token: string): boolean {
  return token.split(/[\\/]/).some((segment) => PAPERCLIP_BIN_PATTERN.test(segment));
}

/**
 * Is this argv a `paperclipai run` server?
 *
 * `run` is the only subcommand that serves, and it has to be the token
 * immediately after the binary: `paperclipai doctor` and
 * `paperclipai heartbeat run` are utilities that exit, and an agent process
 * whose argv merely mentions the bin is not a server either.
 *
 * The first bin token decides the answer, so a later mention (a flag value, a
 * path in an argument) cannot promote a process into a server. Both failure
 * directions of a miss are asymmetric on purpose: a false positive refuses a
 * legitimate startup, while a false negative leaves the pre-existing adopt
 * behaviour in place, so the matcher errs towards the second.
 *
 * One shape is deliberately not recognised: the development runner launches the
 * server through `tsx scripts/dev-runner.ts`, which never puts a bin name and a
 * `run` in one argv. A dev server therefore never refuses a database, and a
 * stray `paperclipai run` can still borrow one. That is the safe direction to
 * miss in -- a dev host is a developer's own -- and closing it would mean
 * pattern-matching on a dev script's internals.
 */
export function isPaperclipServerArgv(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!.trim();
    if (!token) continue;
    if (!isPaperclipBinToken(token)) continue;
    return (argv[index + 1] ?? "").trim() === "run";
  }
  return false;
}

/** `/proc/<pid>/cmdline` as argv, or null when it cannot be read. */
export function readProcessArgv(pid: number): string[] | null {
  try {
    const argv = fsSync
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter((entry) => entry.length > 0);
    return argv.length > 0 ? argv : null;
  } catch {
    // ESRCH (exited) and EACCES (not ours) both mean "cannot claim it".
    return null;
  }
}

/**
 * The cgroup path of `pid`, for the operator to find the owning unit.
 * `/proc/<pid>/cgroup` rows are `hierarchy-ID:controller-list:cgroup-path`; the
 * unified hierarchy leaves the controller list empty.
 */
export function readProcessCgroup(pid: number): string | null {
  let raw: string;
  try {
    raw = fsSync.readFileSync(`/proc/${pid}/cgroup`, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const cgroupPath = line.trim().split(":")[2]?.trim();
    if (cgroupPath) return cgroupPath;
  }
  return null;
}

/** A live `paperclipai run` server found in a postmaster's ancestry. */
export interface LiveServerProcess {
  pid: number;
  /** cgroup path, so the operator can find the unit or terminal that owns it. */
  cgroup: string | null;
  /** The full argv, so the operator can recognise the process. */
  cmdline: string;
}

/**
 * The live `paperclipai run` server that owns `postmasterPid`, or null when
 * there is none.
 *
 * Ancestry is the whole test, and it is the distinction the recovery path turns
 * on:
 *
 *  - A split instance's postmaster is a direct child of the *other* server, so
 *    that server is in its ancestry and this returns it.
 *  - A postmaster reparented to `systemd --user` after an unclean kill has no
 *    surviving `paperclipai run` ancestor, so this returns null and the caller
 *    keeps the supported reclaim behaviour.
 *
 * `selfPid` is this process, which is a legitimate owner whenever it started
 * the postmaster itself and must never be reported as a collision.
 */
export function resolveLiveServerOwner(
  postmasterPid: number,
  options: { selfPid?: number } = {},
): LiveServerProcess | null {
  if (!Number.isInteger(postmasterPid) || postmasterPid <= 0) return null;
  const selfPid = options.selfPid ?? process.pid;
  for (const pid of readProcessAncestry(postmasterPid)) {
    if (pid === selfPid) continue;
    if (!isPidRunning(pid)) continue;
    const argv = readProcessArgv(pid);
    if (!argv || !isPaperclipServerArgv(argv)) continue;
    return { pid, cgroup: readProcessCgroup(pid), cmdline: argv.join(" ") };
  }
  return null;
}

export const __testing = {
  readParentPid,
  isPidRunning,
  readProcessArgv,
  readProcessCgroup,
  MAX_ANCESTOR_DEPTH,
};
