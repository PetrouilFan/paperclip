import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blockedByIssueIds read tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
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

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(
  company: CompanyRow,
  agent: AgentRow,
  runId: string,
): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId,
    source: "agent_jwt",
  };
}

async function seedAgent(db: Db, companyId: string) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning();
  return agent!;
}

async function seedCompany(db: Db, label = "BlockedBy") {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `BB${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedProject(db: Db, companyId: string, name: string) {
  const [project] = await db.insert(projects).values({
    companyId,
    name,
    status: "in_progress",
  }).returning();
  return project!;
}

async function seedIssue(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    title: string;
    status?: string;
  },
) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    parentId: null,
    title: input.title,
    status: input.status ?? "todo",
    priority: "medium",
    responsibleUserId: "board-user",
  }).returning();
  return issue!;
}

async function blockIssue(
  db: Db,
  companyId: string,
  blockerIssueId: string,
  blockedIssueId: string,
) {
  await db.insert(issueRelations).values({
    companyId,
    issueId: blockerIssueId,
    relatedIssueId: blockedIssueId,
    type: "blocks",
  });
}

function issueRow(body: any[], id: string) {
  const row = body.find((entry) => entry.id === id);
  if (!row) throw new Error(`issue ${id} missing from response`);
  return row;
}

/** The `changes` payload the issue.updated activity entry was written with. */
async function issueUpdateChange(db: Db, entityId: string, key: string) {
  const entry = await db.query.activityLog.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.entityId, entityId),
        eq(table.action, "issue.updated"),
        sql`${table.details} -> 'changes' -> ${key} IS NOT NULL`,
      ),
  });
  const changes = (entry?.details as { changes?: Record<string, any> } | undefined)?.changes;
  return changes?.[key];
}

describeEmbeddedPostgres("blockedByIssueIds is readable", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocked-by-readable-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns the blocker ids on a single blocked issue read", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const blocked = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Waiting on the migration",
      status: "blocked",
    });
    const blocker = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Migration",
      status: "in_review",
    });
    await blockIssue(db, company.id, blocker.id, blocked.id);

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${blocked.id}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // A blocked issue with a real first-class blocker must not read `null`
    // here, or every self-audit reads "no blocker" for every ticket.
    expect(res.body.blockedByIssueIds).toEqual([blocker.id]);
    expect(
      (res.body.blockedBy as Array<{ id: string }>).map((relation) => relation.id),
    ).toEqual(res.body.blockedByIssueIds);
  });

  it("returns an empty array, never null, for an issue with no blockers", async () => {
    const company = await seedCompany(db);
    const unblocked = await seedIssue(db, {
      companyId: company.id,
      title: "Nothing in the way",
      status: "todo",
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${unblocked.id}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockedByIssueIds).toEqual([]);
  });

  it("returns blocker ids on the issue list without an opt-in query flag", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const blocked = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Staleness sweep subject",
      status: "blocked",
    });
    const blocker = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Real blocker",
      status: "in_review",
    });
    const other = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Blocked with no first-class blocker",
      status: "blocked",
    });
    await blockIssue(db, company.id, blocker.id, blocked.id);

    const app = createApp(db, boardActor(company));

    // The exact call the staleness sweep makes: no `includeBlockedBy`.
    const full = await request(app)
      .get(`/api/companies/${company.id}/issues`)
      .query({ status: "blocked" });

    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(issueRow(full.body, blocked.id).blockedByIssueIds).toEqual([blocker.id]);
    expect(issueRow(full.body, other.id).blockedByIssueIds).toEqual([]);

    const compact = await request(app)
      .get(`/api/companies/${company.id}/issues`)
      .query({ status: "blocked", view: "compact" });

    expect(compact.status, JSON.stringify(compact.body)).toBe(200);
    expect(issueRow(compact.body, blocked.id).blockedByIssueIds).toEqual([blocker.id]);
    expect(issueRow(compact.body, other.id).blockedByIssueIds).toEqual([]);

    // The opt-in summary field is unchanged: the ids are cheap, the summaries
    // are not, so only `blockedBy` stays behind the flag.
    expect(issueRow(full.body, blocked.id).blockedBy).toBeUndefined();
    const withSummaries = await request(app)
      .get(`/api/companies/${company.id}/issues`)
      .query({ status: "blocked", includeBlockedBy: "true" });
    expect(withSummaries.status, JSON.stringify(withSummaries.body)).toBe(200);
    const summarized = issueRow(withSummaries.body, blocked.id);
    expect(
      (summarized.blockedBy as Array<{ id: string }>).map((relation) => relation.id),
    ).toEqual(summarized.blockedByIssueIds);
  });

  it("keeps every blocker's id on a multi-blocker issue", async () => {
    const company = await seedCompany(db);
    const blocked = await seedIssue(db, {
      companyId: company.id,
      title: "Waiting on two things",
      status: "blocked",
    });
    const first = await seedIssue(db, { companyId: company.id, title: "A blocker", status: "todo" });
    const second = await seedIssue(db, { companyId: company.id, title: "B blocker", status: "todo" });
    await blockIssue(db, company.id, first.id, blocked.id);
    await blockIssue(db, company.id, second.id, blocked.id);

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${blocked.id}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect([...res.body.blockedByIssueIds].sort()).toEqual([first.id, second.id].sort());
  });

  it("scopes the ids to the issue's own company", async () => {
    const company = await seedCompany(db, "Own");
    const other = await seedCompany(db, "Other");
    const blocked = await seedIssue(db, { companyId: company.id, title: "Waiting", status: "blocked" });
    const ownBlocker = await seedIssue(db, { companyId: company.id, title: "Ours", status: "todo" });
    const otherBlocker = await seedIssue(db, { companyId: other.id, title: "Theirs", status: "todo" });
    await blockIssue(db, company.id, ownBlocker.id, blocked.id);
    await blockIssue(db, other.id, otherBlocker.id, otherBlocker.id);

    const app = createApp(db, boardActor(company));

    const read = await request(app).get(`/api/issues/${blocked.id}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.blockedByIssueIds).toEqual([ownBlocker.id]);

    const list = await request(app).get(`/api/companies/${company.id}/issues`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const listed = issueRow(list.body, blocked.id);
    expect(listed.blockedByIssueIds).toEqual([ownBlocker.id]);
    // A cross-company blocker id must not reach another company's list body.
    expect(JSON.stringify(list.body)).not.toContain(otherBlocker.id);
  });

  it("agrees with the PATCH write path: the echo and the next read are the same set", async () => {
    const company = await seedCompany(db);
    const blocked = await seedIssue(db, { companyId: company.id, title: "Waiting", status: "blocked" });
    const first = await seedIssue(db, { companyId: company.id, title: "Alpha", status: "todo" });
    const second = await seedIssue(db, { companyId: company.id, title: "Beta", status: "todo" });
    const app = createApp(db, boardActor(company));

    const patched = await request(app)
      .patch(`/api/issues/${blocked.id}`)
      .send({ blockedByIssueIds: [second.id, first.id, second.id] });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect([...patched.body.blockedByIssueIds].sort()).toEqual([first.id, second.id].sort());

    const read = await request(app).get(`/api/issues/${blocked.id}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect([...read.body.blockedByIssueIds].sort()).toEqual([first.id, second.id].sort());
    expect(read.body.blockedByIssueIds).toEqual(patched.body.blockedByIssueIds);

    const cleared = await request(app)
      .patch(`/api/issues/${blocked.id}`)
      .send({ blockedByIssueIds: [] });

    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.blockedByIssueIds).toEqual([]);

    const afterClear = await request(app).get(`/api/issues/${blocked.id}`);
    expect(afterClear.status, JSON.stringify(afterClear.body)).toBe(200);
    expect(afterClear.body.blockedByIssueIds).toEqual([]);
  });

  it("reflects blockers created through POST, not just the PATCH write path", async () => {
    const company = await seedCompany(db);
    const blocker = await seedIssue(db, { companyId: company.id, title: "Up front", status: "todo" });
    const app = createApp(db, boardActor(company));

    const created = await request(app)
      .post(`/api/companies/${company.id}/issues`)
      .send({ title: "Created blocked", status: "blocked", blockedByIssueIds: [blocker.id] });

    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const read = await request(app).get(`/api/issues/${created.body.id}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.blockedByIssueIds).toEqual([blocker.id]);

    const list = await request(app)
      .get(`/api/companies/${company.id}/issues`)
      .query({ status: "blocked" });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(issueRow(list.body, created.body.id).blockedByIssueIds).toEqual([blocker.id]);
  });

  it("records the blockers it set in the audit log, not an empty set", async () => {
    const company = await seedCompany(db);
    const blocked = await seedIssue(db, { companyId: company.id, title: "Waiting", status: "blocked" });
    const first = await seedIssue(db, { companyId: company.id, title: "Alpha", status: "todo" });
    const second = await seedIssue(db, { companyId: company.id, title: "Beta", status: "todo" });
    const app = createApp(db, boardActor(company));

    // The route echoes the committed relations, so the response body is right
    // even when the receipt underneath it is wrong. The receipt is what the
    // activity log persists, so assert on that: an audit trail that says every
    // blocker was removed whenever any was added is worse than no trail.
    const patched = await request(app)
      .patch(`/api/issues/${blocked.id}`)
      .send({ blockedByIssueIds: [first.id, second.id] });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.blockedByIssueIds).toEqual([first.id, second.id].sort());

    const change = await issueUpdateChange(db, blocked.id, "blockedByIssueIds");
    expect(change, "no issue.updated receipt recorded blockedByIssueIds").toBeDefined();
    expect(change.to).toEqual([first.id, second.id].sort());
  });

  it("tells an agent why its own close is refused, from the read field alone", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const blocked = await seedIssue(db, {
      companyId: company.id,
      title: "Waiting",
      status: "blocked",
      assigneeAgentId: agent.id,
    });
    const blocker = await seedIssue(db, { companyId: company.id, title: "Still open", status: "todo" });
    await blockIssue(db, company.id, blocker.id, blocked.id);
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "running",
      contextSnapshot: { issueId: blocked.id },
    }).returning();
    await db
      .update(issues)
      .set({ checkoutRunId: run!.id, executionRunId: run!.id })
      .where(eq(issues.id, blocked.id));
    const app = createApp(db, agentActor(company, agent, run!.id));

    // A staleness sweep once prescribed this close for an issue that had a
    // legitimate blocker. It cannot execute, and the only reason the sweep had
    // to guess is that the read said `null`.
    const refused = await request(app)
      .patch(`/api/issues/${blocked.id}`)
      .send({ status: "done" });

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.details.unresolvedBlockerIssueIds).toEqual([blocker.id]);

    // The read names the same blocker, so the refusal is self-explaining.
    const read = await request(app).get(`/api/issues/${blocked.id}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.blockedByIssueIds).toEqual([blocker.id]);
  });
});
