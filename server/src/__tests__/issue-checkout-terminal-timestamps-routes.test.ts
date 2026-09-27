import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres checkout terminal-timestamp route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("checkout terminal timestamp routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-checkout-terminal-timestamps-routes-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAgentAndRuns() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const currentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
      {
        id: currentRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, agentId, failedRunId, currentRunId };
  }

  function agentActor(
    companyId: string,
    agentId: string,
    runId: string,
  ): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  async function readRow(issueId: string) {
    return db
      .select({
        status: issues.status,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
  }

  // The caller is the issue's own assignee, which is the ordinary case for
  // whoever just closed the ticket, and the caller names the terminal status in
  // `expectedStatuses`. `checkout` writes `status: "in_progress"` regardless of
  // the status it is leaving, so this call legitimately reopens the issue — and
  // the bug is that the reopen used to leave the terminal timestamp behind. A row
  // reading `in_progress` with a non-null `completedAt` makes every consumer that
  // reads one field disagree with every consumer that reads the other, which is
  // the part of the defect that corrupts downstream reads even under the reading
  // where reopening is allowed to stay permitted.
  it.each([
    {
      label: "done/completedAt",
      status: "done" as const,
      timestampColumn: "completedAt" as const,
    },
    {
      label: "cancelled/cancelledAt",
      status: "cancelled" as const,
      timestampColumn: "cancelledAt" as const,
    },
  ])(
    "clears $timestampColumn when a checkout reopens a $label issue",
    async ({ status, timestampColumn }) => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const issueId = randomUUID();
      const terminalAt = new Date("2026-09-27T01:37:08.243Z");
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Reopened from ${status}`,
        status,
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: null,
        executionRunId: null,
        [timestampColumn]: terminalAt,
      });

      const res = await request(
        createApp(agentActor(companyId, agentId, currentRunId)),
      )
        .post(`/api/issues/${issueId}/checkout`)
        .send({
          agentId,
          expectedStatuses: ["backlog", "todo", "in_progress", "in_review", "blocked", status],
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("in_progress");
      // The response body is the same shape the board reads, so the disagreement
      // is asserted where a consumer would actually observe it, not only in the
      // database.
      expect(res.body[timestampColumn]).toBeNull();

      const row = await readRow(issueId);
      expect(row).toEqual({
        status: "in_progress",
        completedAt: null,
        cancelledAt: null,
        checkoutRunId: currentRunId,
        executionRunId: currentRunId,
      });
    },
  );

  // Same defect on the second statement in `checkout` that writes
  // `in_progress`: the stale-execution-lock adoption, reached when the row still
  // points at a finished run. It is a separate `.set()` object, so it needs its
  // own assertion — the main update going green says nothing about this one.
  it("clears completedAt when a stale-execution-run adoption reopens a done issue", async () => {
    const { companyId, agentId, failedRunId, currentRunId } =
      await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const completedAt = new Date("2026-09-27T01:37:08.243Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Done with a stale execution lock",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
      completedAt,
    });

    const res = await request(
      createApp(agentActor(companyId, agentId, currentRunId)),
    )
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: [
          "backlog",
          "todo",
          "in_progress",
          "in_review",
          "blocked",
          "done",
        ],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("in_progress");
    expect(res.body.completedAt).toBeNull();

    const row = await readRow(issueId);
    expect(row).toEqual({
      status: "in_progress",
      completedAt: null,
      cancelledAt: null,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  // Control: the guard still refuses a transition it was not told to allow, and
  // refusing it leaves the row untouched. Without this, "clear the timestamp" and
  // "silently dropped the guard" would look identical from the response alone.
  it("leaves a done issue untouched when the caller does not name done", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const completedAt = new Date("2026-09-27T01:37:08.243Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Done, not named in expectedStatuses",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      completedAt,
    });

    const res = await request(
      createApp(agentActor(companyId, agentId, currentRunId)),
    )
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["backlog", "todo", "in_progress", "in_review", "blocked"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details.status).toBe("done");

    const row = await readRow(issueId);
    expect(row).toEqual({
      status: "done",
      completedAt,
      cancelledAt: null,
      checkoutRunId: null,
      executionRunId: null,
    });
  });
});
