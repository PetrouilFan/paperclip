import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, issueWatchdogs } from "@paperclipai/db";

export const TASK_WATCHDOG_ORIGIN_KIND = "task_watchdog";

type AgentRunActor = {
  type: string;
  agentId?: string | null;
  companyId?: string | null;
  runId?: string | null;
};

type IssueScopeTarget = {
  id: string;
  companyId: string;
  parentId?: string | null;
};

export type TaskWatchdogMutationScope =
  | { kind: "none" }
  | { kind: "invalid"; detail: string }
  | {
      kind: "watchdog";
      runId: string;
      watchdogId: string;
      companyId: string;
      watchedIssueId: string;
      watchdogIssueId: string | null;
      stopFingerprint: string | null;
      /**
       * Set on the run's own context once this run has been cleared to mutate the
       * watched subtree. From that point on the stop fingerprint is a baseline the
       * run advances itself, so later drift is not by itself a reason to refuse —
       * see `revalidateMutationScope`.
       */
      mutationAdmittedAt: string | null;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readTaskWatchdogContext(contextSnapshot: unknown) {
  const context = isPlainRecord(contextSnapshot) ? contextSnapshot : null;
  const taskWatchdog = isPlainRecord(context?.taskWatchdog) ? context.taskWatchdog : null;
  if (!taskWatchdog && context?.taskWatchdog !== true) return null;
  return {
    watchedIssueId: readString(taskWatchdog?.watchedIssueId) ?? readString(context?.watchedIssueId),
    stopFingerprint: readString(taskWatchdog?.stopFingerprint) ?? readString(context?.stopFingerprint),
    mutationAdmittedAt:
      readString(taskWatchdog?.mutationAdmittedAt) ?? readString(context?.mutationAdmittedAt),
  };
}

export async function resolveTaskWatchdogMutationScope(
  db: Db,
  actor: AgentRunActor,
): Promise<TaskWatchdogMutationScope> {
  if (actor.type !== "agent") return { kind: "none" };
  const agentId = readString(actor.agentId);
  const runId = readString(actor.runId);
  const actorCompanyId = readString(actor.companyId);
  if (!agentId || !runId) return { kind: "none" };

  const run = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);

  if (!run) return { kind: "none" };
  const taskWatchdog = readTaskWatchdogContext(run.contextSnapshot);
  if (!taskWatchdog) return { kind: "none" };
  if (run.agentId !== agentId || (actorCompanyId && run.companyId !== actorCompanyId)) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run context does not belong to this agent.",
    };
  }

  if (!taskWatchdog.watchedIssueId) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run context is missing a persisted watched issue id.",
    };
  }

  const watchdog = await db
    .select({
      id: issueWatchdogs.id,
      companyId: issueWatchdogs.companyId,
      issueId: issueWatchdogs.issueId,
      watchdogAgentId: issueWatchdogs.watchdogAgentId,
      watchdogIssueId: issueWatchdogs.watchdogIssueId,
      status: issueWatchdogs.status,
    })
    .from(issueWatchdogs)
    .where(and(
      eq(issueWatchdogs.companyId, run.companyId),
      eq(issueWatchdogs.issueId, taskWatchdog.watchedIssueId),
      eq(issueWatchdogs.watchdogAgentId, agentId),
      eq(issueWatchdogs.status, "active"),
    ))
    .then((rows) => rows[0] ?? null);

  if (!watchdog) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run context is not backed by an active persisted watchdog.",
    };
  }

  return {
    kind: "watchdog",
    runId: run.id,
    watchdogId: watchdog.id,
    companyId: watchdog.companyId,
    watchedIssueId: watchdog.issueId,
    watchdogIssueId: watchdog.watchdogIssueId ?? null,
    stopFingerprint: taskWatchdog.stopFingerprint,
    mutationAdmittedAt: taskWatchdog.mutationAdmittedAt,
  };
}

/**
 * The two id sets a task-watchdog run may write, derived from the stop
 * classification that `revalidateMutationScope` already computed for this exact
 * mutation.
 *
 * Deriving the scope from the classification rather than from a reverse graph
 * walk is what makes the grant answer to its own justification. A stop is
 * classified from status *and* blocker state, so the issue that causes a stop
 * is frequently a blocker rather than a descendant; the classification already
 * knows which blocker belongs to which stopped leaf, and nothing else.
 */
export type TaskWatchdogWriteScope = {
  /** The watched issue and its descendants, as the classifier walked them. */
  subtreeIssueIds: ReadonlySet<string>;
  /**
   * Blockers of a stopped leaf that is itself `blocked` — the blocker whose
   * closure would release a stop.
   */
  stopBlockerIssueIds: ReadonlySet<string>;
};

type TaskWatchdogStopClassification = {
  state: string;
  includedIssueIds: string[];
  stoppedLeaves?: Array<{ status: string; blockerIssueIds: string[] }>;
};

export function taskWatchdogWriteScopeFromClassification(
  classification: TaskWatchdogStopClassification | null | undefined,
): TaskWatchdogWriteScope {
  const subtreeIssueIds = new Set(classification?.includedIssueIds ?? []);
  const stopBlockerIssueIds = new Set<string>();
  for (const leaf of classification?.stoppedLeaves ?? []) {
    // Bound the grant to the blocker that caused a stop. A blocker attached to
    // a leaf that is still `in_progress` is not what stopped the subtree, and
    // closing it buys the run nothing it cannot already do on the leaf itself —
    // so admitting it would widen the grant past its own justification, and past
    // the issues the board's `instructions` string was written about.
    if (leaf.status !== "blocked") continue;
    for (const blockerIssueId of leaf.blockerIssueIds) stopBlockerIssueIds.add(blockerIssueId);
  }
  return { subtreeIssueIds, stopBlockerIssueIds };
}

/**
 * Whether `issueId` is inside a task-watchdog run's write scope.
 *
 * One query — the subject's own row, for the company boundary and the
 * task-watchdog-issue exclusion. Both id sets are already in hand, and the
 * classification that produced them cost the same fixed number of queries the
 * freshness revalidation spends anyway, so this stays flat no matter how deep
 * the subtree is or how many blocked edges the subject carries.
 */
export async function issueIsInTaskWatchdogSubtree(
  db: Db,
  companyId: string,
  issueId: string,
  writeScope: TaskWatchdogWriteScope,
) {
  if (writeScope.subtreeIssueIds.has(issueId)) return true;
  if (writeScope.stopBlockerIssueIds.has(issueId)) {
    return issueIsWritableTaskWatchdogSubject(db, companyId, issueId);
  }
  return false;
}

/**
 * The bars a granted blocker still has to clear: it has to be a real issue of
 * the watchdog's own company, and it must not itself be a task-watchdog issue.
 */
async function issueIsWritableTaskWatchdogSubject(
  db: Db,
  companyId: string,
  issueId: string,
) {
  const subject: { companyId: string; originKind: string | null } | null = await db
    .select({ companyId: issues.companyId, originKind: issues.originKind })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
  if (!subject) return false;
  if (subject.companyId !== companyId) return false;
  if (subject.originKind === TASK_WATCHDOG_ORIGIN_KIND) return false;
  return true;
}

export async function taskWatchdogScopeAllowsIssueMutation(
  db: Db,
  scope: TaskWatchdogMutationScope,
  issue: IssueScopeTarget,
  opts: { allowWatchdogIssue?: boolean; writeScope: TaskWatchdogWriteScope },
) {
  if (scope.kind !== "watchdog") return scope;
  if (issue.companyId !== scope.companyId) {
    return {
      kind: "invalid" as const,
      detail: "Task-watchdog mutation target is outside the watchdog company.",
    };
  }
  if (opts.allowWatchdogIssue !== false && scope.watchdogIssueId && issue.id === scope.watchdogIssueId) {
    return scope;
  }
  if (
    await issueIsInTaskWatchdogSubtree(
      db,
      scope.companyId,
      issue.id,
      opts.writeScope,
    )
  ) {
    return scope;
  }
  return {
    kind: "invalid" as const,
    detail: "Task-watchdog runs can only mutate the watched issue subtree.",
  };
}
