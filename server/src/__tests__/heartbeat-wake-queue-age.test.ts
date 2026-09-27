import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Wake queue age test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake queue age tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Snapshot = Record<string, unknown>;

function readQueueAge(snapshot: Snapshot | null | undefined) {
  const value = (snapshot as { wakeQueueAge?: unknown } | null | undefined)?.wakeQueueAge;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readTriggerQueueAge(snapshot: Snapshot | null | undefined) {
  const continuation = (snapshot as { executionContinuation?: unknown } | null | undefined)
    ?.executionContinuation;
  const trigger = (continuation as { trigger?: unknown } | null | undefined)?.trigger;
  const value = (trigger as { queueAge?: unknown } | null | undefined)?.queueAge;
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

describeEmbeddedPostgres("heartbeat wake queue age", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-wake-queue-age-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    // One slot, so a lower-priority older run is passed over whenever a
    // higher-priority fresher run is waiting: the strand this issue measured.
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(input: {
    companyId: string;
    agentId: string;
    title: string;
    priority: string;
    /** How long before now the issue last changed. Drives `issueStaleSeconds`. */
    updatedSecondsAgo: number;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      status: "todo",
      priority: input.priority,
      assigneeAgentId: input.agentId,
      responsibleUserId: "responsible-user",
      updatedAt: new Date(Date.now() - input.updatedSecondsAgo * 1000),
    });
    return issueId;
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    /** How long before now the run entered the dispatch queue. */
    createdSecondsAgo: number;
    dispatchSkipCount?: number;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      responsibleUserId: "responsible-user",
      createdAt: new Date(Date.now() - input.createdSecondsAgo * 1000),
      dispatchSkipCount: input.dispatchSkipCount ?? 0,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  async function runRow(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => (rows[0] ?? null) as null | (typeof heartbeatRuns.$inferSelect & { contextSnapshot: Snapshot | null }));
  }

  it("records the strand on the run that stayed queued while a fresher run took the slot", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const staleIssueId = await seedIssue({
      companyId, agentId, title: "Stale low-priority probe", priority: "low", updatedSecondsAgo: 6_300,
    });
    const freshIssueId = await seedIssue({
      companyId, agentId, title: "Fresher critical work", priority: "critical", updatedSecondsAgo: 30,
    });
    // 7h00m16s, the wait this scenario is modelled on.
    const staleRunId = await seedQueuedRun({
      companyId, agentId, issueId: staleIssueId, createdSecondsAgo: 25_216,
    });
    const freshRunId = await seedQueuedRun({
      companyId, agentId, issueId: freshIssueId, createdSecondsAgo: 60,
    });

    await heartbeat.resumeQueuedRuns();

    const stale = await runRow(staleRunId);
    const fresh = await runRow(freshRunId);
    // The urgent run took the only slot; the older low-priority run waited.
    expect(fresh?.status).not.toBe("queued");
    expect(stale?.status).toBe("queued");
    expect(stale?.dispatchSkipCount).toBe(1);
    // The run that was actually dispatched is not a skip.
    expect(fresh?.dispatchSkipCount).toBe(0);
  });

  it("accumulates one skip per dispatch decision that passed the run over", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const staleIssueId = await seedIssue({
      companyId, agentId, title: "Stranded probe", priority: "low", updatedSecondsAgo: 6_300,
    });
    const staleRunId = await seedQueuedRun({
      companyId, agentId, issueId: staleIssueId, createdSecondsAgo: 25_216, dispatchSkipCount: 16,
    });
    // Nothing fresher is waiting, so a sweep must not manufacture a skip: the
    // counter is dispatch history, not a wait clock.
    await heartbeat.resumeQueuedRuns();
    expect((await runRow(staleRunId))?.dispatchSkipCount).toBe(16);
  });

  it("stamps the wait, the skip count, and the issue's staleness onto the woken run", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const issueId = await seedIssue({
      companyId, agentId, title: "Stale assignment", priority: "critical", updatedSecondsAgo: 23_100,
    });
    const runId = await seedQueuedRun({
      companyId, agentId, issueId, createdSecondsAgo: 25_216, dispatchSkipCount: 17,
    });

    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const run = await runRow(runId);
    expect(run?.status).toBe("succeeded");

    const queueAge = readQueueAge(run?.contextSnapshot);
    expect(queueAge).not.toBeNull();
    expect(queueAge?.skippedByDispatchCount).toBe(17);
    expect(queueAge?.enqueuedAt).toBe(run?.createdAt?.toISOString());
    expect(queueAge?.startedAt).toBe(run?.startedAt?.toISOString());
    // The wait this run experienced, from the run row itself.
    const waitSeconds = Math.round(
      ((run?.startedAt?.getTime() ?? 0) - (run?.createdAt?.getTime() ?? 0)) / 1000,
    );
    expect(waitSeconds).toBeGreaterThan(25_000);
    expect(queueAge?.queueAgeSeconds).toBe(waitSeconds);
    // The bound issue had been untouched for 6h25m when the run started. It is
    // the pre-claim `issues.updatedAt`: the claim's own execution binding stamps
    // that column, so a dispatch-time read would always report zero staleness.
    const issueUpdatedAtMs = Date.parse(String(queueAge?.issueUpdatedAt));
    expect(Number.isFinite(issueUpdatedAtMs)).toBe(true);
    const secondsSinceIssueTouched = (Date.now() - issueUpdatedAtMs) / 1000;
    expect(secondsSinceIssueTouched).toBeGreaterThan(23_000);
    expect(secondsSinceIssueTouched).toBeLessThan(23_200);

    // The same answer reaches the continuation trigger, so the wake contract a
    // woken agent reads answers the question without an extra read.
    const triggerQueueAge = readTriggerQueueAge(run?.contextSnapshot);
    expect(triggerQueueAge).toMatchObject({
      enqueuedAt: queueAge?.enqueuedAt,
      startedAt: queueAge?.startedAt,
      queueAgeSeconds: queueAge?.queueAgeSeconds,
      skippedByDispatchCount: 17,
    });
  });

  it("carries the queue age into the rendered wake payload an agent receives", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const issueId = await seedIssue({
      companyId, agentId, title: "Stale payload probe", priority: "critical", updatedSecondsAgo: 23_100,
    });
    const runId = await seedQueuedRun({
      companyId, agentId, issueId, createdSecondsAgo: 25_216, dispatchSkipCount: 17,
    });

    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const run = await runRow(runId);
    const wake = (run?.contextSnapshot as { paperclipWake?: unknown } | null)?.paperclipWake as
      | { queueAge?: Record<string, unknown>; reason?: string }
      | undefined;
    expect(wake?.reason).toBe("issue_assigned");
    expect(wake?.queueAge).toMatchObject({
      skippedByDispatchCount: 17,
      queueAgeSeconds: readQueueAge(run?.contextSnapshot)?.queueAgeSeconds,
    });
    // The issue's own staleness is derived on read, from the pre-claim
    // `issues.updatedAt` the claim captured. The claim's execution binding stamps
    // that column moments later, so a read taken after the claim would always
    // report zero. The bound issue was untouched for 6h25m when this woke.
    expect(Number(wake?.queueAge?.issueStaleSeconds)).toBeGreaterThan(22_900);
    expect(Number(wake?.queueAge?.issueStaleSeconds)).toBeLessThan(23_200);
    expect(Date.parse(String(wake?.queueAge?.issueUpdatedAt))).toBe(
      Date.parse(String(readQueueAge(run?.contextSnapshot)?.issueUpdatedAt)),
    );
  });

  it("reports no queue age for a run dispatched on time", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const issueId = await seedIssue({
      companyId, agentId, title: "Fresh assignment", priority: "critical", updatedSecondsAgo: 5,
    });
    const runId = await seedQueuedRun({ companyId, agentId, issueId, createdSecondsAgo: 2 });

    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const run = await runRow(runId);
    expect(run?.status).toBe("succeeded");
    expect(readQueueAge(run?.contextSnapshot)).toMatchObject({
      skippedByDispatchCount: 0,
      queueAgeSeconds: expect.any(Number),
    });
    expect(Number(readQueueAge(run?.contextSnapshot)?.queueAgeSeconds)).toBeLessThan(60);
  });
});
