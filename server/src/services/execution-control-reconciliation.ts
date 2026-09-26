import { randomUUID } from "node:crypto";
import { logger } from "../middleware/logger.js";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import {
  agents,
  environmentLeases,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { reportRunFailure } from "./run-failure-report.js";
import { readRunFinalizationTimeline } from "./execution-finalization-timeline.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext } from "./native-runtime/native-review-participant.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

export const EXECUTION_FINALIZATION_DEADLINE_CODE =
  "execution_finalization_deadline_exceeded";

/**
 * What the sweep could establish about the provider process, as opposed to
 * assuming it stopped. A PID is only meaningful on the host that spawned it,
 * so a remote lease provider is reported as not inspectable rather than
 * guessed at.
 */
export type ProviderOwnership =
  | "stopped"
  | "still_running"
  | "not_recorded"
  | "remote_not_inspectable";

export interface ProviderOwnershipFinding {
  ownership: ProviderOwnership;
  pid: number | null;
  /** Why the verdict is what it is, so the board does not read silence as proof. */
  detail: string;
}

function localProcessAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists under another user. Only ESRCH is proof
    // of absence.
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
  }
}

/**
 * Resolve whether the run's provider process is still alive. Never throws: a
 * failed probe is reported as "not recorded" rather than failing the sweep.
 */
export async function resolveProviderOwnership(
  db: Db,
  run: HeartbeatRun,
): Promise<ProviderOwnershipFinding> {
  const leases = await db
    .select({ provider: environmentLeases.provider })
    .from(environmentLeases)
    .where(eq(environmentLeases.heartbeatRunId, run.id))
    .catch(() => [] as { provider: string | null }[]);
  const providers = [
    ...new Set(leases.map((lease) => lease.provider).filter((value): value is string => typeof value === "string")),
  ];
  if (providers.some((provider) => provider !== "local")) {
    return {
      ownership: "remote_not_inspectable",
      pid: run.processPid,
      detail: `Provider runs on a remote host (${providers.join(", ")}); a local PID cannot establish whether it stopped.`,
    };
  }
  if (!run.processPid) {
    return {
      ownership: "not_recorded",
      pid: null,
      detail:
        "The run recorded no provider PID, so provider ownership could not be established.",
    };
  }
  const alive = localProcessAlive(run.processPid);
  if (alive === null) {
    return {
      ownership: "not_recorded",
      pid: run.processPid,
      detail: `The provider PID ${run.processPid} could not be probed from this host.`,
    };
  }
  return alive
    ? {
        ownership: "still_running",
        pid: run.processPid,
        detail: `The provider process ${run.processPid} is still alive on this host. A reused PID is possible; processStartedAt is ${run.processStartedAt?.toISOString() ?? "unrecorded"}.`,
      }
    : {
        ownership: "stopped",
        pid: run.processPid,
        detail: `The provider process ${run.processPid} is gone from this host.`,
      };
}

/** Only newly recorded control deadlines are eligible. Upgrades never replay ambiguous historical runs. */
export async function reconcileAbandonedExecutionControl(
  db: Db,
  now = new Date(),
) {
  const nativeDue = await db
    .select({
      runId: nativeRunFinalizations.runId,
      issueId: nativeRunFinalizations.issueId,
      companyId: nativeRunFinalizations.companyId,
    })
    .from(nativeRunFinalizations)
    .where(
      and(
        isNotNull(nativeRunFinalizations.controlDeadlineAt),
        lte(nativeRunFinalizations.controlDeadlineAt, now),
      ),
    )
    .limit(50);
  const controlDue = await db
    .select({
      runId: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      context: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(
      and(
        isNotNull(heartbeatRuns.executionControlDeadlineAt),
        lte(heartbeatRuns.executionControlDeadlineAt, now),
      ),
    )
    .limit(50);
  const due = [
    ...new Map(
      [
        ...nativeDue,
        ...controlDue.map((row) => ({
          ...row,
          issueId:
            typeof row.context?.issueId === "string"
              ? row.context.issueId
              : null,
        })),
      ].map((row) => [row.runId, row]),
    ).values(),
  ];
  let surfaced = 0;
  // Bound contention latency across independent tasks: a locked task must not
  // consume the entire reconciliation window for every task behind it.
  let nextCandidate = 0;
  await Promise.all(Array.from({ length: Math.min(5, due.length) }, async () => {
    while (nextCandidate < due.length) {
      const candidate = due[nextCandidate++]!;
      try {
        // Set inside the transaction only when the write below genuinely
        // transitions the run into "failed". Read after the transaction
        // commits, so a rolled-back write never reports a false failure.
        let terminalRunToReport: typeof heartbeatRuns.$inferSelect | null = null;
        const repaired = await db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
          );
          const task = candidate.issueId
            ? (
                await tx
                  .select()
                  .from(issues)
                  .where(
                    and(
                      eq(issues.id, candidate.issueId),
                      eq(issues.companyId, candidate.companyId),
                    ),
                  )
                  .for("update")
              )[0]
            : null;
          const [coordinator] = await tx
            .select()
            .from(nativeRunFinalizations)
            .where(
              and(
                eq(nativeRunFinalizations.runId, candidate.runId),
                eq(nativeRunFinalizations.companyId, candidate.companyId),
              ),
            )
            .for("update");
          const [run] = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.id, candidate.runId),
                eq(heartbeatRuns.companyId, candidate.companyId),
              ),
            )
            .for("update");
          if (
            !run ||
            ![
              coordinator?.controlDeadlineAt,
              run.executionControlDeadlineAt,
            ].some((deadline) => deadline && deadline <= now)
          )
            return false;
          await tx
            .update(heartbeatRuns)
            .set({ executionControlDeadlineAt: null })
            .where(eq(heartbeatRuns.id, run.id));
          if (
            [
              "succeeded",
              "failed",
              "cancelled",
              "timed_out",
              "interrupted",
            ].includes(run.status)
          ) {
            if (coordinator?.controlDeadlineAt)
              await tx
                .update(nativeRunFinalizations)
                .set({ controlDeadlineAt: null })
                .where(eq(nativeRunFinalizations.runId, run.id));
            return true;
          }
          // A persisted result belongs to the existing finalizer, not a replacement provider.
          if (coordinator?.resultId) {
            await tx
              .update(nativeRunFinalizations)
              .set({
                controlDeadlineAt: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                updatedAt: now,
              })
              .where(eq(nativeRunFinalizations.runId, run.id));
            return true;
          }
          const cause = EXECUTION_FINALIZATION_DEADLINE_CODE;
          const nextAction =
            "Inspect the failed run and verify its provider has stopped. Reconcile any uncertain external action before explicitly continuing this task.";
          // Read the run's own outcome before anything overwrites it. A run that
          // already recorded `adapter_failed` (or any other code) must keep that
          // diagnosis: the deadline is a statement about this sweep, not a
          // replacement cause. A null here is not proof the run had no error —
          // it is equally consistent with a chain that had not reached its own
          // terminal write yet, which the timeline below distinguishes.
          const originalErrorCode = run.errorCode ?? null;
          const originalError = run.error ?? null;
          const originalFailureCode = coordinator?.failureCode ?? null;
          const timeline = readRunFinalizationTimeline(run.id, now);
          const ownership = await resolveProviderOwnership(tx as unknown as Db, run);
          const pendingStep = timeline?.pendingStep ?? null;
          const finalizationDeadline = {
            code: cause,
            observedAt: now.toISOString(),
            deadlineAt: (coordinator?.controlDeadlineAt ?? run.executionControlDeadlineAt)?.toISOString() ?? null,
            originalErrorCode,
            originalError,
            originalFailureCode,
            providerOwnership: ownership.ownership,
            providerOwnershipDetail: ownership.detail,
            providerPid: ownership.pid,
            // Null means no live finalization chain owns this run, so the run was
            // abandoned rather than slow. That is a different fault from a chain
            // that is still working through a stuck step.
            finalizationInFlight: timeline !== null,
            providerThrew: timeline?.providerThrew ?? null,
            finalizationElapsedMs: timeline?.elapsedMs ?? null,
            pendingFinalizationStep: pendingStep?.step ?? null,
            pendingFinalizationStepElapsedMs: pendingStep?.elapsedMs ?? null,
            slowestFinalizationStepMs: timeline?.slowestStepMs ?? null,
            finalizationSteps:
              timeline?.completedSteps.map((step) => ({
                step: step.step,
                durationMs: step.durationMs,
              })) ?? null,
            totalBudgetExceeded: timeline?.totalBudgetExceeded ?? null,
          };
          // `error` describes the fault. The operator instruction belongs to
          // `nextAction` only, so the two no longer hold the same string. The
          // prior error is echoed because it is the actual diagnosis, bounded so
          // a verbose provider message cannot dominate the row.
          const priorErrorSuffix = originalError
            ? ` The run's own recorded error was: ${originalError.slice(0, 500)}`
            : "";
          const faultDescription = pendingStep
            ? `Finalization exceeded its budget while running "${pendingStep.step}", ${Math.round(pendingStep.elapsedMs / 1000)}s into that step.${priorErrorSuffix}`
            : timeline
              ? `Finalization exceeded its budget after ${Math.round(timeline.elapsedMs / 1000)}s with no step in flight.${priorErrorSuffix}`
              : `No finalization chain owned this run when its control deadline expired; the run was abandoned mid-finalization.${priorErrorSuffix}`;

          if (coordinator)
            await tx
              .update(nativeRunFinalizations)
              .set({
                phase: "terminal_failure",
                controlDeadlineAt: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                recoveryState: "blocked",
                nextAttemptAt: null,
                // Keep a coordinator's own classified failure; only a
                // coordinator that never classified one takes the sweep's code.
                failureCode: originalFailureCode ?? cause,
                failureDetail: {
                  ...coordinator.failureDetail,
                  finalizationDeadline,
                  nextAction,
                  recoveryOwner: { kind: "board" },
                },
                updatedAt: now,
              })
              .where(eq(nativeRunFinalizations.runId, run.id));
          const [updatedRun] = await tx
            .update(heartbeatRuns)
            .set({
              status: "failed",
              executionStatusDeliveryId: randomUUID(),
              finishedAt: now,
              ...(coordinator
                ? { nativePhase: "terminal_failure", nativePhaseUpdatedAt: now }
                : {}),
              // Preserve the run's own code. `execution_finalization_deadline_exceeded`
              // is recorded in `resultJson` and in the recovery action instead,
              // so a run that already failed as `adapter_failed` is not relabelled
              // with no trace of the former.
              errorCode: originalErrorCode ?? cause,
              error: faultDescription,
              nextAction,
              resultJson: {
                ...(run.resultJson ?? {}),
                executionFinalizationDeadline: finalizationDeadline,
              },
              updatedAt: now,
            })
            .where(eq(heartbeatRuns.id, run.id))
            .returning();
          if (updatedRun && updatedRun.status !== run.status) {
            terminalRunToReport = updatedRun;
          }
          await tx
            .update(agents)
            .set({ status: "idle", updatedAt: now })
            .where(
              and(
                eq(agents.id, run.agentId),
                eq(agents.companyId, run.companyId),
                eq(agents.status, "running"),
                sql`not exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.agentId} = ${run.agentId} and ${heartbeatRuns.status} = 'running')`,
              ),
            );
          const nativeReviewContext = readNativeReviewAssignmentContext(run.contextSnapshot);
          const nativeReviewAssignment = nativeReviewContext && task
            ? await getNativeReviewAssignment(tx as unknown as Db, {
                companyId: run.companyId,
                issueId: task.id,
                agentId: run.agentId,
                contextSnapshot: nativeReviewContext,
              })
            : null;
          const review = task?.status === "in_review" ? parseIssueExecutionState(task.executionState) : null;
          const isCurrentReviewer = (review?.status === "pending" &&
            review.currentParticipant?.type === "agent" && review.currentParticipant.agentId === run.agentId)
            || nativeReviewAssignment?.interaction.status === "pending";
          if (
            !task ||
            (task.assigneeAgentId !== run.agentId && !isCurrentReviewer) ||
            ["done", "cancelled"].includes(task.status) ||
            (task.executionRunId && task.executionRunId !== run.id) ||
            (task.checkoutRunId && task.checkoutRunId !== run.id)
          )
            return true;
          await tx
            .update(issues)
            .set({ executionRunId: null, checkoutRunId: null, updatedAt: now })
            .where(eq(issues.id, task.id));
          await issueRecoveryActionService(
            tx as unknown as Db,
          ).upsertSourceScoped({
            companyId: run.companyId,
            sourceIssueId: task.id,
            kind: "active_run_watchdog",
            ownerType: "board",
            ownerAgentId: null,
            returnOwnerAgentId: task.assigneeAgentId,
            cause,
            fingerprint: `execution-control:${run.id}`,
            evidence: {
              runId: run.id,
              ...(isCurrentReviewer ? { reviewParticipantAgentId: run.agentId } : {}),
              // The full sweep record, so the board reads a cause and not just an
              // instruction. `originalFailureCode` is kept as its own key because
              // it is the field operators already read for this action kind.
              ...finalizationDeadline,
              originalError,
            },
            nextAction,
            wakePolicy: null,
            maxAttempts: 3,
            supersedeOnIdentityChange: true,
          });
          return true;
        });
        if (repaired) surfaced += 1;
        if (terminalRunToReport) void reportRunFailure(db, terminalRunToReport);
      } catch (error) {
        // Log the error, not just the run. A bare `catch {}` here made every
        // sweep failure indistinguishable from a run that is merely still
        // pending, which is why this class had no attributable cause.
        logger.error(
          {
            err: error,
            runId: candidate.runId,
            companyId: candidate.companyId,
            issueId: candidate.issueId,
          },
          "Execution finalization reconciliation failed for this run; it stays pending and the sweep retries",
        );
      }
    }
  }));
  return { scanned: due.length, surfaced };
}
