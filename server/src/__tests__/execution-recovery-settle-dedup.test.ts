import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { EXECUTION_RECOVERY_DISPOSITION_KEY } from "../services/execution-recovery-identity.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * `issue_recovery_actions.id` is a per-attempt receipt, not the identity of a
 * recovery decision. The sweep used to re-mint that id on every pass, so every
 * dedup keyed on it compared a fresh value against a fresh value and recognised
 * nothing: one dead run was settled every ~30 s indefinitely, re-blocking an
 * issue that was already blocked and writing an activity row for a transition
 * that never happened.
 *
 * These tests pin the three properties that break the loop:
 *   1. the decision is keyed on `(runId, issueId)` — a re-minted row for the
 *      same pair is resolved as a duplicate instead of re-decided;
 *   2. a settlement that changes nothing writes no issue update, so the row
 *      stops taking a lock and a write per sweep;
 *   3. a settlement that changes nothing writes no activity row and does not
 *      re-stamp the run's status-delivery id.
 *
 * And the property that keeps the suppression from becoming a silent drop: an
 * issue whose owner-bearing state genuinely drifted is decided again.
 *
 * Every revisiting test re-mints before each sweep. A plain re-sweep passes on
 * master without this change — once the action is `resolved` the candidate scan
 * no longer selects it — so it does not exercise the loop at all. The loop needs
 * the fresh action row the watchdog mints on every pass.
 */
const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)(
  "execution recovery settles a (runId, issueId) once",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      if (externalDatabaseUrl) {
        db = createDb(externalDatabaseUrl);
        return;
      }
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-recovery-settle-dedup-",
      );
      db = createDb(database.connectionString);
    }, 60_000);
    afterEach(async () => {
      // Every sweep scans all companies; keep earlier fixtures out of later ones.
      await db.execute(sql`TRUNCATE companies CASCADE`);
    });
    afterAll(async () => {
      if (externalDatabaseUrl) await db?.$client.end();
      else await database?.cleanup();
    });

    /** The live watchdog candidate the sweep resolves, exactly as before. */
    async function seedSettleCandidate() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Recovery",
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
        resultJson: {
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        },
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
      const [action] = await db
        .insert(issueRecoveryActions)
        .values({
          companyId,
          sourceIssueId: issueId,
          kind: "active_run_watchdog",
          cause: "native_provider_terminal_failed",
          fingerprint: runId,
          ownerType: "board",
          returnOwnerAgentId: agentId,
          status: "active",
          evidence: { runId },
          nextAction: "Checking recovery",
        })
        .returning();
      return { companyId, agentId, issueId, runId, actionId: action!.id };
    }

    /** What a later sweep mints: a brand new action row, same dead run. */
    async function remintAction(input: {
      companyId: string;
      issueId: string;
      runId: string;
      agentId: string;
    }) {
      const [action] = await db
        .insert(issueRecoveryActions)
        .values({
          companyId: input.companyId,
          sourceIssueId: input.issueId,
          kind: "active_run_watchdog",
          cause: "native_provider_terminal_failed",
          fingerprint: input.runId,
          ownerType: "board",
          returnOwnerAgentId: input.agentId,
          status: "active",
          evidence: { runId: input.runId },
          nextAction: "Checking recovery",
        })
        .returning();
      return action!.id;
    }

    const readIssue = async (issueId: string) => {
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      return issue!;
    };

    const settlementRows = (entityId: string) =>
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityId, entityId),
            eq(activityLog.action, "issue.execution_recovery_settled"),
          ),
        );

    const readDisposition = async (runId: string) => {
      const [run] = await db
        .select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      return (run?.resultJson as Record<string, unknown> | null)?.[
        EXECUTION_RECOVERY_DISPOSITION_KEY
      ] as Record<string, unknown> | undefined;
    };

    const readExecutionStatusDeliveryId = async (runId: string) => {
      const [run] = await db
        .select({ deliveryId: heartbeatRuns.executionStatusDeliveryId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      return run?.deliveryId ?? null;
    };

    it("writes one settlement row no matter how many times the sweep re-mints and revisits the run", async () => {
      const seed = await seedSettleCandidate();
      const wakeup = vi.fn(async () => null);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });
      // The production cadence, not a re-sweep of an already-resolved row: every
      // pass the watchdog mints a fresh action for the same dead run, and that
      // fresh id is what defeated every dedup keyed on the action. 20 passes is
      // the shape of the 153 duplicate settlements measured on a live board.
      for (let i = 0; i < 20; i += 1) {
        await remintAction(seed);
        await settleUnrecoverableExecutions(db, new Date(), { wakeup });
      }

      expect(await settlementRows(seed.issueId)).toHaveLength(1);
      // Every re-minted row is resolved, not left active for the next pass.
      const active = await db
        .select()
        .from(issueRecoveryActions)
        .where(
          and(
            eq(issueRecoveryActions.sourceIssueId, seed.issueId),
            eq(issueRecoveryActions.status, "active"),
          ),
        );
      expect(active).toHaveLength(0);
      expect(await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, seed.issueId))).toHaveLength(21);
    });

    it("stops writing to the issue and re-broadcasting the run once it has settled", async () => {
      const seed = await seedSettleCandidate();
      const wakeup = vi.fn(async () => null);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });
      const afterFirst = await readIssue(seed.issueId);
      const firstDeliveryId = await readExecutionStatusDeliveryId(seed.runId);
      expect(afterFirst.updatedAt).not.toBeNull();
      expect(firstDeliveryId).not.toBeNull();

      for (let i = 0; i < 20; i += 1) {
        await remintAction(seed);
        await settleUnrecoverableExecutions(db, new Date(), { wakeup });
      }

      // A repeat settlement used to run an unconditional `update issues` and
      // re-stamp `updatedAt` on every pass, so one dead run held a row lock and
      // a write per sweep indefinitely. `statusVersion` cannot witness this: the
      // settle never bumps it, only route-level writers do.
      expect((await readIssue(seed.issueId)).updatedAt).toEqual(afterFirst.updatedAt);
      // Same for the re-broadcast: a fresh delivery id is how a settled run
      // re-announces its terminal status to the board on every pass.
      expect(await readExecutionStatusDeliveryId(seed.runId)).toBe(firstDeliveryId);
    });

    it("marks the run consumed on the run's own row", async () => {
      const { issueId, runId } = await seedSettleCandidate();

      await settleUnrecoverableExecutions(db, new Date(), {
        wakeup: async () => null,
      });

      const disposition = await readDisposition(runId);
      expect(disposition).toMatchObject({ runId, issueId, outcome: "blocked" });
      // The run's pre-existing recovery notes must survive the merge.
      const [run] = await db
        .select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(run?.resultJson).toMatchObject({
        executionRecovery: { kind: "bootstrap" },
      });
    });

    it("resolves a re-minted action for the same run without deciding again", async () => {
      const seed = await seedSettleCandidate();
      const wakeup = vi.fn(async () => null);
      await settleUnrecoverableExecutions(db, new Date(), { wakeup });
      const afterFirst = (await readIssue(seed.issueId)).statusVersion;

      // The re-mint: a fresh action id for the very same dead run. This is what
      // the loop did 153 times.
      const reMintedId = await remintAction(seed);
      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      const [reMinted] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, reMintedId));
      expect(reMinted!.status).toBe("resolved");
      // No new decision: the issue did not move and nothing was re-reported.
      expect((await readIssue(seed.issueId)).statusVersion).toBe(afterFirst);
      expect(await settlementRows(seed.issueId)).toHaveLength(1);
      // The duplicate points at the action that actually made the call.
      expect(
        (reMinted!.evidence as Record<string, Record<string, unknown>>)
          .automaticRecovery?.duplicateOfRecoveryActionId,
      ).toBe(seed.actionId);
    });

    it("still settles a run whose issue genuinely changed hands", async () => {
      const seed = await seedSettleCandidate();
      const wakeup = vi.fn(async () => null);
      await settleUnrecoverableExecutions(db, new Date(), { wakeup });
      const afterFirst = (await readIssue(seed.issueId)).statusVersion;

      // A new owner is a new decision, not a duplicate — suppressing it would
      // silently strand a re-assigned issue.
      const newAgentId = randomUUID();
      await db.insert(agents).values({
        id: newAgentId,
        companyId: seed.companyId,
        name: "Successor",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db
        .update(issues)
        .set({ assigneeAgentId: newAgentId })
        .where(eq(issues.id, seed.issueId));

      const reMintedId = await remintAction({ ...seed, agentId: newAgentId });
      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      const [reMinted] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, reMintedId));
      // Decided afresh, not recognised as a duplicate of the earlier call.
      expect(reMinted!.status).toBe("resolved");
      expect(
        (reMinted!.evidence as Record<string, Record<string, unknown>>)
          .automaticRecovery?.duplicateOfRecoveryActionId,
      ).toBeUndefined();
      // The receipt is refreshed to the new owner, so the *next* re-mint against
      // this state is recognised and the loop closes again.
      expect(await readDisposition(seed.runId)).toMatchObject({
        runId: seed.runId,
        issueId: seed.issueId,
        observed: { assigneeAgentId: newAgentId },
      });
      // The successor's settle found the issue already blocked with an exit, so
      // it correctly wrote no second transition.
      expect((await readIssue(seed.issueId)).statusVersion).toBe(afterFirst);
      expect(await settlementRows(seed.issueId)).toHaveLength(1);
    });

    it("leaves the run's own recovery evidence intact for a re-minted duplicate", async () => {
      const seed = await seedSettleCandidate();
      const wakeup = vi.fn(async () => null);
      await settleUnrecoverableExecutions(db, new Date(), { wakeup });
      await remintAction(seed);
      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      const [run] = await db
        .select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, seed.runId));
      expect(run?.resultJson).toMatchObject({
        executionRecovery: { kind: "bootstrap" },
      });
    });
  },
);
