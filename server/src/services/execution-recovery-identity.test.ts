import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  EXECUTION_RECOVERY_DISPOSITION_KEY,
  executionRecoveryDispositionMerge,
  isExecutionRecoveryAlreadySettled,
  observeIssueForRecovery,
  readExecutionRecoveryDisposition,
  type ExecutionRecoveryDisposition,
} from "./execution-recovery-identity.js";

const runId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";

const settledIssue = {
  status: "blocked",
  assigneeAgentId: "33333333-3333-4333-8333-333333333333",
  executionRunId: null,
  checkoutRunId: null,
};

const disposition: ExecutionRecoveryDisposition = {
  runId,
  issueId,
  outcome: "blocked",
  recoveryActionId: "44444444-4444-4444-8444-444444444444",
  changedIssueState: true,
  settledAt: "2026-09-26T12:32:45.000Z",
  observed: observeIssueForRecovery(settledIssue),
};

const resultJson = {
  executionRecovery: { kind: "interrupted" },
  [EXECUTION_RECOVERY_DISPOSITION_KEY]: disposition,
};

describe("reading a settlement receipt", () => {
  it("round-trips a disposition written under the run's resultJson", () => {
    expect(readExecutionRecoveryDisposition(resultJson)).toEqual(disposition);
  });

  it.each([
    ["absent", { executionRecovery: { kind: "interrupted" } }],
    ["null", null],
    ["undefined", undefined],
    ["a non-object", "settled"],
    ["an array", [disposition]],
    ["a non-object disposition", { [EXECUTION_RECOVERY_DISPOSITION_KEY]: "done" }],
  ])("reads a %s resultJson as undecided", (_label, value) => {
    expect(readExecutionRecoveryDisposition(value)).toBeNull();
  });

  it.each([
    ["a missing runId", { ...disposition, runId: undefined }],
    ["a missing issueId", { ...disposition, issueId: 7 }],
    ["an unknown outcome", { ...disposition, outcome: "replayed" }],
    ["a missing observation", { ...disposition, observed: undefined }],
    ["an unobserved status", { ...disposition, observed: { assigneeAgentId: null } }],
  ])("refuses to read %s as a decision", (_label, broken) => {
    expect(
      readExecutionRecoveryDisposition({ [EXECUTION_RECOVERY_DISPOSITION_KEY]: broken }),
    ).toBeNull();
  });

  it("tolerates a receipt written before the receipt fields existed", () => {
    const read = readExecutionRecoveryDisposition({
      [EXECUTION_RECOVERY_DISPOSITION_KEY]: {
        runId,
        issueId,
        outcome: "blocked",
        observed: { status: "blocked" },
      },
    });
    expect(read).not.toBeNull();
    expect(read!.changedIssueState).toBe(false);
    expect(read!.recoveryActionId).toBe("");
    expect(read!.settledAt).toBe("");
    expect(read!.observed).toEqual({
      status: "blocked",
      assigneeAgentId: null,
      executionRunId: null,
      checkoutRunId: null,
    });
  });
});

describe("dedup keyed on (runId, issueId)", () => {
  it("recognises the repeat settlement of an unchanged issue", () => {
    expect(
      isExecutionRecoveryAlreadySettled({
        disposition: readExecutionRecoveryDisposition(resultJson),
        runId,
        issueId,
        issue: settledIssue,
      }),
    ).toBe(true);
  });

  it("does not care which action id the re-minted row carries", () => {
    // The whole defect: every sweep mints a new action, so a new id is the
    // normal case on the second visit, not evidence of a new decision.
    for (const reMintedId of ["a", "b", "c", "44444444-4444-4444-8444-444444444444"]) {
      expect(
        isExecutionRecoveryAlreadySettled({
          disposition: readExecutionRecoveryDisposition({
            [EXECUTION_RECOVERY_DISPOSITION_KEY]: { ...disposition, recoveryActionId: reMintedId },
          }),
          runId,
          issueId,
          issue: settledIssue,
        }),
      ).toBe(true);
    }
  });

  it("refuses a receipt that belongs to another run or another issue", () => {
    const check = (over: Partial<ExecutionRecoveryDisposition>, issue = settledIssue) =>
      isExecutionRecoveryAlreadySettled({
        disposition: readExecutionRecoveryDisposition({
          [EXECUTION_RECOVERY_DISPOSITION_KEY]: { ...disposition, ...over },
        }),
        runId,
        issueId,
        issue,
      });
    expect(check({ runId: "55555555-5555-4555-8555-555555555555" })).toBe(false);
    expect(check({ issueId: "66666666-6666-4666-8666-666666666666" })).toBe(false);
  });

  it.each([
    ["status", { status: "in_progress" }],
    ["assignee", { assigneeAgentId: "77777777-7777-4777-8777-777777777777" }],
    ["execution", { executionRunId: runId }],
    ["checkout", { checkoutRunId: runId }],
  ])("treats a change of %s as a genuinely new decision", (_label, drift) => {
    expect(
      isExecutionRecoveryAlreadySettled({
        disposition: readExecutionRecoveryDisposition(resultJson),
        runId,
        issueId,
        issue: { ...settledIssue, ...drift },
      }),
    ).toBe(false);
  });

  it("decides nothing when the run carries no receipt", () => {
    expect(
      isExecutionRecoveryAlreadySettled({
        disposition: readExecutionRecoveryDisposition({ executionRecovery: {} }),
        runId,
        issueId,
        issue: settledIssue,
      }),
    ).toBe(false);
  });
});

describe("observing the issue", () => {
  it("normalises absent owner and run bindings to null", () => {
    expect(observeIssueForRecovery({ status: "blocked" })).toEqual({
      status: "blocked",
      assigneeAgentId: null,
      executionRunId: null,
      checkoutRunId: null,
    });
    expect(observeIssueForRecovery({ status: "blocked", assigneeAgentId: undefined })).toEqual(
      observeIssueForRecovery({ status: "blocked" }),
    );
  });

  it("keeps a distinct assignee distinct from an absent one", () => {
    expect(
      observeIssueForRecovery({ status: "blocked", assigneeAgentId: "a" }).assigneeAgentId,
    ).not.toBe(observeIssueForRecovery({ status: "blocked" }).assigneeAgentId);
  });
});

describe("the durable merge that records a settlement", () => {
  const receiptParam = (query: ReturnType<PgDialect["sqlToQuery"]>) =>
    query.params.find(
      (param) => typeof param === "string" && param.includes(EXECUTION_RECOVERY_DISPOSITION_KEY),
    ) as string;

  it("adds the receipt to the run's own resultJson without discarding it", () => {
    const query = new PgDialect().sqlToQuery(
      executionRecoveryDispositionMerge(disposition),
    );
    // `coalesce(result_json, '{}') || <receipt>::jsonb` — additive, so the run's
    // own recovery notes survive and a second settlement overwrites only the key
    // this merge owns. A whole-row replace would lose `executionRecovery`.
    expect(query.sql).toMatch(/coalesce/i);
    expect(query.sql).toMatch(/\|\|/);
    expect(query.sql).toMatch(/::jsonb/i);
    expect(JSON.parse(receiptParam(query))[EXECUTION_RECOVERY_DISPOSITION_KEY]).toEqual(
      disposition,
    );
  });

  it("overwrites only the disposition key when the run already settled", () => {
    const again = new PgDialect().sqlToQuery(
      executionRecoveryDispositionMerge({
        ...disposition,
        recoveryActionId: "88888888-8888-4888-8888-888888888888",
        changedIssueState: false,
      }),
    );
    expect(Object.keys(JSON.parse(receiptParam(again)))).toEqual([
      EXECUTION_RECOVERY_DISPOSITION_KEY,
    ]);
  });
});
