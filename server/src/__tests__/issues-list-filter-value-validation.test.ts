import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import { issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * `?status=` and `?originKind=` are registered query keys whose *values* were
 * never validated, while every neighbouring enum key (`sortField`, `sortDir`,
 * `view`, `attention`) is. An unrecognised value therefore answered `200` with
 * an empty result instead of an error.
 *
 * The empty answer is the damaging shape: `?status=<typo>` tells a caller the
 * board has no work in a status, and `?attention=blocked&status=<typo>` on the
 * count route reports a confident `0` blocked while issues are in fact blocked.
 *
 * These tests assert the effect on the response — status code, body, and which
 * issues come back — not that a `res.status(400)` call exists.
 */

describeEmbeddedPostgres("issue list filter value validation", () => {
  const ctx = useEmbeddedPostgres("paperclip-issues-filter-value-", {
    resetEach: resetCompanyIssueFixtures,
  });

  async function seed(label: string) {
    const company = await seedCompanyWithBoardAccess(ctx.db, label);
    const companyId = company.companyId;
    await ctx.db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "Todo",
        status: "todo",
        priority: "medium",
        originKind: "manual",
      },
      {
        id: randomUUID(),
        companyId,
        title: "In progress",
        status: "in_progress",
        priority: "medium",
        originKind: "routine_execution",
      },
      {
        id: randomUUID(),
        companyId,
        title: "Done",
        status: "done",
        priority: "medium",
        originKind: "manual",
      },
      {
        id: randomUUID(),
        companyId,
        title: "Blocked",
        status: "blocked",
        priority: "medium",
        originKind: "manual",
      },
    ]);
    return company;
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function appFor(seeded: Seeded) {
    return routeApp(ctx.db, seeded.actor, issueRoutes);
  }

  async function listStatuses(
    seeded: Seeded,
    query: Record<string, string>,
  ): Promise<string[]> {
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query(query)
      .expect(200);
    return (res.body as { status: string }[]).map((issue) => issue.status).sort();
  }

  async function blockedCount(seeded: Seeded, query: Record<string, string>) {
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query(query)
      .expect(200);
    return (res.body as { count: number }).count;
  }

  it("400s an unrecognised ?status= value instead of answering empty", async () => {
    const seeded = await seed("bogus status");
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ status: "bogus_status_value" })
      .expect(400);
    expect(res.body).toMatchObject({
      unknownStatusValues: ["bogus_status_value"],
    });
    expect(String(res.body.error)).toContain("status must be one of");
  });

  it("400s a wrong-case ?status= value rather than matching nothing", async () => {
    const seeded = await seed("wrong case status");
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ status: "TODO" })
      .expect(400);
    expect(res.body).toMatchObject({ unknownStatusValues: ["TODO"] });
  });

  it("400s a comma list with one bad member instead of partially applying it", async () => {
    const seeded = await seed("partial csv status");
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ status: "todo,bogus" })
      .expect(400);
    // The valid `todo` member must not have been applied and returned as if the
    // whole filter had been understood.
    expect(res.body).toMatchObject({ unknownStatusValues: ["bogus"] });
    expect(res.body).not.toHaveProperty("issues");
  });

  it("400s a bad member in a repeated-key ?status= list", async () => {
    const seeded = await seed("repeated key status");
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query("status=todo&status=nope")
      .expect(400);
    expect(res.body).toMatchObject({ unknownStatusValues: ["nope"] });
  });

  it("400s an unrecognised ?originKind= value", async () => {
    const seeded = await seed("bogus origin kind");
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ originKind: "bogus_kind" })
      .expect(400);
    expect(res.body).toMatchObject({ unknownOriginKindValues: ["bogus_kind"] });
    expect(String(res.body.error)).toContain("originKind must be one of");
  });

  it("400s a bad ?originKind= value on the count route too", async () => {
    const seeded = await seed("count bogus origin kind");
    await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query({ attention: "blocked", originKind: "bogus_kind" })
      .expect(400);
  });

  it("400s a bad ?status= value on the count route instead of reporting 0", async () => {
    const seeded = await seed("count bogus status");
    // Ground truth first: one issue really is blocked, so a `0` here is a lie.
    expect(await blockedCount(seeded, { attention: "blocked" })).toBe(1);

    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues/count`)
      .query({ attention: "blocked", status: "bogus_status_value" })
      .expect(400);
    expect(res.body).toMatchObject({
      unknownStatusValues: ["bogus_status_value"],
    });
    expect(res.body).not.toHaveProperty("count");
  });

  it("keeps every canonical status spelling working", async () => {
    const seeded = await seed("all statuses");
    for (const status of [
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "blocked",
      "cancelled",
    ]) {
      const res = await request(appFor(seeded))
        .get(`/api/companies/${seeded.companyId}/issues`)
        .query({ status })
        .expect(200);
      expect(res.body, `status=${status} should be accepted`).toBeInstanceOf(Array);
    }
  });

  it("keeps the comma-list form returning every requested status", async () => {
    const seeded = await seed("csv statuses");
    expect(await listStatuses(seeded, { status: "todo,in_progress" })).toEqual([
      "in_progress",
      "todo",
    ]);
  });

  it("keeps every canonical originKind spelling working", async () => {
    const seeded = await seed("origin kinds");
    for (const originKind of [
      "manual",
      "routine_execution",
      "stale_active_run_evaluation",
      "harness_liveness_escalation",
      "stranded_issue_recovery",
      "task_watchdog",
      "chat_channel",
    ]) {
      const res = await request(appFor(seeded))
        .get(`/api/companies/${seeded.companyId}/issues`)
        .query({ originKind })
        .expect(200);
      expect(res.body, `originKind=${originKind} should be accepted`).toBeInstanceOf(
        Array,
      );
    }
  });

  it("accepts a plugin: originKind, which is a valid IssueOriginKind by design", async () => {
    const seeded = await seed("plugin origin kind");
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ originKind: "plugin:some.plugin:operation" })
      .expect(200);
    expect(res.body).toBeInstanceOf(Array);
  });

  it("keeps filtering by originKind rather than only validating it", async () => {
    const seeded = await seed("origin kind filters");
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ originKind: "routine_execution" })
      .expect(200);
    expect(
      (res.body as { title: string }[]).map((issue) => issue.title),
    ).toEqual(["In progress"]);
  });

  it("leaves ?originKindPrefix= unvalidated, since it is a LIKE prefix", async () => {
    const seeded = await seed("origin kind prefix");
    // `originKindPrefix` is deliberately a prefix match, so a value that is not
    // a complete origin kind is legitimate there. This pins that the validation
    // did not leak onto the prefix key.
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ originKindPrefix: "plugin:" })
      .expect(200);
    expect(res.body).toBeInstanceOf(Array);
  });

  it("still answers 200 with every status when ?status is absent", async () => {
    const seeded = await seed("no status filter");
    expect(await listStatuses(seeded, {})).toEqual([
      "blocked",
      "done",
      "in_progress",
      "todo",
    ]);
  });
});
