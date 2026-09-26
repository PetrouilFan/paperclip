import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issues,
  issueRelations,
  issueThreadInteractions,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import {
  backfillStrandedBlockedIssues,
  findStrandedBlockedIssues,
  STRANDED_BLOCKED_BACKFILL_ACTION,
} from "../services/stranded-blocked-backfill.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * PR #47 made the writers name an exit. It could not rescue issues that were
 * already stranded, because the self-heal path only fires when a sweep touches
 * the issue again, and a stranded issue whose run is gone is never selected
 * again. Those tickets are `blocked`, have no unresolved blockers, no pending
 * interaction or approval, and no `unblock_descriptor` — which is the whole
 * problem, because checkout refuses `blocked`, so no agent can resume them.
 *
 * The backfill writes the missing exit onto exactly that set, and the sweep
 * stops re-settling a run whose outcome it has already recorded.
 */
const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)(
  "stranded blocked backfill",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      if (externalDatabaseUrl) {
        db = createDb(externalDatabaseUrl);
        return;
      }
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-stranded-backfill-",
      );
      db = createDb(database.connectionString);
    }, 60_000);
    afterEach(async () => {
      await db.execute(sql`TRUNCATE companies CASCADE`);
    });
    afterAll(async () => {
      if (externalDatabaseUrl) await db?.$client.end();
      else await database?.cleanup();
    });

    async function seedCompany() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issuePrefix = `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      await db.insert(companies).values({
        id: companyId,
        name: "Backfill",
        issuePrefix,
        defaultResponsibleUserId: "responsible-user",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Executor",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return { companyId, agentId, issuePrefix };
    }

    async function seedStrandedBlocked(
      opts: {
        assigneeAgentId?: string | null;
        assigneeUserId?: string | null;
        descriptor?: unknown;
      } = {},
    ) {
      const { companyId, agentId, issuePrefix } = await seedCompany();
      const issueId = randomUUID();
      await db
        .insert(issues)
        .values({
          id: issueId,
          companyId,
          title: "Stranded by a dead run",
          status: "blocked",
          priority: "medium",
          assigneeAgentId: opts.assigneeAgentId === undefined ? agentId : opts.assigneeAgentId,
          assigneeUserId: opts.assigneeUserId ?? null,
          responsibleUserId: "responsible-user",
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
          unblockDescriptor: (opts.descriptor ?? null) as never,
        })
        .returning();
      return { companyId, agentId, issueId, issuePrefix };
    }

    async function readIssue(issueId: string) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      return issue!;
    }

    it("names the assignee so the exit is self-serviceable", async () => {
      const { agentId, issueId } = await seedStrandedBlocked();

      const result = await backfillStrandedBlockedIssues(db);

      expect(result.written).toBe(1);
      const repaired = await readIssue(issueId);
      expect(repaired.unblockDescriptor).toEqual({
        owner: { agentId },
        action: STRANDED_BLOCKED_BACKFILL_ACTION,
      });
    });

    it("names the user assignee when no agent owns the issue", async () => {
      const { companyId, issueId } = await seedStrandedBlocked({
        assigneeAgentId: null,
        assigneeUserId: "human-operator",
      });

      await backfillStrandedBlockedIssues(db);

      expect((await readIssue(issueId)).unblockDescriptor).toMatchObject({
        owner: { userId: "human-operator" },
      });
      expect(companyId).toBeTruthy();
    });

    it("names the board when nothing is assigned, instead of inventing nothing", async () => {
      const { issueId } = await seedStrandedBlocked({
        assigneeAgentId: null,
        assigneeUserId: null,
      });

      const result = await backfillStrandedBlockedIssues(db);

      // "Nobody to name" is what made these tickets dead. An unassigned issue
      // is named `board`, which the attention service already surfaces as an
      // unblock/reassign decision.
      expect(result.written).toBe(1);
      expect((await readIssue(issueId)).unblockDescriptor).toMatchObject({
        owner: "board",
      });
    });

    it("re-run changes nothing", async () => {
      const { issueId } = await seedStrandedBlocked();

      const first = await backfillStrandedBlockedIssues(db);
      const afterFirst = await readIssue(issueId);
      const second = await backfillStrandedBlockedIssues(db);
      const third = await backfillStrandedBlockedIssues(db);

      expect(first.written).toBe(1);
      expect(second).toMatchObject({ scanned: 0, written: 0 });
      expect(third).toMatchObject({ scanned: 0, written: 0 });
      expect((await readIssue(issueId)).unblockDescriptor).toEqual(
        afterFirst.unblockDescriptor,
      );
      expect((await readIssue(issueId)).updatedAt).toEqual(afterFirst.updatedAt);
    });

    it("does not overwrite an existing descriptor", async () => {
      const { issueId } = await seedStrandedBlocked({
        descriptor: { owner: "board", action: "Operator: approve the exception." },
      });

      const result = await backfillStrandedBlockedIssues(db);

      // Scanned zero: the candidate query only selects null descriptors.
      expect(result.written).toBe(0);
      expect((await readIssue(issueId)).unblockDescriptor).toEqual({
        owner: "board",
        action: "Operator: approve the exception.",
      });
    });

    it("does not touch a dependency hold", async () => {
      const { companyId, issueId, issuePrefix } = await seedStrandedBlocked();
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId,
        title: "The real blocker",
        status: "in_progress",
        priority: "medium",
        responsibleUserId: "responsible-user",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });

      const result = await backfillStrandedBlockedIssues(db);

      expect(result).toMatchObject({ scanned: 1, written: 0, held: 1 });
      expect((await readIssue(issueId)).unblockDescriptor).toBeNull();
    });

    it("does not touch a hold whose blocker is already terminal", async () => {
      const { companyId, issueId, issuePrefix } = await seedStrandedBlocked();
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId,
        title: "Finished blocker",
        status: "done",
        priority: "medium",
        responsibleUserId: "responsible-user",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        completedAt: new Date(),
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });

      // A terminal blocker is not a hold, so this issue really is stranded and
      // does get an exit.
      const result = await backfillStrandedBlockedIssues(db);
      expect(result.written).toBe(1);
      expect((await readIssue(issueId)).unblockDescriptor).toMatchObject({
        owner: { agentId: (await readIssue(issueId)).assigneeAgentId },
      });
    });

    it("does not touch a pending interaction", async () => {
      const { companyId, issueId } = await seedStrandedBlocked();
      await db.insert(issueThreadInteractions).values({
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        idempotencyKey: randomUUID(),
        payload: {},
      } as never);

      const result = await backfillStrandedBlockedIssues(db);

      expect(result).toMatchObject({ written: 0, held: 1 });
      expect((await readIssue(issueId)).unblockDescriptor).toBeNull();
    });

    it("does not touch a pending approval", async () => {
      const { companyId, issueId } = await seedStrandedBlocked();
      const approvalId = randomUUID();
      await db.insert(approvals).values({
        id: approvalId,
        companyId,
        type: "issue_execution",
        status: "pending",
        payload: {},
      } as never);
      await db.insert(issueApprovals).values({
        companyId,
        issueId,
        approvalId,
      } as never);

      const result = await backfillStrandedBlockedIssues(db);

      expect(result).toMatchObject({ written: 0, held: 1 });
      expect((await readIssue(issueId)).unblockDescriptor).toBeNull();
    });

    it("leaves a non-blocked issue alone", async () => {
      const { companyId, issueId, issuePrefix } = await seedCompany();
      const issueId2 = randomUUID();
      await db.insert(issues).values({
        id: issueId2,
        companyId,
        title: "Todo work",
        status: "todo",
        priority: "medium",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const result = await backfillStrandedBlockedIssues(db);

      expect(result.scanned).toBe(0);
      expect((await readIssue(issueId2)).unblockDescriptor).toBeNull();
      expect(issueId).toBeTruthy();
    });

    it("findStrandedBlockedIssues is the board assertion and reads empty after the backfill", async () => {
      await seedStrandedBlocked();

      const before = await findStrandedBlockedIssues(db);
      expect(before.map(i => i.identifier)).toHaveLength(1);

      await backfillStrandedBlockedIssues(db);

      expect(await findStrandedBlockedIssues(db)).toEqual([]);
    });

    it("findStrandedBlockedIssues counts an issue with a hold as non-stranded", async () => {
      const { companyId, issueId, issuePrefix } = await seedStrandedBlocked();
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId,
        title: "The real blocker",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });

      expect(await findStrandedBlockedIssues(db)).toEqual([]);
    });
  },
);

(support.supported ? describe : describe.skip)(
  "a settled run is not settled again",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      if (externalDatabaseUrl) {
        db = createDb(externalDatabaseUrl);
        return;
      }
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-settle-idempotent-",
      );
      db = createDb(database.connectionString);
    }, 60_000);
    afterEach(async () => {
      await db.execute(sql`TRUNCATE companies CASCADE`);
    });
    afterAll(async () => {
      if (externalDatabaseUrl) await db?.$client.end();
      else await database?.cleanup();
    });

    /** The dead native run shape, with the live watchdog action the sweep resolves. */
    async function seedDeadRun() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Settle",
        issuePrefix,
        defaultResponsibleUserId: "responsible-user",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Executor",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "failed",
        runId,
        claimedAt: new Date(),
        finishedAt: new Date(),
        error: "Timed out after 1800s",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "timed_out",
        wakeupRequestId,
        nativeIssueId: issueId,
        runtimeMode: "native",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        startedAt: new Date(),
        finishedAt: new Date(),
        updatedAt: new Date(),
        errorCode: "execution_finalization_deadline_exceeded",
        error: "Timed out after 1800s",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Work the dead run started",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: new Date(),
      });
      await db.insert(nativeRunFinalizations).values({
        runId,
        companyId,
        issueId,
        phase: "terminal_failure",
        attempt: 1,
        failureCode: "native_provider_terminal_failed",
        failureDetail: { replacementDenied: "uncertain_external_action" },
      });
      return { companyId, agentId, issueId, runId, issuePrefix };
    }

    async function insertWatchdogAction(
      input: { companyId: string; issueId: string; agentId: string; runId: string },
      status: "active" | "resolved" = "active",
    ) {
      await db.insert(issueRecoveryActions).values({
        companyId: input.companyId,
        sourceIssueId: input.issueId,
        kind: "active_run_watchdog",
        cause: "native_provider_terminal_failed",
        fingerprint: `execution-control:${input.runId}`,
        ownerType: "board",
        returnOwnerAgentId: input.agentId,
        status,
        ...(status === "resolved"
          ? {
              outcome: "blocked" as const,
              resolvedAt: new Date(),
              evidence: {
                runId: input.runId,
                automaticRecovery: {
                  policy: "preserve_without_replay_v1",
                  runId: input.runId,
                  replay: "blocked",
                  actionOutcome: "unknown",
                  recordedAt: new Date().toISOString(),
                },
              },
            }
          : { evidence: { runId: input.runId } }),
        nextAction: "Checking recovery",
      });
    }

    async function countSettledActivity(issueId: string) {
      const rows = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, issueId),
            eq(activityLog.action, "issue.execution_recovery_settled"),
          ),
        );
      return rows.length;
    }

    it("a second sweep over an already-settled run is a no-op", async () => {
      const seed = await seedDeadRun();
      await insertWatchdogAction(seed);
      const wakeup = vi.fn(async () => null);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });
      const afterFirst = await db.select().from(issues).where(eq(issues.id, seed.issueId));
      const settledActivities = await countSettledActivity(seed.issueId);
      expect(settledActivities).toBe(1);

      // The reconciler re-surfaces the same dead run under a fresh watchdog
      // action. That is what used to make one dead run settle 2-4 times.
      await insertWatchdogAction(seed);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });
      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      // The issue is not re-written and the activity log is not polluted.
      const afterRepeat = await db.select().from(issues).where(eq(issues.id, seed.issueId));
      expect(afterRepeat[0].updatedAt).toEqual(afterFirst[0].updatedAt);
      expect(await countSettledActivity(seed.issueId)).toBe(1);
      // The duplicate action is retired, not left active for the attention queue.
      const actions = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, seed.issueId));
      expect(actions.every(a => a.status === "resolved")).toBe(true);
      expect(wakeup).toHaveBeenCalledTimes(1);
    });

    it("still settles a distinct run on the same issue", async () => {
      const seed = await seedDeadRun();
      await insertWatchdogAction(seed);
      await settleUnrecoverableExecutions(db, new Date());

      // A genuinely new failure is a new run and must still be dispositioned.
      const secondRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: secondRunId,
        companyId: seed.companyId,
        agentId: seed.agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        nativeIssueId: seed.issueId,
        runtimeMode: "native",
        contextSnapshot: { issueId: seed.issueId, taskId: seed.issueId, wakeReason: "issue_assigned" },
        startedAt: new Date(),
        finishedAt: new Date(),
        updatedAt: new Date(),
        errorCode: "process_lost",
      });
      await db.insert(nativeRunFinalizations).values({
        runId: secondRunId,
        companyId: seed.companyId,
        issueId: seed.issueId,
        phase: "terminal_failure",
        attempt: 1,
        failureCode: "native_provider_terminal_failed",
        failureDetail: { replacementDenied: "uncertain_external_action" },
      });
      await insertWatchdogAction({ ...seed, runId: secondRunId });

      await settleUnrecoverableExecutions(db, new Date());

      expect(await countSettledActivity(seed.issueId)).toBe(2);
    });
  },
);
