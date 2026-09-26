import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXIT_DRIFT,
  EXIT_OK,
  EXIT_UNEVALUATED,
  RUNNING_BUILD_SENTINELS,
  evaluateSentinels,
  formatReport,
  resolveRunningServerDist,
  runCheck,
  runningServerDistCandidates,
  summarize,
} from "./check-running-build-drift.mjs";

/** A dist root with the given `services/<file>` contents. */
function distRootWith(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "drift-dist-"));
  mkdirSync(path.join(root, "services"), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(root, "services", name), contents);
  }
  return root;
}

/** A `git show HEAD:<path>` stub that serves one file body. */
function gitServing(sourcePath, body) {
  return (args) => {
    const spec = args[1];
    if (spec === `HEAD:${sourcePath}`) return body;
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
}

const FIXTURE = {
  id: "fixture",
  sinceCommit: "abc1234",
  sourcePath: "server/src/services/example.ts",
  distPath: "services/example.js",
  markers: ["GUARD_SYMBOL"],
  summary: "example guard",
};

test("a sentinel whose marker is in both source and dist reads as deployed", () => {
  const root = distRootWith({ "example.js": "function GUARD_SYMBOL() {}\n" });
  const [result] = evaluateSentinels([FIXTURE], {
    distRoot: root,
    git: gitServing(FIXTURE.sourcePath, "const GUARD_SYMBOL = 1;\n"),
  });
  assert.equal(result.state, "deployed");
  assert.deepEqual(result.missingFromDeployed, []);
});

test("a committed fix missing from the running build reads as drifted, not as ok", () => {
  const root = distRootWith({ "example.js": "// build predates the fix\n" });
  const [result] = evaluateSentinels([FIXTURE], {
    distRoot: root,
    git: gitServing(FIXTURE.sourcePath, "const GUARD_SYMBOL = 1;\n"),
  });
  assert.equal(result.state, "drifted");
  assert.deepEqual(result.missingFromDeployed, ["GUARD_SYMBOL"]);
  assert.deepEqual(summarize([result]).drifted, ["fixture"]);
});

test("a manifest that no longer matches the source is its own state, never ok and never drifted", () => {
  const root = distRootWith({ "example.js": "function GUARD_SYMBOL() {}\n" });
  const [result] = evaluateSentinels([FIXTURE], {
    distRoot: root,
    // The guard was renamed at HEAD. Reporting "deployed" here would keep the
    // board green forever; reporting "drifted" would blame a deploy that is fine.
    git: gitServing(FIXTURE.sourcePath, "const RENAMED_SYMBOL = 1;\n"),
  });
  assert.equal(result.state, "manifest_mismatch");
  assert.deepEqual(result.sourceMissingFromHead, ["GUARD_SYMBOL"]);
  assert.deepEqual(summarize([result]).manifestMismatch, ["fixture"]);
  assert.deepEqual(summarize([result]).drifted, []);
});

test("a missing dist file reports every marker missing rather than throwing", () => {
  const root = distRootWith({});
  const [result] = evaluateSentinels([FIXTURE], {
    distRoot: root,
    git: gitServing(FIXTURE.sourcePath, "const GUARD_SYMBOL = 1;\n"),
  });
  assert.equal(result.deployedExists, false);
  assert.equal(result.state, "drifted");
  assert.deepEqual(result.missingFromDeployed, ["GUARD_SYMBOL"]);
});

test("resolveRunningServerDist picks the first candidate that holds a server dist", () => {
  const present = new Set(["/b/services/issues.js", "/c/services/issues.js"]);
  assert.equal(
    resolveRunningServerDist(["/a", "/b", "/c"], (p) => present.has(p)),
    "/b",
  );
  assert.equal(resolveRunningServerDist(["/a"], () => false), null);
});

test("candidate roots do not contain duplicates, so one artifact is not checked twice", () => {
  const candidates = runningServerDistCandidates({ HOME: "/home/tester" });
  assert.equal(new Set(candidates).size, candidates.length);
  // The CLI's nested install must be preferred over a repo checkout. The reason
  // is not that a checkout "drifts ahead": measured, a checkout can also be
  // behind, and preferring it then reports sentinels as drifted that the
  // running build genuinely has. The order exists so the report describes what
  // the server loads.
  assert.ok(candidates[0].includes(path.join("node_modules", "@paperclipai", "server", "dist")));
  // ...and the bare repo checkout stays last, behind every installed tree.
  assert.equal(
    candidates[candidates.length - 1],
    path.resolve(path.join("/home/tester", "Projects", "paperclipai", "paperclip", "server", "dist")),
  );
});

test("the report names the drift and says a reinstall is not a deploy", () => {
  const root = distRootWith({ "example.js": "stale\n" });
  const results = evaluateSentinels([FIXTURE], {
    distRoot: root,
    git: gitServing(FIXTURE.sourcePath, "const GUARD_SYMBOL = 1;\n"),
  });
  const report = { distRoot: root, ...summarize(results), results };
  const text = formatReport(report);
  assert.match(text, /DRIFT fixture/);
  assert.match(text, /abc1234/);
  assert.match(text, /reinstall that keeps an older artifact is not a deploy/);
});

test("a manifest mismatch is reported as a bug in this check, not a deploy state", () => {
  const root = distRootWith({ "example.js": "function GUARD_SYMBOL() {}\n" });
  const results = evaluateSentinels([FIXTURE], {
    distRoot: root,
    git: gitServing(FIXTURE.sourcePath, "const RENAMED = 1;\n"),
  });
  const text = formatReport({ distRoot: root, ...summarize(results), results });
  assert.match(text, /bug in check-running-build-drift\.mjs/);
});

test("the shipped sentinels guard the two files PET-227 names", () => {
  const sources = RUNNING_BUILD_SENTINELS.map((s) => s.sourcePath);
  assert.ok(sources.includes("server/src/services/cross-issue-influence-limit.ts"));
  assert.ok(sources.includes("server/src/services/issues.ts"));
  for (const sentinel of RUNNING_BUILD_SENTINELS) {
    assert.ok(sentinel.markers.length > 0, `${sentinel.id} needs at least one marker`);
    assert.match(sentinel.sinceCommit, /^[a-f0-9]{7,40}$/);
  }
});

test("sentinel ids are unique so a report never double-counts one fix", () => {
  const ids = RUNNING_BUILD_SENTINELS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the source-attribution sentinel is not satisfied by the superseded fallback variant", () => {
  // The variant that shipped as a hand-patch, reproduced from the running
  // build. It carries TERMINAL_HEARTBEAT_RUN_STATUSES, so the older
  // `run-bound-fallback-scoped` sentinel reads it as deployed — but it never
  // derives a source from the binding and reports a terminal run under the
  // generic reason, so it must still read as drift.
  const supersededVariant = [
    "const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(['succeeded', 'failed']);",
    "if (!contextSourceIssueId && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) {",
    "  const targetIsBound = await tx.select().where(/* target only */);",
    "  if (targetIsBound) return null;",
    "}",
    "if (!contextSourceIssueId)",
    "  throw crossIssueInfluenceRunContextError('no_context_source_and_target_unbound');",
    "const sourceIssueId = contextSourceIssueId;",
  ].join("\n");

  const source = [
    "const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(['succeeded', 'failed']);",
    "let boundSourceIssueId = null;",
    "let targetIsBound = false;",
    "if (!contextSourceIssueId) {",
    "  if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status))",
    "    throw crossIssueInfluenceRunContextError('terminal_status');",
    "  targetIsBound = boundIssues.some((row) => row.id === input.targetIssueId);",
    "}",
    "if (targetIsBound) return null;",
    "const sourceIssueId = contextSourceIssueId ?? boundSourceIssueId;",
  ].join("\n");

  const path = "server/src/services/cross-issue-influence-limit.ts";
  // Every shipped sentinel is evaluated, so the stub has to serve each source
  // path. Only the fallback file's contents decide the two states asserted
  // below; the checkout sentinel is served a body carrying its marker so it
  // does not muddy the result.
  const git = (args) => {
    const spec = args[1];
    if (spec === `HEAD:${path}`) return source;
    if (spec === "HEAD:server/src/services/issues.ts") return "function assertCheckoutRunIsActive() {}\n";
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
  const root = distRootWith({
    "cross-issue-influence-limit.js": supersededVariant,
    "issues.js": "function assertCheckoutRunIsActive() {}\n",
  });
  const results = evaluateSentinels(RUNNING_BUILD_SENTINELS, { distRoot: root, git });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  // The pre-existing sentinel is fooled by this variant; that is the bug.
  assert.equal(byId["run-bound-fallback-scoped"].state, "deployed");
  // The new one is not.
  assert.equal(byId["run-bound-fallback-attributes-source"].state, "drifted");
  assert.deepEqual(
    byId["run-bound-fallback-attributes-source"].missingFromDeployed,
    ["boundSourceIssueId", "terminal_status"],
  );
  assert.ok(summarize(results).drifted.includes("run-bound-fallback-attributes-source"));
});

test("an unreadable source tree is unevaluated, not drift", () => {
  // `git show HEAD:<file>` fails when the check runs outside a checkout. Node
  // exits an uncaught exception with status 1, which is the drift code, so a
  // board consumer would have read a broken check as a deploy finding.
  const root = distRootWith({ "example.js": "stale\n" });
  let out = "";
  const code = runCheck({
    distRoot: root,
    git: () => {
      throw new Error("fatal: not a git repository");
    },
    sentinels: [FIXTURE],
    write: (text) => {
      out += text;
    },
  });
  assert.equal(code, EXIT_UNEVALUATED);
  assert.notEqual(code, EXIT_DRIFT);
  assert.match(out, /could not read the source tree at HEAD/);
  assert.doesNotMatch(out, /DRIFT/);
});

test("a missing running build is unevaluated, and says so in --json", () => {
  let out = "";
  const code = runCheck({
    asJson: true,
    distRoot: null,
    git: gitServing(FIXTURE.sourcePath, "const GUARD_SYMBOL = 1;\n"),
    sentinels: [FIXTURE],
    write: (text) => {
      out += text;
    },
  });
  assert.equal(code, EXIT_UNEVALUATED);
  const parsed = JSON.parse(out);
  assert.equal(parsed.unevaluated, true);
  assert.ok(parsed.error.includes("no running @paperclipai/server dist"));
});

test("a manifest mismatch is unevaluated rather than a deploy finding", () => {
  const root = distRootWith({ "example.js": "stale\n" });
  let out = "";
  const code = runCheck({
    distRoot: root,
    git: gitServing(FIXTURE.sourcePath, "const RENAMED = 1;\n"),
    sentinels: [FIXTURE],
    write: (text) => {
      out += text;
    },
  });
  assert.equal(code, EXIT_UNEVALUATED);
  assert.match(out, /bug in check-running-build-drift\.mjs/);
});

test("exit codes stay distinct: deployed is 0, drift is 1, and never the reverse", () => {
  const deployed = distRootWith({ "example.js": "function GUARD_SYMBOL() {}\n" });
  const stale = distRootWith({ "example.js": "nothing here\n" });
  const serving = gitServing(FIXTURE.sourcePath, "const GUARD_SYMBOL = 1;\n");
  const quiet = () => {};
  assert.equal(runCheck({ distRoot: deployed, git: serving, sentinels: [FIXTURE], write: quiet }), EXIT_OK);
  assert.equal(runCheck({ distRoot: stale, git: serving, sentinels: [FIXTURE], write: quiet }), EXIT_DRIFT);
  // A drifted build is still not an unevaluated check, and vice versa.
  assert.notEqual(EXIT_UNEVALUATED, EXIT_DRIFT);
  assert.notEqual(EXIT_UNEVALUATED, EXIT_OK);
});

test("the run shape of the live build still reports exactly the two real findings", () => {
  // Guards against the exit-code refactor changing what the check measures. The
  // source carries every marker (as HEAD does), while the artifact is the
  // hand-patched build: the checkout guard is gone and the fallback is the
  // superseded narrow variant. That must read as two drifts, not one and not a
  // manifest mismatch.
  const crossSource = [
    "const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(['succeeded', 'failed']);",
    "let boundSourceIssueId = null;",
    "  throw crossIssueInfluenceRunContextError('terminal_status');",
    "  throw crossIssueInfluenceRunContextError('no_context_source_and_target_unbound');",
    "const sourceIssueId = contextSourceIssueId ?? boundSourceIssueId;",
  ].join("\n");
  const crossSupersededVariant = [
    "const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(['succeeded', 'failed']);",
    "  throw crossIssueInfluenceRunContextError('no_context_source_and_target_unbound');",
    "const sourceIssueId = contextSourceIssueId;",
  ].join("\n");
  const p = "server/src/services/cross-issue-influence-limit.ts";
  const git = (args) => {
    const spec = args[1];
    if (spec === `HEAD:${p}`) return crossSource;
    if (spec === "HEAD:server/src/services/issues.ts") {
      return "function assertCheckoutRunIsActive() {}\n";
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
  const root = distRootWith({
    "cross-issue-influence-limit.js": crossSupersededVariant,
    "issues.js": "// build predates the checkout guard\n",
  });
  let out = "";
  const code = runCheck({
    distRoot: root,
    git,
    write: (text) => {
      out += text;
    },
  });
  assert.equal(code, EXIT_DRIFT);
  assert.match(out, /DRIFT checkout-refuses-terminal-run/);
  assert.match(out, /DRIFT run-bound-fallback-attributes-source/);
  // The two sentinels the superseded variant does satisfy stay green, which is
  // the discrimination the check exists to make.
  assert.match(out, /ok   run-bound-fallback-scoped/);
  assert.match(out, /ok   cross-issue-403-names-the-gate/);
  assert.doesNotMatch(out, /BUG  /);
  assert.match(out, /2 fix\(es\) are committed/);
});
