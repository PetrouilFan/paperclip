import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue review attention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-review-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Review Attention Co",
      issuePrefix: "RVA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertReview(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    assigneeUserId?: string | null;
    executionState?: Record<string, unknown> | null;
    monitorNextCheckAt?: Date | null;
    executionPolicy?: Record<string, unknown> | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: input.assigneeUserId ? null : input.agentId,
      assigneeUserId: input.assigneeUserId ?? null,
      executionState: input.executionState ?? null,
      monitorNextCheckAt: input.monitorNextCheckAt ?? null,
      executionPolicy: input.executionPolicy ?? null,
    });
    return id;
  }

  it("surfaces a pathless agent-owned review as stalled and a queued recovery as covered", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-1" });

    let row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({
      state: "stalled",
      paths: [],
    });
    expect(row?.reviewAttention?.reason).toContain("no participant, interaction, approval");

    const recoveryIdempotencyKey = `issue_review_path_lost:${issueId}:fingerprint`;
    const recoveryWake = {
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      status: "queued",
      payload: { issueId },
      idempotencyKey: recoveryIdempotencyKey,
    };
    await db.insert(agentWakeupRequests).values(recoveryWake);
    await expect(db.insert(agentWakeupRequests).values(recoveryWake)).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint_name: "agent_wakeup_requests_review_path_recovery_idempotency_uq",
      },
    });

    row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({
      state: "covered",
      paths: [expect.objectContaining({ kind: "queued_wake", responder: "Review Agent" })],
    });
  });

  it("reports every healthy review path as covered", async () => {
    const { companyId, agentId } = await seed();
    const interactionIssueId = await insertReview({ companyId, agentId, identifier: "RVA-2" });
    const humanOnlyInteractionIssueId = await insertReview({ companyId, agentId, identifier: "RVA-2H" });
    const approvalIssueId = await insertReview({ companyId, agentId, identifier: "RVA-3" });
    const monitorIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-4",
      monitorNextCheckAt: new Date(Date.now() + 60_000),
      executionPolicy: { monitor: { maxAttempts: 3 } },
    });
    const humanIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-5",
      assigneeUserId: "board-user",
    });
    const participantIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-6",
      executionState: { status: "pending", currentParticipant: { type: "agent", agentId } },
    });
    const activeRunIssueId = await insertReview({ companyId, agentId, identifier: "RVA-7" });
    const recoveryIssueId = await insertReview({ companyId, agentId, identifier: "RVA-8" });

    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: interactionIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Approve?" },
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: humanOnlyInteractionIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      payload: { version: 1, prompt: "Human review?" },
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Review" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId: approvalIssueId, approvalId });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: activeRunIssueId },
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: recoveryIssueId,
      kind: "missing_disposition",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "review_path_lost",
      fingerprint: "review-path",
      evidence: {},
      nextAction: "Restore review path",
    });

    const rows = await svc.list(companyId, { status: "in_review" });
    const byId = new Map(rows.map((row) => [row.id, row.reviewAttention]));
    const expectedKinds = new Map([
      [interactionIssueId, "interaction"],
      [humanOnlyInteractionIssueId, "interaction"],
      [approvalIssueId, "approval"],
      [monitorIssueId, "monitor"],
      [humanIssueId, "human_reviewer"],
      [participantIssueId, "execution_participant"],
      [activeRunIssueId, "active_run"],
      [recoveryIssueId, "recovery"],
    ]);

    for (const [issueId, kind] of expectedKinds) {
      expect(byId.get(issueId), kind).toMatchObject({
        state: "covered",
        paths: expect.arrayContaining([expect.objectContaining({ kind })]),
      });
    }
    // An interaction that names no addressee is board-addressed. It is not the
    // assignee's card, so the assignee is not its responder.
    expect(byId.get(interactionIssueId)?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", responder: "Board" }),
    ]));
    expect(byId.get(humanOnlyInteractionIssueId)?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", responder: "Board" }),
    ]));
  });

  it("names the addressee of an interaction, and the board when the card names nobody", async () => {
    const { companyId, agentId } = await seed();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Addressed Agent",
      role: "engineer",
      status: "idle",
    });

    // Every one of these is assigned to `agentId`. Only the addressee differs.
    const unaddressedIssueId = await insertReview({ companyId, agentId, identifier: "RVA-A1" });
    const selfAddressedIssueId = await insertReview({ companyId, agentId, identifier: "RVA-A2" });
    const otherAddressedIssueId = await insertReview({ companyId, agentId, identifier: "RVA-A3" });
    const humanOnlyUnaddressedIssueId = await insertReview({ companyId, agentId, identifier: "RVA-A4" });

    // No resolver policy columns are set on this row, so it takes the schema
    // defaults: effective `anyone`, provenance `inherited`. That is the
    // default path for every card created without an explicit policy, and it
    // is the configuration under which the assignee used to be reported.
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: unaddressedIssueId,
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, questions: [{ id: "q", prompt: "Which?" }] },
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: selfAddressedIssueId,
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      addresseeAgentId: agentId,
      payload: { version: 1, questions: [{ id: "q", prompt: "Which?" }] },
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: otherAddressedIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      addresseeAgentId: otherAgentId,
      payload: { version: 1, prompt: "Approve?" },
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: humanOnlyUnaddressedIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      payload: { version: 1, prompt: "Human review?" },
    });

    const rows = await svc.list(companyId, { status: "in_review" });
    const responderFor = (issueId: string) =>
      (rows.find((row) => row.id === issueId)?.reviewAttention?.paths ?? []).find(
        (path) => path.kind === "interaction",
      )?.responder;

    // Nobody was addressed, so the card waits on the board. Naming the
    // assignee here is the defect: it is the party blocked on the card, and
    // the creation route never wakes it because it names no addressee.
    expect(responderFor(unaddressedIssueId)).toBe("Board");
    // The addressee branch is preserved for the case it was written for.
    expect(responderFor(selfAddressedIssueId)).toBe("Review Agent");
    // Negative control for both failure modes at once. This card DOES name an
    // addressee, and it is not the assignee, so the projection must follow the
    // card rather than the issue - a "always Board" fix and a "name the
    // assignee" fix both fail here.
    expect(responderFor(otherAddressedIssueId)).toBe("Addressed Agent");
    // An explicit human-only card was already correct and must stay correct.
    expect(responderFor(humanOnlyUnaddressedIssueId)).toBe("Board");
  });

  it("does not let a transiently skipped recovery consume its fingerprint", async () => {
    const { companyId, agentId } = await seed();
    const idempotencyKey = `issue_review_path_lost:${randomUUID()}:fingerprint`;
    const baseWake = {
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      payload: {},
      idempotencyKey,
    };

    await db.insert(agentWakeupRequests).values({
      ...baseWake,
      status: "skipped",
      finishedAt: new Date(),
    });

    await expect(db.insert(agentWakeupRequests).values({
      ...baseWake,
      status: "queued",
    })).resolves.toBeDefined();
  });
});
