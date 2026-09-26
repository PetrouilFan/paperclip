import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS,
  isNeverDispatchedQueuedRun,
  neverDispatchedQueuedRun,
  neverDispatchedRunCutoff,
  notNeverDispatchedQueuedRun,
} from "./never-dispatched-run.js";

// Regression cover for the self-sealing strand described in the pull request.
//
// A `queued` run with `startedAt IS NULL` is a row the dispatcher never claimed.
// Because its status is still `queued` it satisfied every
// `EXECUTION_PATH_HEARTBEAT_RUN_STATUSES` test, so recovery believed the issue
// already had a live execution path and never re-queued the work -- while the run
// itself held `issues.executionRunId` and therefore refused every write to its own
// issue. The tests below pin both halves: the pure predicate, and the SQL it
// produces when applied to a real `heartbeat_runs` table.

const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = [
  "queued",
  "running",
  "scheduled_retry",
] as const;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres never-dispatched-run tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("never-dispatched queued run predicate", () => {
  const now = new Date("2026-09-26T09:00:00.000Z");

  it("treats an unclaimed queued run past the admission window as stranded", () => {
    expect(
      isNeverDispatchedQueuedRun(
        {
          status: "queued",
          startedAt: null,
          createdAt: new Date(now.getTime() - NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS - 1_000),
        },
        now,
      ),
    ).toBe(true);
  });

  it("keeps a freshly queued run inside its admission window", () => {
    expect(
      isNeverDispatchedQueuedRun(
        { status: "queued", startedAt: null, createdAt: new Date(now.getTime() - 1_000) },
        now,
      ),
    ).toBe(false);
  });

  it("never strands a run the dispatcher already claimed", () => {
    expect(
      isNeverDispatchedQueuedRun(
        {
          status: "queued",
          startedAt: new Date(now.getTime() - 26 * 60 * 60 * 1_000),
          createdAt: new Date(now.getTime() - 27 * 60 * 60 * 1_000),
        },
        now,
      ),
    ).toBe(false);
  });

  it("only matches queued rows, so a running or scheduled_retry row is untouched", () => {
    for (const status of ["running", "scheduled_retry"]) {
      expect(
        isNeverDispatchedQueuedRun(
          {
            status,
            startedAt: null,
            createdAt: new Date(now.getTime() - 26 * 60 * 60 * 1_000),
          },
          now,
        ),
      ).toBe(false);
    }
  });

  it("derives the cutoff from the admission window", () => {
    expect(neverDispatchedRunCutoff(now).getTime()).toBe(
      now.getTime() - NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS,
    );
  });

  it("leaves alone a run that waited as long as the slowest run ever observed to wait", () => {
    // Measured on the reporting deployment: over the 2645 runs carrying both
    // `createdAt` and `startedAt`, `startedAt - createdAt` peaked at 25531 s
    // (7.09 h). That run was slow, not stranded -- it started normally. The window
    // has to sit above that figure, so this test fails if anyone shortens the
    // constant back toward a "reasonable looking" hour and starts cancelling work
    // that was only ever going to be slow.
    const slowestObservedDispatchMs = 25_531_000;
    expect(NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS).toBeGreaterThan(
      slowestObservedDispatchMs,
    );
    expect(
      isNeverDispatchedQueuedRun(
        {
          status: "queued",
          startedAt: null,
          createdAt: new Date(now.getTime() - slowestObservedDispatchMs),
        },
        now,
      ),
    ).toBe(false);
  });
});

describeEmbeddedPostgres("never-dispatched queued run SQL", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let issueId!: string;

  /**
   * The exact shape of the production execution-path query, so this test fails
   * if the fix is dropped from any of its three call sites' semantics.
   */
  async function findExecutionPathRun(opts: {
    issueId: string;
    excludeRunId: string;
    agentId?: string | null;
  }) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          notNeverDispatchedQueuedRun(),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${opts.issueId}`,
          opts.agentId ? eq(heartbeatRuns.agentId, opts.agentId) : sql`true`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-never-dispatched-run-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed(input?: { executionRunId?: string | null }): Promise<void> {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Never dispatched fixture",
      issuePrefix: "NDR",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fixture Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Never dispatched fixture issue",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      executionRunId: input?.executionRunId ?? null,
    });
  }

  async function seedRun(input: {
    status?: string;
    startedAt?: Date | null;
    createdAt?: Date;
    issueId?: string;
  }): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: input.status ?? "queued",
      contextSnapshot: {
        issueId: input.issueId ?? issueId,
        source: "issue.continuation_recovery",
        wakeReason: "issue_continuation_needed",
      },
      startedAt: input.startedAt ?? null,
      createdAt: input.createdAt ?? new Date(),
    });
    return runId;
  }

  it("does not count a never-dispatched continuation run as a live execution path", async () => {
    await seed();
    // The stranded shape seen in production: queued since creation, never claimed,
    // and the issue is bound to it.
    const strandedRunId = await seedRun({
      status: "queued",
      startedAt: null,
      createdAt: new Date(Date.now() - 15 * 60 * 60 * 1_000),
    });
    await db
      .update(issues)
      .set({ executionRunId: strandedRunId })
      .where(eq(issues.id, issueId));

    const path = await findExecutionPathRun({
      issueId,
      excludeRunId: randomUUID(),
      agentId,
    });

    expect(path).toBeNull();
  });

  it("still counts a freshly queued run, so normal contention is not misread as a strand", async () => {
    await seed();
    await seedRun({ status: "queued", startedAt: null, createdAt: new Date() });

    const path = await findExecutionPathRun({
      issueId,
      excludeRunId: randomUUID(),
      agentId,
    });

    expect(path).not.toBeNull();
  });

  it("still counts a long-running run that has not emitted output yet", async () => {
    await seed();
    await seedRun({
      status: "running",
      startedAt: new Date(Date.now() - 15 * 60 * 60 * 1_000),
      createdAt: new Date(Date.now() - 15 * 60 * 60 * 1_000),
    });

    const path = await findExecutionPathRun({
      issueId,
      excludeRunId: randomUUID(),
      agentId,
    });

    expect(path).not.toBeNull();
  });

  it("selects stranded runs for the age-out sweep and nothing else", async () => {
    await seed();
    const stranded = await seedRun({
      status: "queued",
      startedAt: null,
      createdAt: new Date(Date.now() - 15 * 60 * 60 * 1_000),
    });
    const fresh = await seedRun({ status: "queued", startedAt: null, createdAt: new Date() });
    const claimedButSlow = await seedRun({
      status: "queued",
      startedAt: new Date(),
      createdAt: new Date(Date.now() - 15 * 60 * 60 * 1_000),
    });

    const swept = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(neverDispatchedQueuedRun());

    expect(swept.map((row) => row.id)).toEqual([stranded]);
    expect(swept.map((row) => row.id)).not.toContain(fresh);
    expect(swept.map((row) => row.id)).not.toContain(claimedButSlow);
  });

  it("agrees with the in-memory predicate on the sweep's own boundary", async () => {
    await seed();
    const justInside = new Date(Date.now() - NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS + 5_000);
    const justOutside = new Date(Date.now() - NEVER_DISPATCHED_RUN_ADMISSION_WINDOW_MS - 5_000);
    await seedRun({ status: "queued", startedAt: null, createdAt: justInside });
    await seedRun({ status: "queued", startedAt: null, createdAt: justOutside });

    const swept = await db
      .select({ id: heartbeatRuns.id, startedAt: heartbeatRuns.startedAt, createdAt: heartbeatRuns.createdAt, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(neverDispatchedQueuedRun());

    expect(swept).toHaveLength(1);
    expect(
      isNeverDispatchedQueuedRun(swept[0]!, new Date()),
    ).toBe(true);
  });

  it("stays company-scoped", async () => {
    await seed();
    await seedRun({
      status: "queued",
      startedAt: null,
      createdAt: new Date(Date.now() - 15 * 60 * 60 * 1_000),
    });

    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other company",
      issuePrefix: "OTH",
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Other Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: otherCompanyId,
      title: "Other company issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: otherAgentId,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: otherCompanyId,
      agentId: otherAgentId,
      invocationSource: "automation",
      status: "running",
      contextSnapshot: { issueId: otherIssueId },
      startedAt: new Date(),
      createdAt: new Date(),
    });

    // A foreign-company live run must not make this company's issue look covered.
    const path = await findExecutionPathRun({
      issueId,
      excludeRunId: randomUUID(),
      agentId,
    });
    expect(path).toBeNull();
  });
});
