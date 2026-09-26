import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import {
  issueRoutes,
  issueListKnownQueryKeys,
  issueCountKnownQueryKeys,
} from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import type { createDb } from "@paperclipai/db";

type Db = ReturnType<typeof createDb>;

/**
 * `resetCompanyIssueFixtures` ends by deleting `companies`, which an `agents`
 * row would then violate through `agents_company_id_companies_id_fk`. This suite
 * seeds an agent, so it owns its reset: children first (self-referencing
 * `parent_id`), then issues, then agents, then the company graph.
 */
async function resetUnknownQueryKeyFixtures(db: Db) {
  await db.delete(issues).where(isNotNull(issues.parentId));
  await db.delete(issues);
  await db.delete(agents);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
}

/**
 * Regression coverage for the silent-drop defect behind PET-206:
 * `GET /companies/:companyId/issues` read a fixed set of query keys and never
 * inspected the key set, so a key it did not read was dropped with no trace and
 * the caller got the *unfiltered* board. `?assigneeId=` (the real key is
 * `assigneeAgentId=`) therefore returned every issue in the company.
 *
 * The naive fix — a 400 on any key outside a list of names — regresses
 * legitimate requests, because the handler accepts more spellings than its bare
 * `req.query.X` names suggest: `parentIssueId` is a real alias for `parentId`,
 * and several `include*` flags also accept `"1"`. Those cases are covered below,
 * and the last test fails if the allowlist ever drifts from the handler.
 */

describeEmbeddedPostgres("issue list unknown query key rejection", () => {
  const ctx = useEmbeddedPostgres("paperclip-issues-unknown-query-key-", {
    resetEach: resetUnknownQueryKeyFixtures,
  });

  async function seed() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Unknown query key");
    const companyId = company.companyId;
    const agentId = randomUUID();

    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ListTester",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const assignedId = randomUUID();
    const unassignedId = randomUUID();
    const otherAssignedId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();

    await ctx.db.insert(issues).values([
      { id: assignedId, companyId, title: "Assigned to agent", status: "todo", priority: "medium", assigneeAgentId: agentId },
      { id: unassignedId, companyId, title: "Unassigned", status: "todo", priority: "medium", assigneeAgentId: null },
      { id: otherAssignedId, companyId, title: "Assigned to someone else", status: "todo", priority: "medium" },
      { id: parentId, companyId, title: "Parent", status: "todo", priority: "medium" },
      { id: childId, companyId, title: "Child", status: "todo", priority: "medium", parentId },
    ]);

    return { ...company, agentId, assignedId, unassignedId, otherAssignedId, parentId, childId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function appFor(seeded: Seeded) {
    return routeApp(ctx.db, seeded.actor, issueRoutes);
  }

  async function listIds(seeded: Seeded, query: Record<string, string>) {
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query(query)
      .expect(200);
    return (res.body as { id: string }[]).map((issue) => issue.id).sort();
  }

  // 1. The PET-206 case itself, and the regression guard for it.
  it("rejects ?assigneeId= with 400 instead of returning the unfiltered board", async () => {
    const seeded = await seed();
    const agentId = seeded.agentId;

    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ assigneeId: agentId })
      .expect(400);

    expect(res.body).toMatchObject({
      unknownQueryKeys: ["assigneeId"],
    });
    expect(res.body.error).toContain("assigneeId");
    // The whole point: no issue list is served at all, so a caller can never
    // mistake the unfiltered board for a filtered result.
    expect(res.body).not.toHaveProperty("0.id");
  });

  // 2. Guards against a fix that over-rejects the correctly spelled key.
  it("still filters with ?assigneeAgentId=", async () => {
    const seeded = await seed();
    expect(await listIds(seeded, { assigneeAgentId: seeded.agentId })).toEqual([
      seeded.assignedId,
    ]);
  });

  // 3. The alias trap: a bare-name allowlist without parentIssueId 400s a
  //    request the server has always honored.
  it("treats ?parentIssueId= as the documented alias for ?parentId=", async () => {
    const seeded = await seed();
    const viaAlias = await listIds(seeded, { parentIssueId: seeded.parentId });
    const viaCanonical = await listIds(seeded, { parentId: seeded.parentId });
    expect(viaAlias).toEqual([seeded.childId]);
    expect(viaAlias).toEqual(viaCanonical);
  });

  // 4. Boolean flags accept "1" as well as "true"; the key set is unaffected.
  it("accepts the \"1\" spelling of a boolean include flag", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ includeBlockedBy: "1" })
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // 5. The "null" sentinel means unassigned and must not be read as a key miss.
  it("accepts ?assigneeAgentId=null as the unassigned sentinel", async () => {
    const seeded = await seed();
    const ids = await listIds(seeded, { assigneeAgentId: "null" });
    expect(ids).toContain(seeded.unassignedId);
    expect(ids).not.toContain(seeded.assignedId);
  });

  // 6. Mixed known + unknown names only the unknown key, so the caller can fix
  //    the call in one round trip instead of bisecting the parameter list.
  it("names only the unknown key when known and unknown keys are mixed", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ status: "todo", assigneeId: seeded.agentId })
      .expect(400);

    expect(res.body.unknownQueryKeys).toEqual(["assigneeId"]);
    expect(res.body.unknownQueryKeys).not.toContain("status");
  });

  it("reports every unknown key at once", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ assigneeId: seeded.agentId, totallyMadeUp: "1" })
      .expect(400);

    expect([...res.body.unknownQueryKeys].sort()).toEqual([
      "assigneeId",
      "totallyMadeUp",
    ]);
  });

  it("echoes the known key set so a caller can correct itself in one call", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ assigneeId: seeded.agentId })
      .expect(400);

    expect(res.body.knownQueryKeys).toContain("assigneeAgentId");
    expect(res.body.knownQueryKeys).not.toContain("assigneeId");
  });

  // 7. The shape pin, and the reason the test above is not enough on its own.
  //    Every other assertion in this block is `toContain`-only, and the 400 body
  //    is now built by `rejectUnknownIssueQueryKeys`, which is *shared* with
  //    `GET /issues/count`. So nothing in the suite notices the list route's own
  //    body changing underneath a `toContain`: rewording the `"issues list"`
  //    label leaves all 28 other tests green while changing what every caller
  //    of this route actually receives.
  //
  //    Both halves are pinned exactly, because they fail for different reasons.
  //    The message uses `toBe`: the label is a per-call-site *argument*, so no
  //    test of the shared helper itself can cover it. The key set uses
  //    `toEqual` against the allowlist, which pins membership and order in one
  //    line. Note the order half is a *forward* guard, not a live one: both
  //    allowlist literals are currently written in alphabetical order, so
  //    dropping the route's `.sort()` is a byte-identical no-op today and
  //    cannot fail. It becomes live the moment a key is appended out of order,
  //    which is exactly the edit that would otherwise ship silently.
  it("pins the list 400 body so the shared helper cannot drift it", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ assigneeId: seeded.agentId })
      .expect(400);

    expect(res.body.error).toBe(
      "Unknown issues list query parameter(s): assigneeId",
    );
    expect(res.body.knownQueryKeys).toEqual([...issueListKnownQueryKeys()]);
    // Assert the ordering directly rather than trusting the allowlist literal to
    // stay alphabetical, which is what makes the comparison above a real pin.
    expect(res.body.knownQueryKeys).toEqual(
      [...res.body.knownQueryKeys].sort(),
    );
  });

  // 8. The guard must not require callers to pass filters.
  it("serves the list with no query string at all", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .expect(200);
    expect(res.body).toHaveLength(5);
  });

  it("keeps failing loud on bad values for known keys", async () => {
    const seeded = await seed();
    await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ limit: "abc" })
      .expect(400);
    await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ view: "everything" })
      .expect(400);
  });
});

/**
 * The same defect on the sibling endpoint, `GET /companies/:companyId/issues/count`.
 *
 * It is covered separately rather than alongside the list route because it is a
 * second endpoint with a separately consumed error contract: it *requires*
 * `attention=blocked`, it *rejects* `limit`/`offset` with a 400 the list route
 * clamps instead, and it forces `includeBlockedBy` true whatever the caller
 * sent. The guard is therefore placed after those checks, and the tests below
 * pin that ordering as carefully as they pin the rejection itself.
 */
describeEmbeddedPostgres("issue count unknown query key rejection", () => {
  const ctx = useEmbeddedPostgres("paperclip-issues-count-unknown-query-key-", {
    resetEach: resetUnknownQueryKeyFixtures,
  });

  async function seed() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Count query key");
    const companyId = company.companyId;
    const agentId = randomUUID();

    await ctx.db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CountTester",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const parentId = randomUUID();
    const blockedChildId = randomUUID();

    await ctx.db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent",
        status: "blocked",
        priority: "high",
        blockedTransitionAt: new Date(),
      },
      {
        id: blockedChildId,
        companyId,
        title: "Blocked child",
        status: "blocked",
        priority: "high",
        parentId,
        blockedTransitionAt: new Date(),
      },
      {
        id: randomUUID(),
        companyId,
        title: "Open issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    return { ...company, agentId, parentId, blockedChildId };
  }

  type CountSeeded = Awaited<ReturnType<typeof seed>>;

  function countAppFor(seeded: CountSeeded) {
    return routeApp(ctx.db, seeded.actor, issueRoutes);
  }

  async function countFor(
    seeded: CountSeeded,
    query: Record<string, string>,
  ): Promise<number> {
    const res = await request(countAppFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query(query)
      .expect(200);
    return (res.body as { count: number }).count;
  }

  // 1. The defect on this endpoint: a misspelled filter is dropped and the
  //    caller is handed an unfiltered count.
  it("rejects ?assigneeId= with 400 instead of an unfiltered count", async () => {
    const seeded = await seed();
    const res = await request(countAppFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query({ attention: "blocked", assigneeId: seeded.agentId })
      .expect(400);

    expect(res.body.unknownQueryKeys).toEqual(["assigneeId"]);
    expect(res.body.error).toContain("assigneeId");
    // The whole point: no count is served at all, so the unfiltered total can
    // never be mistaken for a filtered one.
    expect(res.body).not.toHaveProperty("count");
  });

  // 2. The test that separates a real fix from a widened one. `view`,
  //    `sortField` and the inbox/pagination keys are in the LIST allowlist, so a
  //    fix that reused the list superset here would let them through and still
  //    drop them in silence -- the original defect, wearing a guard. The count
  //    set is narrower on purpose.
  //
  //    `limit`/`offset` are excluded from this list precisely because they are
  //    NOT in that category: the handler reads them in order to reject them, so
  //    they stay in the allowlist and keep their own message (asserted below).
  it("rejects list-only keys the count handler does not read", async () => {
    const seeded = await seed();
    for (const key of [
      "view",
      "sortField",
      "sortDir",
      "afterId",
      "unreadForUserId",
      "touchedByUserId",
      "inboxArchivedByUserId",
      "includeBlockedBy",
    ]) {
      const res = await request(countAppFor(seeded))
        .get(`/api/companies/${seeded.companyId}/issues/count`)
        .query({ attention: "blocked", [key]: "1" })
        .expect(400);
      expect(res.body.unknownQueryKeys, `${key} should be rejected`).toEqual([
        key,
      ]);
    }
  });

  it("reports limit and offset with their own message, not as unknown keys", async () => {
    const seeded = await seed();
    const base = `/api/companies/${seeded.companyId}/issues/count`;
    for (const key of ["limit", "offset"]) {
      const res = await request(countAppFor(seeded))
        .get(base)
        .query({ attention: "blocked", [key]: "5" })
        .expect(400);
      expect(res.body.error, `${key} keeps its specific rejection`).toContain(
        "does not accept limit or offset",
      );
      expect(res.body, `${key} is not an unknown key`).not.toHaveProperty(
        "unknownQueryKeys",
      );
    }
  });

  // 3. Ordering is the contract. A guard placed before the value checks would
  //    make these keys 400 as "unknown" and destroy a message callers and tests
  //    already depend on.
  it("keeps the existing 400s intact rather than shadowing them", async () => {
    const seeded = await seed();
    const base = `/api/companies/${seeded.companyId}/issues/count`;

    const missingAttention = await request(countAppFor(seeded))
      .get(base)
      .query({ status: "todo" })
      .expect(400);
    expect(missingAttention.body.error).toContain("requires attention=blocked");

    const withLimit = await request(countAppFor(seeded))
      .get(base)
      .query({ attention: "blocked", limit: "5" })
      .expect(400);
    expect(withLimit.body.error).toContain(
      "does not accept limit or offset",
    );
    expect(withLimit.body).not.toHaveProperty("unknownQueryKeys");

    const badBoolean = await request(countAppFor(seeded))
      .get(base)
      .query({ attention: "blocked", hasPlanDocument: "maybe" })
      .expect(400);
    expect(badBoolean.body.error).toContain("hasPlanDocument");
    expect(badBoolean.body).not.toHaveProperty("unknownQueryKeys");
  });

  // 4. The alias trap, on this endpoint too: a bare-name allowlist would 400 a
  //    request the server has always honored.
  it("treats ?parentIssueId= as the documented alias for ?parentId=", async () => {
    const seeded = await seed();
    const viaAlias = await countFor(seeded, {
      attention: "blocked",
      parentIssueId: seeded.parentId,
    });
    const viaCanonical = await countFor(seeded, {
      attention: "blocked",
      parentId: seeded.parentId,
    });
    expect(viaAlias).toBe(viaCanonical);
    expect(viaAlias).toBe(1);
  });

  // 5. Value spellings are not keys: "1" for a boolean, "null" for the
  //    unassigned sentinel.
  it("accepts the \"1\" spelling and the \"null\" sentinel", async () => {
    const seeded = await seed();
    await countFor(seeded, {
      attention: "blocked",
      includeRoutineExecutions: "1",
    });
    await countFor(seeded, { attention: "blocked", assigneeAgentId: "null" });
  });

  // 6. The in-repo caller (ui/src/api/issues.ts `count`) sends exactly these
  //    seven keys. All are honored, so the hard 400 breaks no current caller.
  it("serves the exact query the UI count caller sends", async () => {
    const seeded = await seed();
    expect(
      await countFor(seeded, {
        attention: "blocked",
        status: "blocked",
        assigneeAgentId: seeded.agentId,
        assigneeUserId: "someone",
        projectId: randomUUID(),
        labelId: randomUUID(),
        q: "child",
      }),
    ).toBeTypeOf("number");
  });

  it("names only the unknown key when known and unknown keys are mixed", async () => {
    const seeded = await seed();
    const res = await request(countAppFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query({ attention: "blocked", status: "blocked", assigneeId: "x" })
      .expect(400);

    expect(res.body.unknownQueryKeys).toEqual(["assigneeId"]);
    expect(res.body.unknownQueryKeys).not.toContain("status");
  });

  it("echoes the count-specific known key set, not the list superset", async () => {
    const seeded = await seed();
    const res = await request(countAppFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query({ attention: "blocked", assigneeId: "x" })
      .expect(400);

    expect(res.body.knownQueryKeys).toContain("assigneeAgentId");
    expect(res.body.knownQueryKeys).not.toContain("assigneeId");
    // A caller corrected by this response must not be handed a key that will
    // be dropped again.
    expect(res.body.knownQueryKeys).not.toContain("view");
    expect(res.body.knownQueryKeys).not.toContain("sortField");
  });

  // 7. The count route's own half of the same shape pin, and the one that is
  //    actually load-bearing today. The label is a per-call-site argument, so
  //    the shared helper cannot cover it: rewording `"issues/count"` here
  //    leaves every other assertion in this block green, because they are all
  //    `toContain`/`not.toContain`. Two endpoints that deliberately share a body
  //    builder are exactly the pair whose separate call-site arguments drift
  //    apart unnoticed -- and `issues/count` is read by the board UI, so its
  //    message is a shipped contract, not an internal one.
  it("pins the count 400 body so the shared helper cannot drift it", async () => {
    const seeded = await seed();
    const res = await request(countAppFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query({ attention: "blocked", assigneeId: "x" })
      .expect(400);

    expect(res.body.error).toBe(
      "Unknown issues/count query parameter(s): assigneeId",
    );
    expect(res.body.knownQueryKeys).toEqual([...issueCountKnownQueryKeys()]);
    expect(res.body.knownQueryKeys).toEqual(
      [...res.body.knownQueryKeys].sort(),
    );
  });
});

/**
 * Drift guard. A new filter added to the handler without registering its key
 * here would 400 a legitimate caller in production, which is a worse failure
 * than the bug this change fixes. Read the handler, extract the keys it
 * actually reads, and require exact agreement with the allowlist.
 *
 * Extraction is scoped to the single list route's source range, because the
 * file contains many routes and many `req.query` call sites; a whole-file diff
 * mixes them and reports phantom findings.
 */
describe("issue list query-key allowlist drift", () => {
  it("matches exactly the keys the list handler reads", () => {
    const sourcePath = fileURLToPath(
      new URL("../routes/issues.ts", import.meta.url),
    );
    const source = readFileSync(sourcePath, "utf8");
    const lines = source.split("\n");

    const startIndex = lines.findIndex((line) =>
      line.includes('router.get("/companies/:companyId/issues",'),
    );
    expect(startIndex, "list route not found in issues.ts").toBeGreaterThan(-1);

    const endIndex = lines.findIndex(
      (line, index) => index > startIndex && /^\s*router\.(get|post|put|patch|delete)\(/.test(line),
    );
    expect(endIndex, "end of list route not found in issues.ts").toBeGreaterThan(startIndex);

    const handlerSource = lines.slice(startIndex, endIndex).join("\n");
    const readKeys = new Set<string>();
    for (const match of handlerSource.matchAll(/req\.query\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      readKeys.add(match[1]!);
    }

    // A dynamic or spread read would make an allowlist unsound, because the
    // allowlist could not express a key it has never seen. Strip the two forms
    // this change itself introduces -- the guard's own key-set inspection and
    // the direct named reads -- and require that nothing else touches the
    // query object. Failing loudly here beats silently reading fewer keys than
    // the handler does.
    const residualQueryAccess = handlerSource
      .replace(/req\.query\.[A-Za-z_][A-Za-z0-9_]*/g, "")
      .replace(/Object\.keys\(\s*req\.query\s*\)/g, "")
      .match(/req\.query\b/g);
    expect(
      residualQueryAccess,
      "list handler reads req.query in a way the allowlist cannot express",
    ).toBe(null);

    const allowlist = new Set(issueListKnownQueryKeys());
    const missing = [...readKeys].filter((key) => !allowlist.has(key)).sort();
    const stale = [...allowlist].filter((key) => !readKeys.has(key)).sort();

    expect(missing, "handler reads keys missing from the allowlist").toEqual([]);
    expect(stale, "allowlist registers keys the handler does not read").toEqual([]);
  });

  it("registers parentIssueId as an alias key, not just parentId", () => {
    expect(issueListKnownQueryKeys()).toContain("parentIssueId");
    expect(issueListKnownQueryKeys()).toContain("parentId");
  });

  it("does not treat value spellings as keys", () => {
    const keys = issueListKnownQueryKeys();
    expect(keys).not.toContain("null");
    expect(keys).not.toContain("true");
    expect(keys).not.toContain("1");
  });
});

/**
 * The same drift guard for the count route, which is the larger hazard here: a
 * filter added to that handler without registering its key would 400 a real
 * caller, and the failure would be attributed to this change rather than to
 * the omission. Scoped to the count route's own source range, for the same
 * reason the list guard is: the file has many routes and many `req.query` call
 * sites, and a whole-file diff reports phantom findings.
 */
describe("issue count query-key allowlist drift", () => {
  const sourceLines = () =>
    readFileSync(
      fileURLToPath(new URL("../routes/issues.ts", import.meta.url)),
      "utf8",
    ).split("\n");

  it("matches exactly the keys the count handler reads", () => {
    const lines = sourceLines();

    const startIndex = lines.findIndex((line) =>
      line.includes('router.get("/companies/:companyId/issues/count",'),
    );
    expect(startIndex, "count route not found in issues.ts").toBeGreaterThan(-1);

    const endIndex = lines.findIndex(
      (line, index) => index > startIndex && /^\s*router\.(get|post|put|patch|delete)\(/.test(line),
    );
    expect(endIndex, "end of count route not found in issues.ts").toBeGreaterThan(startIndex);

    const handlerSource = lines.slice(startIndex, endIndex).join("\n");
    const readKeys = new Set<string>();
    for (const match of handlerSource.matchAll(/req\.query\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      readKeys.add(match[1]!);
    }

    // Same soundness check as the list route: a spread or computed read would
    // make the allowlist unsound, because it could not express a key it has
    // never seen.
    const residualQueryAccess = handlerSource
      .replace(/req\.query\.[A-Za-z_][A-Za-z0-9_]*/g, "")
      .replace(/Object\.keys\(\s*req\.query\s*\)/g, "")
      .match(/req\.query\b/g);
    expect(
      residualQueryAccess,
      "count handler reads req.query in a way the allowlist cannot express",
    ).toBe(null);

    const allowlist = new Set(issueCountKnownQueryKeys());
    const missing = [...readKeys].filter((key) => !allowlist.has(key)).sort();
    const stale = [...allowlist].filter((key) => !readKeys.has(key)).sort();

    expect(missing, "count handler reads keys missing from the allowlist").toEqual([]);
    expect(stale, "count allowlist registers keys the handler does not read").toEqual([]);
  });

  it("registers parentIssueId as an alias key, not just parentId", () => {
    expect(issueCountKnownQueryKeys()).toContain("parentIssueId");
    expect(issueCountKnownQueryKeys()).toContain("parentId");
  });

  it("keeps limit and offset registered so their specific 400 stays reachable", () => {
    const keys = issueCountKnownQueryKeys();
    expect(keys).toContain("limit");
    expect(keys).toContain("offset");
  });

  it("does not treat value spellings as keys", () => {
    const keys = issueCountKnownQueryKeys();
    expect(keys).not.toContain("null");
    expect(keys).not.toContain("true");
    expect(keys).not.toContain("1");
  });

  it("is a strict subset of the list keys, and does not shadow them", () => {
    const list = new Set(issueListKnownQueryKeys());
    const count = issueCountKnownQueryKeys();
    // A count key that the list route does not read would mean the narrower set
    // is wrong in the direction that breaks list callers reusing it.
    expect(count.filter((key) => !list.has(key))).toEqual([]);
    // The narrowing is the point: reusing the list superset would re-admit
    // keys this handler drops in silence.
    for (const key of ["view", "sortField", "sortDir"]) {
      expect(list.has(key), `${key} is a list key`).toBe(true);
      expect(count).not.toContain(key);
    }
  });
});
