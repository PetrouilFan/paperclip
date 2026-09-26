import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  issueWatchdogs,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * A dead run on a ticket that is under an active task watchdog was pinned back
 * to `blocked` by the recovery sweeper, and it did so on a 30s cadence: the
 * owner could clear the issue and the next sweep put it back, so the ticket's
 * monitor — the thing meant to report the failure — never ran again.
 *
 * The mechanism is not subtle once measured. A monitor only dispatches from
 * `in_progress` / `in_review`, so writing `blocked` silences it, and the settle
 * re-selects the run on every sweep. Nothing anywhere reported the watch had
 * gone dark.
 *
 * These tests pin the carve-out and, just as importantly, its boundaries: an
 * ordinary stranded ticket must still be blocked, because dropping the block
 * everywhere would trade a dead watch for a ticket nobody ever looks at.
 */
const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)(
  "execution-recovery leaves a live watched issue alone",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      if (externalDatabaseUrl) {
        db = createDb(externalDatabaseUrl);
        return;
      }
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-live-watch-exempt-",
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

    /**
     * The `settleUnrecoverableExecutions` shape: a failed native run whose
     * finalization already reached `terminal_failure` with a denial recorded,
     * plus the live watchdog recovery action the sweep resolves.
     */
    async function seedSettleCandidate(
      options: {
        watchdog?: "active" | "none" | "dismissed";
        monitor?: "scheduled" | "triggered" | "cleared";
      } = {},
    ) {
      const { watchdog = "active", monitor = "scheduled" } = options;
      const companyId = randomUUID();
      const agentId = randomUUID();
      const watchdogAgentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      const nextCheckAt = new Date(Date.now() + 60 * 60 * 1000);

      await db.insert(companies).values({
        id: companyId,
        name: "Watched",
        issuePrefix,
        defaultResponsibleUserId: "responsible-user",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values([
        {
          id: agentId,
          companyId,
          name: "Executor",
          role: "engineer",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: watchdogAgentId,
          companyId,
          name: "Watchdog",
          role: "engineer",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
      ]);
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
        title: "The watched work",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: new Date(),
        // The monitor pointer is nulled while a check is in flight and re-armed
        // when it is rescheduled, so the two states are seeded separately.
        monitorNextCheckAt:
          monitor === "scheduled" ? nextCheckAt : null,
        monitorLastTriggeredAt: new Date(),
        monitorAttemptCount: monitor === "cleared" ? 0 : 4,
        executionState:
          monitor === "cleared"
            ? { monitor: { status: "cleared", nextCheckAt: null } }
            : { monitor: { status: monitor, nextCheckAt: null } },
      });
      if (watchdog !== "none") {
        await db.insert(issueWatchdogs).values({
          companyId,
          issueId,
          watchdogAgentId,
          status: watchdog === "active" ? "active" : "dismissed",
          instructions: "Report if the assignee goes quiet.",
          triggerCount: 3,
        });
      }
      await db.insert(nativeRunFinalizations).values({
        runId,
        companyId,
        issueId,
        phase: "terminal_failure",
        attempt: 1,
        failureCode: "native_provider_terminal_failed",
        failureDetail: { replacementDenied: "uncertain_external_action" },
      });
      await db.insert(issueRecoveryActions).values({
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
      });
      return { companyId, agentId, issueId, runId };
    }

    async function readIssue(issueId: string) {
      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId));
      return issue!;
    }

    async function readSettlement(issueId: string) {
      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
      return (
        action!.evidence.automaticRecovery as
          | Record<string, unknown>
          | undefined
      );
    }

    it("does not pin an actively watched issue that has a scheduled monitor", async () => {
      const { companyId, issueId } = await seedSettleCandidate();
      const wakeup = vi.fn(async () => null);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      const settled = await readIssue(issueId);
      // The whole point: the status a monitor dispatches from is left alone.
      expect(settled.status).toBe("in_progress");
      expect(settled.blockedTransitionAt).toBeNull();
      expect(settled.unblockDescriptor).toBeNull();
      // The dead run still has to give the locks back, or the ticket stays
      // checked out to a run that will never finish.
      expect(settled.checkoutRunId).toBeNull();
      expect(settled.executionRunId).toBeNull();
      // The monitor is untouched, so the next scheduled check still fires.
      expect(settled.monitorNextCheckAt).not.toBeNull();
      // Nothing to release: the issue was never taken out of a runnable state.
      expect(wakeup).not.toHaveBeenCalled();
      // And the issue is admissible again — the execution hold does not survive
      // an exempt settlement.
      expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    });

    it("still writes the no-replay receipt, and names the exemption on it", async () => {
      const { issueId } = await seedSettleCandidate();

      await settleUnrecoverableExecutions(db, new Date(), {
        wakeup: async () => null,
      });

      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(action!.status).toBe("resolved");
      // The safety property about the dead run is unchanged: nothing replays.
      expect(await readSettlement(issueId)).toMatchObject({
        policy: "preserve_without_replay_v1",
        replay: "blocked",
        liveWatchExempt: true,
      });
    });

    it("exempts a monitor that has just fired and is waiting to be rescheduled", async () => {
      // `monitorNextCheckAt` is null in this window, so a carve-out that reads
      // only the pointer misses the sweep that lands right after a trigger.
      const { issueId } = await seedSettleCandidate({ monitor: "triggered" });

      await settleUnrecoverableExecutions(db, new Date(), {
        wakeup: async () => null,
      });

      expect((await readIssue(issueId)).status).toBe("in_progress");
    });

    it("stops exempting once the watch is torn down", async () => {
      // A cleared monitor means the ticket is stranded in the ordinary sense.
      // Nothing would be lost by blocking it, so the block still applies.
      const { agentId, issueId } = await seedSettleCandidate({
        monitor: "cleared",
      });
      const wakeup = vi.fn(async () => null);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      const settled = await readIssue(issueId);
      expect(settled.status).toBe("blocked");
      expect(settled.unblockDescriptor).toMatchObject({ owner: { agentId } });
      expect((await readSettlement(issueId))?.liveWatchExempt).toBeUndefined();
    });

    it("stops exempting when the watchdog is no longer active", async () => {
      const { issueId } = await seedSettleCandidate({ watchdog: "dismissed" });

      await settleUnrecoverableExecutions(db, new Date(), {
        wakeup: async () => null,
      });

      expect((await readIssue(issueId)).status).toBe("blocked");
    });

    it("still blocks an issue with no watchdog at all", async () => {
      const { issueId } = await seedSettleCandidate({ watchdog: "none" });

      await settleUnrecoverableExecutions(db, new Date(), {
        wakeup: async () => null,
      });

      expect((await readIssue(issueId)).status).toBe("blocked");
    });

    it("still blocks from a status no monitor can dispatch from", async () => {
      // The exemption is scoped to the statuses a monitor actually runs from.
      const { issueId } = await seedSettleCandidate();
      await db
        .update(issues)
        .set({ status: "todo" })
        .where(eq(issues.id, issueId));

      await settleUnrecoverableExecutions(db, new Date(), {
        wakeup: async () => null,
      });

      expect((await readIssue(issueId)).status).toBe("blocked");
    });

    it("does not re-pin the issue on the next sweep", async () => {
      const { issueId } = await seedSettleCandidate();
      const settle = () =>
        settleUnrecoverableExecutions(db, new Date(), {
          wakeup: async () => null,
        });

      await settle();
      await settle();
      await settle();

      expect((await readIssue(issueId)).status).toBe("in_progress");
    });

    it("records the exemption decision even when it changes no column", async () => {
      // The run died without holding a lock, so the settle writes no issue
      // column. The decision is still worth a durable trace: it is the only
      // record that the dead run was disposed of at all.
      const { companyId, runId, issueId } = await seedSettleCandidate();
      await db
        .update(issues)
        .set({ checkoutRunId: null, executionRunId: null })
        .where(eq(issues.id, issueId));

      await settleUnrecoverableExecutions(db, new Date(), {
        wakeup: async () => null,
      });

      const [event] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(event!.status).toBe("timed_out");
      expect((await readIssue(issueId)).status).toBe("in_progress");
      expect(await readSettlement(issueId)).toMatchObject({
        liveWatchExempt: true,
        changedIssueState: false,
      });
      // The run is consumed, so the next sweep does not select it again.
      expect(
        (
          event!.resultJson as {
            executionRecoveryDisposition?: { changedIssueState?: boolean };
          }
        ).executionRecoveryDisposition,
      ).toMatchObject({ issueId, changedIssueState: false });
      expect(
        await getExecutionBlocker(db, companyId, issueId),
      ).toBeNull();
    });
  },
);
