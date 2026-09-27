import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { executionProjectionsForRuns } from "../services/execution-projection.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * `getExecutionBlocker` is the enforcement half and the execution projection is
 * the reporting half. Both read `issue_recovery_actions`, and a resolved action
 * can still be the hold. These tests assert they agree: when they disagree the
 * issue is refused a run by a recovery action that no read surface names, and the
 * payload reports no owner and nothing to inspect.
 */
describeEmbeddedPostgres("resolved recovery bookkeeping that still holds execution", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resolved-hold-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        source: "session",
        userId: "hold-owner",
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", agentRoutes(db, {} as never, {} as never));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seed(status: "blocked" | "in_progress" = "blocked") {
    const now = new Date("2026-09-27T00:00:00.000Z");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const prefix = `RH${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Resolved Hold Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Held by resolved bookkeeping",
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      errorCode: "interrupted",
      contextSnapshot: { issueId },
      createdAt: now,
      updatedAt: now,
    });
    return { companyId, issueId, runId, now };
  }

  async function insertResolvedAction(
    fixture: { companyId: string; issueId: string; runId: string; now: Date },
    automaticRecovery: Record<string, unknown>,
  ) {
    const [row] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId: fixture.companyId,
        sourceIssueId: fixture.issueId,
        kind: "active_run_watchdog",
        status: "resolved",
        ownerType: "board",
        cause: "legacy_execution_requires_reconciliation",
        fingerprint: `resolved-hold:${fixture.runId}`,
        evidence: { runId: fixture.runId, automaticRecovery },
        nextAction: "Automatic recovery stopped. Recorded work is preserved.",
        attemptCount: 1,
        maxAttempts: 3,
        lastAttemptAt: fixture.now,
        outcome: "blocked",
        resolvedAt: fixture.now,
        createdAt: fixture.now,
        updatedAt: fixture.now,
      })
      .returning();
    return row!;
  }

  async function project(fixture: { companyId: string; runId: string; now: Date }) {
    const projections = await executionProjectionsForRuns(
      db,
      fixture.companyId,
      [fixture.runId],
      fixture.now,
    );
    return projections.get(fixture.runId)!;
  }

  it("holds an issue from a resolved action that closed with replay blocked, and says so", async () => {
    const fixture = await seed();
    const action = await insertResolvedAction(fixture, {
      replay: "blocked",
      policy: "preserve_without_replay_v1",
    });

    expect(await getExecutionBlocker(db, fixture.companyId, fixture.issueId)).toMatchObject({
      recoveryActionId: action.id,
      cause: "legacy_execution_requires_reconciliation",
      runId: fixture.runId,
    });
    expect(await project(fixture)).toMatchObject({
      phase: "recovery_needed",
      label: "Stopped",
      recoveryOwner: "board",
      permittedActions: ["inspect_run", "inspect_recovery"],
    });
  });

  it("does not hold an issue from a resolved action whose replay was not blocked", async () => {
    const fixture = await seed();
    await insertResolvedAction(fixture, { policy: "preserve_without_replay_v1" });

    expect(await getExecutionBlocker(db, fixture.companyId, fixture.issueId)).toBeNull();
    expect(await project(fixture)).toMatchObject({
      phase: "recovery_needed",
      recoveryOwner: null,
      permittedActions: ["inspect_run"],
    });
  });

  it.each([
    { label: "replay blocked", automaticRecovery: { replay: "blocked" }, holds: true },
    { label: "replay allowed", automaticRecovery: { replay: "allowed" }, holds: false },
    { label: "no replay key", automaticRecovery: { policy: "preserve_without_replay_v1" }, holds: false },
  ])("agrees between the gate and the projection: $label", async ({ automaticRecovery, holds }) => {
    const fixture = await seed();
    await insertResolvedAction(fixture, automaticRecovery);
    const enforced = (await getExecutionBlocker(db, fixture.companyId, fixture.issueId)) !== null;
    const reported = (await project(fixture)).recoveryOwner === "board";
    expect(enforced).toBe(holds);
    expect(reported).toBe(holds);
  });

  it("names the hold on GET /issues/:id/execution instead of reporting nothing to inspect", async () => {
    const fixture = await seed();
    await insertResolvedAction(fixture, {
      replay: "blocked",
      policy: "preserve_without_replay_v1",
    });

    const held = await request(app(fixture.companyId))
      .get(`/api/issues/${fixture.issueId}/execution`)
      .expect(200);
    // The action is resolved, so `recoveryAction` stays null by contract. Without a
    // separate field the payload claims there is no hold, no owner and nothing to
    // inspect, while dispatch refuses to move the issue.
    expect(held.body.recoveryAction).toBeNull();
    expect(held.body.executionHold).toMatchObject({
      recoveryActionId: expect.any(String),
      cause: "legacy_execution_requires_reconciliation",
      runId: fixture.runId,
    });
    expect(held.body.execution).toMatchObject({
      phase: "recovery_needed",
      recoveryOwner: "board",
      permittedActions: ["inspect_run", "inspect_recovery"],
    });

    // Negative control: with no hold at all the field is null rather than absent.
    const clear = await seed();
    const unheld = await request(app(clear.companyId))
      .get(`/api/issues/${clear.issueId}/execution`)
      .expect(200);
    expect(unheld.body).toHaveProperty("executionHold", null);
  });
});
