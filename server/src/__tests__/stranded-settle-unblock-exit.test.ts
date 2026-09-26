import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  issueRelations,
  issueThreadInteractions,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { strandedRunUnblockDescriptor } from "../services/routable-blocked.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * A dead run is not a hold. Both recovery sweeps that convert a dead run into a
 * `blocked` issue used to write the status and nothing else: no
 * `unblockDescriptor`, no `blockedTransitionAt`, and no blocker row. The result
 * was an issue the server simultaneously reported as blocked and as having
 * nothing blocking it, with no mechanism able to release it, and which the
 * assignee cannot check back out (checkout refuses `blocked`).
 *
 * These tests pin the invariant both sites now have to satisfy:
 *   an issue entering `blocked` always has unresolved blockers, a pending
 *   interaction/approval, or an `unblockDescriptor` with a named owner.
 */
const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();

describe("strandedRunUnblockDescriptor", () => {
  it("names the agent assignee so the exit is self-serviceable", () => {
    expect(
      strandedRunUnblockDescriptor({
        assigneeAgentId: "agent-1",
        action: "The run stopped.",
      }),
    ).toEqual({ owner: { agentId: "agent-1" }, action: "The run stopped." });
  });

  it("names the user assignee when no agent owns the issue", () => {
    expect(
      strandedRunUnblockDescriptor({
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        action: "The run stopped.",
      }),
    ).toEqual({ owner: { userId: "user-1" }, action: "The run stopped." });
  });

  it("never overwrites a separate human or dependency hold's exit", () => {
    const existing = { owner: "board" as const, action: "Approve the exception" };
    expect(
      strandedRunUnblockDescriptor({
        existing,
        assigneeAgentId: "agent-1",
        action: "The run stopped.",
      }),
    ).toBeNull();
  });

  it("refuses to invent an owner when nothing is assigned", () => {
    expect(
      strandedRunUnblockDescriptor({
        assigneeAgentId: null,
        assigneeUserId: null,
        action: "The run stopped.",
      }),
    ).toBeNull();
  });

  it("honours an explicit board owner over the assignee", () => {
    expect(
      strandedRunUnblockDescriptor({
        owner: "board",
        assigneeAgentId: "agent-1",
        action: "Board operator: inspect the run evidence.",
      }),
    ).toEqual({ owner: "board", action: "Board operator: inspect the run evidence." });
  });
});

(support.supported ? describe : describe.skip)(
  "stranded settle leaves an exit behind",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      if (externalDatabaseUrl) {
        db = createDb(externalDatabaseUrl);
        return;
      }
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-stranded-settle-",
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
    async function seedSettleCandidate() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Stranded",
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

    it("settleUnrecoverableExecutions names the assignee and wakes them", async () => {
      const { agentId, issueId } = await seedSettleCandidate();
      const wakeup = vi.fn(async () => null);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      const settled = await readIssue(issueId);
      expect(settled.status).toBe("blocked");
      // The exit exists and names the agent whose run died, so the state is
      // legible and self-serviceable instead of a dead ticket.
      expect(settled.unblockDescriptor).toMatchObject({
        owner: { agentId },
      });
      expect(typeof (settled.unblockDescriptor as { action: string }).action)
        .toBe("string");
      // A real transition, so the routable-blocked path considers it.
      expect(settled.blockedTransitionAt).not.toBeNull();
      expect(wakeup).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({ reason: "issue_unblock_requested" }),
      );
      expect(settled.blockedOwnerNotifiedAt).not.toBeNull();
    });

    it("wakes the unblock owner once, not once per sweep", async () => {
      const { agentId, issueId } = await seedSettleCandidate();
      const wakeup = vi.fn(async () => null);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });
      await settleUnrecoverableExecutions(db, new Date(), { wakeup });
      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      expect(wakeup).toHaveBeenCalledTimes(1);
      // The descriptor survives repeated sweeps; nothing rewrites or drops it.
      expect((await readIssue(issueId)).unblockDescriptor).toMatchObject({
        owner: { agentId },
      });
    });

    it("repairs a block this same sweep already stranded", async () => {
      const { agentId, issueId } = await seedSettleCandidate();
      // The shape the pre-fix sweep left behind: blocked, no descriptor, and no
      // transition stamp, so neither the unblock wake nor the attention queue
      // can see it.
      await db
        .update(issues)
        .set({
          status: "blocked",
          unblockDescriptor: null,
          blockedTransitionAt: null,
          blockedOwnerNotifiedAt: null,
        })
        .where(eq(issues.id, issueId));
      const wakeup = vi.fn(async () => null);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      const repaired = await readIssue(issueId);
      expect(repaired.status).toBe("blocked");
      expect(repaired.unblockDescriptor).toMatchObject({ owner: { agentId } });
      expect(repaired.blockedTransitionAt).not.toBeNull();
      expect(wakeup).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({ reason: "issue_unblock_requested" }),
      );
    });

    it("settleUnrecoverableExecutions keeps an existing hold's descriptor", async () => {
      const { issueId } = await seedSettleCandidate();
      const existing = {
        owner: { userId: "responsible-user" as const },
        action: "Approve the exception",
      };
      await db
        .update(issues)
        .set({ status: "blocked", unblockDescriptor: existing })
        .where(eq(issues.id, issueId));
      const wakeup = vi.fn(async () => null);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      expect((await readIssue(issueId)).unblockDescriptor).toEqual(existing);
      expect(wakeup).not.toHaveBeenCalled();
    });

    it("settleUnrecoverableExecutions does not add an exit a real blocker already provides", async () => {
      const { issueId } = await seedSettleCandidate();
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId: (await readIssue(issueId)).companyId,
        title: "Real dependency",
        status: "todo",
        priority: "medium",
        issueNumber: 2,
        identifier: "S-BLOCK",
      });
      await db.insert(issueRelations).values({
        companyId: (await readIssue(issueId)).companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });
      const wakeup = vi.fn(async () => null);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      const settled = await readIssue(issueId);
      expect(settled.status).toBe("blocked");
      // The dependency is the exit, so no duplicate unblock request is raised.
      expect(settled.unblockDescriptor).toBeNull();
      expect(wakeup).not.toHaveBeenCalled();
    });

    it("settleUnrecoverableExecutions leaves a pending interaction as the exit", async () => {
      const { issueId } = await seedSettleCandidate();
      const companyId = (await readIssue(issueId)).companyId;
      await db.insert(issueThreadInteractions).values({
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        idempotencyKey: randomUUID(),
        payload: { questions: [{ id: "q1", prompt: "Which environment?" }] },
        createdByActorType: "agent",
        createdByAgentId: (await readIssue(issueId)).assigneeAgentId,
      });
      const wakeup = vi.fn(async () => null);

      await settleUnrecoverableExecutions(db, new Date(), { wakeup });

      expect((await readIssue(issueId)).unblockDescriptor).toBeNull();
      expect(wakeup).not.toHaveBeenCalled();
    });

    /**
     * The second write site. A `in_progress` issue whose continuation run failed
     * non-retryably is escalated straight to `blocked`; the sweep wrote
     * `blockedByIssueIds: []`, which is observably a zero-blocker hold.
     */
    async function seedStrandedAssignedIssue() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      const issueId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      await db.insert(companies).values({
        id: companyId,
        name: "Stranded",
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
        error: "adapter setup failed",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "failed",
        wakeupRequestId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        startedAt: new Date(),
        finishedAt: new Date(),
        updatedAt: new Date(),
        errorCode: "setup_failed",
        error: "adapter setup failed",
        resultJson: {
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        },
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Continuation work",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: new Date(),
      });
      return { companyId, agentId, issueId, runId };
    }

    it("reconcileStrandedAssignedIssues names the board, not the failed agent", async () => {
      const { agentId, issueId } = await seedStrandedAssignedIssue();

      const result = await heartbeatService(db).reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);

      const escalated = await readIssue(issueId);
      expect(escalated.status).toBe("blocked");
      // `board_escalation_no_takeover_v1`: this sweep escalates to a human
      // operator rather than handing the work back to the agent that failed. A
      // board-owned descriptor is what the attention service surfaces to them.
      expect(escalated.unblockDescriptor).toMatchObject({ owner: "board" });
      // The instruction has to say what happened, or "blocked" says nothing.
      expect((escalated.unblockDescriptor as { action: string }).action).toContain(
        "setup failed",
      );
      expect(escalated.blockedTransitionAt).not.toBeNull();
      // No takeover wake: the routing policy is unchanged by this fix.
      const wakes = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakes.map((wake) => wake.reason)).not.toContain(
        "issue_unblock_requested",
      );
    });

    it("reconcileStrandedAssignedIssues keeps a real blocker's exit", async () => {
      const { companyId, issueId } = await seedStrandedAssignedIssue();
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId,
        title: "Real dependency",
        status: "todo",
        priority: "medium",
        issueNumber: 2,
        identifier: "T-BLOCK",
      });
      await issueService(db).update(issueId, {
        blockedByIssueIds: [blockerId],
        actorUserId: "responsible-user",
      });
      await db
        .update(issues)
        .set({ status: "in_progress" })
        .where(eq(issues.id, issueId));

      const result = await heartbeatService(db).reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);

      const escalated = await readIssue(issueId);
      expect(escalated.status).toBe("blocked");
      expect(escalated.unblockDescriptor).toBeNull();
      const [relation] = await db
        .select()
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.relatedIssueId, issueId),
            eq(issueRelations.type, "blocks"),
          ),
        );
      expect(relation?.issueId).toBe(blockerId);
    });

    it("no blocked issue in these fixtures is left without a way out", async () => {
      const settled = await seedSettleCandidate();
      const stranded = await seedStrandedAssignedIssue();
      await settleUnrecoverableExecutions(db, new Date(), {
        wakeup: async () => null,
      });
      await heartbeatService(db).reconcileStrandedAssignedIssues();

      for (const issueId of [settled.issueId, stranded.issueId]) {
        const issue = await readIssue(issueId);
        expect(issue.status).toBe("blocked");
        const blockers = await db
          .select({ issueId: issueRelations.issueId })
          .from(issueRelations)
          .innerJoin(issues, eq(issues.id, issueRelations.issueId))
          .where(
            and(
              eq(issueRelations.relatedIssueId, issueId),
              eq(issueRelations.type, "blocks"),
              sql`${issues.status} not in ('done', 'cancelled')`,
            ),
          );
        const pending = await db
          .select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions)
          .where(
            and(
              eq(issueThreadInteractions.issueId, issueId),
              eq(issueThreadInteractions.status, "pending"),
            ),
          );
        // The route layer already enforces exactly this disjunction. The
        // internal sweeps bypassed it, which is how stranded tickets formed.
        expect(
          blockers.length > 0 || pending.length > 0 || issue.unblockDescriptor,
        ).toBeTruthy();
      }
    });
  },
);
