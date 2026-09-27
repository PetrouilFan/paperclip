import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ISSUE_EXECUTION_MONITOR_LIVE_STATUSES } from "@paperclipai/shared";

/**
 * "Is there a live watch on this issue?" was asked independently in three
 * places, and two of the three spelled the answer as raw SQL — which is why a
 * TypeScript-scoped sweep of the enum's readers kept missing them. All three
 * re-spelled the same two-member set, and a member added to
 * `ISSUE_EXECUTION_MONITOR_STATE_STATUSES` would have fallen through all three
 * silently, in the direction that treats an armed-but-held watch as no watch at
 * all.
 *
 * These assertions are deliberately source-level. The predicate lives in SQL in
 * two of the three sites, so there is no exported value to assert on and no
 * behaviour to observe without a live database; a literal left in the source is
 * exactly the regression, and reading the source is the only check that sees it.
 */
const READERS = [
  "slack-conversation-state.ts",
  "execution-recovery-identity.ts",
  "slack-conversation-lifecycle.ts",
] as const;

function readServiceSource(name: (typeof READERS)[number]): string {
  return readFileSync(fileURLToPath(new URL(`../services/${name}`, import.meta.url)), "utf8");
}

describe("monitor liveness readers", () => {
  it.each(READERS)("%s derives its status set from the shared constant", (name) => {
    const source = readServiceSource(name);
    expect(source).toContain("ISSUE_EXECUTION_MONITOR_LIVE_STATUSES");
  });

  it.each(READERS)("%s does not re-spell the live set inline", (name) => {
    const source = readServiceSource(name);
    const hardcoded = new RegExp(
      `[\\[('"]\\s*${ISSUE_EXECUTION_MONITOR_LIVE_STATUSES[0]}\\s*['"]?\\s*,\\s*['"]?\\s*${ISSUE_EXECUTION_MONITOR_LIVE_STATUSES[1]}`,
    );
    expect(source).not.toMatch(hardcoded);
  });

  it("names the set's two members from the constant, not from a comment", () => {
    // The SQL reader inlines the members into a literal list because
    // `sql.raw` is what makes the correlated sub-select valid. That is the one
    // place the values appear as text, and it must be built from the constant.
    const source = readServiceSource("slack-conversation-state.ts");
    expect(source).toMatch(/ISSUE_EXECUTION_MONITOR_LIVE_STATUSES\.map\(/);
    expect(source).not.toMatch(/not in \('scheduled'/);
  });
});
