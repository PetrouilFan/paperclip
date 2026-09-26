import { and, eq, isNull, notInArray } from "drizzle-orm";
import {
  approvals,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { strandedRunUnblockDescriptor } from "./routable-blocked.js";

/**
 * `blocked` is only an exit when something else would open it. A ticket that a
 * dead run left with no unresolved blockers, no pending interaction or
 * approval, and no `unblock_descriptor` is not stuck — it is stranded, and the
 * checkout refusal means no agent can recover it by resuming the work.
 *
 * This module is the one place that answers "does this issue already have a
 * first-class reason to be blocked?". The recovery settle asks the same
 * question before it owns a block, and the backfill asks it before it writes an
 * exit, so a descriptor never lands on an issue whose real blocker already
 * names the way out. Sharing the predicate is the point: a second copy of the
 * disjunction is how a backfill starts overwriting holds it never read.
 */
export async function hasFirstClassIssueHold(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<boolean> {
  const { companyId, issueId } = input;
  const [blockingRelation] = await db
    .select({ id: issues.id })
    .from(issueRelations)
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, issueRelations.companyId),
        eq(issues.id, issueRelations.issueId),
      ),
    )
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, issueId),
        eq(issueRelations.type, "blocks"),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .limit(1);
  if (blockingRelation) return true;

  const [pendingInteraction] = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.status, "pending"),
      ),
    )
    .limit(1);
  if (pendingInteraction) return true;

  const [pendingApproval] = await db
    .select({ id: approvals.id })
    .from(issueApprovals)
    .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
    .where(
      and(
        eq(issueApprovals.companyId, companyId),
        eq(issueApprovals.issueId, issueId),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(1);
  return Boolean(pendingApproval);
}

export const STRANDED_BLOCKED_BACKFILL_ACTION =
  "Stranded by a run that died before it recorded an exit. " +
  "Re-verify the recorded work, then resume the issue or cancel it.";

export const STRANDED_BLOCKED_BACKFILL_BATCH = 25;

/**
 * How often the boot-scheduled safety net re-runs the backfill. The repair
 * itself is one-off, but the pass is kept on a slow timer rather than run once
 * so a strand left by a writer that regresses is still picked up without anyone
 * restarting the server.
 */
export const STRANDED_BLOCKED_BACKFILL_INTERVAL_MS = 10 * 60_000;

/**
 * Writes an exit onto issues that a recovery sweep stranded before the writers
 * learned to name one. The two writers pick their owner the same way, through
 * `strandedRunUnblockDescriptor`: the assignee when there is one, otherwise
 * `board`, which the attention service already surfaces as an unblock/reassign
 * decision. An unassigned issue therefore still gets named — `board` — because
 * "nobody to name" is what made these tickets dead in the first place.
 *
 * Deliberately does *not* stamp `blockedTransitionAt` and does not wake the
 * named owner. The escalation path in PR #47 names the board rather than
 * taking work back from an agent that just failed, and a backfill that
 * re-dispatched every stranded ticket would walk that policy backwards. This
 * only restores the missing exit; whether to run the work stays a board
 * decision.
 *
 * Idempotent by construction: the candidate query only selects issues whose
 * descriptor is still null, so a second pass over the same board writes
 * nothing.
 */
export async function backfillStrandedBlockedIssues(
  db: Db,
  now = new Date(),
  options: { limit?: number } = {},
): Promise<{ scanned: number; written: number; held: number }> {
  const limit = Math.max(1, Math.min(options.limit ?? STRANDED_BLOCKED_BACKFILL_BATCH, 200));
  // A batch per sweep, bounded and lock-free: the sweep runs on a timer, so a
  // large board drains over consecutive passes instead of holding one long
  // transaction against the issues table.
  const candidates = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.status, "blocked"),
        isNull(issues.unblockDescriptor),
      ),
    )
    .limit(limit);

  let written = 0;
  let held = 0;
  for (const candidate of candidates) {
    // Same function the settle uses to decide whether it owns a block. A real
    // hold keeps its own exit, whatever shape that exit takes.
    if (await hasFirstClassIssueHold(db, { companyId: candidate.companyId, issueId: candidate.id })) {
      held += 1;
      continue;
    }
    const descriptor = strandedRunUnblockDescriptor({
      owner: candidate.assigneeAgentId || candidate.assigneeUserId ? undefined : "board",
      assigneeAgentId: candidate.assigneeAgentId,
      assigneeUserId: candidate.assigneeUserId,
      action: STRANDED_BLOCKED_BACKFILL_ACTION,
    });
    if (!descriptor) {
      held += 1;
      continue;
    }
    const updated = await db
      .update(issues)
      .set({ unblockDescriptor: descriptor, updatedAt: now })
      .where(and(eq(issues.id, candidate.id), eq(issues.companyId, candidate.companyId), isNull(issues.unblockDescriptor)))
      .returning({ id: issues.id });
    // Zero rows means another writer or a concurrent pass got there first. That
    // is the idempotency guarantee, not a failure.
    if (updated.length) written += 1;
  }
  if (written || held) {
    logger.info({ scanned: candidates.length, written, held }, "stranded blocked backfill sweep");
  }
  return { scanned: candidates.length, written, held };
}

/**
 * The §4.3 board assertion, as a query. Returns the issues that are `blocked`
 * with neither an unresolved blocker nor a named owner — the exact set the
 * backfill exists to empty, and the set that must read empty for the board to
 * be considered non-stranded.
 */
export async function findStrandedBlockedIssues(db: Db): Promise<
  Array<{
    id: string;
    companyId: string;
    identifier: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  }>
> {
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issues)
    .where(and(eq(issues.status, "blocked"), isNull(issues.unblockDescriptor)))
    .orderBy(issues.identifier);

  const stranded: Array<{
    id: string;
    companyId: string;
    identifier: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  }> = [];
  for (const row of rows) {
    if (await hasFirstClassIssueHold(db, { companyId: row.companyId, issueId: row.id })) continue;
    stranded.push(row);
  }
  return stranded;
}
