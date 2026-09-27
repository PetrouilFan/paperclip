import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { activityService } from "../services/activity.js";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";

/**
 * `GET /api/heartbeat-runs/{runId}/issues` and the cross-issue influence guard
 * must answer "is this run bound to anything?" the same way.
 *
 * They used to read different sources, and an agent that read the endpoint
 * before writing got a wrong answer in both directions: an issue the run had
 * only *touched* looked bound, and an issue the run had *checked out* but never
 * written to did not appear at all. A run reporting one way and being refused
 * the other is the `cross_issue_influence_run_context_required` report this
 * suite pins shut.
 *
 * These run against real PostgreSQL because the whole point is that both
 * callers run the same SQL predicates over the same rows.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("run binding is one source for the guard and the read endpoint", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const prefix = `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

  /** The bound issue, the one written to elsewhere, and one it only touched. */
  const boundIssueId = randomUUID();
  const targetIssueId = randomUUID();
  const touchedOnlyIssueId = randomUUID();
  const unboundIssueId = randomUUID();
  const watchHostIssueId = randomUUID();

  let identifierSeq = 0;
  const nextIdentifier = () => `${prefix}-${++identifierSeq}`;

  const newRunId = () => randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-binding-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeAll(async () => {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Binding Coder", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: otherAgentId, companyId, name: "Someone Else", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const insertRun = (runId: string, contextSnapshot: unknown, status = "running") =>
    db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status,
      responsibleUserId: "board-user",
      contextSnapshot: contextSnapshot as Record<string, unknown>,
    });

  /** An `activity_log` row, which is what the read endpoint used to treat as a binding. */
  const touchIssue = (runId: string, issueId: string) =>
    db.insert(activityLog).values({
      companyId,
      actorType: "agent" as const,
      actorId: agentId,
      agentId,
      runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });

  const rowsFor = async (runId: string) => {
    const rows = await activityService(db).issuesForRun(runId);
    return new Map(rows.map((row) => [row.issueId, row.binding]));
  };

  const decide = (runId: string, issueId: string) =>
    observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: issueId,
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    });

  const observedSourceFor = async (runId: string, issueId: string) => {
    const rows = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.runId, runId),
        eq(activityLog.action, "issue.cross_issue_influence_observed"),
      ));
    const row = rows.find((entry) => (entry.details as { targetIssueId?: string } | null)?.targetIssueId === issueId);
    return (row?.details as { sourceIssueId?: string } | undefined)?.sourceIssueId ?? null;
  };

  beforeEach(async () => {
    await db.insert(issues).values([
      { id: boundIssueId, companyId, title: "Checked out", identifier: nextIdentifier(), status: "in_progress" },
      { id: targetIssueId, companyId, title: "Written to elsewhere", identifier: nextIdentifier(), status: "todo" },
      { id: touchedOnlyIssueId, companyId, title: "Only ever touched", identifier: nextIdentifier(), status: "todo" },
      { id: unboundIssueId, companyId, title: "Bound to nothing", identifier: nextIdentifier(), status: "todo", assigneeAgentId: otherAgentId },
      { id: watchHostIssueId, companyId, title: "Standing watch host", identifier: nextIdentifier(), status: "in_progress", assigneeAgentId: agentId },
    ]);
  });

  afterEach(async () => {
    await db.delete(issues);
  });

  it("names the checkout binding the guard charges the write to", async () => {
    const runId = newRunId();
    await insertRun(runId, {});
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, boundIssueId));

    // Read before the write: the guard records its own `activity_log` row for
    // every metered attempt, which legitimately shows the target as touched.
    expect(await rowsFor(runId)).toEqual(new Map([[boundIssueId, "checkout"]]));

    // The reported failure, reproduced: a context-less run holding a checkout,
    // writing to an issue it does not hold.
    const decision = await decide(runId, targetIssueId);
    expect(decision).toMatchObject({ allowed: true, count: 1 });
    // Metered against the bound issue, not accepted for free.
    expect(await observedSourceFor(runId, targetIssueId)).toBe(boundIssueId);

    // The target now shows as touched-but-not-bound, which is the honest reading:
    // the run paid for it out of the bound issue's budget.
    const rows = await rowsFor(runId);
    expect(rows.get(targetIssueId)).toBeNull();
    expect(rows.get(boundIssueId)).toBe("checkout");
  });

  it("does not report a touched issue as a binding", async () => {
    const runId = newRunId();
    await insertRun(runId, {});
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, boundIssueId));
    await touchIssue(runId, touchedOnlyIssueId);

    const rows = await rowsFor(runId);
    // Present, because the run touched it...
    expect(rows.has(touchedOnlyIssueId)).toBe(true);
    // ...but not claimed as a binding, which is what let the endpoint read as
    // proof of attribution for an issue the guard was about to refuse.
    expect(rows.get(touchedOnlyIssueId)).toBeNull();
    expect(rows.get(boundIssueId)).toBe("checkout");
  });

  it("keeps a run that only ever touched an issue unbound, in both places", async () => {
    const runId = newRunId();
    await insertRun(runId, {});
    await touchIssue(runId, touchedOnlyIssueId);

    // The guard still fails closed — making the endpoint honest must not widen
    // what the guard honours.
    await expect(decide(runId, unboundIssueId)).rejects.toMatchObject({
      status: 403,
      details: { reason: "no_context_source_and_target_unbound" },
    });
    expect(await rowsFor(runId)).toEqual(new Map([[touchedOnlyIssueId, null]]));
  });

  it("reports a checkout the run never wrote to", async () => {
    const runId = newRunId();
    await insertRun(runId, {});
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, boundIssueId));

    // No activity row anywhere: the old endpoint returned [] here, so a run that
    // checked an issue out and then produced nothing looked bound to nothing.
    expect(await rowsFor(runId)).toEqual(new Map([[boundIssueId, "checkout"]]));
    await expect(decide(runId, targetIssueId)).resolves.toMatchObject({ allowed: true });
  });

  it("reports the context source and ignores a checkout on a context-ful run", async () => {
    const runId = newRunId();
    await insertRun(runId, { issueId: targetIssueId });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, boundIssueId));

    // Master semantics: a run that already has a source keeps it, and a mutable
    // checkout stamp cannot displace it. The endpoint must report the same
    // single source, or it advertises a binding the guard will not charge to.
    expect(await rowsFor(runId)).toEqual(new Map([[targetIssueId, "context"]]));
    await expect(decide(runId, unboundIssueId)).resolves.toMatchObject({ allowed: true });
    expect(await observedSourceFor(runId, unboundIssueId)).toBe(targetIssueId);
  });

  it("reports a standing-watch host as a binding", async () => {
    const runId = newRunId();
    await insertRun(runId, { standingWatchIssueId: watchHostIssueId });

    expect(await rowsFor(runId)).toEqual(new Map([[watchHostIssueId, "standing_watch"]]));
    // A watch's job is writing to issues it does not own, so the target is
    // charged to the host rather than refused.
    const decision = await decide(runId, unboundIssueId);
    expect(decision).toMatchObject({ allowed: true });
    expect(await observedSourceFor(runId, unboundIssueId)).toBe(watchHostIssueId);
  });

  it("reports no binding for a terminal run holding a stale stamp", async () => {
    const runId = newRunId();
    await insertRun(runId, {}, "succeeded");
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, boundIssueId));
    await touchIssue(runId, boundIssueId);

    // The stamp lingers on the row after the run finished. It is not a binding,
    // and the endpoint must not resurrect it as one.
    expect(await rowsFor(runId)).toEqual(new Map([[boundIssueId, null]]));
    await expect(decide(runId, unboundIssueId)).rejects.toMatchObject({
      status: 403,
      details: { reason: "terminal_status" },
    });
  });
});
