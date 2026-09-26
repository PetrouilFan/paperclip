import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A blocker edge must never be a one-way door (PET-392).
 *
 * `blockedByIssueIds` is the prescribed way to park an issue behind a dependency,
 * so an agent that follows the documented disposition correctly writes the edge
 * and then loses the ability to undo it. Measured on a live board, all six exits
 * are refused:
 *
 *   PATCH {status, blockedByIssueIds:[X]}   -> 200 accepted
 *   PATCH {status, blockedByIssueIds:[]}    -> 409, guard reads *pre-patch* edges
 *   PATCH {status}                          -> 409, same
 *   PATCH {blockedByIssueIds:[]}            -> 403, no `status` key is a cross-issue write
 *   POST /checkout                          -> 422 blocked by unresolved blockers
 *   POST /comments                          -> 403 run context, binding dropped on entry
 *
 * The root cause is a single shape repeated at every gate: each one asks
 * `getDependencyReadiness(...)` what is unresolved, which can only ever report
 * the edges as they were *before* the request, and then refuses the request for
 * having unresolved blockers. A request whose payload clears the blocker list
 * resolves the very condition being checked, so gating it on the stale read is
 * exactly backwards.
 *
 * The fix inverts the polarity: a request carrying an empty `blockedByIssueIds`
 * is exempt. That mirrors `requestAddsExplicitBlockers` in
 * `shouldImplicitlyMoveCommentedIssueToTodo`, which already suppresses the
 * implicit reopen when a request *adds* blockers — the file had half the rule
 * and not the other half.
 *
 * The behavioural tests for these gates need an embedded Postgres. This one does
 * not, and it is the guard that matters: the bug is the *recurrence* of the
 * shape, so a new gate added without the exemption has to fail here.
 */
const issuesSource = readFileSync(
  fileURLToPath(new URL("../routes/issues.ts", import.meta.url)),
  "utf8",
);

const REFUSAL = 'Issue follow-up blocked by unresolved blockers';

/** How far above a refusal the exemption is allowed to sit. */
const EXEMPTION_LOOKBEHIND_LINES = 16;

function refusalSites(): number[] {
  return issuesSource
    .split("\n")
    .flatMap((line, index) => (line.includes(REFUSAL) ? [index + 1] : []));
}

describe("unresolved-blocker refusals are not a one-way door (PET-392)", () => {
  it("finds the gates this invariant is meant to cover", () => {
    // Guards the guard: if a refactor moves or removes the refusal, the
    // assertions below would silently pass over an empty set.
    expect(refusalSites().length).toBeGreaterThanOrEqual(3);
  });

  it.each(refusalSites().map((line) => [line]))(
    "the refusal at issues.ts:%i exempts a request that clears the blocker list",
    (line) => {
      const lines = issuesSource.split("\n");
      const preceding = lines
        .slice(Math.max(0, line - 1 - EXEMPTION_LOOKBEHIND_LINES), line - 1)
        .join("\n");
      expect(preceding).toContain("requestClearsExplicitBlockers");
    },
  );

  it("does not exempt anything else: the clearing check is scoped to an empty list", () => {
    // Guards against the exemption being widened into "ignore readiness
    // entirely", which would let a genuinely blocked issue be resumed.
    const checks = issuesSource.match(
      /requestClearsExplicitBlockers\s*=\s*\n?\s*Array\.isArray\([^)]*\)\s*&&\s*\n?\s*[^;]*?\.length === 0/g,
    );
    expect(checks).not.toBeNull();
    expect(checks!.length).toBe(refusalSites().length);
    for (const check of checks!) {
      expect(check).toContain("blockedByIssueIds");
      expect(check).toContain(".length === 0");
    }
  });
});
