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
  taskWatchdogWriteScopeFromClassification,
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

  async function seedWatchdog(
    companyId: string,
    issueId: string,
    agentId: string,
    instructions: string | null,
  ) {
    const [row] = await db.insert(issueWatchdogs).values({
      companyId,
      issueId,
      watchdogAgentId: agentId,
      instructions,
      status: "active",
    }).returning();
    return row;
  }

  /**
   * The write scope a task-watchdog run is actually held to, derived the way
   * the route derives it: revalidate the stop, then read the id sets out of the
   * classification that revalidation produced. Nothing here hand-builds a set,
   * so a test cannot pass by agreeing with itself about what the gate should
   * admit.
   */
  async function writeScopeFor(
    companyId: string,
    watchedId: string,
    agentId: string,
    instructions: string | null = "Verify stopped work.",
    dbForService: unknown = db,
  ) {
    // Reuse the watchdog the test already seeded where there is one:
    // `issue_watchdogs` is unique per (company, issue), and this helper is
    // about reading the scope, not about creating a second watchdog.
    const existing = await db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.companyId, companyId),
        eq(issueWatchdogs.issueId, watchedId),
        eq(issueWatchdogs.status, "active"),
      ))
      .then((rows) => rows[0] ?? null);
    const watchdogRow = existing ?? (await seedWatchdog(companyId, watchedId, agentId, instructions));
    const service = taskWatchdogService(dbForService as never, {});
    const revalidated = await service.revalidateMutationScope({
      kind: "watchdog",
      // No run id: the baseline write is skipped, and the rebase branch needs
      // one, so the revalidation reports its refusal instead of adopting a new
      // fingerprint. The classification is present either way, and that is all
      // the scope is read from.
      runId: null,
      watchdogId: watchdogRow.id,
      companyId,
      watchedIssueId: watchedId,
      stopFingerprint: "task_watchdog_stop:not-the-live-fingerprint",
      mutationAdmittedAt: null,
    });
    return taskWatchdogWriteScopeFromClassification(revalidated.classification);
  }

  /**
   * Count every query the authorization path issues, so a test can assert the
   * count does not move when the graph gets wider or deeper. `.select` and
   * `.execute` are both counted: the subtree is loaded by a recursive CTE
   * through `.execute`, and missing that one would make the count look flat for
   * the wrong reason.
   */
  function countingDb(inner: unknown) {
    const state = { queries: 0 };
    const proxy = new Proxy(inner as object, {
      get(target, prop, receiver) {
        if (prop === "select" || prop === "execute") state.queries += 1;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { db: proxy, state };
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
      // The advertised grant has to be the grant. The line is the only place
      // the run learns what it may write, so a scope that narrowed while this
      // sentence kept describing the old one would send the run into 403s.
      expect(prompt).toContain("the blockers of the stopped");
      expect(prompt).toContain("that are themselves blocked");
      expect(prompt).not.toContain(
        "the direct blockers of the watched issue and of its in-scope descendants are writable",
      );
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
     *
     * The watched issue is `blocked` and is itself the stopped leaf, so the
     * grant under test is the real one — a blocker whose closure releases a
     * stop — rather than the over-wide grant this change removed.
     */
    it("delivers a forbidden-write instruction about a blocker the new scope admits", async () => {
      const companyId = await seedCompany("Guarded Widen Co");
      const watchedId = await seedIssue(companyId, { identifier: "GW-1", status: "blocked" });
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
      const writeScope = await writeScopeFor(companyId, watchedId, agentId, prohibition);
      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, writeScope),
      ).toBe(true);
      // ...so the prohibition has to arrive, or the grant is unguarded.
      const prompt = renderPaperclipWakePrompt(wakeContext);
      expect(prompt).toContain(prohibition);
    });
  });


  describe("watchdog mutation scope reaches the blocker that causes the stop", () => {
    it("admits the blocker of a leaf the stop actually rests on", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-1", status: "done" });
      const stoppedLeafId = await seedIssue(companyId, {
        identifier: "SC-2",
        status: "blocked",
        parentId: watchedId,
      });
      const blockerId = await seedIssue(companyId, { identifier: "SC-3", status: "blocked" });
      await blockIssue(companyId, stoppedLeafId, blockerId);
      const agentId = await seedAgent(companyId);

      const writeScope = await writeScopeFor(companyId, watchedId, agentId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, writeScope),
      ).toBe(true);
    });

    it("admits a blocker of the watched issue itself when the stop is the watched issue", async () => {
      const companyId = await seedCompany("Scope Co");
      // The watched issue is its own stopped leaf here, so its blockers are the
      // blockers that caused the stop.
      const watchedId = await seedIssue(companyId, { identifier: "SC-1b", status: "blocked" });
      const blockerId = await seedIssue(companyId, { identifier: "SC-2c", status: "blocked" });
      await blockIssue(companyId, watchedId, blockerId);
      const agentId = await seedAgent(companyId);

      const writeScope = await writeScopeFor(companyId, watchedId, agentId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, writeScope),
      ).toBe(true);
    });

    /**
     * The over-wide grant, as a fixture.
     *
     * `L1` is healthy and still working; `L2` is the stop. A third party's
     * blocker hangs off `L1`, in a different branch of the subtree from the one
     * that stopped, and closing it releases nothing. Before the rework the
     * predicate walked the reverse graph and admitted it anyway.
     *
     * Both instruction configurations are covered because `instructions` is
     * nullable: the safety argument this change was carrying — "the prohibition
     * arrives with the grant" — only holds for the watchdogs that have one, so
     * the grant has to be sound without it.
     */
    it("refuses a third party's blocker of a healthy descendant, with or without instructions", async () => {
      const configurations = [
        "Never touch the healthy-descendant blocker.",
        null,
      ];
      for (const [iteration, instructions] of configurations.entries()) {
        const companyId = await seedCompany(`Fixture A Co ${iteration}`);
        const watchedId = await seedIssue(companyId, { identifier: `FA-${iteration}-1`, status: "done" });
        const healthyId = await seedIssue(companyId, {
          identifier: `FA-${iteration}-2`,
          title: "Healthy, still in progress",
          status: "in_progress",
          parentId: watchedId,
        });
        // The actual stop, in a different branch of the subtree.
        await seedIssue(companyId, {
          identifier: `FA-${iteration}-3`,
          title: "The actual stop",
          status: "blocked",
          parentId: watchedId,
        });
        const thirdPartyId = await seedIssue(companyId, {
          identifier: `FA-${iteration}-4`,
          title: "Belongs to another team",
          status: "blocked",
        });
        // Blocks only the healthy descendant, not the stop.
        await blockIssue(companyId, healthyId, thirdPartyId);
        const agentId = await seedAgent(companyId);

        const writeScope = await writeScopeFor(companyId, watchedId, agentId, instructions);

        // Non-vacuity: the classification really ran, the healthy leaf is inside
        // the scope, and the third party is in no stop's blocker set. Without
        // these, an empty classification would make the refusal below pass for
        // the wrong reason.
        expect(writeScope.subtreeIssueIds.has(healthyId)).toBe(true);
        expect(writeScope.stopBlockerIssueIds.has(thirdPartyId)).toBe(false);

        expect(
          await issueIsInTaskWatchdogSubtree(db, companyId, thirdPartyId, writeScope),
        ).toBe(false);
      }
    });

    it("refuses a blocker of a watched issue that is already done", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-4", status: "done" });
      const blockerId = await seedIssue(companyId, { identifier: "SC-5", status: "blocked" });
      // A `done` watched issue is terminal, so it is never a stopped leaf and
      // this edge is not what stopped anything.
      await blockIssue(companyId, watchedId, blockerId);
      const agentId = await seedAgent(companyId);

      const writeScope = await writeScopeFor(companyId, watchedId, agentId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, writeScope),
      ).toBe(false);
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
      const agentId = await seedAgent(companyId);

      const writeScope = await writeScopeFor(companyId, watchedId, agentId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, watchedId, writeScope),
      ).toBe(true);
      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, grandchildId, writeScope),
      ).toBe(true);
    });

    it("refuses an unrelated issue that blocks nothing in the watched subtree", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-9", status: "done" });
      const outsideBlockedId = await seedIssue(companyId, { identifier: "SC-12" });
      const blockerId = await seedIssue(companyId, { identifier: "SC-11", status: "blocked" });
      // The candidate blocks a real issue, just not one in the watched subtree.
      await blockIssue(companyId, outsideBlockedId, blockerId);
      const agentId = await seedAgent(companyId);

      const writeScope = await writeScopeFor(companyId, watchedId, agentId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, writeScope),
      ).toBe(false);
    });

    it("admits a candidate that blocks a stopped leaf even when it also blocks an out-of-scope one", async () => {
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
      const agentId = await seedAgent(companyId);

      const writeScope = await writeScopeFor(companyId, watchedId, agentId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, writeScope),
      ).toBe(true);
    });

    it("refuses a blocker of a blocker: the scope is exactly one hop", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-13", status: "done" });
      const stoppedLeafId = await seedIssue(companyId, {
        identifier: "SC-15b",
        status: "blocked",
        parentId: watchedId,
      });
      const blockerId = await seedIssue(companyId, { identifier: "SC-14", status: "blocked" });
      const outerBlockerId = await seedIssue(companyId, { identifier: "SC-15", status: "blocked" });
      await blockIssue(companyId, stoppedLeafId, blockerId);
      await blockIssue(companyId, blockerId, outerBlockerId);
      const agentId = await seedAgent(companyId);

      const writeScope = await writeScopeFor(companyId, watchedId, agentId);

      // The inner blocker is the one that released the stop, so it is admitted...
      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, blockerId, writeScope),
      ).toBe(true);
      // ...and the outer one belongs to that blocker's own owner.
      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, outerBlockerId, writeScope),
      ).toBe(false);
    });

    it("refuses a granted blocker that is itself a task-watchdog issue", async () => {
      const companyId = await seedCompany("Scope Co");
      const watchedId = await seedIssue(companyId, { identifier: "SC-16", status: "done" });
      const stoppedLeafId = await seedIssue(companyId, {
        identifier: "SC-17b",
        status: "blocked",
        parentId: watchedId,
      });
      // A nested watchdog's review issue is a blocker of the stop, so it reaches
      // the subject check rather than being filtered out of the set — which is
      // the point: the bar that refuses it has to be the one under test.
      const watchdogIssueId = await seedIssue(companyId, {
        identifier: "SC-17",
        status: "blocked",
        originKind: "task_watchdog",
        originId: watchedId,
      });
      await blockIssue(companyId, stoppedLeafId, watchdogIssueId);
      const agentId = await seedAgent(companyId);

      const writeScope = await writeScopeFor(companyId, watchedId, agentId);

      expect(writeScope.stopBlockerIssueIds.has(watchdogIssueId)).toBe(true);
      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, watchdogIssueId, writeScope),
      ).toBe(false);
    });

    it("refuses a granted blocker that belongs to another company", async () => {
      const companyId = await seedCompany("Scope Co A");
      const otherCompanyId = await seedCompany("Scope Co B");
      const watchedId = await seedIssue(companyId, { identifier: "SC-18", status: "done" });
      const stoppedLeafId = await seedIssue(companyId, {
        identifier: "SC-18b",
        status: "blocked",
        parentId: watchedId,
      });
      const foreignBlockerId = await seedIssue(otherCompanyId, { identifier: "SC-19" });
      // A row that names the watched company but points at another company's issue.
      await blockIssue(companyId, stoppedLeafId, foreignBlockerId);
      const agentId = await seedAgent(companyId);

      const writeScope = await writeScopeFor(companyId, watchedId, agentId);

      // The relation row is company-scoped, so the id reaches the set; the
      // subject's own company is what has to refuse it.
      expect(writeScope.stopBlockerIssueIds.has(foreignBlockerId)).toBe(true);
      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, foreignBlockerId, writeScope),
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
      const agentId = await seedAgent(companyId);

      const writeScope = await writeScopeFor(companyId, watchedId, agentId);

      expect(
        await issueIsInTaskWatchdogSubtree(db, companyId, siblingBlockerId, writeScope),
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
      const agentId = await seedAgent(companyId);
      const writeScope = await writeScopeFor(companyId, watchedId, agentId);
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
        await taskWatchdogScopeAllowsIssueMutation(
          db,
          scope,
          { id: blockerId, companyId },
          { writeScope },
        ),
      ).toMatchObject({ kind: "watchdog" });
      expect(
        await taskWatchdogScopeAllowsIssueMutation(
          db,
          scope,
          { id: outsideId, companyId },
          { writeScope },
        ),
      ).toMatchObject({ kind: "invalid" });
    });

    it("refuses a blocker in another company through the mutation gate", async () => {
      const companyId = await seedCompany("Scope Co A");
      const otherCompanyId = await seedCompany("Scope Co B");
      const watchedId = await seedIssue(companyId, { identifier: "SC-28", status: "done" });
      const foreignId = await seedIssue(otherCompanyId, { identifier: "SC-29" });
      await blockIssue(companyId, watchedId, foreignId);
      const agentId = await seedAgent(companyId);
      const writeScope = await writeScopeFor(companyId, watchedId, agentId);
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
        await taskWatchdogScopeAllowsIssueMutation(
          db,
          scope,
          { id: foreignId, companyId: otherCompanyId },
          { writeScope },
        ),
      ).toMatchObject({ kind: "invalid" });
    });
  });

  /**
   * The cost of the authorization decision, as a test.
   *
   * The scope check is on the mutation-approval path, so it runs on every write
   * a watchdog run makes. Deriving the grant from the classification the
   * freshness revalidation already computed is what keeps it flat: the subtree
   * arrives as one recursive-CTE result and both id sets arrive with it, so
   * neither the depth of the subtree nor the number of blocked edges the
   * candidate carries can turn into more round-trips.
   */
  describe("watchdog write scope costs the same whatever the graph looks like", () => {
    async function measureAuthorization(depth: number, decoyEdges: number) {
      const companyId = await seedCompany(`Cost ${depth}-${decoyEdges}`);
      // `issues.identifier` is unique instance-wide, not per company, so every
      // fixture in this describe needs its own prefix.
      const tag = `${depth}x${decoyEdges}`;
      const watchedId = await seedIssue(companyId, { identifier: `CO-${tag}-1`, status: "done" });

      // A chain of `depth` descendants under the watched issue, so ancestry has
      // somewhere to be deep.
      let parentId = watchedId;
      let stoppedLeafId = watchedId;
      for (let index = 0; index < depth; index += 1) {
        stoppedLeafId = await seedIssue(companyId, {
          identifier: `CO-${tag}-chain-${index}`,
          status: index === depth - 1 ? "blocked" : "in_progress",
          parentId,
        });
        parentId = stoppedLeafId;
      }

      const blockerId = await seedIssue(companyId, { identifier: `CO-${tag}-2`, status: "blocked" });
      await blockIssue(companyId, stoppedLeafId, blockerId);

      // Decoy edges: the candidate blocks issues that are outside the subtree.
      // A reverse-graph walk matches each of these and re-walks ancestry for it.
      for (let index = 0; index < decoyEdges; index += 1) {
        const decoyId = await seedIssue(companyId, {
          identifier: `CO-${tag}-decoy-${index}`,
          parentId: index % 2 === 0 ? watchedId : null,
        });
        await blockIssue(companyId, decoyId, blockerId);
      }

      const agentId = await seedAgent(companyId);
      const counted = countingDb(db);
      const writeScope = await writeScopeFor(
        companyId,
        watchedId,
        agentId,
        "Verify stopped work.",
        counted.db,
      );
      const admitted = await issueIsInTaskWatchdogSubtree(
        counted.db as never,
        companyId,
        blockerId,
        writeScope,
      );
      return { queries: counted.state.queries, admitted };
    }

    it("does not spend more queries as decoy edges and ancestry depth grow", async () => {
      const small = await measureAuthorization(2, 0);
      const wide = await measureAuthorization(2, 49);
      const deep = await measureAuthorization(40, 0);
      const worst = await measureAuthorization(40, 49);

      // Each fixture has to be the same decision, or the counts are not
      // comparable: only the shape of the graph is allowed to differ.
      for (const measured of [small, wide, deep, worst]) {
        expect(measured.admitted).toBe(true);
      }

      expect(wide.queries).toBe(small.queries);
      expect(deep.queries).toBe(small.queries);
      expect(worst.queries).toBe(small.queries);
      // And a ceiling, so a future change cannot buy a flat count by moving the
      // work somewhere this assertion no longer sees — and a floor, so a flat
      // count of zero cannot pass for a measurement.
      expect(small.queries).toBeGreaterThan(0);
      expect(small.queries).toBeLessThanOrEqual(16);
    }, 30_000);
  });
});
