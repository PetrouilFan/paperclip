import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  buildExecutionContinuation,
  continuationSourceFailureCode,
  continuationSourceFailureResultJson,
} from "./execution-continuation.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "rejected handoff source is not resume provenance",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-continuation-handoff-source-",
      );
      db = createDb(database.connectionString);
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
    });

    /**
     * Models a reassignment handoff: the issue moves A -> B, so A's run is
     * cancelled with `issue_reassigned` and its id is recorded as the successor's
     * `interruptedRunId`. `sourceIssueId` is what the cancelled run's own context
     * snapshot carries — `null` is the taskless `heartbeat_timer` run that has no
     * `issueId` key at all, which is the PET-307 defect.
     */
    async function handoffFixture(sourceIssueId: string | null) {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        previousAgentId = randomUUID(),
        issueId = randomUUID(),
        interruptedRunId = randomUUID(),
        commentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Handoff source",
        issuePrefix: `HND${companyId.slice(0, 8)}`,
      });
      await db.insert(agents).values([
        { id: agentId, companyId, name: "Successor", role: "engineer", adapterType: "paperclip_runner" },
        { id: previousAgentId, companyId, name: "Predecessor", role: "engineer", adapterType: "paperclip_runner" },
      ]);
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Reassigned task",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      await db.insert(issueComments).values({
        id: commentId,
        companyId,
        issueId,
        authorType: "user",
        authorUserId: "local-board",
        body: "Continue the reassigned task.",
      });
      await db.insert(heartbeatRuns).values({
        id: interruptedRunId,
        companyId,
        agentId: previousAgentId,
        status: "cancelled",
        errorCode: "issue_reassigned",
        contextSnapshot: {
          // A taskless scheduler run carries no issue scope whatsoever.
          ...(sourceIssueId ? { issueId: sourceIssueId } : {}),
          wakeReason: "heartbeat_timer",
          source: "scheduler",
          executionIdentityCause: "company_default",
          executionContinuation: null,
        },
      });
      const build = (context: Record<string, unknown> = {}) =>
        buildExecutionContinuation({
          db,
          companyId,
          issueId,
          agentId,
          context: {
            issueId,
            taskId: issueId,
            wakeReason: "issue_assigned",
            source: "issue.assignment",
            interruptedRunId,
            ...context,
          },
          summary: null,
          exposeLowTrustRaw: false,
        });
      return { companyId, agentId, issueId, otherIssueId: randomUUID(), interruptedRunId, commentId, build };
    }

    it("builds an envelope when the rejected handoff source is taskless (the PET-307 defect)", async () => {
      const f = await handoffFixture(null);
      const envelope = await f.build();
      expect(envelope.issueId).toBe(f.issueId);
    });

    it("still fails closed when the handoff source names a different issue", async () => {
      const foreign = await handoffFixture(null);
      const f = await handoffFixture(foreign.otherIssueId);
      await expect(f.build()).rejects.toThrow("continuation_source_context_missing");
    });

    it("still fails closed when the resume source row does not exist", async () => {
      const f = await handoffFixture(null);
      await expect(f.build({ interruptedRunId: randomUUID() })).rejects.toThrow(
        "continuation_source_context_missing",
      );
    });

    it("does not relax an explicit user-authorized resume source", async () => {
      const f = await handoffFixture(null);
      await expect(
        f.build({
          interruptedRunId: undefined,
          explicitUserContinuation: { previousRunId: randomUUID() },
        }),
      ).rejects.toThrow("continuation_user_authorization_missing");
    });

    it("keeps a same-issue interrupted source as real resume provenance", async () => {
      const f = await handoffFixture(null);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: f.companyId,
        agentId: f.agentId,
        status: "failed",
        contextSnapshot: { issueId: f.issueId, commentId: f.commentId },
      });
      const envelope = await f.build({ interruptedRunId: runId });
      expect(envelope.issueId).toBe(f.issueId);
    });

    it("classifies a fail-closed code into a message and a next action", () => {
      for (const code of [
        "continuation_source_context_missing",
        "continuation_user_authorization_missing",
        "continuation_task_ownership_changed",
      ] as const) {
        expect(continuationSourceFailureCode(code)).toBe(code);
        const failure = continuationSourceFailureResultJson(
          {
            companyId: randomUUID(),
            agentId: randomUUID(),
            contextSnapshot: { issueId: randomUUID(), interruptedRunId: randomUUID() },
          },
          code,
        );
        expect(failure.error.length).toBeGreaterThan(20);
        expect(failure.nextAction.length).toBeGreaterThan(20);
        const resultJson = failure.resultJson.continuationSource as Record<string, unknown>;
        expect(resultJson.code).toBe(code);
        expect(resultJson.retryable).toBe(false);
        expect(resultJson.requestedSourceRunId).toBeTruthy();
      }
      expect(continuationSourceFailureCode("some other failure")).toBeNull();
    });
  },
);
