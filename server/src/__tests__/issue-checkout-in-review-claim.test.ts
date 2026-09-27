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
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueService } from "../services/issues.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres in_review checkout claim tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// The status set the platform documents to agents, verbatim. `in_review` is in
// it, which is the whole problem: every agent following the documented
// protocol could name a parked issue and take it.
const DOCUMENTED_AGENT_DEFAULT = ["todo", "backlog", "blocked", "in_review"];

describeEmbeddedPostgres("checkout cannot self-authorize the in_review edge", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-in-review-claim-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
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

  async function seed(status: "in_review" | "todo" | "done") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

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
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Parked task (${status})`,
      status,
      priority: "high",
      assigneeAgentId: agentId,
    });

    return { companyId, agentId, issueId, runId };
  }

  async function readRow(issueId: string) {
    return db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
  }

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

  it("refuses a documented-default checkout of an in_review issue and writes no binding", async () => {
    // `in_review` encodes a decision: a real reviewer, a pending
    // confirmation card, a monitor. `POST /checkout` wrote
    // `status: "in_progress"` unconditionally, gated only by the caller's own
    // `expectedStatuses` list -- and the list agents are told to send contains
    // "in_review". So the platform's documented claim call silently dismantled
    // the review path, and because the same statement also stamped
    // executionRunId, the agent then had to race its own execution lock to put
    // the disposition back. The assertion is on the row, not just the throw: a
    // test that only checked the status code would pass if the write landed and
    // then something re-set the status.
    const { companyId, agentId, issueId, runId } = await seed("in_review");
    const actor = {
      type: "agent" as const,
      agentId,
      companyId,
      runId,
      permissions: {} as any,
    };

    const res = await request(createApp(actor))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: DOCUMENTED_AGENT_DEFAULT });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // `code` + `remediation` are the two detail fields the shared error handler
    // forwards for any denial, so the refusal survives to the caller without
    // widening that allowlist. An opaque 409 here is what turns a legible
    // refusal into a retry loop.
    expect(res.body).toMatchObject({
      error: "Issue checkout conflict",
      code: "in_review_not_claimable",
    });
    expect(res.body.remediation).toContain("review-path disposition");
    expect(res.body.remediation).toContain("PATCH the status");
    expect(await readRow(issueId)).toEqual({
      status: "in_review",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("refuses even when in_review is the only status the caller named", async () => {
    // The all-filtered case must still be a conflict on the issue, not a
    // malformed-request error: the caller named a real status and the refusal
    // is about authority, not about the shape of the request. The row *is*
    // in_review here, so the specific refusal and its remediation are the
    // honest answer.
    const { companyId, agentId, issueId, runId } = await seed("in_review");

    const error = await svc
      .checkout(issueId, agentId, ["in_review"], runId)
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error).toMatchObject({
      status: 409,
      message: "Issue checkout conflict",
      details: expect.objectContaining({ code: "in_review_not_claimable" }),
    });
    expect(await readRow(issueId)).toMatchObject({
      status: "in_review",
      checkoutRunId: null,
      executionRunId: null,
    });
    expect(companyId).toBeTruthy();
  });

  it("does not claim in_review_not_claimable when the row is not in_review", async () => {
    // Naming `in_review` as the only expected status says nothing about the
    // row, and the guard that empties the list runs before the row is read. So
    // against a `todo`, unassigned, unlocked issue -- a perfectly claimable one
    // that pre-#143 this request claimed -- the refusal used to be built from
    // the request and claim a review disposition the issue does not have, then
    // advise the caller to PATCH a task that is not parked. The conflict has to
    // answer from the row instead.
    const { agentId, issueId, runId } = await seed("todo");

    const error = await svc
      .checkout(issueId, agentId, ["in_review"], runId)
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error).toMatchObject({
      status: 409,
      message: "Issue checkout conflict",
    });
    // Reports the row, not the request.
    expect((error as { details?: { status?: string } }).details).toMatchObject({
      issueId,
      status: "todo",
    });
    expect((error as { details?: { code?: string } }).details?.code).toBeUndefined();
    expect((error as { details?: { remediation?: string } }).details?.remediation)
      .toBeUndefined();
    expect(await readRow(issueId)).toMatchObject({
      status: "todo",
      checkoutRunId: null,
      executionRunId: null,
    });
    expect(agentId).toBeTruthy();
  });

  it("keeps the specific refusal when the named list holds a claimable status too", async () => {
    // The wart above is narrow: it needs `in_review` as the *sole* named
    // status. With anything else in the list the update is well-formed, so this
    // already behaved correctly -- the control for the test above, so a future
    // change cannot make the guard fire on the documented default either.
    const { agentId, issueId, runId } = await seed("in_review");

    const error = await svc
      .checkout(issueId, agentId, DOCUMENTED_AGENT_DEFAULT, runId)
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error).toMatchObject({
      status: 409,
      details: expect.objectContaining({ code: "in_review_not_claimable" }),
    });
    expect(agentId).toBeTruthy();
  });

  it("tells a bound or human caller to PATCH and an unbound agent to use the review path", async () => {
    // The PATCH is only reachable for a board member or a run already working
    // on this issue. For an agent that is not bound to it, the PATCH is a
    // cross-issue write -- and the 403 that stops it also rules out binding the
    // run to the issue instead, because claiming moves it to in_progress. So a
    // single unconditional "PATCH it" is advice with no route behind it, and
    // the refusal names both routes by who can follow them.
    const { agentId, issueId, runId } = await seed("in_review");

    const error = await svc
      .checkout(issueId, agentId, ["in_review"], runId)
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    const remediation = (error as { details?: { remediation?: string } }).details
      ?.remediation ?? "";

    expect(remediation).toContain("review-path disposition");
    expect(remediation).toContain("PATCH the status to in_progress");
    // The PATCH route is scoped to who can actually make the call.
    expect(remediation).toContain("board action");
    expect(remediation).toContain("already working on");
    // And the unbound-agent route is the review path, not a state change.
    expect(remediation).toContain("cross-issue");
    expect(remediation).toContain("review artifact resolved");
    // The refusal must not tell the run to claim its way in; that is the
    // sibling copy's explicit "do not bind this run to another task".
    expect(remediation).not.toMatch(/check\s?out (the|this) issue/i);
    expect(agentId).toBeTruthy();
  });

  it("still crosses the edge for a server-derived authorization", async () => {
    // The heartbeat service legitimately needs this: a resolved interaction
    // means the review state really is over, and it must be able to take
    // execution in the same guarded update
    // (resolvedInteractionCheckoutExpectedStatuses). Only the authorization is
    // new -- the transition itself is unchanged.
    const { agentId, issueId, runId } = await seed("in_review");

    const checkedOut = await svc.checkout(
      issueId,
      agentId,
      ["in_progress", "in_review"],
      runId,
      { inReviewResumeAuthorized: true },
    );

    expect(checkedOut).toMatchObject({ status: "in_progress", checkoutRunId: runId });
    expect(await readRow(issueId)).toMatchObject({
      status: "in_progress",
      checkoutRunId: runId,
      executionRunId: runId,
    });
  });

  it("leaves the ordinary work-start transitions alone", async () => {
    // The guard is scoped to the in_review edge. If it ever widened to refuse
    // todo/backlog/blocked it would break the main claim path and the
    // heartbeat auto-checkout, which uses exactly ["todo","backlog","blocked"].
    for (const status of ["todo"] as const) {
      const { agentId, issueId, runId } = await seed(status);
      const checkedOut = await svc.checkout(
        issueId,
        agentId,
        DOCUMENTED_AGENT_DEFAULT,
        runId,
      );
      expect(checkedOut, `status ${status}`).toMatchObject({
        status: "in_progress",
        checkoutRunId: runId,
      });
    }
  });

  it("does not let the authorization widen the claim to statuses the caller did not name", async () => {
    // The flag authorizes the in_review edge; it must not turn
    // expectedStatuses into a wildcard. A caller that named only in_review and
    // is authorized still cannot take a todo issue it did not ask for.
    const { agentId, issueId, runId } = await seed("todo");

    await expect(
      svc.checkout(issueId, agentId, ["in_review"], runId, {
        inReviewResumeAuthorized: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readRow(issueId)).toMatchObject({ status: "todo", checkoutRunId: null });
  });
});
