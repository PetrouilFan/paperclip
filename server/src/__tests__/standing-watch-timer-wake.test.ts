import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres standing watch timer wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * PET-397. A `heartbeat_timer` wake is created with no issue in its context, so
 * every cross-issue write from it was refused with
 * `no_context_source_and_target_unbound` — which is most of a watch role's job
 * (PET-349's rules 1-3 and its daily board report). The run produced nothing and
 * said nothing, so the failure was invisible.
 *
 * These cases cover the scheduler half only: the host is resolved and stamped
 * onto the wake, and a bad configuration is reported instead of silently
 * producing a mute run. The gate half is in `cross-issue-influence-limit.test.ts`.
 */
describeEmbeddedPostgres("standing watch host on timer wakes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-standing-watch-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * The wake's attribution travels on the run, not the wakeup request: the
   * request row keeps only `payload`, and `cross-issue-influence-limit.ts`
   * reads the run's `context_snapshot`.
   */
  async function timerWakeContext(agentId: string) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    return (run?.contextSnapshot ?? {}) as Record<string, unknown>;
  }

  afterEach(async () => {
    // A claimed wake dispatches its execution fire-and-forget, so rows can
    // still be landing while teardown deletes. Retry rather than flake.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await db.delete(issueComments);
        await db.delete(issueDocuments);
        await db.delete(documentRevisions);
        await db.delete(documents);
        await db.delete(activityLog);
        await db.delete(environmentLeases);
        await db.delete(workspaceRuntimeServices);
        await db.delete(heartbeatRunEvents);
        await db.delete(issues);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(companySkills);
        await db.delete(companies);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw lastError;
  });

  async function seedFixture(input?: {
    hostStatus?: "todo" | "in_progress" | "blocked" | "done";
    hostAssigned?: boolean;
    /** `null` leaves the watch unconfigured; `"identifier"` uses `PREFIX-1`. */
    standingWatch?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const hostIssueId = randomUUID();
    const otherAgentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Coordinator",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            // Long enough that the seeded `lastHeartbeatAt` is unambiguously due.
            intervalSec: 30,
            wakeOnDemand: true,
            ...(input?.standingWatch === null
              ? {}
              : {
                  standingWatchIssueId:
                    input?.standingWatch === "identifier"
                      ? `${issuePrefix}-1`
                      : (input?.standingWatch ?? hostIssueId),
                }),
          },
        },
        permissions: {},
        lastHeartbeatAt: new Date("2026-04-11T00:00:00.000Z"),
      },
      {
        id: otherAgentId,
        companyId,
        name: "Neighbour",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        permissions: {},
      },
    ]);

    await db.insert(issues).values({
      id: hostIssueId,
      companyId,
      title: "Standing coordinator mandate",
      status: input?.hostStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input?.hostAssigned === false ? otherAgentId : agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, hostIssueId, issuePrefix, tickAt };
  }

  it("stamps the resolved host on the timer wake so a task-less run has a source", async () => {
    const { agentId, hostIssueId, issuePrefix, tickAt } = await seedFixture();

    const result = await heartbeatService(db).tickTimers(tickAt);
    expect(result.enqueued).toBe(1);
    expect(result.standingWatchUnresolved).toBe(0);

    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeup?.reason).toBe("heartbeat_timer");
    const context = await timerWakeContext(agentId);
    expect(context.standingWatchIssueId).toBe(hostIssueId);
    expect(context.standingWatchIdentifier).toBe(`${issuePrefix}-1`);
    // The wake stays unscoped on purpose: the host is where the watch's
    // authority comes from, not the issue this run is working on, so it must
    // not drag in issue-scoped wake behaviour.
    expect(context.issueId ?? null).toBeNull();
  });

  it("resolves a blocked host, which is the case checkout can never serve", async () => {
    // `checkout` refuses a blocked issue, so a watch hosted on one could never
    // reach the issue-side binding. PET-399 was re-homed off PET-72 for
    // precisely this reason.
    const { agentId, hostIssueId, tickAt } = await seedFixture({ hostStatus: "blocked" });

    await heartbeatService(db).tickTimers(tickAt);

    expect((await timerWakeContext(agentId)).standingWatchIssueId).toBe(hostIssueId);
  });

  it("accepts an issue identifier as well as a uuid", async () => {
    const { agentId, hostIssueId, tickAt } = await seedFixture({
      standingWatch: "identifier",
    });

    const result = await heartbeatService(db).tickTimers(tickAt);
    expect(result.standingWatchUnresolved).toBe(0);

    expect((await timerWakeContext(agentId)).standingWatchIssueId).toBe(hostIssueId);
  });

  it.each([
    ["host assigned to another agent", { hostAssigned: false } as const],
    ["host is done", { hostStatus: "done" as const }],
  ])("reports an unusable %s instead of waking mute", async (_label, overrides) => {
    const { agentId, tickAt } = await seedFixture(overrides);

    const result = await heartbeatService(db).tickTimers(tickAt);

    // The wake still happens — a broken watch config must not stop the
    // scheduler — but the miss is counted and the run carries no host, so the
    // cross-issue gate refuses its writes exactly as it did before.
    expect(result.enqueued).toBe(1);
    expect(result.standingWatchUnresolved).toBe(1);
    expect((await timerWakeContext(agentId)).standingWatchIssueId).toBeUndefined();
  });

  it("reports a host that does not exist", async () => {
    const { tickAt } = await seedFixture({ standingWatch: randomUUID() });

    const result = await heartbeatService(db).tickTimers(tickAt);
    expect(result.enqueued).toBe(1);
    expect(result.standingWatchUnresolved).toBe(1);
  });

  it("leaves an agent with no watch configured unscoped", async () => {
    const { agentId, tickAt } = await seedFixture({ standingWatch: null });

    const result = await heartbeatService(db).tickTimers(tickAt);
    expect(result.enqueued).toBe(1);
    expect(result.standingWatchUnresolved).toBe(0);

    expect((await timerWakeContext(agentId)).standingWatchIssueId).toBeUndefined();
  });

  it("leaves a paused agent unwatched", async () => {
    const { agentId, tickAt } = await seedFixture();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));

    const result = await heartbeatService(db).tickTimers(tickAt);
    expect(result.standingWatchUnresolved).toBe(0);
    const wakeups = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(0);
  });

  it("does not charge a timer wake for a host in another company", async () => {
    // Company scope is the first predicate on the host read, so a cross-tenant
    // reference can never resolve.
    const { agentId, tickAt } = await seedFixture();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Neighbour Co",
      issuePrefix: `N${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: otherCompanyId,
      title: "Foreign watch host",
      status: "in_progress",
      priority: "medium",
      issueNumber: 1,
      identifier: `N${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });
    const foreign = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, otherCompanyId));
    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 30, wakeOnDemand: true, standingWatchIssueId: foreign[0]!.id },
        },
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeatService(db).tickTimers(tickAt);
    expect(result.standingWatchUnresolved).toBe(1);
  });

  it("keeps the wake on its own row when nothing is due", async () => {
    // Sanity check on the fixture's clock: with the interval not elapsed the
    // scheduler must not claim the agent at all.
    const { agentId, tickAt } = await seedFixture();
    await db.update(agents).set({ lastHeartbeatAt: tickAt }).where(eq(agents.id, agentId));

    const result = await heartbeatService(db).tickTimers(new Date(tickAt.getTime() + 1_000));
    expect(result.enqueued).toBe(0);
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });
});
