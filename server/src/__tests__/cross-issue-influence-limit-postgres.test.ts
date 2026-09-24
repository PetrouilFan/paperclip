import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-issue influence limit PostgreSQL serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows exactly one of concurrent attempts 20 and 21", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Concurrent Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(activityLog).values(
      Array.from({ length: 18 }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: targetIssueId,
      })),
    );

    const input = {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "CAP-2",
      kind: "comment" as const,
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    };
    // A comment, a PATCH, and an issue-thread interaction resolution race for the
    // last slot of the shared budget: the row lock must let exactly one of 19/20
    // through per attempt and fail the twenty-first closed.
    const decisions = await Promise.all([
      observeCrossIssueInfluence(db, input),
      observeCrossIssueInfluence(db, { ...input, kind: "update" }),
      observeCrossIssueInfluence(db, { ...input, kind: "interaction_resolution" }),
    ]);

    expect(decisions.map((decision) => decision?.allowed).sort()).toEqual([false, true, true]);
    expect(decisions.map((decision) => decision?.count).sort((a, b) => Number(a) - Number(b)))
      .toEqual([19, 20, 21]);

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_observed")).toHaveLength(20);
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected")).toHaveLength(1);
  });

  async function seedRunAndCompany(input: {
    runStatus?: string;
    contextSnapshot?: Record<string, unknown>;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // A timer/retry run can start with no issue in its context snapshot, then
    // have an issue stamped onto the run (checkout_run_id / execution_run_id).
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: input.runStatus ?? "running",
      responsibleUserId: "board-user",
      contextSnapshot: input.contextSnapshot ?? { wakeReason: "heartbeat_timer" },
    });
    return { companyId, agentId, runId };
  }

  async function seedIssue(input: {
    companyId: string;
    identifier: string;
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Issue ${input.identifier}`,
      identifier: input.identifier,
      checkoutRunId: input.checkoutRunId ?? null,
      executionRunId: input.executionRunId ?? null,
    });
    return issueId;
  }

  it("resolves a context-less run's checkout-only binding", async () => {
    const { companyId, agentId, runId } = await seedRunAndCompany();
    const boundIssueId = await seedIssue({
      companyId,
      identifier: "BND-1",
      checkoutRunId: runId,
    });
    const otherIssueId = await seedIssue({ companyId, identifier: "BND-2" });

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: boundIssueId,
      targetIssueIdentifier: "BND-1",
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toBeNull();

    // A context-less run still has no source for an issue it does not hold, so
    // the cap's fail-closed backstop applies instead of an unattributed count.
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: otherIssueId,
      targetIssueIdentifier: "BND-2",
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
  });

  it("resolves a context-less run's execution-only binding", async () => {
    const { companyId, agentId, runId } = await seedRunAndCompany();
    const boundIssueId = await seedIssue({
      companyId,
      identifier: "EXE-1",
      executionRunId: runId,
    });

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: boundIssueId,
      targetIssueIdentifier: "EXE-1",
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toBeNull();
  });

  it("allows writes to any of several issues a context-less run holds", async () => {
    const { companyId, agentId, runId } = await seedRunAndCompany();
    const firstIssueId = await seedIssue({
      companyId,
      identifier: "MUL-1",
      checkoutRunId: runId,
    });
    const secondIssueId = await seedIssue({
      companyId,
      identifier: "MUL-2",
      executionRunId: runId,
    });

    // The legacy execution-lock fallback can stamp one run onto a sibling issue.
    // Selecting a single bound issue would cap the other; each target must be
    // recognized through its own binding.
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: firstIssueId,
      targetIssueIdentifier: "MUL-1",
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toBeNull();

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: secondIssueId,
      targetIssueIdentifier: "MUL-2",
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toBeNull();
  });

  it("fails closed for a terminal run with a stale binding", async () => {
    const { companyId, agentId, runId } = await seedRunAndCompany({
      runStatus: "succeeded",
    });
    const staleIssueId = await seedIssue({
      companyId,
      identifier: "STL-1",
      checkoutRunId: runId,
      executionRunId: runId,
    });

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: staleIssueId,
      targetIssueIdentifier: "STL-1",
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
  });
});
