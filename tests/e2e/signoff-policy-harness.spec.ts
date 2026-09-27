import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  TERMINAL_RUN_STATUSES,
  describeObservedRuns,
  everyObservedRunIsTerminal,
  invokeHeartbeatWithRetry,
  noIssueBoundRunError,
  type ObservedRun,
} from "./heartbeat-run-diagnostics";

/**
 * The signoff harness's own diagnostic, asserted without a server.
 *
 * `signoff-policy.spec.ts` can only report a run that died before it bound; it
 * cannot check that its own terminal-status set still says so. A run that the
 * watchdog ended with `timed_out` was once read as a harness that waited too
 * briefly, because `timed_out` was missing from the set. A hand-edited set
 * reintroduces that silently, so it is pinned here.
 *
 * Needs no board: `invokeHeartbeatWithRetry` takes the wait as a callback and the
 * board only to read run logs on the failure path, which a stub answers.
 */

const AGENT_ID = "agent-under-test";
const ISSUE_ID = "issue-under-test";
const BASE_URL = "http://127.0.0.1:1";

function observed(overrides: Partial<ObservedRun> & { id: string }): ObservedRun {
  return {
    agentId: AGENT_ID,
    status: null,
    errorCode: null,
    executionStage: null,
    boundIssueId: null,
    ...overrides,
  };
}

function observationsOf(...runs: ObservedRun[]): Map<string, ObservedRun> {
  return new Map(runs.map((run) => [run.id, run]));
}

/** A board whose run log is empty, so the failure path is exercised but silent. */
const silentBoard = {
  get: async () => ({ ok: () => false }),
} as unknown as APIRequestContext;

test.describe("signoff harness heartbeat-run diagnostics", () => {
  test("a timed_out run is terminal, so the retry fires", async () => {
    // The status that caused the original misdiagnosis: the watchdog ended the
    // run during setup, so it can never bind the issue and only a second invoke
    // can produce a usable run.
    expect(TERMINAL_RUN_STATUSES.has("timed_out")).toBe(true);
    expect(everyObservedRunIsTerminal(observationsOf(observed({ id: "run-1", status: "timed_out" })), AGENT_ID))
      .toBe(true);

    let attempts = 0;
    const observations = observationsOf(observed({ id: "run-1", status: "timed_out" }));
    const runId = await invokeHeartbeatWithRetry(
      silentBoard,
      BASE_URL,
      AGENT_ID,
      ISSUE_ID,
      observations,
      async () => {
        attempts += 1;
        return attempts === 1 ? null : "run-2";
      },
    );

    expect(attempts).toBe(2);
    expect(runId).toBe("run-2");
  });

  test("a timed_out run is reported by the failure message instead of the harness", async () => {
    const observations = observationsOf(
      observed({ id: "run-1", status: "timed_out", executionStage: "lease" }),
    );
    const message = (
      await noIssueBoundRunError(silentBoard, BASE_URL, AGENT_ID, ISSUE_ID, observations, 15_000)
    ).message;

    expect(describeObservedRuns(observations, AGENT_ID)).toContain("status=timed_out");
    expect(message).toContain("status=timed_out");
    // The server ended it, so the message must not blame the window.
    expect(message).toContain("the server ended it before setup finished");
    expect(message).not.toContain("the window was too short");
  });

  test("a live run is not retried, because it can still bind on its own", async () => {
    for (const status of ["queued", "scheduled_retry", "running"]) {
      expect(TERMINAL_RUN_STATUSES.has(status)).toBe(false);
      const observations = observationsOf(observed({ id: "run-1", status }));
      expect(everyObservedRunIsTerminal(observations, AGENT_ID)).toBe(false);

      let attempts = 0;
      await expect(
        invokeHeartbeatWithRetry(
          silentBoard,
          BASE_URL,
          AGENT_ID,
          ISSUE_ID,
          observations,
          async () => {
            attempts += 1;
            return null;
          },
        ),
      ).rejects.toThrow(/window was too short/);
      expect(attempts, `status=${status} must not trigger a second invoke`).toBe(1);
    }
  });

  test("a still-live run withholds the retry even beside a terminal one", async () => {
    // The safety property that the retry depends on: one live run plus one
    // timed-out run is not "every run is terminal", because a second invoke
    // would put two runs in a race for one issue lock.
    const observations = observationsOf(
      observed({ id: "run-1", status: "timed_out" }),
      observed({ id: "run-2", status: "running" }),
    );
    expect(everyObservedRunIsTerminal(observations, AGENT_ID)).toBe(false);

    let attempts = 0;
    await expect(
      invokeHeartbeatWithRetry(
        silentBoard,
        BASE_URL,
        AGENT_ID,
        ISSUE_ID,
        observations,
        async () => {
          attempts += 1;
          return null;
        },
      ),
    ).rejects.toThrow(/window was too short/);
    expect(attempts).toBe(1);
  });

  test("another agent's runs neither trigger nor are described", async () => {
    const observations = observationsOf(
      observed({ id: "run-1", status: "timed_out", agentId: "someone-else" }),
    );
    expect(everyObservedRunIsTerminal(observations, AGENT_ID)).toBe(false);
    expect(describeObservedRuns(observations, AGENT_ID)).toContain("no run of this agent was ever visible");

    let attempts = 0;
    await expect(
      invokeHeartbeatWithRetry(
        silentBoard,
        BASE_URL,
        AGENT_ID,
        ISSUE_ID,
        observations,
        async () => {
          attempts += 1;
          return null;
        },
      ),
    ).rejects.toThrow(/no run of this agent was ever visible/);
    expect(attempts).toBe(1);
  });

  test("the terminal set holds exactly the statuses a run cannot leave", () => {
    // `HEARTBEAT_RUN_STATUSES` is queued, scheduled_retry, running, then the five
    // terminal ones. A status outside both halves is a typo that makes a run
    // invisible, which is how `timed_out` was lost once.
    const live = ["queued", "scheduled_retry", "running"];
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(
      ["cancelled", "failed", "interrupted", "succeeded", "timed_out"],
    );
    for (const status of live) expect(TERMINAL_RUN_STATUSES.has(status)).toBe(false);
  });
});
