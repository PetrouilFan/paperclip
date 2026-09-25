import fsSync from "node:fs";
import os from "node:os";

import {
  isPidAlive,
  isProcessGroupAlive,
} from "./local-service-supervisor.js";

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
 *    the run's scratch directory, or members of the run's own process group.
 *  - It never signals this process, its ancestors, or anything in this
 *    server's own process group.
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

function collectSelfProtectedPids(): Set<number> {
  const protectedPids = new Set<number>([process.pid, process.ppid]);
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
}): number[] {
  const matched: number[] = [];
  for (const pid of readProcNumericEntries()) {
    if (input.protect.has(pid)) continue;
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
 * Terminate the process group recorded for a run. Returns false when the run
 * recorded no usable group, which is the signal to fall back to the scratch
 * directory sweep.
 */
async function reapRunProcessGroup(
  processGroupId: number | null,
  graceMs: number,
): Promise<{ signalled: boolean; refusedOwnGroup: boolean }> {
  const refused = { signalled: false, refusedOwnGroup: false };
  if (
    process.platform === "win32" ||
    processGroupId === null ||
    !Number.isInteger(processGroupId) ||
    processGroupId <= 0
  ) {
    return refused;
  }
  // Never signal our own group: that is the server, and a run that inherited
  // it must be handled by the directory sweep instead.
  if (readProcessGroupId(process.pid) === processGroupId) {
    refused.refusedOwnGroup = true;
    return refused;
  }
  if (!isProcessGroupAlive(processGroupId)) return { signalled: true, refusedOwnGroup: false };
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch {
    return {
      signalled: !isProcessGroupAlive(processGroupId),
      refusedOwnGroup: false,
    };
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupId)) {
      return { signalled: true, refusedOwnGroup: false };
    }
    await delay(100);
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch {
    // Group already gone; fall through to the verification sweep.
  }
  return {
    signalled: !isProcessGroupAlive(processGroupId),
    refusedOwnGroup: false,
  };
}

/**
 * Reap every surviving process that still references `scratchDir`. The scratch
 * directory is the run's ownership anchor; the group kill above is a fast path,
 * and this sweep is what catches descendants that escaped the group.
 */
async function reapScratchAnchoredProcesses(
  dir: string,
  graceMs: number,
  result: RunProcessReapResult,
): Promise<void> {
  const protect = collectSelfProtectedPids();
  const candidates = collectDescendantCandidates({ dir, protect });
  result.matchedPids = candidates;
  if (candidates.length === 0) return;

  for (const pid of candidates) {
    if (signalPid(pid, "SIGTERM")) result.signalledPids.push(pid);
    else result.errors.push(`failed to SIGTERM pid ${pid}`);
  }

  const deadline = Date.now() + graceMs;
  let survivors = candidates.filter((pid) => isPidAlive(pid));
  while (Date.now() < deadline && survivors.length > 0) {
    await delay(100);
    survivors = survivors.filter((pid) => isPidAlive(pid));
  }

  for (const pid of survivors) {
    if (signalPid(pid, "SIGKILL")) result.killedPids.push(pid);
    else result.errors.push(`failed to SIGKILL pid ${pid}`);
  }
}

/**
 * Reap the process tree a run left behind after it was lost.
 *
 * Bounded: it only ever considers same-uid processes that name the run's
 * scratch directory, or members of the run's own recorded process group.
 * Idempotent: a second call after a successful reap matches nothing.
 */
export async function reapLostRunProcessTree(input: {
  processGroupId?: number | null;
  scratchDir?: string | null;
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
    skippedReason: null,
    errors: [],
  };

  if (process.platform !== "linux") {
    result.skippedReason = "not_linux";
    return result;
  }

  const groupId = input.processGroupId ?? null;
  if (groupId !== null) {
    result.groupWasAlive = isProcessGroupAlive(groupId);
  }

  const dir = input.scratchDir?.trim() || null;
  if (groupId === null && !dir) {
    result.skippedReason = "no_anchor";
    return result;
  }

  const graceMs = input.graceMs ?? SIGTERM_GRACE_MS;
  try {
    if (groupId !== null) {
      const group = await reapRunProcessGroup(groupId, graceMs);
      result.groupSignalled = group.signalled;
      result.refusedOwnGroup = group.refusedOwnGroup;
    }
    if (dir) {
      await reapScratchAnchoredProcesses(dir, graceMs, result);
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
  os,
  SIGKILL_GRACE_MS,
};
