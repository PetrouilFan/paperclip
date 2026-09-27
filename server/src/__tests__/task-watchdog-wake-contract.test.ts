import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  issueRelations,
  issueWatchdogs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { taskWatchdogService } from "../services/task-watchdogs.ts";
import {
  issueIsInTaskWatchdogSubtree,
  taskWatchdogScopeAllowsIssueMutation,
} from "../services/task-watchdog-scope.ts";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task watchdog wake contract tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("task watchdog wake contract", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-watchdog-wake-contract-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWatchdogs);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `WC${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      issueCounter: 0,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "Watchdog Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedIssue(
    companyId: string,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Watched issue",
      status: overrides.status ?? "done",
      priority: overrides.priority ?? "medium",
      identifier: overrides.identifier ?? `WC-${Math.floor(Math.random() * 10_000)}`,
      issueNumber: overrides.issueNumber ?? Math.floor(Math.random() * 10_000),
      parentId: overrides.parentId,
      assigneeAgentId: overrides.assigneeAgentId,
      originKind: overrides.originKind,
      originId: overrides.originId,
      createdAt: overrides.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  async function blockIssue(companyId: string, blockedId: string, blockerId: string) {
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });
  }

  function createService(instructions: string) {
    const wakes: Array<{ agentId: string; opts: Record<string, unknown> | undefined }> = [];
    const service = taskWatchdogService(db, {
      enqueueWakeup: async (agentId, opts) => {
        wakes.push({ agentId, opts });
        return { id: randomUUID() };
      },
    });
    return { service, wakes, instructions };
  }

  async function seedWatchdog(companyId: string, issueId: string, agentId: string, instructions: string) {
    const [row] = await db.insert(issueWatchdogs).values({
      companyId,
      issueId,
      watchdogAgentId: agentId,
      instructions,
      status: "active",
    }).returning();
    return row;
  }

  describe("board watchdog instructions reach the woken run", () => {
    it("delivers the stored instruction string into the rendered wake prompt", async () => {
      const companyId = await seedCompany("Wake Contract Co");
      const watchedId = await seedIssue(companyId, { identifier: "WC-1", status: "done" });
      const leafId = await seedIssue(companyId, {
        identifier: "WC-2",
        status: "blocked",
        parentId: watchedId,
      });
      const blockerId = await seedIssue(companyId, { identifier: "WC-3", status: "blocked" });
      await blockIssue(companyId, leafId, blockerId);
      const agentId = await seedAgent(companyId);
      await seedWatchdog(
        companyId,
        watchedId,
        agentId,
        "Never change WC-3 status; it belongs to another agent.",
      );
      const { service, wakes } = createService("unused");

      await service.reconcileTaskWatchdogs({ companyId });

      expect(wakes).toHaveLength(1);
      const wakeContext = wakes[0]?.opts?.contextSnapshot;
      expect(wakeContext).toBeTruthy();

      // The run never reads the raw snapshot. It reads the prompt an adapter
      // renders from it, so the contract under test is snapshot -> prompt.
      const prompt = renderPaperclipWakePrompt(wakeContext);

      expect(prompt).toContain("Never change WC-3 status; it belongs to another agent.");
      expect(prompt).not.toContain("No board-supplied watchdog instructions.");
    });

    it("keeps the instruction inside the taskWatchdog object the adapter parses", async () => {
      const companyId = await seedCompany("Wake Shape Co");
      const watchedId = await seedIssue(companyId, { identifier: "WC-10", status: "done" });
      const agentId = await seedAgent(companyId);
      await seedWatchdog(companyId, watchedId, agentId, "Verify stopped work.");
      const { service, wakes } = createService("unused");

      await service.reconcileTaskWatchdogs({ companyId });

      const wakeContext = wakes[0]?.opts?.contextSnapshot as Record<string, unknown>;
      expect(wakeContext.taskWatchdog).toMatchObject({
        watchedIssueId: watchedId,
        customInstructions: "Verify stopped work.",
      });
    });

    it("delivers the stopped leaves the classifier found, not an empty list", async () => {
      const companyId = await seedCompany("Wake Leaves Co");
      const watchedId = await seedIssue(companyId, { identifier: "WC-20", status: "done" });
      const leafId = await seedIssue(companyId, {
        identifier: "WC-21",
        title: "Parked leaf",
        status: "blocked",
        parentId: watchedId,
      });
      const blockerId = await seedIssue(companyId, { identifier: "WC-22", status: "blocked" });
      await blockIssue(companyId, leafId, blockerId);
      const agentId = await seedAgent(companyId);
      await seedWatchdog(companyId, watchedId, agentId, "Verify stopped work.");
      const { service, wakes } = createService("unused");

      await service.reconcileTaskWatchdogs({ companyId });

      const prompt = renderPaperclipWakePrompt(wakes[0]?.opts?.contextSnapshot);

      expect(prompt).toContain("WC-21");
    });

    it("tells the run that blocker-linked issues are writable, so the scope is not a surprise", async () => {
      const companyId = await seedCompany("Wake Capability Co");
      const watchedId = await seedIssue(companyId, { identifier: "WC-30", status: "done" });
      const agentId = await seedAgent(companyId);
      await seedWatchdog(companyId, watchedId, agentId, "Verify stopped work.");
      const { service, wakes } = createService("unused");

      await service.reconcileTaskWatchdogs({ companyId });

      const prompt = renderPaperclipWakePrompt(wakes[0]?.opts?.contextSnapshot);

      // Not `toContain("blocker")` — the unfixed prompt already says the word
      // somewhere, so that assertion passes either way and proves nothing.
      expect(prompt).toContain("Blocker scope:");
      expect(prompt).toContain("direct blockers of the watched issue");
    });

    /**
     * The two halves of this change have to land together, and this is the
     * test that says why.
     *
     * Before the change, a stopped leaf's blocker was out of scope, so a run
     * told "never change this issue's status" was stopped by the scope gate —
     * the prohibition never had to be read. Widening the scope alone makes
     * that same write *permitted*, while the instruction the board wrote to
     * forbid it is still never delivered, because the adapter reads
     * `taskWatchdog.customInstructions` and the wake context only ever wrote
     * it as a sibling key. The defect would stop being visible and start
     * being executed.
     *
     * So: for a run that is handed a forbidden-write instruction about a
     * blocker the new scope admits, the prohibition must be in the prompt the
     * run actually reads. If either half regresses, this goes red.
     */
    it("delivers a forbidden-write instruction about a blocker the new scope admits", async () => {
      const companyId = await seedCompany("Guarded Widen Co");
      const watchedId = await seedIssue(companyId, { identifier: "GW-1", status: "done" });
      const blockerId = await seedIssue(companyId, { identifier: "GW-2", status: "blocked" });
      await blockIssue(companyId, watchedId, blockerId);
      const agentId = await seedAgent(companyId);
      const prohibition = "Never change GW-2 status; it belongs to another agent.";
      await seedWatchdog(companyId, watchedId, agentId, prohibition);
      const { service, wakes } = createService("unused");

      await service.reconcileTaskWatchdogs({ companyId });

      const wakeContext = wakes[0]?.opts?.contextSnapshot as Record<string, unknown>;
      const taskWatchdog = wakeContext.taskWatchdog as Record<string, unknown>;

      // The scope the run is handed admits the blocker...
      expect(taskWatchdog.capabilities).toMatchObject({
        targetScope: { watchedIssueId: watchedId, includeBlockersOfWatchedSubtree: true },
      });
      // ...and the raw scope predicate agrees, so the gate would not stop it.
      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, watchedId),
      ).toBe(true);
      // ...so the prohibition has to arrive, or the grant is unguarded.
      const prompt = renderPaperclipWakePrompt(wakeContext);
      expect(prompt).toContain(prohibition);
    });
  });

  describe("watchdog mutation scope reaches the blocker that causes the stop", () => {
    it("admits a blocker of the watched issue that is not a child", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-1", status: "done" });
      const blockerId = await seedIssue(companyId, { identifier: "SC-2", status: "blocked" });
      expect(await seedIssue(companyId, { identifier: "SC-2b" })).not.toBe(blockerId);
      await blockIssue(companyId, watchedId, blockerId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, watchedId),
      ).toBe(true);
    });

    it("admits a blocker of a descendant of the watched issue", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-3", status: "done" });
      const childId = await seedIssue(companyId, {
        identifier: "SC-4",
        status: "blocked",
        parentId: watchedId,
      });
      const blockerId = await seedIssue(companyId, { identifier: "SC-5", status: "blocked" });
      await blockIssue(companyId, childId, blockerId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, watchedId),
      ).toBe(true);
    });

    it("still admits the watched issue and its parent-ancestry subtree", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-6", status: "done" });
      const childId = await seedIssue(companyId, {
        identifier: "SC-7",
        status: "blocked",
        parentId: watchedId,
      });
      const grandchildId = await seedIssue(companyId, {
        identifier: "SC-8",
        status: "blocked",
        parentId: childId,
      });

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, watchedId, watchedId),
      ).toBe(true);
      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, grandchildId, watchedId),
      ).toBe(true);
    });

    it("refuses an unrelated issue that blocks nothing in the watched subtree", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-9", status: "done" });
      const outsideBlockedId = await seedIssue(companyId, { identifier: "SC-12" });
      const blockerId = await seedIssue(companyId, { identifier: "SC-11", status: "blocked" });
      // The candidate blocks a real issue, just not one in the watched subtree.
      await blockIssue(companyId, outsideBlockedId, blockerId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, watchedId),
      ).toBe(false);
    });

    it("admits a candidate that blocks an in-scope issue even when it also blocks an out-of-scope one", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-9b", status: "done" });
      const childId = await seedIssue(companyId, {
        identifier: "SC-10b",
        status: "blocked",
        parentId: watchedId,
      });
      const outsideBlockedId = await seedIssue(companyId, { identifier: "SC-12b" });
      const blockerId = await seedIssue(companyId, { identifier: "SC-11b", status: "blocked" });
      await blockIssue(companyId, childId, blockerId);
      await blockIssue(companyId, outsideBlockedId, blockerId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, watchedId),
      ).toBe(true);
    });

    it("refuses a blocker of a blocker: the scope is exactly one hop", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-13", status: "done" });
      const blockerId = await seedIssue(companyId, { identifier: "SC-14", status: "blocked" });
      const outerBlockerId = await seedIssue(companyId, { identifier: "SC-15", status: "blocked" });
      await blockIssue(companyId, watchedId, blockerId);
      await blockIssue(companyId, blockerId, outerBlockerId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, outerBlockerId, watchedId),
      ).toBe(false);
    });

    it("refuses a blocker that is itself a task-watchdog issue", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-16", status: "done" });
      const watchdogIssueId = await seedIssue(companyId, {
        identifier: "SC-17",
        status: "blocked",
        originKind: "task_watchdog",
        originId: watchedId,
      });
      await blockIssue(companyId, watchedId, watchdogIssueId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, watchdogIssueId, watchedId),
      ).toBe(false);
    });

    it("refuses a blocker edge that crosses a company boundary", async () => {
      const companyId = await seedCompany("Scope Co A");
      const otherCompanyId = await seedCompany("Scope Co B");
      const watchedId = await seedIssue(companyId, { identifier: "SC-18", status: "done" });
      const foreignBlockerId = await seedIssue(otherCompanyId, { identifier: "SC-19" });
      // A row that names the watched company but points at another company's issue.
      await blockIssue(companyId, watchedId, foreignBlockerId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, foreignBlockerId, watchedId),
      ).toBe(false);
    });

    it("refuses a blocker of a sibling subtree outside the watched issue", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-20", status: "done" });
      const siblingRootId = await seedIssue(companyId, { identifier: "SC-21" });
      const siblingChildId = await seedIssue(companyId, {
        identifier: "SC-22",
        status: "blocked",
        parentId: siblingRootId,
      });
      const siblingBlockerId = await seedIssue(companyId, { identifier: "SC-23", status: "blocked" });
      await blockIssue(companyId, siblingChildId, siblingBlockerId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, siblingBlockerId, watchedId),
      ).toBe(false);
    });

    it("admits the writable blocker through the mutation gate, not only the raw predicate", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-24", status: "done" });
      const childId = await seedIssue(companyId, {
        identifier: "SC-25",
        status: "blocked",
        parentId: watchedId,
      });
      const blockerId = await seedIssue(companyId, { identifier: "SC-26", status: "blocked" });
      await blockIssue(companyId, childId, blockerId);
      const outsideId = await seedIssue(companyId, { identifier: "SC-27" });
      const scope = {
        kind: "watchdog" as const,
        runId: randomUUID(),
        watchdogId: randomUUID(),
        companyId,
        watchedIssueId: watchedId,
        watchdogIssueId: null,
        stopFingerprint: "task_watchdog_stop:test",
        mutationAdmittedAt: null,
      };

      expect(
        await taskWatchdogScopeAllowsIssueMutation(db, scope, {
          id: blockerId,
          companyId,
        }),
      ).toMatchObject({ kind: "watchdog" });
      expect(
        await taskWatchdogScopeAllowsIssueMutation(db, scope, {
          id: outsideId,
          companyId,
        }),
      ).toMatchObject({ kind: "invalid" });
    });

    it("refuses a blocker in another company through the mutation gate", async () => {
      const companyId = await seedCompany("Scope Co A");
      const otherCompanyId = await seedCompany("Scope Co B");
      const watchedId = await seedIssue(companyId, { identifier: "SC-28", status: "done" });
      const foreignId = await seedIssue(otherCompanyId, { identifier: "SC-29" });
      await blockIssue(companyId, watchedId, foreignId);
      const scope = {
        kind: "watchdog" as const,
        runId: randomUUID(),
        watchdogId: randomUUID(),
        companyId,
        watchedIssueId: watchedId,
        watchdogIssueId: null,
        stopFingerprint: "task_watchdog_stop:test",
        mutationAdmittedAt: null,
      };

      expect(
        await taskWatchdogScopeAllowsIssueMutation(db, scope, {
          id: foreignId,
          companyId: otherCompanyId,
        }),
      ).toMatchObject({ kind: "invalid" });
    });
  });
});
