/**
 * Per-step accounting for the post-provider finalization chain.
 *
 * `executionControlDeadlineAt` is armed the moment the provider returns or
 * throws, so the deadline has always covered the *whole* chain that follows:
 * run-log finalize, the terminal status write, continuation summary, issue
 * comment policy, interaction retries, issue release, review disposition,
 * runtime state and agent status. A chain that merely makes slow progress
 * across many of those steps therefore trips a budget that was only ever
 * meant to bound lifecycle control work.
 *
 * This module makes the budget per-step instead. Each step re-arms the
 * deadline, so the reconciliation sweep only fires when one bounded sub-step
 * is genuinely stuck. `EXECUTION_CONTROL_TOTAL_DEADLINE_MS` remains as the
 * backstop for a chain that keeps making progress and never terminates.
 *
 * The timeline is deliberately in-process. The reconciliation sweep runs in
 * the same server process as the finalization chain, so the sweep can read the
 * step that is in flight at the moment the budget expires. An absent timeline
 * is itself a finding: it means no live finalization chain owns the run, so the
 * run was abandoned rather than slow.
 */
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  EXECUTION_CONTROL_DEADLINE_MS,
  EXECUTION_CONTROL_TOTAL_DEADLINE_MS,
} from "./execution-control-deadline.js";

/** Bounded step timeline retained per run. Enough to name the slow step. */
const MAX_TRACKED_STEPS = 24;

export type FinalizationStepName =
  | "provider_settled"
  | "workspace_restore"
  | "workspace_finalize_record"
  | "native_finalize"
  | "cancellation_settlement"
  | "run_log_finalize"
  | "provider_trace_finalize"
  | "terminal_status_write"
  | "continuation_summary"
  | "issue_comment_policy"
  | "interaction_retry"
  | "issue_release"
  | "review_disposition"
  | "runtime_state"
  | "agent_status"
  | "gateway_token_revoke"
  | "run_scratch_cleanup";

export interface FinalizationStepRecord {
  step: FinalizationStepName;
  startedAtMs: number;
  /** Absent while the step is still in flight. */
  finishedAtMs?: number;
  durationMs?: number;
}

export interface FinalizationStepTiming extends FinalizationStepRecord {
  durationMs: number;
  completed: true;
}

/** The step that is in flight right now, or null when the chain is between steps. */
export interface PendingFinalizationStep {
  step: FinalizationStepName;
  startedAtMs: number;
  elapsedMs: number;
}

export interface RunFinalizationTimeline {
  runId: string;
  companyId: string;
  /** When the provider returned or threw and the first deadline was armed. */
  providerSettledAtMs: number;
  /** Hard cap across the whole chain, independent of per-step renewals. */
  totalDeadlineAtMs: number;
  /** True when the provider threw rather than returning cleanly. */
  providerThrew: boolean;
  steps: FinalizationStepRecord[];
  pending: FinalizationStepName | null;
  pendingStartedAtMs: number | null;
}

export interface RunFinalizationTimelineView {
  providerSettledAtMs: number;
  providerThrew: boolean;
  /** Milliseconds since the provider settled when the view was read. */
  elapsedMs: number;
  /** The step in flight, or null between steps. */
  pendingStep: PendingFinalizationStep | null;
  completedSteps: FinalizationStepTiming[];
  /** Milliseconds spent in the slowest completed step. */
  slowestStepMs: number | null;
  /** True when the chain had already passed the overall backstop. */
  totalBudgetExceeded: boolean;
}

const timelines = new Map<string, RunFinalizationTimeline>();

function viewOf(timeline: RunFinalizationTimeline, nowMs: number): RunFinalizationTimelineView {
  const pendingStep =
    timeline.pending && timeline.pendingStartedAtMs !== null
      ? {
          step: timeline.pending,
          startedAtMs: timeline.pendingStartedAtMs,
          elapsedMs: Math.max(0, nowMs - timeline.pendingStartedAtMs),
        }
      : null;
  const completedSteps = timeline.steps
    .filter(
      (step): step is FinalizationStepTiming =>
        typeof step.durationMs === "number",
    )
    .map((step) => ({ ...step, completed: true as const }));
  return {
    providerSettledAtMs: timeline.providerSettledAtMs,
    providerThrew: timeline.providerThrew,
    elapsedMs: Math.max(0, nowMs - timeline.providerSettledAtMs),
    pendingStep,
    completedSteps,
    slowestStepMs: completedSteps.reduce<number | null>(
      (slowest, step) =>
        slowest === null || step.durationMs > slowest ? step.durationMs : slowest,
      null,
    ),
    totalBudgetExceeded: nowMs >= timeline.totalDeadlineAtMs,
  };
}

/**
 * Re-arm `executionControlDeadlineAt` for a still-running run. The write is
 * guarded on `status = 'running'` so it can never resurrect a deadline on a run
 * the reconciliation sweep already terminalized, and it never throws: a failed
 * renewal must not fail the finalization step that asked for it.
 */
export async function renewExecutionControlDeadline(
  db: Db,
  runId: string,
  options: { budgetMs?: number; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const budgetMs = options.budgetMs ?? EXECUTION_CONTROL_DEADLINE_MS;
  try {
    await db
      .update(heartbeatRuns)
      .set({ executionControlDeadlineAt: new Date(now.getTime() + budgetMs) })
      .where(
        and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")),
      );
  } catch {
    // A lost renewal only means the previous deadline still stands. The
    // reconciliation sweep stays authoritative either way.
  }
}

/**
 * Start (or restart) the timeline for a run whose provider has settled. Call
 * this at the two points where `executionControlDeadlineAt` is armed today, so
 * the first deadline and the timeline are established together.
 */
export function beginRunFinalization(
  runId: string,
  options: { companyId: string; providerThrew: boolean; now?: Date },
): RunFinalizationTimeline {
  const nowMs = (options.now ?? new Date()).getTime();
  const timeline: RunFinalizationTimeline = {
    runId,
    companyId: options.companyId,
    providerSettledAtMs: nowMs,
    totalDeadlineAtMs: nowMs + EXECUTION_CONTROL_TOTAL_DEADLINE_MS,
    providerThrew: options.providerThrew,
    steps: [],
    pending: null,
    pendingStartedAtMs: null,
  };
  timelines.set(runId, timeline);
  return timeline;
}

/**
 * Mark a step as in flight and renew the budget for that step alone. The
 * returned function ends the step and records its duration.
 */
export function beginFinalizationStep(
  runId: string,
  step: FinalizationStepName,
  now: Date = new Date(),
): () => void {
  const timeline = timelines.get(runId);
  const startedAtMs = now.getTime();
  if (!timeline) {
    return () => undefined;
  }
  timeline.pending = step;
  timeline.pendingStartedAtMs = startedAtMs;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const current = timelines.get(runId);
    if (!current) return;
    const finishedAtMs = Date.now();
    const record: FinalizationStepRecord = {
      step,
      startedAtMs,
      finishedAtMs,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
    };
    current.steps.push(record);
    if (current.steps.length > MAX_TRACKED_STEPS) {
      current.steps.splice(0, current.steps.length - MAX_TRACKED_STEPS);
    }
    if (current.pending === step) {
      current.pending = null;
      current.pendingStartedAtMs = null;
    }
  };
}

/** Read the live timeline for a run, or null when no chain owns it. */
export function readRunFinalizationTimeline(
  runId: string,
  now: Date = new Date(),
): RunFinalizationTimelineView | null {
  const timeline = timelines.get(runId);
  return timeline ? viewOf(timeline, now.getTime()) : null;
}

/** Drop the timeline once the run is terminal. Safe to call more than once. */
export function clearRunFinalizationTimeline(runId: string): void {
  timelines.delete(runId);
}

/** Test seam: forget every tracked run. */
export function resetRunFinalizationTimelines(): void {
  timelines.clear();
}
