import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The zero-blocker-hold invariant, asserted at the source level.
 *
 * `POST /api/issues/:id` refuses to put an issue into `blocked` unless something
 * is actually holding it: unresolved dependency blockers, a pending
 * interaction/approval, or an `unblockDescriptor` naming an owner. Every internal
 * writer that skips the route skips that check, and the recovery sweeps are
 * exactly those writers — they are internal, and each one that wrote the bare
 * status produced an issue the server reported as blocked and as having nothing
 * blocking it at the same time.
 *
 * That combination is not untidy, it is terminal in practice: checkout refuses a
 * `blocked` issue, so the assignee cannot pick the work back up, and no blocker
 * exists for the dependency path to release. Nothing else can open it, because
 * the issue never says what would.
 *
 * The behavioural tests beside each sweep prove the writers that were caught
 * leave the exit they claim to. They cannot catch the *next* writer, because a
 * new sweep is not in anyone's test file yet. This one can: it reads every issue
 * write in the server and fails if one blocks an issue without also writing
 * something that holds it.
 */
const serverSrc = fileURLToPath(new URL("..", import.meta.url));

/**
 * The call expressions that persist an issue row. `issueService(db).update`,
 * `issuesSvc.update` and `db.update(issues).set` all bottom out in one of these
 * two names. Activity logs also mention `status: "blocked"`, but inside a
 * `details:` record rather than as a write, so only these two callees count.
 */
const WRITE_CALLEES = new Set(["update", "set"]);

/**
 * Blanks out everything that cannot affect brace matching — comment bodies,
 * string contents and template contents — while keeping offsets and newlines
 * intact, and reports which offsets fell inside a comment or a string so a
 * `status: "blocked"` occurring there can be told apart from real code.
 */
function maskNonCode(src: string): { masked: string; inLiteral: boolean[] } {
  const out = src.split("");
  const inLiteral = new Array<boolean>(src.length).fill(false);
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
      inLiteral[i] = true;
    }
  };
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const quote = src[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        // An unterminated literal runs to end of file; masking the rest is the
        // safe reading, and the scanner then reports nothing for this file.
        if (src[j] === "\n" && quote !== "`") break;
        j += 1;
      }
      blank(i + 1, Math.min(j, src.length));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return { masked: out.join(""), inLiteral };
}

function matchForward(masked: string, from: number, open: string, close: string) {
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    if (masked[i] === open) depth += 1;
    else if (masked[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the `{` that opens the object literal containing `at`. */
function enclosingObjectStart(masked: string, at: number) {
  let depth = 0;
  for (let i = at; i >= 0; i -= 1) {
    if (masked[i] === "}") depth += 1;
    else if (masked[i] === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * Index of the `(` that opens the call the object at `objectStart` is an
 * argument of, skipping over any arguments of that call that were passed inline.
 * `db.update(issues).set({ ... })` resolves to `set(`, not to `update(`.
 */
function enclosingCallOpen(masked: string, objectStart: number) {
  let depth = 0;
  for (let i = objectStart - 1; i >= 0; i -= 1) {
    if (masked[i] === ")") depth += 1;
    else if (masked[i] === "(") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

type Offender = { file: string; line: number; keys: string[] };

/**
 * True when the write leaves an exit. `blockedByIssueIds` counts because the
 * writers compute it from real unresolved blockers; the behavioural tests prove
 * the value is non-empty whenever a list is the only exit claimed. A
 * conditionally spread `unblockDescriptor` counts too, because the spread only
 * writes the key when the descriptor was actually built.
 */
function leavesExit(objectText: string) {
  return /\bblockedByIssueIds\b/.test(objectText) || /\bunblockDescriptor\b/.test(objectText);
}

function findBareBlockedWrites(source: string, file: string): Offender[] {
  const { masked, inLiteral } = maskNonCode(source);
  const offenders: Offender[] = [];
  const statusPattern = /status\s*:\s*(["'])blocked\1/g;

  for (let m = statusPattern.exec(source); m; m = statusPattern.exec(source)) {
    // The pattern is matched against the original text and the mask is only used
    // for structure, so a `"blocked"` inside a string or a comment still matches
    // here. Reject it: the `status` token itself is part of a literal, not code.
    if (inLiteral[m.index]) continue;

    const objectStart = enclosingObjectStart(masked, m.index);
    if (objectStart === -1) continue;
    const objectEnd = matchForward(masked, objectStart, "{", "}");
    if (objectEnd === -1) continue;
    const objectText = masked.slice(objectStart, objectEnd + 1);

    // Only a call argument is a write. An object in a property value is
    // something else entirely — `goalJson: { status: "blocked" }` records a
    // runner goal's state, not an issue's. `(`, `[` and `,` all introduce a call
    // argument; `:` introduces a property value.
    const before = masked.slice(0, objectStart).replace(/\s+$/, "");
    if (before.endsWith(":")) continue;

    // Not an issue write: `logActivity(tx, { status: "blocked", ... })` reports a
    // transition somebody else made.
    const callOpen = enclosingCallOpen(masked, objectStart);
    const callee =
      callOpen === -1
        ? null
        : /([A-Za-z_$][\w$]*)\s*$/.exec(masked.slice(0, callOpen));
    if (!callee || !WRITE_CALLEES.has(callee[1]!)) continue;
    if (leavesExit(objectText)) continue;

    const keys = [...objectText.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map(
      (k) => k[1]!,
    );
    offenders.push({
      file,
      line: masked.slice(0, m.index).split("\n").length,
      keys,
    });
  }
  return offenders;
}

function listServerSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      listServerSources(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    acc.push(full);
  }
  return acc;
}

describe("every issue write into `blocked` leaves an exit", () => {
  const files = [
    ...listServerSources(join(serverSrc, "services")),
    ...listServerSources(join(serverSrc, "routes")),
  ];

  it("audits a non-empty set of server sources", () => {
    // Otherwise the audit below passes vacuously if the file walk breaks.
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds no write that blocks an issue with neither blockers nor an unblock owner", () => {
    const offenders = files.flatMap((file) =>
      findBareBlockedWrites(readFileSync(file, "utf8"), relative(serverSrc, file)),
    );
    expect(
      offenders,
      `these writes set status: "blocked" with nothing holding the issue. Either ` +
        `write blockedByIssueIds from real unresolved blockers, or an ` +
        `unblockDescriptor naming who releases the hold:\n` +
        offenders.map((o) => `  ${o.file}:${o.line} — ${o.keys.join(", ")}`).join("\n"),
    ).toEqual([]);
  });

  it("flags a bare write, so the audit above is not vacuous", () => {
    // The exact shape the recovery sweeps used to write: the status, and nothing
    // that would release it.
    expect(
      findBareBlockedWrites(
        [
          "await issuesSvc.update(id, {",
          '  status: "blocked",',
          "  executionRunId: null,",
          "  checkoutRunId: null,",
          "});",
        ].join("\n"),
        "synthetic.ts",
      ),
    ).toEqual([
      {
        file: "synthetic.ts",
        line: 2,
        keys: ["status", "executionRunId", "checkoutRunId"],
      },
    ]);
  });

  it("accepts a write that records a real blocker list", () => {
    expect(
      findBareBlockedWrites(
        'await issuesSvc.update(id, { status: "blocked", blockedByIssueIds });',
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("accepts a conditionally written descriptor", () => {
    expect(
      findBareBlockedWrites(
        [
          "await issuesSvc.update(id, {",
          '  status: "blocked",',
          "  ...(unblockDescriptor ? { unblockDescriptor } : {}),",
          "});",
        ].join("\n"),
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("ignores an activity-log record that only reports a transition", () => {
    expect(
      findBareBlockedWrites(
        "await logActivity(tx, { details: { status: \"blocked\", previousStatus: \"in_progress\" } });",
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("ignores a blocked status that belongs to some other record", () => {
    // A runner goal's own lifecycle, written as a property value rather than as
    // a row update.
    expect(
      findBareBlockedWrites(
        [
          "await tx.update(agentTaskSessions).set({",
          "  goalJson: { status: 'blocked', workingNow: false, lastReason: reason },",
          "  goalStatus: 'blocked',",
          "});",
        ].join("\n"),
        "synthetic.ts",
      ),
    ).toEqual([]);
  });

  it("is not fooled by braces and statuses inside strings or comments", () => {
    expect(
      findBareBlockedWrites(
        [
          'await issuesSvc.update(id, { status: "blocked" });',
          '// await issuesSvc.update(id, { status: "blocked" });',
          'const note = \'{ status: "blocked" }\';',
          "/* issuesSvc.update(id, { status: 'blocked' }) */",
        ].join("\n"),
        "synthetic.ts",
      ),
    ).toEqual([
      { file: "synthetic.ts", line: 1, keys: ["status"] },
    ]);
  });
});
