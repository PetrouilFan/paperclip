import { describe, expect, it } from "vitest";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  crossIssueInfluenceLimitError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.ts";

function counterDb(
  initialCount = 0,
  runOverrides: Record<string, unknown> | null = {},
  /** Issues whose `checkout_run_id` / `execution_run_id` points at this run. */
  boundIssueIds: string[] = [],
) {
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if (Object.keys(selection).includes("count")) {
            return {
              then: (resolve: (rows: unknown[]) => unknown) => resolve([{ count: observedCount }]),
            };
          }
          // The issue-side binding lookup: the same chain shape the run read
          // uses, so both branches hang off one thenable.
          if (!Object.keys(selection).includes("contextSnapshot")) {
            const rows = boundIssueIds.map((id) => ({ id }));
            return {
              orderBy: () => ({ limit: () => ({ then: (resolve: (rows: unknown[]) => unknown) => resolve(rows) }) }),
            };
          }
          return {
            for: () => ({
              then: (resolve: (rows: unknown[]) => unknown) => resolve(runOverrides === null ? [] : [{
                id: "11111111-1111-4111-8111-111111111111",
                companyId: "22222222-2222-4222-8222-222222222222",
                agentId: "33333333-3333-4333-8333-333333333333",
                responsibleUserId: "user-1",
                contextSnapshot: { issueId: "44444444-4444-4444-8444-444444444444" },
                status: "running",
                ...runOverrides,
              }]),
            }),
          };
        },
      }),
    }),
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        inserted.push(value);
        if (value.action === "issue.cross_issue_influence_observed") observedCount += 1;
      },
    }),
  };
  return {
    db: {
      transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    },
    inserted,
    get observedCount() {
      return observedCount;
    },
  };
}

describe("cross-issue influence limit rollout", () => {
  it("logs observations without enforcement during the one-week rollout", () => {
    const decision = evaluateCrossIssueInfluenceLimit({
      priorCount: CROSS_ISSUE_INFLUENCE_LIMIT,
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    });

    expect(decision).toMatchObject({
      allowed: true,
      mode: "log_only",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
      cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    });
  });

  it("allows the twentieth influence and fails closed on the twenty-first after the flip", () => {
    const now = CROSS_ISSUE_INFLUENCE_ENFORCE_AT;
    expect(evaluateCrossIssueInfluenceLimit({ priorCount: 19, now })).toMatchObject({
      allowed: true,
      mode: "enforce",
      count: 20,
      cap: 20,
    });

    const rejected = evaluateCrossIssueInfluenceLimit({ priorCount: 20, now });
    expect(rejected).toMatchObject({
      allowed: false,
      mode: "enforce",
      count: 21,
      cap: 20,
    });
    const capError = crossIssueInfluenceLimitError(rejected, {
      actorLabel: "Fable",
      issueIdentifier: "TASK-482",
    });
    expect(capError.details).toMatchObject({
      code: "cross_issue_influence_cap_exceeded",
      cap: 20,
      count: 21,
      mode: "enforce",
      enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT.toISOString(),
    });
    // Plan §6: the 429 names the boundary, who can act, and the way forward.
    expect(capError.error).toContain("20");
    expect(capError.error).toContain("Who can act:");
    expect(capError.error).toContain("Try this:");
    expect(capError.error).toContain("next heartbeat");
    expect(capError.details.boundary).toContain("20");
    expect(capError.details.whoCanAct).toContain("Fable");
  });

  it("uses one durable counter for cross-issue comments, PATCH updates, and interaction resolutions", async () => {
    const fake = counterDb();
    const base = {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    } as const;

    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "comment" }))
      .resolves.toMatchObject({ count: 1, allowed: true });
    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "update" }))
      .resolves.toMatchObject({ count: 2, allowed: true });
    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "interaction_resolution" }))
      .resolves.toMatchObject({ count: 3, allowed: true });

    expect(fake.observedCount).toBe(3);
    expect(fake.inserted.map((row) => (row.details as { kind: string }).kind))
      .toEqual(["comment", "update", "interaction_resolution"]);
  });

  it("counts an interaction resolution against a budget already spent on comments", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "interaction_resolution",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({
      allowed: false,
      mode: "enforce",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
    });
    expect(fake.inserted).toEqual([
      expect.objectContaining({ action: "issue.cross_issue_influence_cap_rejected" }),
    ]);
  });

  it("does not count same-issue writes", async () => {
    const fake = counterDb(0, {
      contextSnapshot: { issueId: "55555555-5555-4555-8555-555555555555" },
    });
    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).resolves.toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it.each([
    ["missing", null],
    ["wrong-agent", { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["wrong-company", { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
  ] as const)("fails closed for a %s locked run", async (_label, runOverrides) => {
    const fake = counterDb(0, runOverrides);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });

  it("fails closed before querying for a malformed run id", async () => {
    const fake = counterDb();

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "attacker-controlled-run-id",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });

  it("fails closed when the persisted run has no source issue", async () => {
    const fake = counterDb(0, { contextSnapshot: {} });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "update",
    })).rejects.toMatchObject({
      status: 403,
      details: {
        code: "cross_issue_influence_run_context_required",
        reason: "no_context_source_and_target_unbound",
      },
    });
    expect(fake.inserted).toEqual([]);
  });
});

/**
 * PET-156. `POST /checkout` stamps the run onto the issue but never stamps the
 * issue back onto the run, so a run woken by `heartbeat_timer` (created with no
 * issue in its context) held a real claim to its checked-out issue and still had
 * no source. The guard threw before the same-issue short-circuit, so that run
 * was refused everywhere — the asymmetry behind the fleet-wide 403 reports.
 */
describe("cross-issue influence: run-side binding is bidirectional", () => {
  const base = {
    companyId: "22222222-2222-4222-8222-222222222222",
    runId: "11111111-1111-4111-8111-111111111111",
    agentId: "33333333-3333-4333-8333-333333333333",
    kind: "comment",
    now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  } as const;
  const contextless = { contextSnapshot: {}, status: "running" } as const;

  it("matrix row 1: a context-less run writes to the issue it checked out", async () => {
    const fake = counterDb(0, contextless, ["55555555-5555-4555-8555-555555555555"]);

    // The run's own bound issue is not a cross-issue write, so it is exempt
    // exactly like a context-derived source issue.
    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...base,
      targetIssueId: "55555555-5555-4555-8555-555555555555",
    })).resolves.toBeNull();
    expect(fake.inserted).toEqual([]);
    expect(fake.observedCount).toBe(0);
  });

  it("matrix row 2: a context-less run writing elsewhere passes while under the cap", async () => {
    const fake = counterDb(0, contextless, ["44444444-4444-4444-8444-444444444444"]);

    // The run now has a source (its checked-out issue), so the write is a real
    // cross-issue mutation: it passes and is charged to the per-run budget.
    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...base,
      targetIssueId: "55555555-5555-4555-8555-555555555555",
    })).resolves.toMatchObject({ allowed: true, mode: "enforce", count: 1 });
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({
          sourceIssueId: "44444444-4444-4444-8444-444444444444",
          targetIssueId: "55555555-5555-4555-8555-555555555555",
        }),
      }),
    ]);
  });

  it("matrix row 2: the same write is still capped once the budget is spent", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT, contextless, [
      "44444444-4444-4444-8444-444444444444",
    ]);

    // Buying run context must not buy an uncapped run: the 20-write cap is the
    // containment control, and the fallback does not exempt from it.
    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...base,
      targetIssueId: "55555555-5555-4555-8555-555555555555",
    })).resolves.toMatchObject({ allowed: false, count: CROSS_ISSUE_INFLUENCE_LIMIT + 1 });
    expect(fake.inserted).toEqual([
      expect.objectContaining({ action: "issue.cross_issue_influence_cap_rejected" }),
    ]);
  });

  it("matrix row 3: a context-less run bound to nothing still fails closed", async () => {
    const fake = counterDb(0, contextless);

    // The guard this change must not weaken: no context source and no binding
    // anywhere leaves nothing to attribute the write to.
    await expect(observeCrossIssueInfluence(fake.db as never, {
      ...base,
      targetIssueId: "55555555-5555-4555-8555-555555555555",
    })).rejects.toMatchObject({
      status: 403,
      details: {
        code: "cross_issue_influence_run_context_required",
        reason: "no_context_source_and_target_unbound",
      },
    });
    expect(fake.inserted).toEqual([]);
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted"])(
    "ignores a %s run's stale binding on the issue",
    async (status) => {
      const fake = counterDb(0, { contextSnapshot: {}, status }, [
        "55555555-5555-4555-8555-555555555555",
      ]);

      // A finished run's stamp lingers on the issue row until cleanup runs. It
      // must not buy a later write an exemption from the cap.
      await expect(observeCrossIssueInfluence(fake.db as never, {
        ...base,
        targetIssueId: "55555555-5555-4555-8555-555555555555",
      })).rejects.toMatchObject({
        status: 403,
        details: {
          code: "cross_issue_influence_run_context_required",
          reason: "terminal_status",
        },
      });
    },
  );

  it("keeps master semantics for a run that already has a context source", async () => {
    // A context-ful run must not check its way past the cap: the binding is
    // scoped to runs whose context names no source.
    const fake = counterDb(0, contextless, ["55555555-5555-4555-8555-555555555555"]);
    const contextful = counterDb(0, { contextSnapshot: { issueId: "44444444-4444-4444-8444-444444444444" } });

    await expect(observeCrossIssueInfluence(contextful.db as never, {
      ...base,
      targetIssueId: "55555555-5555-4555-8555-555555555555",
    })).resolves.toMatchObject({ allowed: true, count: 1 });
    // The binding is never consulted, so it is not even read.
    expect(contextful.inserted).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ sourceIssueId: "44444444-4444-4444-8444-444444444444" }),
      }),
    ]);
    expect(fake.inserted).toEqual([]);
  });
});
