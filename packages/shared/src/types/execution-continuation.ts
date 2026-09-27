/**
 * How long this run waited for a dispatch slot, and how many fresher runs for
 * the same agent took one first.
 *
 * Without this, a woken agent cannot tell a fresh assignment from a run that sat
 * at the head of the queue for hours while later-created runs were started ahead
 * of it. The wait itself only ever existed on the `heartbeat_runs` row, which a
 * woken agent never reads, so a stale dispatch was indistinguishable from a live
 * one at every point the agent could act on.
 *
 * Every field is server-owned and derived from the run row at claim time. A
 * woken agent can answer "how long has this been waiting, and how many fresher
 * runs went first?" from the wake payload alone, with no extra read.
 */
export interface ExecutionContinuationQueueAge {
  /** `heartbeat_runs.createdAt`: when the run entered the dispatch queue. */
  enqueuedAt: string;
  /** `heartbeat_runs.startedAt`: when the dispatcher claimed the run. */
  startedAt: string;
  /** `startedAt - enqueuedAt`. The wait a woken agent actually experienced. */
  queueAgeSeconds: number;
  /**
   * Dispatch decisions in which this still-queued run was passed over while the
   * same agent took a slot for a later-created run. "I waited 7 h" and "17
   * fresher runs went first" are different statements, and only the second one is
   * actionable by the woken agent.
   */
  skippedByDispatchCount: number;
  /** `issues.updatedAt` for the bound issue, read at dispatch. */
  issueUpdatedAt?: string | null;
  /**
   * `startedAt - issueUpdatedAt`, floored at zero: how long the bound issue had
   * already been untouched when this run woke onto it. A run whose issue has not
   * moved for hours may have woken onto already-cancelled or already-answered
   * work.
   */
  issueStaleSeconds?: number | null;
}

/** Server-authored context. Each message retains its author and trust boundary. */
export interface ExecutionContinuationEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  trigger: {
    reason: string;
    interactionId: string | null;
    sourceRunId: string | null;
    queueAge: ExecutionContinuationQueueAge | null;
  };
  originCommentIds: string[];
  objective: string;
  messages: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    /** Run-authored Local CLI comments retain user attribution but are not human direction. */
    createdByRunId?: string | null;
    body: string;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    sourceTrust: unknown;
  }>;
  /** Only direct human resolutions, projected from server-owned resolver columns. */
  humanResponses?: Array<{
    id: string;
    kind: string;
    status: string;
    resolvedByUserId: string;
    resolvedAt: string;
    result: unknown;
  }>;
  interactionOutcomes: Array<{
    id: string;
    kind: string;
    status: string;
    result: unknown;
  }>;
  /** Only valid when resuming the provider session associated with this run. */
  resumeDelta?: {
    baseRunId: string;
    messages: ExecutionContinuationEnvelope["messages"];
  };
  recoveryOutcomes?: Array<{ recoveryActionId: string; decision: unknown }>;
  completedWork: string | null;
  /** Start a new turn from history; never replay prior tool calls automatically. */
  interruptedRunId?: string;
  /** Completed mutations are context, never instructions to replay them. */
  completedActions?: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
    result: unknown;
  }>;
  unresolvedInteractionIds: string[];
  coverage: {
    kind: "full_task_history" | "task_history_delta";
    baseRunId?: string;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
  };
}
