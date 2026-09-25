import { and, asc, count, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike, issueWriteDenialResponse } from "@paperclipai/shared";
import type { CrossIssueRunContextReason } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";

export const CROSS_ISSUE_INFLUENCE_LIMIT = 20;
export const CROSS_ISSUE_INFLUENCE_ENFORCE_AT = new Date("2026-08-11T00:00:00.000Z");

/**
 * A finished run's checkout/execution stamp can linger on the issue row until
 * cleanup runs. Such a binding must not buy a *later* write an exemption, so
 * the run-side fallback only trusts a run that is still live.
 */
const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

const CROSS_ISSUE_INFLUENCE_ACTIVITY = "issue.cross_issue_influence_observed";
const CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY = "issue.cross_issue_influence_cap_rejected";

/**
 * Every kind shares one per-run counter. `interaction_resolution` covers the
 * issue-thread accept/reject/respond/verdict routes: an open `anyone` resolver
 * audience is not a licence to resolve, wake, and spawn suggested tasks across
 * the whole company from one run.
 */
export type CrossIssueInfluenceKind = "comment" | "update" | "interaction_resolution";

export type CrossIssueInfluenceDecision = {
  allowed: boolean;
  mode: "log_only" | "enforce";
  count: number;
  cap: number;
  enforceAt: string;
};

export function crossIssueInfluenceRunContextError(
  reason: CrossIssueRunContextReason = "run_not_found",
) {
  // Copy comes from the shared issue-write denial contract (the open cross-task write design (failure UX))
  // so the agent reading this 403 is told the fix, not just the refusal. The
  // `reason` picks the advice: "send the run header" is correct when the run is
  // missing, and unfollowable when only the source issue is missing.
  const { body } = issueWriteDenialResponse("cross_issue_influence_run_context_required", {
    runContextReason: reason,
  });
  return forbidden(body.error, { ...body.details, reason });
}

function readRunSourceIssueId(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function evaluateCrossIssueInfluenceLimit(input: {
  priorCount: number;
  now?: Date;
}): CrossIssueInfluenceDecision {
  const now = input.now ?? new Date();
  const mode = now >= CROSS_ISSUE_INFLUENCE_ENFORCE_AT ? "enforce" : "log_only";
  const nextCount = input.priorCount + 1;
  return {
    allowed: mode === "log_only" || nextCount <= CROSS_ISSUE_INFLUENCE_LIMIT,
    mode,
    count: nextCount,
    cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT.toISOString(),
  };
}

/**
 * Atomically observes one cross-issue influence attempt for a heartbeat run.
 *
 * Locking the run row serializes concurrent attempts from the same run. The
 * observation is intentionally recorded before the route mutation: once the
 * rollout reaches enforcement, failures cannot be used to race or probe past
 * the fail-closed backstop.
 */
export async function observeCrossIssueInfluence(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    agentId: string;
    responsibleUserId?: string | null;
    targetIssueId: string;
    targetIssueIdentifier?: string | null;
    kind: CrossIssueInfluenceKind;
    now?: Date;
  },
): Promise<CrossIssueInfluenceDecision | null> {
  // API-key callers control the run header. Reject malformed UUIDs before the
  // database can turn an untrusted identifier into a PostgreSQL cast error.
  if (!isUuidLike(input.runId)) throw crossIssueInfluenceRunContextError("malformed_run_id");

  return db.transaction(async (tx) => {
    const run = await tx
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !run ||
      run.companyId !== input.companyId ||
      run.agentId !== input.agentId
    ) {
      throw crossIssueInfluenceRunContextError("run_not_found");
    }

    const contextSourceIssueId = readRunSourceIssueId(run.contextSnapshot);
    if (
      contextSourceIssueId &&
      (contextSourceIssueId === input.targetIssueId ||
        (input.targetIssueIdentifier &&
          contextSourceIssueId.toUpperCase() === input.targetIssueIdentifier.toUpperCase()))
    ) {
      return null;
    }

    // The run's own source issue normally comes from its context snapshot, but
    // `POST /checkout` stamps the run onto the *issue* (`checkout_run_id`) and
    // never stamps the issue back onto the *run*. The binding was therefore
    // one-directional: a run that checked out an issue on an ordinary
    // `heartbeat_timer` wake (which is created with no issue in its context)
    // held a real claim to that issue and still had no source, so it was refused
    // everywhere — the same asymmetry behind the fleet-wide 403 reports.
    //
    // This fallback is deliberately scoped to runs whose context names NO source.
    // A run that already has a source keeps master semantics: its own issue is
    // exempt above and every other issue counts against the cap. Letting a
    // mutable checkout stamp short-circuit a context-ful run would let it check
    // out its way past the 20-write limit.
    //
    // Only a live run's binding counts. A stamp left behind by a terminal run
    // must not exempt a later write.
    let boundSourceIssueId: string | null = null;
    let targetIsBound = false;
    if (!contextSourceIssueId) {
      if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) {
        throw crossIssueInfluenceRunContextError("terminal_status");
      }
      const boundIssues = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(
          eq(issues.companyId, input.companyId),
          or(
            eq(issues.checkoutRunId, input.runId),
            eq(issues.executionRunId, input.runId),
          ),
        ))
        // Deterministic pick: a run can legitimately hold more than one issue
        // (the legacy execution-lock fallback stamps a sibling too), and the
        // audit row must name the same source every time for the same state.
        .orderBy(asc(issues.id))
        .limit(2);
      boundSourceIssueId = boundIssues[0]?.id ?? null;
      // A run may always write to an issue it actually holds, so the target's
      // own binding is checked before the cap rather than after it.
      targetIsBound = boundIssues.some((row) => row.id === input.targetIssueId);
    }

    if (targetIsBound) return null;

    // No context source and no binding anywhere: there is nothing to attribute
    // the write to, so fail closed. This is the guard the fleet-wide reports
    // exercised and it must keep refusing a run that is bound to nothing.
    const sourceIssueId = contextSourceIssueId ?? boundSourceIssueId;
    if (!sourceIssueId) {
      throw crossIssueInfluenceRunContextError("no_context_source_and_target_unbound");
    }

    const priorCount = await tx
      .select({ count: count() })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.runId, input.runId),
        eq(activityLog.action, CROSS_ISSUE_INFLUENCE_ACTIVITY),
      ))
      .then((rows) => Number(rows[0]?.count ?? 0));
    const decision = evaluateCrossIssueInfluenceLimit({ priorCount, now: input.now });

    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      responsibleUserId: input.responsibleUserId ?? run.responsibleUserId ?? null,
      action: decision.allowed
        ? CROSS_ISSUE_INFLUENCE_ACTIVITY
        : CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY,
      entityType: "issue",
      entityId: input.targetIssueId,
      details: {
        kind: input.kind,
        sourceIssueId,
        targetIssueId: input.targetIssueId,
        targetIssueIdentifier: input.targetIssueIdentifier ?? null,
        count: decision.count,
        cap: decision.cap,
        mode: decision.mode,
        enforceAt: decision.enforceAt,
        allowed: decision.allowed,
      },
    });

    const logContext = {
      event: "cross_issue_influence_cap",
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      sourceIssueId,
      targetIssueId: input.targetIssueId,
      kind: input.kind,
      count: decision.count,
      cap: decision.cap,
      mode: decision.mode,
      enforceAt: decision.enforceAt,
      allowed: decision.allowed,
    };
    if (decision.allowed) {
      logger.info(logContext, "cross-issue influence observed");
    } else {
      logger.warn(logContext, "cross-issue influence cap exceeded");
    }

    return decision;
  });
}

export function crossIssueInfluenceLimitError(
  decision: CrossIssueInfluenceDecision,
  context: { actorLabel?: string | null; assigneeLabel?: string | null; issueIdentifier?: string | null } = {},
) {
  // The cap is a rate backstop, not a permission decision — the shared copy
  // contract says so explicitly, and names the next run as the way forward.
  const { body } = issueWriteDenialResponse("cross_issue_influence_cap_exceeded", {
    ...context,
    cap: decision.cap,
    count: decision.count,
    enforceAt: decision.enforceAt,
  });
  return {
    error: body.error,
    details: {
      ...body.details,
      cap: decision.cap,
      count: decision.count,
      mode: decision.mode,
      enforceAt: decision.enforceAt,
    },
  };
}
