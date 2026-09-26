import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guard on the one `markShutdownIntent` call site.
 *
 * `shutdownIntent` in embedded-postgres-supervisor.ts is a one-way, process-wide
 * latch with no reset. Once it is set the supervisor classifies every later exit of
 * the managed PostgreSQL as controlled and never recovers:
 *
 *     if (shutdownIntent) {
 *       options.onControlledExit?.("shutdown_requested", code, signal);
 *       return;
 *     }
 *
 * So the entire safety of the latch rests on one rule: mark the intent only from a
 * path that is going down. `shutdown()` in index.ts is the only such path today —
 * the SIGINT/SIGTERM handlers run it with `exitProcess: true` and it ends in
 * `process.exit(0)`, and the programmatic export runs it with `exitProcess: false`
 * while its own caller is already tearing the server down.
 *
 * Nothing enforced that rule. The behavioural tests in
 * embedded-postgres-supervisor.test.ts drive the supervisor directly and never load
 * index.ts, so a second call site — a "restart the embedded database", a "pause the
 * supervisor", a reconfigure — would silently kill crash recovery for the rest of
 * the process lifetime with the whole suite still green. These assertions fail
 * instead, at CI time, at the moment the invariant is broken.
 */

const SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_TS = join(SERVER_SRC, "index.ts");

/**
 * A member call: `supervisor.markShutdownIntent()` or the optional-chained
 * `supervisor?.markShutdownIntent()`. The interface declaration
 * (`markShutdownIntent(): void;`) and the supervisor's own definition
 * (`markShutdownIntent: () => { shutdownIntent = true; }`) are not member calls and
 * so do not match, which is what keeps the definition itself from counting.
 */
const MEMBER_CALL_PATTERN = String.raw`\??\.\s*markShutdownIntent\s*\(\s*\)`;

/** The bare identifier, to catch a destructured/bare call or a copied second latch. */
const MENTION_PATTERN = String.raw`\bmarkShutdownIntent\b`;

/**
 * A call to the local `shutdown(signal, exitProcess)` with a literal second argument.
 *
 * The signal-literal alternative must admit digits. `SIGUSR1` and `SIGUSR2` are the two
 * signals POSIX reserves for whatever a program wants to hang its own handlers on, so they
 * are the most likely names for a reconfigure or pause-the-supervisor path — exactly the
 * paths that mark the intent without exiting. With `[A-Z]+` such a call matched nothing at
 * all and the guard below passed on it silently, which is the exact failure this file exists
 * to prevent. The identifier alternative still covers a signal held in a variable.
 */
const SHUTDOWN_CALL_PATTERN = String.raw`\bshutdown\(\s*(?:"[A-Z0-9]+"|[A-Za-z_$][\w$]*)\s*,\s*(true|false)\s*\)`;

/**
 * `shutdown` is the next local declaration; the first `process.once(` after it is
 * the SIGINT registration that closes the body. The marker is deliberately
 * quote-free, because this body is matched against stripped source where string
 * literals are blanked and `process.once("SIGINT"` is not there to be found.
 */
const SHUTDOWN_START = "const shutdown = async (";
const SHUTDOWN_END = "process.once(";

/** Production sources only: a mark inside a test proves nothing about the latch. */
function productionSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...productionSources(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    found.push(full);
  }
  return found;
}

/**
 * Blanks non-code while preserving every offset and newline, so a match found in
 * the result maps to the same line in the original source.
 *
 * This is not cosmetic: the comment sitting above the real call site reads "Record
 * the shutdown before the first await", and a naive `/\bawait\b/` scan over raw
 * source finds that prose at index 138 and reports the real mark at 571 as being
 * far too late. Comments must not be able to satisfy or break this guard.
 *
 * `keepStrings` decides how much is blanked, and the choice matters per caller:
 *
 * - `false` also blanks string bodies, for the searches that must not be satisfied
 *   by prose. The call site is `shutdown("SIGTERM", false)`, so an earlier revision
 *   of this guard that scanned with strings blanked matched no string-argument call
 *   at all and passed a file containing a non-teardown `shutdown(..., false)`.
 * - `true` keeps string bodies verbatim, for the call-expression scan that needs the
 *   signal names.
 *
 * It is a small scanner, not a JavaScript tokenizer: it does not model regex
 * literals, so in `adapters/cursor-models.ts` the `/^["'`]+|["'`]+$/g` character
 * class is read as a string and blanks a short span. That file holds no shutdown
 * mark, and `index.ts` — the only file this guard actually constrains — has no
 * quote-bearing regex literal. `readProductionSource` still checks length and line
 * count per file, so any imbalance fails loudly instead of shifting a line number.
 */
function scanSource(source: string, keepStrings: boolean): string {
  const out: string[] = [];
  const n = source.length;
  let i = 0;
  // Every branch below consumes exactly as many source characters as it pushes, so
  // the result is always the same length as the input and keeps its line breaks.
  while (i < n) {
    const ch = source[i]!;
    if (ch === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      if (i < n) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out.push(keepStrings ? quote : " ");
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          out.push(source[i], source[i + 1] ?? " ");
          i += 2;
          continue;
        }
        const closed = source[i] === quote;
        out.push(keepStrings ? source[i] : source[i] === "\n" ? "\n" : " ");
        i += 1;
        if (closed) break;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/** Comments and string bodies blanked: safe to search for `await` and for marks. */
function stripCommentsAndStrings(source: string): string {
  return scanSource(source, false);
}

/** Only comments blanked: string literals stay readable for call-expression scans. */
function stripComments(source: string): string {
  return scanSource(source, true);
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** Strips one scanned file and asserts the offset contract the guard depends on. */
function readProductionSource(file: string): string {
  const raw = readFileSync(file, "utf8");
  const stripped = stripCommentsAndStrings(raw);
  const where = relative(SERVER_SRC, file);
  expect(stripped, `${where}: stripping changed its length`).toHaveLength(raw.length);
  expect(
    stripped.split("\n"),
    `${where}: stripping changed its line count`,
  ).toHaveLength(raw.split("\n").length);
  return stripped;
}

/** Same offset contract, but with string literals left readable. */
function readSourceKeepingStrings(file: string): string {
  const raw = readFileSync(file, "utf8");
  const stripped = stripComments(raw);
  const where = relative(SERVER_SRC, file);
  expect(stripped, `${where}: stripping changed its length`).toHaveLength(raw.length);
  expect(
    stripped.split("\n"),
    `${where}: stripping changed its line count`,
  ).toHaveLength(raw.split("\n").length);
  return stripped;
}

/** `index.ts` with comments and string bodies blanked; offsets still map to the file. */
function readIndexStripped(): string {
  return readProductionSource(INDEX_TS);
}

/** `shutdown()` out of an already-stripped `index.ts`. */
function shutdownBody(stripped: string): string {
  const start = stripped.indexOf(SHUTDOWN_START);
  expect(start, `index.ts no longer declares \`${SHUTDOWN_START}\``).toBeGreaterThan(-1);
  const end = stripped.indexOf(SHUTDOWN_END, start);
  expect(
    end,
    `index.ts no longer registers a process.once(...) signal handler after \`${SHUTDOWN_START}\``,
  ).toBeGreaterThan(start);
  return stripped.slice(start, end);
}

describe("embedded PostgreSQL shutdown-intent call site", () => {
  it("keeps offsets and line numbers intact while stripping", () => {
    // Every other assertion here reads a match offset out of the stripped source and
    // resolves it against the original file to name a line in a failure message. If
    // the stripper changed length the guard would still "pass" while pointing at the
    // wrong lines, so length preservation is asserted directly rather than assumed.
    const sample = [
      'const url = "https://example.com/a"; // await markShutdownIntent()',
      "/* block await markShutdownIntent() */",
      "const tpl = `line one await ${x} line two`;",
      'const esc = "quote \\" and await";',
      "real(); await markShutdownIntent();",
    ].join("\n");

    const stripped = stripCommentsAndStrings(sample);
    expect(stripped).toHaveLength(sample.length);
    expect(stripped.split("\n")).toHaveLength(sample.split("\n").length);

    // Comment and string bodies are blanked, so prose that merely mentions a mark or
    // an await cannot satisfy the guard that searches this text.
    expect(stripped).not.toContain("example.com");
    expect(stripped).not.toContain("block await");
    expect(stripped).not.toContain("line one");
    expect(stripped).not.toContain("quote");

    // The `//` inside the string on line 1 is not a comment opener, so the block
    // comment on line 2 is still recognised and does not swallow the code after it.
    expect(stripped).toContain("real(); await markShutdownIntent();");
  });

  it("marks the shutdown intent from exactly one production call site", () => {
    const callSites = productionSources(SERVER_SRC).flatMap((file) => {
      const source = readProductionSource(file);
      return [...source.matchAll(new RegExp(MEMBER_CALL_PATTERN, "g"))].map((match) => ({
        file: relative(SERVER_SRC, file),
        line: lineOf(source, match.index),
      }));
    });

    // The latch is process-wide and one-way, so the second mark is the defect this
    // ticket is about — wherever it lands, in whatever shape it takes.
    //
    // The assertion is deliberately on the *count* and the *file*, not on the line
    // number. Pinning a line number in index.ts would break this test on every
    // unrelated comment or import edit above the call site, and the line number
    // carries none of the invariant: that the mark is unique, and that it is in
    // index.ts at all. The next test pins down which part of index.ts it is in.
    expect(
      callSites.map((site) => site.file),
      "markShutdownIntent() must be called from `shutdown()` in index.ts only. Any " +
        "other call site can mark the intent on a path that does not exit, which " +
        "disables PostgreSQL crash recovery for the rest of the process lifetime. " +
        "Move that work inside shutdown(), or stop marking the intent for it. Found: " +
        callSites.map((site) => `${site.file}:${site.line}`).join(", "),
    ).toEqual(["index.ts"]);
  });

  it("keeps the shutdown-intent mark inside shutdown() itself", () => {
    const body = shutdownBody(readIndexStripped());
    const mark = body.search(new RegExp(MEMBER_CALL_PATTERN));

    expect(
      mark,
      "shutdown() must mark the shutdown intent; the supervisor has no other " +
        "in-process path that records it",
    ).toBeGreaterThan(-1);
  });

  it("marks the shutdown intent before the first await of shutdown()", () => {
    const body = shutdownBody(readIndexStripped());
    const mark = body.search(new RegExp(MEMBER_CALL_PATTERN));
    const firstAwait = body.search(/\bawait\b/);
    expect(firstAwait, "shutdown() must contain an awaited teardown step").toBeGreaterThan(-1);

    // A unit with `KillMode=control-group` SIGTERMs PostgreSQL in the same cgroup
    // at the same moment, so its clean `code=0` exit can land while the teardown
    // below is still draining runs and connections. Any await before the mark
    // reopens that window and the supervisor reads our own stop as a crash.
    expect(
      mark,
      "the shutdown-intent mark must be the first statement of shutdown(), before " +
        "any await, so a cgroup SIGTERM cannot land an exit before the intent is set",
    ).toBeLessThan(firstAwait);
  });

  it("confines the shutdown-intent identifier to the supervisor and its one caller", () => {
    const mentions = productionSources(SERVER_SRC)
      .filter((file) => new RegExp(MENTION_PATTERN, "g").test(readProductionSource(file)))
      .map((file) => relative(SERVER_SRC, file))
      .sort();

    // Catches a bare or destructured `markShutdownIntent()` that the member-call
    // pattern above cannot see, and a second latch copied into a new module.
    expect(mentions).toEqual([
      "embedded-postgres-supervisor.ts",
      "index.ts",
    ]);
  });

  it("sees every signal spelling, including the digit-bearing user signals", () => {
    // Self-test for the scanner itself. A hole in SHUTDOWN_CALL_PATTERN is invisible from
    // the outside: the scan simply finds fewer calls, the "non-exiting callers" list stays
    // short, and every assertion below it passes. `SIGUSR1`/`SIGUSR2` are the signals a
    // program is expected to use for its own reconfigure/pause handlers, so a pattern that
    // skipped them would miss the very call this ticket is about.
    const seen = (line: string) =>
      [...line.matchAll(new RegExp(SHUTDOWN_CALL_PATTERN, "g"))].map((m) => m[0]);

    expect(seen('void shutdown("SIGTERM", true);')).toHaveLength(1);
    expect(seen('void shutdown("SIGINT", true);')).toHaveLength(1);
    expect(seen('void shutdown("SIGUSR1", false);')).toHaveLength(1);
    expect(seen('void shutdown("SIGUSR2", false);')).toHaveLength(1);
    expect(seen("void shutdown(SOME_SIGNAL, false);")).toHaveLength(1);

    // The literal branch is still anchored: a lowercase or non-signal token is a different
    // call and must not be counted as evidence either way.
    expect(seen('void shutdown("sigterm", false);')).toHaveLength(0);
    expect(seen("void shutdown(signal, maybe);")).toHaveLength(0);
  });

  it("only runs shutdown() without exiting the process from the teardown export", () => {
    const lines = readFileSync(INDEX_TS, "utf8").split("\n");
    // Strings are kept here: the callers are `shutdown("SIGTERM", false)`, and
    // scanning a strings-blanked copy would match no signal-named call at all.
    const stripped = readSourceKeepingStrings(INDEX_TS);
    const calls = [...stripped.matchAll(new RegExp(SHUTDOWN_CALL_PATTERN, "g"))].map(
      (match) => ({ index: match.index, exiting: match[1] === "true" }),
    );

    // The two signal handlers must still be visible to this scan, otherwise the loop
    // below is checking a single call and the guard is weaker than it reads.
    expect(
      calls.filter((call) => call.exiting).length,
      "expected the SIGINT/SIGTERM handlers to call shutdown(..., true)",
    ).toBeGreaterThanOrEqual(2);

    // `exitProcess: true` ends in process.exit(0), so those callers are safe. The
    // `false` branch is the one shape that marks intent without exiting; today it is
    // only safe because the programmatic export is itself mid-teardown.
    const nonExiting = calls.filter((call) => !call.exiting);
    expect(
      nonExiting.length,
      "expected the programmatic shutdown export to keep its exitProcess: false call",
    ).toBeGreaterThan(0);

    for (const call of nonExiting) {
      const lineNumber = lineOf(stripped, call.index);
      expect(
        lines[lineNumber - 1],
        `index.ts:${lineNumber} calls shutdown(..., false), which marks ` +
          "the shutdown intent but never exits the process. The one caller allowed to " +
          "do that is the programmatic teardown export on the returned object.",
      ).toMatch(/shutdown\s*:/);
    }

    expect(
      shutdownBody(stripped),
      "shutdown() must still end in process.exit(0) for its exitProcess: true callers",
    ).toMatch(/if\s*\(\s*exitProcess\s*\)\s*process\.exit\(\s*0\s*\)/);
  });
});
