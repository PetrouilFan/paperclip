import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentTaskRun: mockTrackAgentTaskRun };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres rejected-handoff-source tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rejected handoff source is not persisted as resume provenance", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-rejected-handoff-source-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  // Each fixture mints fresh UUIDs, so only the in-flight execution needs
  // draining between cases; the database is torn down wholesale in afterAll.
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * `sourceIssueId` is what the cancelled predecessor run's own context snapshot
   * carries. `null` is the taskless `heartbeat_timer` run PET-307 measured: the
   * handoff guard rejects it, yet its id was still advertised to the
   * continuation builder, which then failed the successor run during setup.
   */
  async function seedReassignmentHandoff(sourceIssueId: string | null) {
    const companyId = randomUUID();
    const predecessorAgentId = randomUUID();
    const successorAgentId = randomUUID();
    const issueId = randomUUID();
    const cancelledRunId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: predecessorAgentId,
        companyId,
        name: "Predecessor",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: successorAgentId,
        companyId,
        name: "Successor",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: successorAgentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    // The predecessor's run was cancelled by the reassignment. It either names
    // this issue (a genuine handoff source) or, when the predecessor was a
    // taskless timer run, carries no issue scope at all.
    await db.insert(heartbeatRuns).values({
      id: cancelledRunId,
      companyId,
      agentId: predecessorAgentId,
      invocationSource: "scheduler",
      triggerDetail: "system",
      status: "cancelled",
      errorCode: "issue_reassigned",
      contextSnapshot: {
        ...(sourceIssueId ? { issueId: sourceIssueId } : {}),
        wakeReason: "heartbeat_timer",
        source: "scheduler",
        executionIdentityCause: "company_default",
        executionContinuation: null,
      },
    });
    return { companyId, issueId, successorAgentId, cancelledRunId };
  }

  async function wakeSuccessor(fixture: {
    companyId: string;
    issueId: string;
    successorAgentId: string;
    cancelledRunId: string;
  }) {
    const heartbeat = heartbeatService(db);
    return heartbeat.wakeup(fixture.successorAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: fixture.issueId, mutation: "update", interruptedRunId: fixture.cancelledRunId },
      contextSnapshot: {
        issueId: fixture.issueId,
        taskId: fixture.issueId,
        wakeReason: "issue_assigned",
        source: "issue.assignment",
        interruptedRunId: fixture.cancelledRunId,
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
  }

  it("drops a taskless rejected handoff source from the successor's persisted context", async () => {
    const fixture = await seedReassignmentHandoff(null);
    const run = await wakeSuccessor(fixture);
    expect(run).not.toBeNull();

    const persisted = await db
      .select({ context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(persisted).not.toBeNull();
    // The run row must not advertise provenance the dispatcher already rejected.
    expect(persisted!.context as Record<string, unknown>).not.toHaveProperty("interruptedRunId");
  });

  it("keeps a validated same-issue handoff source in the successor's persisted context", async () => {
    const fixture = await seedReassignmentHandoff(null);
    const scoped = await seedReassignmentHandoff(fixture.issueId);
    const run = await wakeSuccessor(scoped);
    expect(run).not.toBeNull();

    const persisted = await db
      .select({ context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(persisted).not.toBeNull();
    expect((persisted!.context as Record<string, unknown>).interruptedRunId).toBe(scoped.cancelledRunId);
  });

  it("keeps a handoff source that names a different issue so the fail-closed check still runs", async () => {
    const unrelated = await seedReassignmentHandoff(null);
    const fixture = await seedReassignmentHandoff(unrelated.issueId);
    const run = await wakeSuccessor(fixture);
    expect(run).not.toBeNull();

    const persisted = await db
      .select({ context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    // A foreign-issue source is a real fail-closed case, so it is not stripped.
    expect((persisted!.context as Record<string, unknown>).interruptedRunId).toBe(fixture.cancelledRunId);
  });
});
