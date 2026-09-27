// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveMonitorState,
  formatMonitorAbsolute,
  formatMonitorAbsoluteFull,
  formatMonitorEta,
  formatMonitorEtaLabel,
  formatMonitorOffset,
  useMonitorCountdown,
} from "./issue-monitor";

describe("monitor time formatting", () => {
  const now = new Date("2026-07-17T19:56:00.000Z");

  it.each([
    [45_000, "in 45s"],
    [5 * 60_000, "in 5m"],
    [2 * 60 * 60_000, "in 2h"],
    [(2 * 60 + 12) * 60_000, "in 2h 12m"],
    [(2 * 60 + 59) * 60_000, "in 2h 59m"],
    [(3 * 24 + 4) * 60 * 60_000, "in 3d 4h"],
    [3 * 24 * 60 * 60_000, "in 3d"],
  ])("formats future offset %i with up to two non-zero units", (offsetMs, expected) => {
    expect(formatMonitorEta(new Date(now.getTime() + offsetMs), now)).toBe(expected);
  });

  it("uses due-now grace before switching to overdue copy", () => {
    expect(formatMonitorEta(now, now)).toBe("due now");
    expect(formatMonitorEta(new Date(now.getTime() - 59_999), now)).toBe("due now");
    expect(formatMonitorEta(new Date(now.getTime() - 60_000), now)).toBe("overdue by 1m");
    expect(formatMonitorEta(new Date(now.getTime() - 12 * 60_000), now)).toBe("overdue by 12m");
  });

  it("formats sentence-case ETA labels without slicing prefixes", () => {
    expect(formatMonitorEtaLabel(new Date(now.getTime() + (2 * 60 + 12) * 60_000), now)).toBe("In 2h 12m");
    expect(formatMonitorEtaLabel(now, now)).toBe("Due now");
    expect(formatMonitorEtaLabel(new Date(now.getTime() - 18 * 60_000), now)).toBe("Overdue by 18m");
  });

  it("uses the injectable Date.now clock for scheduled retry offsets", () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    expect(formatMonitorOffset(new Date(now.getTime() + 15 * 60_000))).toBe("in 15m");
    expect(formatMonitorOffset(new Date(now.getTime() + 10_000))).toBe("now");
    expect(formatMonitorOffset(now)).toBe("now");
    dateNowSpy.mockRestore();
  });

  it("formats the full local timestamp with weekday, year and zone", () => {
    const timestamp = "2026-07-17T21:08:00.000Z";
    const options = { locale: "en-US", timeZone: "America/Chicago" } as const;

    expect(formatMonitorAbsoluteFull(timestamp, options)).toBe("Friday, July 17, 2026, 4:08:00 PM CDT");
  });

  describe("formatMonitorAbsolute compact copy (wireframe 04)", () => {
    const options = { locale: "en-US", timeZone: "America/Chicago" } as const;
    // 2026-07-17T21:08:00Z is 4:08 PM in America/Chicago.
    const timestamp = "2026-07-17T21:08:00.000Z";

    it("says Today when the check lands on the reference day", () => {
      const now = "2026-07-17T14:00:00.000Z"; // 9:00 AM Chicago, same day
      expect(formatMonitorAbsolute(timestamp, options, now)).toBe("Today, 4:08 PM");
    });

    it("compares the day in the display time zone, not UTC", () => {
      // 2026-07-18T04:08:00Z is still 11:08 PM on Jul 17 in Chicago.
      const lateNight = "2026-07-18T04:08:00.000Z";
      const now = "2026-07-17T14:00:00.000Z"; // 9:00 AM Chicago, Jul 17
      expect(formatMonitorAbsolute(lateNight, options, now)).toBe("Today, 11:08 PM");
    });

    it("prefixes the weekday beyond today within the current year", () => {
      const later = "2026-07-20T14:00:00.000Z"; // 9:00 AM Chicago, Mon Jul 20
      const now = "2026-07-17T14:00:00.000Z";
      expect(formatMonitorAbsolute(later, options, now)).toBe("Mon Jul 20, 9:00 AM");
    });

    it("adds the year only when it differs from the reference year", () => {
      const nextYear = "2027-01-04T15:00:00.000Z"; // 9:00 AM Chicago, Mon Jan 4 2027
      const now = "2026-07-17T14:00:00.000Z";
      expect(formatMonitorAbsolute(nextYear, options, now)).toBe("Mon Jan 4, 2027, 9:00 AM");
    });
  });
});

describe("deriveMonitorState", () => {
  const now = new Date("2026-07-17T20:00:00.000Z");

  it("derives scheduled and retrying states with monitor details", () => {
    expect(
      deriveMonitorState(
        {
          executionPolicy: { monitor: { nextCheckAt: "2026-07-17T22:12:00.000Z", serviceName: "API" } },
          executionState: {
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-07-17T22:12:00.000Z",
              attemptCount: 1,
              serviceName: "API",
            },
          },
        },
        now,
      ),
    ).toEqual({
      state: "scheduled",
      source: "monitor",
      nextCheckAt: "2026-07-17T22:12:00.000Z",
      attemptCount: 1,
      serviceName: "API",
    });

    expect(
      deriveMonitorState(
        {
          executionState: {
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-07-17T22:12:00.000Z",
              attemptCount: 3,
              serviceName: "deploy health",
            },
          },
        },
        now,
      ).state,
    ).toBe("retrying");
  });

  it("derives due-now and overdue at the grace boundary", () => {
    const issue = (nextCheckAt: string) => ({
      executionState: { monitor: { status: "scheduled" as const, nextCheckAt, attemptCount: 1 } },
    });

    expect(deriveMonitorState(issue("2026-07-17T19:59:00.001Z"), now).state).toBe("due-now");
    expect(deriveMonitorState(issue("2026-07-17T19:59:00.000Z"), now).state).toBe("overdue");
  });

  it.each(["queued", "running", "cancelled"] as const)("ignores a %s retry's historical start time", (status) => {
    const issue = {
      status: "in_progress",
      scheduledRetry: {
        status,
        scheduledRetryAt: "2026-07-17T19:58:00.000Z",
        scheduledRetryAttempt: 1,
      },
    };

    expect(deriveMonitorState(issue, now)).toMatchObject({ state: "none", nextCheckAt: null });
    // A separate, explicitly scheduled monitor must still be visible.
    expect(deriveMonitorState({ ...issue, monitorNextCheckAt: "2026-07-17T20:05:00.000Z" }, now))
      .toMatchObject({ state: "scheduled", source: "monitor" });
  });

  it("keeps overdue warnings for retries that have not been promoted", () => {
    expect(deriveMonitorState({
      scheduledRetry: { status: "scheduled_retry", scheduledRetryAt: "2026-07-17T19:58:00.000Z" },
    }, now)).toMatchObject({ state: "overdue", source: "scheduled-retry" });
  });

  it.each(["done", "cancelled"])("ignores stale monitor and retry schedules on %s tasks", (status) => {
    const scheduledRetry = { status: "scheduled_retry" as const, scheduledRetryAt: "2026-07-17T19:58:00.000Z" };
    expect(deriveMonitorState({ status, scheduledRetry }, now)).toMatchObject({ state: "none", nextCheckAt: null });
    expect(deriveMonitorState({ status, monitorNextCheckAt: scheduledRetry.scheduledRetryAt }, now))
      .toMatchObject({ state: "none", nextCheckAt: null });
  });

  it("derives cleared, none, and scheduled retry states", () => {
    expect(
      deriveMonitorState({ executionState: { monitor: { status: "cleared", attemptCount: 2 } } }, now),
    ).toMatchObject({ state: "cleared", attemptCount: 2 });
    expect(deriveMonitorState({}, now)).toEqual({
      state: "none",
      source: "none",
      nextCheckAt: null,
      attemptCount: 0,
      serviceName: null,
    });
    expect(
      deriveMonitorState(
        {
          monitorAttemptCount: 0,
          scheduledRetry: {
            status: "scheduled_retry",
            scheduledRetryAt: "2026-07-17T20:05:00.000Z",
            scheduledRetryAttempt: 2,
          },
        },
        now,
      ),
    ).toMatchObject({ state: "retrying", source: "scheduled-retry", attemptCount: 2 });
  });
});

/**
 * The board re-derived "can this watch fire?" from `issue.status` alone and never
 * read the `suspended` / `suspendedReason` the server sends. That predicate was a
 * strict subset of the server's — it ignored the assignee — so an issue held for
 * want of an agent rendered a red "overdue by 2h" countdown naming a check the
 * server had already declared it would not make.
 */
describe("deriveMonitorState suspension", () => {
  const now = new Date("2026-09-27T08:40:48.000Z");
  const overdueBy = "2026-09-27T06:40:48.000Z";

  /** The payload `GET /api/issues/{id}` sends for a held issue. */
  function projectedMonitor(suspendedReason: "host_status" | "host_assignee" | null) {
    return {
      executionState: {
        monitor: {
          status: suspendedReason ? ("suspended" as const) : ("scheduled" as const),
          nextCheckAt: overdueBy,
          attemptCount: 9,
          serviceName: "model-liveness-probe",
          ...(suspendedReason ? { suspendedReason } : {}),
        },
      },
    };
  }

  it.each(["in_progress", "in_review"] as const)(
    "reads the server's verdict on a %s issue instead of counting an overdue watch",
    (status) => {
      const derived = deriveMonitorState(
        { status, ...projectedMonitor("host_assignee") },
        now,
      );
      expect(derived.state).toBe("suspended");
      expect(derived.suspendedReason).toBe("host_assignee");
    },
  );

  it("trusts a projected `suspended` even when the row looks runnable", () => {
    // The payload is the authority. A client that second-guesses it is back to
    // two predicates, which is the drift this replaced.
    const derived = deriveMonitorState(
      { status: "in_progress", assigneeAgentId: "agent-1", ...projectedMonitor("host_status") },
      now,
    );
    expect(derived.state).toBe("suspended");
  });

  it("keeps the cadence on a suspended watch, so the banner can still show when it was due", () => {
    const derived = deriveMonitorState({ status: "blocked", ...projectedMonitor("host_status") }, now);
    expect(derived).toMatchObject({
      state: "suspended",
      nextCheckAt: overdueBy,
      attemptCount: 9,
      serviceName: "model-liveness-probe",
    });
  });

  it("derives the same verdict on an unprojected read, with the full predicate", () => {
    // List rows and relation summaries carry the stored `scheduled`, not the
    // projection. The board still has to be right there, which is why the
    // fallback is the shared predicate rather than a status-only subset.
    const stored = { executionState: { monitor: { status: "scheduled" as const, nextCheckAt: overdueBy, attemptCount: 9 } } };
    expect(deriveMonitorState({ status: "blocked", assigneeAgentId: "agent-1", ...stored }, now))
      .toMatchObject({ state: "suspended", suspendedReason: "host_status" });
    expect(deriveMonitorState({ status: "todo", assigneeAgentId: null, assigneeUserId: "u1", ...stored }, now))
      .toMatchObject({ state: "suspended", suspendedReason: "host_assignee" });
    // …and a genuinely runnable issue is left alone.
    expect(deriveMonitorState({ status: "in_progress", assigneeAgentId: "agent-1", ...stored }, now).state)
      .toBe("overdue");
  });

  it("keeps a terminal issue's stale monitor out of the picture", () => {
    expect(deriveMonitorState({ status: "done", ...projectedMonitor(null) }, now).state).toBe("none");
  });

  it("does not invent a suspension for a read that projects nothing and says nothing", () => {
    // An absent status is not evidence that the watch is held. Suspending here
    // would replace a working countdown with a false alarm.
    const derived = deriveMonitorState(
      { executionState: { monitor: { status: "scheduled", nextCheckAt: "2026-09-27T09:40:48.000Z", attemptCount: 1 } } },
      now,
    );
    expect(derived.state).toBe("scheduled");
  });

  it("reports a suspended watch with no reason rather than naming a cause it was not told", () => {
    const derived = deriveMonitorState(
      { status: "in_progress", executionState: { monitor: { status: "suspended", nextCheckAt: overdueBy, attemptCount: 9 } } },
      now,
    );
    expect(derived.state).toBe("suspended");
    expect(derived.suspendedReason).toBeUndefined();
  });
});

describe("useMonitorCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T20:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks every 30 seconds normally, every second near due, and cleans up", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const observed: number[] = [];

    function Probe({ nextCheckAt }: { nextCheckAt: string | null }) {
      observed.push(useMonitorCountdown(nextCheckAt).getTime());
      return null;
    }

    flushSync(() => root.render(<Probe nextCheckAt="2026-07-17T20:02:00.000Z" />));
    expect(vi.getTimerCount()).toBe(1);

    flushSync(() => vi.advanceTimersByTime(30_000));
    expect(observed.at(-1)).toBe(new Date("2026-07-17T20:00:30.000Z").getTime());

    flushSync(() => root.render(<Probe nextCheckAt="2026-07-17T20:00:45.000Z" />));
    flushSync(() => vi.advanceTimersByTime(1_000));
    expect(observed.at(-1)).toBe(new Date("2026-07-17T20:00:31.000Z").getTime());

    flushSync(() => root.render(<Probe nextCheckAt={null} />));
    expect(vi.getTimerCount()).toBe(0);

    flushSync(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
