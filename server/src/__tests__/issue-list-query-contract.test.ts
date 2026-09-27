import { randomUUID } from "node:crypto";
import request from "supertest";
import { isNotNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { buildOpenApiSpec } from "../routes/openapi.js";
import { issueRoutes } from "../routes/issues.js";
import {
  issueListKnownQueryKeys,
  issueCountKnownQueryKeys,
} from "../services/issue-list-query-keys.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import type { createDb } from "@paperclipai/db";

type Db = ReturnType<typeof createDb>;

/**
 * The two halves of the silent-wrong-answer defect that neither half fixes on
 * its own.
 *
 * `issues-unknown-query-key.test.ts` covers the loud half: an unread key is
 * rejected with a 400 that names what the route accepts. This suite covers the
 * quiet half, which is what made the defect expensive in the first place:
 *
 *  1. The 400 is only a usable answer if the caller can find the real name
 *     without triggering it. The OpenAPI spec used to document one query
 *     parameter on the list route -- `view`, which is not a filter -- and *no*
 *     query parameter on the count route, so the error body was the only place
 *     the 33 accepted keys existed. A caller working from the contract had no
 *     documented key to get right, and the one documented key did nothing.
 *  2. Both routes answer with a bare array, so a page that stopped at `limit`
 *     was indistinguishable from a complete result. The list route defaults to
 *     `ISSUE_LIST_DEFAULT_LIMIT` rows, so a company larger than that page size
 *     silently loses the rest -- which is how an ignored filter produced a
 *     short, plausible, entirely wrong list rather than an obviously too-large
 *     one.
 *
 * Asserting spec/enforcement parity here is what keeps the two from drifting
 * apart again: nothing else connects the documented surface to the enforced
 * one, so a new filter would be enforced-but-undocumented with no test failing.
 */
async function resetIssueListContractFixtures(db: Db) {
  await db.delete(issues).where(isNotNull(issues.parentId));
  await db.delete(issues);
  await db.delete(agents);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
}

function queryParameterNames(
  path: string,
): string[] {
  const spec = buildOpenApiSpec() as {
    paths: Record<string, Record<string, { parameters?: unknown[] }>>;
  };
  const operation = spec.paths[path]?.get;
  expect(operation, `${path} GET is missing from the OpenAPI spec`).toBeDefined();
  return (operation?.parameters ?? [])
    .map((parameter) => (parameter as { in?: string; name?: string }))
    .filter((parameter) => parameter.in === "query")
    .map((parameter) => parameter.name!)
    .sort();
}

describe("issue list query contract is documented, not just enforced", () => {
  it("documents every query key the list route accepts, and nothing else", () => {
    const documented = queryParameterNames("/api/companies/{companyId}/issues");
    const accepted = [...issueListKnownQueryKeys()].sort();

    expect(
      documented.filter((name) => !accepted.includes(name)),
      "spec documents a query key the list route does not accept",
    ).toEqual([]);
    expect(
      accepted.filter((name) => !documented.includes(name)),
      "list route accepts a query key the spec does not document",
    ).toEqual([]);
  });

  it("documents every query key the count route accepts, and nothing else", () => {
    const documented = queryParameterNames(
      "/api/companies/{companyId}/issues/count",
    );
    const accepted = [...issueCountKnownQueryKeys()].sort();

    expect(
      documented.filter((name) => !accepted.includes(name)),
      "spec documents a query key the count route does not accept",
    ).toEqual([]);
    expect(
      accepted.filter((name) => !documented.includes(name)),
      "count route accepts a query key the spec does not document",
    ).toEqual([]);
  });

  it("names the agent assignee filter the guard rejects `assigneeId` for", () => {
    // The specific mistake this contract exists to prevent: a caller reaching
    // for `assigneeId` because nothing told them it was `assigneeAgentId`.
    const documented = queryParameterNames("/api/companies/{companyId}/issues");
    expect(documented).toContain("assigneeAgentId");
    expect(documented).not.toContain("assigneeId");
  });

  it("documents the paging keys that decide whether a page is complete", () => {
    const documented = queryParameterNames("/api/companies/{companyId}/issues");
    expect(documented).toContain("limit");
    expect(documented).toContain("offset");
  });
});

describeEmbeddedPostgres("issue list truncation is observable", () => {
  const ctx = useEmbeddedPostgres("paperclip-issues-list-truncation-", {
    resetEach: resetIssueListContractFixtures,
  });

  async function seed(issueCount: number) {
    const company = await seedCompanyWithBoardAccess(ctx.db, "List truncation");
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId: company.companyId,
      name: "TruncationTester",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await ctx.db.insert(issues).values(
      Array.from({ length: issueCount }, (_, index) => ({
        id: randomUUID(),
        companyId: company.companyId,
        title: `Issue ${index}`,
        status: "todo" as const,
        priority: "medium" as const,
        assigneeAgentId: agentId,
        createdAt: new Date(index * 1000),
        updatedAt: new Date(index * 1000),
      })),
    );
    return company;
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function appFor(seeded: Seeded) {
    return routeApp(ctx.db, seeded.actor, issueRoutes);
  }

  it("says so when a full page is returned and more rows may exist", async () => {
    const seeded = await seed(5);
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ limit: 2 })
      .expect(200);

    expect(res.body).toHaveLength(2);
    expect(res.headers["x-paperclip-result-count"]).toBe("2");
    expect(res.headers["x-paperclip-result-truncated"]).toBe("true");
  });

  it("says not-truncated on a short page", async () => {
    const seeded = await seed(5);
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ limit: 10 })
      .expect(200);

    expect(res.body).toHaveLength(5);
    expect(res.headers["x-paperclip-result-count"]).toBe("5");
    expect(res.headers["x-paperclip-result-truncated"]).toBe("false");
  });

  it("keeps the header on the compact view too", async () => {
    const seeded = await seed(5);
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ view: "compact", limit: 2 })
      .expect(200);

    expect(res.body).toHaveLength(2);
    expect(res.headers["x-paperclip-result-truncated"]).toBe("true");
  });

  it("still reports truncation on a served-from-cache repeat request", async () => {
    // The compact view is served from a 2s TTL cache, so the flag has to ride
    // along with the prepared response. Recomputing it from the body per
    // request would be wrong for the same reason it is wrong for a filtered
    // actor: the body is not what the query returned.
    const seeded = await seed(5);
    const app = appFor(seeded);
    const query = { view: "compact", limit: 2 };

    const first = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query(query)
      .expect(200);
    const second = await request(app)
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query(query)
      .expect(200);

    expect(first.headers["x-paperclip-request-cache"]).not.toBe("hit");
    expect(second.headers["x-paperclip-request-cache"]).toBe("hit");
    expect(first.headers["x-paperclip-result-truncated"]).toBe("true");
    expect(second.headers["x-paperclip-result-truncated"]).toBe("true");
    expect(second.headers["x-paperclip-result-count"]).toBe(
      first.headers["x-paperclip-result-count"],
    );
  });

  it("makes a truncated default page recoverable by paging with offset", async () => {
    const seeded = await seed(5);
    const first = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ limit: 2, sortField: "id", sortDir: "asc" })
      .expect(200);
    const second = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ limit: 2, offset: 2, sortField: "id", sortDir: "asc" })
      .expect(200);

    expect(first.body).toHaveLength(2);
    expect(second.body).toHaveLength(2);
    // Disjoint pages are what makes the header actionable rather than advisory.
    const firstIds = first.body.map((issue: { id: string }) => issue.id);
    const secondIds = second.body.map((issue: { id: string }) => issue.id);
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
  });
});
