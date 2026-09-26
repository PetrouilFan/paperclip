import fsSync from "node:fs";
import os from "node:os";

import {
  isPidAlive,
  isProcessGroupAlive,
} from "./local-service-supervisor.js";
import {
  resolveInstanceDatabaseGuard,
  type InstanceDatabaseGuard,
} from "./instance-database-guard.js";

/**
 * A run that dies by process loss can leave its own descendant tree running.
 *
 * The recorded `processPid` is the run's direct child. When that child exits,
 * the kernel reparents anything it spawned to init, so the server loses the
 * only handle it had. Two shapes leak in practice:
 *
 *  1. The run recorded a process group, but the group leader is gone and the
 *     remaining members were reparented. `process.kill(-pgid)` still works,
 *     so this is the cheap, authoritative case.
 *  2. The run recorded no process group, so its descendants were never
 *     isolated and share the server's own group. Signalling that group would
 *     take down the server itself, so the descendants have to be found
 *     individually. That is what the run scratch directory buys us: every
 *     descendant inherits `PAPERCLIP_RUN_SCRATCH_DIR` and the run's own argv,
 *     and that path is a unique `mkdtemp` name, so matching on it is an exact
 *     ownership proof rather than a heuristic.
 *
 * The reaper is deliberately bounded and idempotent:
 *
 *  - It only ever signals same-uid processes whose cmdline or environ contains
 *    the run's scratch directory, or a recorded process group whose ownership
 *    is still provable.
 *  - It never signals this process, its ancestors, or anything in this
 *    server's own process group.
 *  - It never signals a recorded process group it cannot prove is the run's.
 *    A pgid is a recyclable number and the run's group is already known dead
 *    when the process-loss path gets here, so "the group is alive" is not
 *    evidence of anything.
 *  - It never signals the instance's live embedded PostgreSQL, or anything that
 *    supervises it. See `instance-database-guard.ts`: a leaked-tree heuristic
 *    cannot tell a healthy database owner from an orphan, so ownership of the
 *    database is checked directly and the group kill is refused outright when
 *    it would reach it.
 *  - Re-running it after a successful reap finds nothing and is a no-op.
 */

const SIGTERM_GRACE_MS = 2_000;
const SIGKILL_GRACE_MS = 2_000;

export interface RunProcessReapResult {
  processGroupId: number | null;
  groupWasAlive: boolean;
  groupSignalled: boolean;
  matchedPids: number[];
  signalledPids: number[];
  killedPids: number[];
  /**
   * Set when the run's recorded group is this server's own group. Signalling it
   * would terminate the server itself, so the group is skipped and only the
   * scratch-directory sweep (if it has an anchor) is used.
   */
  refusedOwnGroup: boolean;
  /**
   * Set when the run's recorded group is alive but nothing proves it still
   * belongs to the run — no scratch directory is known, or no live member of
   * the group names it. A recorded pgid is a bare number that the kernel
   * recycles, and the run's group was already observed dead before this runs, so
   * signalling it unverified could take down an unrelated process group. The
   * scratch sweep still runs and still reaps anything it can prove.
   */
  refusedUnverifiedGroup: boolean;
  /**
   * Set when the run's recorded group contains the instance's live embedded
   * PostgreSQL, or a process that supervises it. `process.kill(-pgid)` cannot
   * exempt one member, so the whole group is left alone and only the
   * scratch-directory sweep runs.
   */
  refusedProtectedGroup: boolean;
  /**
   * The postmaster and its ancestor chain, as protected for this call. Empty
   * when no database was found to protect, which is the normal case for a test
   * or a server that is not using an embedded database.
   */
  protectedPids: number[];
  skippedReason: "not_linux" | "no_anchor" | null;
  errors: string[];
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readProcNumericEntries(): number[] {
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const pid = Number.parseInt(entry.name, 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

function readProcessGroupId(pid: number): number | null {
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field is parenthesised and may contain spaces, so the fields
    // after it are located from the last ')' rather than by index.
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const rest = stat.slice(close + 1).trim().split(/\s+/);
    // rest[0] is state; ppid is rest[1]; pgrp is rest[2].
    const pgrp = Number.parseInt(rest[2] ?? "", 10);
    return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
  } catch {
    return null;
  }
}

/**
 * The real uid a process runs as, or null when `/proc/<pid>/status` cannot be
 * read or parsed.
 *
 * The sweep matches on a scratch path that is unique per run, so a foreign-uid
 * hit should be impossible. It is not: a server started as root can read
 * another account's `cmdline` and `environ`, so any process that merely
 * mentions the path becomes a signal target. Requiring the real uid to equal
 * the server's keeps the sweep inside the account that owns the run, and keeps
 * a failed read meaning "cannot claim it" rather than "claim it".
 */
function readRealUid(pid: number): number | null {
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^Uid:\s+(\d+)/m);
    if (!match) return null;
    const uid = Number.parseInt(match[1] ?? "", 10);
    return Number.isInteger(uid) ? uid : null;
  } catch {
    // ESRCH (exited) and EACCES (not ours) both mean "cannot claim it".
    return null;
  }
}

/**
 * The single-letter run state from `/proc/<pid>/stat` (`R`, `S`, `Z`, ...), or
 * null when it cannot be read.
 */
function readProcessState(pid: number): string | null {
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    return stat.slice(close + 1).trim().split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Liveness as "still holding resources", which is how a reap has to judge it.
 *
 * A process whose parent has not reaped it yet is a zombie: it cannot run and
 * cannot own a listener, but `kill(pid, 0)` still succeeds for one. Treating a
 * zombie as alive would hold the grace period open for its full window and make
 * the post-escalation confirmation below never report a clean tree, so the reap
 * would always escalate and always look like it had survivors.
 */
function isPidLive(pid: number): boolean {
  if (!isPidAlive(pid)) return false;
  const state = readProcessState(pid);
  return state !== "Z" && state !== "X";
}

/**
 * A process "references" the run when its argv or its environment mentions the
 * run's scratch directory. Both are inherited by descendants, and the scratch
 * path is a unique per-run mkdtemp name, so this cannot match another run.
 */
function processReferencesDir(pid: number, dir: string): boolean {
  for (const file of ["cmdline", "environ"]) {
    let raw: string;
    try {
      raw = fsSync.readFileSync(`/proc/${pid}/${file}`, "utf8");
    } catch {
      // ESRCH (exited) and EACCES (not ours) both mean "cannot claim it".
      continue;
    }
    if (raw.includes(dir)) return true;
  }
  return false;
}

function collectSelfProtectedPids(extra: number[] = []): Set<number> {
  const protectedPids = new Set<number>([process.pid, process.ppid, ...extra]);
  const ownGroup = readProcessGroupId(process.pid);
  if (ownGroup === null) return protectedPids;
  for (const pid of readProcNumericEntries()) {
    // Anything sharing this server's process group would be killed with us if
    // we ever signalled the group, so it is never a reap candidate.
    if (readProcessGroupId(pid) === ownGroup) protectedPids.add(pid);
  }
  return protectedPids;
}

function collectDescendantCandidates(input: {
  dir: string;
  protect: Set<number>;
  uid: number | null;
}): number[] {
  const matched: number[] = [];
  for (const pid of readProcNumericEntries()) {
    if (input.protect.has(pid)) continue;
    // Same-uid only. A server with permission to read other accounts' /proc
    // entries would otherwise match — and signal — a bystander that merely
    // mentions the run's scratch path in its argv or environment.
    if (input.uid !== null && readRealUid(pid) !== input.uid) continue;
    if (processReferencesDir(pid, input.dir)) matched.push(pid);
  }
  return matched;
}

function signalPid(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
/**
 * Does a live member of `processGroupId` still prove the group belongs to the
 * run, by naming the run's scratch directory?
 *
 * The scratch anchor is inherited through both `PAPERCLIP_RUN_SCRATCH_DIR` and
 * argv, and process-group membership survives reparenting, so a member that
 * references the directory is the run's own process. An unrelated group that
 * inherited the recycled pgid references nothing.
 */
function groupHasAnchoredMember(
  processGroupId: number,
  dir: string,
  uid: number | null,
): boolean {
  for (const pid of readProcNumericEntries()) {
    if (readProcessGroupId(pid) !== processGroupId) continue;
    if (uid !== null && readRealUid(pid) !== uid) continue;
    if (processReferencesDir(pid, dir)) return true;
  }
  return false;
}

/**
 * True when any protected pid is a member of `groupId`.
 *
 * Membership is read from /proc rather than assumed from ancestry, because the
 * protected set is exactly the ancestry of the postmaster and the question is
 * whether the kernel put any of it in the group the run recorded.
 */
function groupContainsProtected(
  groupId: number,
  protectedPids: number[],
): boolean {
  return protectedPids.some((pid) => readProcessGroupId(pid) === groupId);
}

/**
 * Terminate the process group recorded for a run. Returns false when the run
 * recorded no usable group, which is the signal to fall back to the scratch
 * directory sweep.
 *
 * The group is signalled only while its ownership is still provable. A recorded
 * pgid is a bare number, and on the path that matters here the run's group has
 * already been observed dead: the liveness reaper marks a run with a live
 * persisted pid or group as `detached` and skips it, so `process_lost` is only
 * reached once both read dead. Between that observation and this call the
 * number may have been recycled into an unrelated group, and
 * `isProcessGroupAlive` cannot tell the two apart — it succeeds for whatever
 * group holds the id. So the group fast path requires a live member that still
 * names the run's scratch directory, and is skipped when no scratch directory
 * is known, because then no ownership evidence exists at all.
 */
async function reapRunProcessGroup(
  processGroupId: number | null,
  dir: string | null,
  uid: number | null,
  graceMs: number,
  guard: InstanceDatabaseGuard | null,
): Promise<{
  signalled: boolean;
  refusedOwnGroup: boolean;
  refusedUnverifiedGroup: boolean;
  refusedProtectedGroup: boolean;
}> {
  const notSignalled = {
    signalled: false,
    refusedOwnGroup: false,
    refusedUnverifiedGroup: false,
    refusedProtectedGroup: false,
  };
  if (
    process.platform === "win32" ||
    processGroupId === null ||
    !Number.isInteger(processGroupId) ||
    processGroupId <= 0
  ) {
    // No usable group recorded: the scratch sweep is the only remaining anchor.
    return notSignalled;
  }
  // Never signal our own group: that is the server, and a run that inherited
  // it must be handled by the directory sweep instead.
  if (readProcessGroupId(process.pid) === processGroupId) {
    return { ...notSignalled, refusedOwnGroup: true };
  }
  // A group signal is all-or-nothing. If the instance's database, or the
  // process supervising it, sits in this group, killing the group is exactly
  // the outage this guard exists to prevent, so nothing in it is signalled.
  // This is checked before the anchoring gate because a group can be both
  // anchored to the run and hold the database — the anchoring evidence proves
  // the group is the run's, which is precisely when signalling it would be
  // fatal.
  if (guard && groupContainsProtected(processGroupId, guard.protectedPids)) {
    return { ...notSignalled, refusedProtectedGroup: true };
  }
  if (!isProcessGroupAlive(processGroupId)) {
    return { ...notSignalled, signalled: true };
  }
  if (dir === null || !groupHasAnchoredMember(processGroupId, dir, uid)) {
    return { ...notSignalled, refusedUnverifiedGroup: true };
  }
  const signalled = (): {
    signalled: boolean;
    refusedOwnGroup: false;
    refusedUnverifiedGroup: false;
    refusedProtectedGroup: false;
  } => ({
    signalled: !isProcessGroupAlive(processGroupId as number),
    refusedOwnGroup: false,
    refusedUnverifiedGroup: false,
    refusedProtectedGroup: false,
  });
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch {
    return signalled();
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupId)) return signalled();
    await delay(100);
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch {
    // Group already gone; fall through to the verification sweep.
  }
  return signalled();
}

/**
 * Reap every surviving process that still references `scratchDir`. The scratch
 * directory is the run's ownership anchor; the group kill above is a fast path,
 * and this sweep is what catches descendants that escaped the group.
 *
 * The candidate set is re-collected on every poll rather than snapshotted once.
 * A matched descendant that ignores SIGTERM long enough to fork a replacement
 * worker produces a pid that did not exist when the sweep started; the new
 * worker inherits `dir` from its parent, so it is reapable by the same anchor —
 * it is simply not in the first snapshot. Without the rescan, killing the
 * original leaves the replacement holding memory and a listening port, which is
 * the exact leak this reaper exists to close.
 */
async function reapScratchAnchoredProcesses(
  dir: string,
  graceMs: number,
  uid: number | null,
  result: RunProcessReapResult,
  guard: InstanceDatabaseGuard | null,
): Promise<void> {
  // The postmaster is not expected to match the scratch directory -- it is
  // spawned with a scrubbed environment -- but that is a property of
  // @embedded-postgres rather than a guarantee this module should rely on, so
  // the database and its supervisors are excluded by pid.
  const protect = collectSelfProtectedPids(guard?.protectedPids ?? []);
  const matched = new Set<number>();
  const signalled = new Set<number>();
  const killed = new Set<number>();

  /** Anchored pids that no earlier scan has already reported. */
  function discover(): number[] {
    const fresh: number[] = [];
    for (const pid of collectDescendantCandidates({ dir, protect, uid })) {
      if (matched.has(pid)) continue;
      matched.add(pid);
      fresh.push(pid);
    }
    return fresh;
  }

  function signalAll(pids: number[], signal: NodeJS.Signals, into: Set<number>) {
    for (const pid of pids) {
      if (signalPid(pid, signal)) into.add(pid);
      else result.errors.push(`failed to ${signal} pid ${pid}`);
    }
  }

  const liveMatched = () => [...matched].filter((pid) => isPidLive(pid));

  signalAll(discover(), "SIGTERM", signalled);

  // Hold the grace period open while anything is still running, and re-collect
  // on each poll so a worker forked mid-window is signalled while there is still
  // time to stop it cleanly rather than after the sweep has escalated.
  const graceDeadline = Date.now() + graceMs;
  let outstanding = liveMatched();
  while (Date.now() < graceDeadline && outstanding.length > 0) {
    await delay(100);
    signalAll(discover(), "SIGTERM", signalled);
    outstanding = liveMatched();
  }

  signalAll(outstanding, "SIGKILL", killed);

  // Confirm the tree is actually gone before reporting success. A kill that
  // lands while a descendant is mid-fork can leave one more anchored process
  // behind, and a survivor reported as reaped is worse than a reported failure:
  // the caller treats this as done and moves on. Bounded by SIGKILL_GRACE_MS.
  const settleDeadline = Date.now() + SIGKILL_GRACE_MS;
  for (;;) {
    const late = discover();
    if (late.length === 0) break;
    signalAll(late, "SIGKILL", killed);
    if (Date.now() >= settleDeadline) {
      result.errors.push(
        `scratch sweep still matches ${late.length} process(es) after escalation`,
      );
      break;
    }
    await delay(100);
  }

  result.matchedPids = [...matched];
  result.signalledPids = [...signalled];
  result.killedPids = [...killed];
}

/**
 * Reap the process tree a run left behind after it was lost.
 *
 * Bounded: it only ever considers same-uid processes that name the run's
 * scratch directory, or a recorded process group whose ownership it can still
 * verify. Idempotent: a second call after a successful reap matches nothing.
 *
 * `databaseDataDir` is the instance's embedded PostgreSQL data directory. When
 * the instance is using an embedded database, pass it: the database and
 * anything supervising it are then never signalled, and a recorded group that
 * contains them is refused whole. Omitting it is safe only where no live
 * database can be at risk.
 */
export async function reapLostRunProcessTree(input: {
  processGroupId?: number | null;
  scratchDir?: string | null;
  databaseDataDir?: string | null;
  graceMs?: number;
}): Promise<RunProcessReapResult> {
  const result: RunProcessReapResult = {
    processGroupId: input.processGroupId ?? null,
    groupWasAlive: false,
    groupSignalled: false,
    matchedPids: [],
    signalledPids: [],
    killedPids: [],
    refusedOwnGroup: false,
    refusedUnverifiedGroup: false,
    refusedProtectedGroup: false,
    protectedPids: [],
    skippedReason: null,
    errors: [],
  };

  if (process.platform !== "linux") {
    result.skippedReason = "not_linux";
    return result;
  }

  const guard = resolveInstanceDatabaseGuard(input.databaseDataDir);
  result.protectedPids = guard?.protectedPids ?? [];

  const groupId = input.processGroupId ?? null;
  if (groupId !== null) {
    result.groupWasAlive = isProcessGroupAlive(groupId);
  }

  const dir = input.scratchDir?.trim() || null;
  if (groupId === null && !dir) {
    result.skippedReason = "no_anchor";
    return result;
  }

  // One uid for the whole reap, and null only where the platform cannot report
  // one. Candidates whose uid cannot be read are then not filtered out — the
  // scratch anchor still has to match — but a readable uid that is not ours is
  // never claimed.
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const graceMs = input.graceMs ?? SIGTERM_GRACE_MS;
  try {
    if (groupId !== null) {
      const group = await reapRunProcessGroup(groupId, dir, uid, graceMs, guard);
      result.groupSignalled = group.signalled;
      result.refusedOwnGroup = group.refusedOwnGroup;
      result.refusedUnverifiedGroup = group.refusedUnverifiedGroup;
      result.refusedProtectedGroup = group.refusedProtectedGroup;
    }
    if (dir) {
      await reapScratchAnchoredProcesses(dir, graceMs, uid, result, guard);
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  return result;
}

export const __testing = {
  readProcessGroupId,
  readProcNumericEntries,
  processReferencesDir,
  collectDescendantCandidates,
  readRealUid,
  isPidLive,
  os,
  SIGKILL_GRACE_MS,
};
