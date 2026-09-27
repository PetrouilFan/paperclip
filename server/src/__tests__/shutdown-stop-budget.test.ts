import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  resolveHeartbeatDrainBudgetMs,
  resolveShutdownWatchdogMs,
  SHUTDOWN_SCHEDULER_IDLE_TIMEOUT_MS,
  SHUTDOWN_STOP_BUDGET_MS,
  SHUTDOWN_STOP_RESERVE_MS,
} from "../shutdown.js";

/**
 * The drain budget and the stop budget have to be two numbers that agree, and
 * the only place that can be checked is here: `server/src/shutdown.ts` mirrors
 * `TimeoutStopSec` because the unit is not readable from inside the process.
 * A mirror is only honest if something compares it to the original, so this
 * file parses the renderer instead of trusting a comment.
 *
 * The relation being pinned is a floor, not a preference. Reducing
 * `TimeoutStopSec` while the drain can wait an hour converts "slow stop" into
 * "guaranteed cgroup-wide SIGKILL of the drain", which is worse than the hang it
 * was meant to shorten. Landing the reduction alone makes this worse, so the
 * test fails if the two ever stop fitting together.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const serviceManagerPath = path.join(repoRoot, "cli/src/services/service-manager.ts");
const serviceManagerSource = readFileSync(serviceManagerPath, "utf8");

function renderedUnitTimeoutStopSec(): number {
  // The renderer is a template literal, so the setting is matched as source
  // text. It is a single line with a literal value, and the CLI's own test
  // (`cli/src/__tests__/service-manager.test.ts`) pins the same string.
  const match = serviceManagerSource.match(/^TimeoutStopSec=(\d+)$/m);
  expect(
    match,
    `no TimeoutStopSec=<seconds> line in ${serviceManagerPath}; the rendered unit's stop budget is the number this file compares against`,
  ).not.toBeNull();
  return Number(match![1]);
}

describe("the run drain budget fits inside the rendered unit's stop budget", () => {
  it("derives the drain budget from the stop budget and leaves teardown headroom", () => {
    const unitStopSec = renderedUnitTimeoutStopSec();
    const unitStopBudgetMs = unitStopSec * 1000;
    const drainBudgetMs = resolveHeartbeatDrainBudgetMs({ stopBudgetMs: unitStopBudgetMs });

    // Strictly less, by construction and asserted: the drain must never be able
    // to consume the whole stop budget, because `finalizeServerShutdown` has to
    // run inside what is left over.
    expect(drainBudgetMs).toBeLessThan(unitStopBudgetMs);
    expect(drainBudgetMs).toBe(unitStopBudgetMs - SHUTDOWN_STOP_RESERVE_MS);
  });

  it("keeps SHUTDOWN_STOP_BUDGET_MS in step with the rendered TimeoutStopSec", () => {
    // The mirror and the original. A drift here means the drain budget is being
    // derived from a number the unit is not enforcing, which is the arithmetic
    // failure this ticket exists to close.
    expect(SHUTDOWN_STOP_BUDGET_MS).toBe(renderedUnitTimeoutStopSec() * 1000);
  });

  it("keeps the scheduler idle wait and the run drain inside the rendered stop budget", () => {
    // Both bounded waits are taken out of the same stop budget, so they have to
    // sum to less than it. The scheduler wait is a slice of the reserve, not an
    // addition to it, precisely so this holds. Checked against the *rendered*
    // value rather than the mirror, so a change to the unit alone is caught here
    // too instead of only by the mirror-drift test.
    const unitStopBudgetMs = renderedUnitTimeoutStopSec() * 1000;
    expect(SHUTDOWN_SCHEDULER_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(SHUTDOWN_STOP_RESERVE_MS);
    expect(
      SHUTDOWN_SCHEDULER_IDLE_TIMEOUT_MS + resolveHeartbeatDrainBudgetMs(),
    ).toBeLessThan(unitStopBudgetMs);
  });

  it("keeps the watchdog outside both drains and inside the rendered stop budget", () => {
    // A watchdog armed *below* the waits it guards would fire while a legitimate
    // run drain was still counting down, turning a slow stop into the very
    // cgroup SIGKILL it exists to prevent. So the sum is the number, and it
    // still has to leave room for the ordered teardown.
    const unitStopBudgetMs = renderedUnitTimeoutStopSec() * 1000;
    const watchdogMs = resolveShutdownWatchdogMs();
    expect(watchdogMs).toBeGreaterThan(resolveHeartbeatDrainBudgetMs());
    expect(watchdogMs).toBeGreaterThan(SHUTDOWN_SCHEDULER_IDLE_TIMEOUT_MS);
    expect(watchdogMs).toBeLessThan(unitStopBudgetMs);
  });

  it("is far below the 3600 s adapter run ceiling, so a long run is abandoned rather than waited out", () => {
    // `adapter_config.timeoutSec` is 3600 on every `opencode_local` agent
    // (raised from 1800 by an earlier change to all eight of them), and the
    // drain waits for an in-flight run.
    // A drain budget at or above that ceiling is not a bound, it is a promise to
    // be SIGKILLed. This is the inequality that makes a healthy shutdown
    // possible at all while a long run is in flight.
    const adapterRunCeilingMs = 3600 * 1000;
    expect(resolveHeartbeatDrainBudgetMs()).toBeLessThan(adapterRunCeilingMs);
  });

  it("refuses a reserve that would leave the drain no budget", () => {
    expect(() => resolveHeartbeatDrainBudgetMs({ stopBudgetMs: 1000, reserveMs: 1000 })).toThrow(
      /must be positive/,
    );
    expect(() => resolveHeartbeatDrainBudgetMs({ stopBudgetMs: 1000, reserveMs: 2000 })).toThrow(
      /must be positive/,
    );
  });
});
