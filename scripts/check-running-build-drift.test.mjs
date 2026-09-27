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
  findPatchScars,
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

/**
 * A dist root with the given `distPath` contents, so a sentinel that guards a
 * file outside `services/` can be exercised.
 */
function distRootWithPaths(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "drift-dist-"));
  for (const [distPath, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, distPath)), { recursive: true });
    writeFileSync(path.join(root, distPath), contents);
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

test("the shipped sentinels guard the two files the drift check names", () => {
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
  // below; the other sentinels are served bodies carrying their markers so they
  // do not muddy the result.
  const git = gitServingAllShippedSentinels({ [path]: source });
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

test("the reason string alone does not make the cross-issue guard look deployed", () => {
  // The variant that shipped, reproduced from the running build: it names the
  // reason and fails closed, and carries none of the payload the guard has
  // since grown. `no_context_source_and_target_unbound` is a reason-code string
  // literal, so it survives compilation on its own — which is exactly why it
  // cannot be the only thing a sentinel requires.
  const reasonStringOnly = [
    "const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(['succeeded', 'failed']);",
    "let boundSourceIssueId = null;",
    "let targetIsBound = false;",
    "if (!contextSourceIssueId) {",
    "  if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status))",
    "    throw crossIssueInfluenceRunContextError('terminal_status');",
    "  targetIsBound = boundIssues.some((row) => row.id === input.targetIssueId);",
    "}",
    "if (targetIsBound) return null;",
    "if (!contextSourceIssueId)",
    "  throw crossIssueInfluenceRunContextError('no_context_source_and_target_unbound');",
    "const sourceIssueId = contextSourceIssueId ?? boundSourceIssueId;",
  ].join("\n");

  const source = [
    "const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(['succeeded', 'failed']);",
    "let boundSourceIssueId = null;",
    "let targetIsBound = false;",
    "  throw crossIssueInfluenceRunContextError('terminal_status');",
    "  throw crossIssueInfluenceRunContextError('no_context_source_and_target_unbound');",
    "  targetAssignedToOtherActor: Boolean(targetAssignee?.assigneeAgentId),",
    "  targetHeldByAnotherRun: Boolean(targetAssignee?.checkoutRunId),",
    "const sourceIssueId = contextSourceIssueId ?? boundSourceIssueId;",
  ].join("\n");

  const path = "server/src/services/cross-issue-influence-limit.ts";
  const git = gitServingAllShippedSentinels({ [path]: source });
  const root = distRootWith({
    "cross-issue-influence-limit.js": reasonStringOnly,
    "issues.js": "function assertCheckoutRunIsActive() {}\nasync function blockedByIdsMapForIssues() {}\n",
  });
  const results = evaluateSentinels(RUNNING_BUILD_SENTINELS, { distRoot: root, git });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  // The reason string is present, so the old single-marker requirement is
  // satisfied; the payload key is what makes it drift.
  assert.match(reasonStringOnly, /no_context_source_and_target_unbound/);
  assert.equal(byId["cross-issue-403-names-the-gate"].state, "drifted");
  assert.deepEqual(byId["cross-issue-403-names-the-gate"].missingFromDeployed, [
    "targetAssignedToOtherActor",
  ]);
  assert.equal(byId["run-context-allows-self-assigned-target"].state, "drifted");
  assert.deepEqual(
    byId["run-context-allows-self-assigned-target"].missingFromDeployed,
    ["targetAssignedToOtherActor", "targetHeldByAnotherRun"],
  );
  // The sentinel that only ever needed the reason's sibling is unaffected.
  assert.equal(byId["run-bound-fallback-attributes-source"].state, "deployed");
});

test("a write-only blockedByIssueIds reads as drift, on both read paths", () => {
  // `blockedByIssueIds` was accepted by PATCH and returned by no read, so an
  // issue that had just been given a blocker read back as having none. Both
  // read paths were fixed separately and drift independently, so a build that
  // carried one and not the other is half-readable and still wrong.
  const git = gitServingAllShippedSentinels();
  const root = distRootWithPaths({
    "services/issues.js": "function assertCheckoutRunIsActive() {}\n",
    "routes/issues.js": "function sortedRelationIds(relations) { return relations.map(r => r.id) }\n",
  });
  const results = evaluateSentinels(RUNNING_BUILD_SENTINELS, { distRoot: root, git });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  // The single read is current, so it is not drift.
  assert.equal(byId["blocked-issue-ids-readable-on-single-read"].state, "deployed");
  // The list read never had the field, and that is the one a sweep reads.
  assert.equal(byId["blocked-issue-ids-readable-on-list-read"].state, "drifted");
  assert.deepEqual(
    byId["blocked-issue-ids-readable-on-list-read"].missingFromDeployed,
    ["blockedByIdsMapForIssues"],
  );
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

/** A `git show HEAD:<path>` stub serving every shipped sentinel's source path. */
function gitServingAllShippedSentinels(overrides = {}) {
  const defaults = {
    "server/src/services/cross-issue-influence-limit.ts": [
      "const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(['succeeded', 'failed']);",
      "let boundSourceIssueId = null;",
      "let targetIsBound = false;",
      "  throw crossIssueInfluenceRunContextError('terminal_status');",
      "  throw crossIssueInfluenceRunContextError('no_context_source_and_target_unbound');",
      "  targetAssignedToOtherActor: Boolean(targetAssignee?.assigneeAgentId),",
      "  targetHeldByAnotherRun: Boolean(targetAssignee?.checkoutRunId),",
      "const sourceIssueId = contextSourceIssueId ?? boundSourceIssueId;",
    ].join("\n"),
    "server/src/services/issues.ts":
      "function assertCheckoutRunIsActive() {}\nasync function blockedByIdsMapForIssues() {}\n",
    "server/src/routes/issues.ts": "function sortedRelationIds(relations) {}\n",
    "server/src/middleware/error-handler.ts": "res.status(400).json({ error: 'Invalid JSON body' });\n",
    "server/src/embedded-postgres-supervisor.ts":
      "const markShutdownIntent = () => {};\noptions.onRecoveryExhausted?.(lastError);\n",
  };
  const bodies = { ...defaults, ...overrides };
  return (args) => {
    const spec = args[1];
    if (spec?.startsWith("HEAD:")) {
      const body = bodies[spec.slice("HEAD:".length)];
      if (body === undefined) throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      return body;
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
}

/** A dist root whose `services/` holds the two fallback sentinels' files. */
function distRootWithFallbackSentinels() {
  const root = mkdtempSync(path.join(os.tmpdir(), "drift-dist-"));
  mkdirSync(path.join(root, "services"), { recursive: true });
  mkdirSync(path.join(root, "routes"), { recursive: true });
  writeFileSync(
    path.join(root, "services", "issues.js"),
    "function assertCheckoutRunIsActive() {}\nasync function blockedByIdsMapForIssues() {}\n",
  );
  writeFileSync(
    path.join(root, "routes", "issues.js"),
    "function sortedRelationIds(relations) { return relations.map((r) => r.id) }\n",
  );
  writeFileSync(
    path.join(root, "services", "cross-issue-influence-limit.js"),
    [
      "const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(['succeeded', 'failed']);",
      "  throw crossIssueInfluenceRunContextError('terminal_status');",
      "  throw crossIssueInfluenceRunContextError('no_context_source_and_target_unbound');",
      "  targetAssignedToOtherActor: Boolean(targetAssignee?.assigneeAgentId),",
      "  targetHeldByAnotherRun: Boolean(targetAssignee?.checkoutRunId),",
      "const sourceIssueId = contextSourceIssueId ?? boundSourceIssueId;",
    ].join("\n"),
  );
  return root;
}

/** A dist root holding `middleware/error-handler.js` alongside services/. */
function distRootWithMiddleware(contents) {
  const root = distRootWithFallbackSentinels();
  mkdirSync(path.join(root, "middleware"), { recursive: true });
  writeFileSync(path.join(root, "middleware", "error-handler.js"), contents);
  return root;
}

test("the run shape of the live build still reports exactly the findings it has", () => {
  // Guards against the exit-code refactor changing what the check measures. The
  // source carries every marker (as HEAD does), while the artifact is the
  // hand-patched build: the checkout guard is gone, the fallback is the
  // superseded narrow variant, the malformed-JSON mapping is absent, and the
  // database shutdown latch is present because it was patched in directly.
  const git = gitServingAllShippedSentinels();
  const root = mkdtempSync(path.join(os.tmpdir(), "drift-dist-"));
  mkdirSync(path.join(root, "services"), { recursive: true });
  mkdirSync(path.join(root, "middleware"), { recursive: true });
  mkdirSync(path.join(root, "routes"), { recursive: true });
  writeFileSync(path.join(root, "services", "issues.js"), "// build predates the checkout guard\n");
  writeFileSync(
    path.join(root, "routes", "issues.js"),
    "// build predates the readable blockedByIssueIds\n",
  );
  writeFileSync(
    path.join(root, "services", "cross-issue-influence-limit.js"),
    [
      "const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(['succeeded', 'failed']);",
      "  throw crossIssueInfluenceRunContextError('no_context_source_and_target_unbound');",
      "const sourceIssueId = contextSourceIssueId;",
    ].join("\n"),
  );
  writeFileSync(path.join(root, "middleware", "error-handler.js"), "res.status(500).json({});\n");
  writeFileSync(
    path.join(root, "embedded-postgres-supervisor.js"),
    "let shutdownIntent = false;\nconst markShutdownIntent = () => { shutdownIntent = true };\noptions.onRecoveryExhausted?.(lastError);\n",
  );
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
  // `cross-issue-403-names-the-gate` used to be green here. This artifact
  // names the reason and nothing else, and requiring a payload key alongside
  // the reason is what stops that from reading as deployed.
  assert.match(out, /DRIFT cross-issue-403-names-the-gate/);
  assert.match(out, /DRIFT run-context-allows-self-assigned-target/);
  assert.match(out, /DRIFT blocked-issue-ids-readable-on-single-read/);
  assert.match(out, /DRIFT blocked-issue-ids-readable-on-list-read/);
  // The one sentinel the superseded variant does satisfy stays green, which is
  // the discrimination the check exists to make.
  assert.match(out, /ok   run-bound-fallback-scoped/);
  // The shutdown latch is green only because the install was hand-patched, and
  // the report has to say so rather than let a green line read as "a reinstall
  // is safe".
  assert.match(out, /ok   embedded-postgres-shutdown-intent/);
  assert.match(out, /DRIFT malformed-json-is-a-400/);
  assert.doesNotMatch(out, /BUG  /);
  // 3 pre-existing plus the 4 the reason-string sentinel and the two fixes it
  // could not see contribute. The per-id assertions above pin the set; this
  // only keeps the headline count from drifting away from it.
  assert.match(out, /7 fix\(es\) are committed/);
});

test("a fix held only by a hand-patch is reported as a reinstall hazard, not as a green line", () => {
  // The whole point of the scars section. Every sentinel is deployed, so the
  // drift line reads "every guarded fix is present" — and without the scars the
  // reader concludes a reinstall is safe, which silently reverts the hand-patch.
  const root = distRootWithFallbackSentinels();
  mkdirSync(path.join(root, "middleware"), { recursive: true });
  writeFileSync(
    path.join(root, "middleware", "error-handler.js"),
    "res.status(400).json({ error: 'Invalid JSON body' });\n",
  );
  writeFileSync(
    path.join(root, "embedded-postgres-supervisor.js"),
    "const markShutdownIntent = () => {};\noptions.onRecoveryExhausted?.(lastError);\n",
  );
  writeFileSync(
    path.join(root, "services", "cross-issue-influence-limit.js.bak-20260925T002012Z"),
    "released original\n",
  );
  let out = "";
  const code = runCheck({
    distRoot: root,
    git: gitServingAllShippedSentinels(),
    write: (text) => {
      out += text;
    },
  });
  // Scars are reported but never borrow the drift code: the question this
  // check answers is "is the fix deployed", and that answer is yes.
  assert.equal(code, EXIT_OK);
  assert.match(out, /every guarded fix is present/);
  assert.match(out, /retained-original file\(s\)/);
  assert.match(out, /cross-issue-influence-limit\.js\.bak-20260925T002012Z/);
  assert.match(out, /edited in place/);
});

test("a clean dist reports no scars and does not print the hazard section", () => {
  const root = distRootWithFallbackSentinels();
  const results = evaluateSentinels(RUNNING_BUILD_SENTINELS, {
    distRoot: root,
    git: gitServingAllShippedSentinels(),
  });
  assert.deepEqual(findPatchScars(root, RUNNING_BUILD_SENTINELS), []);
  const out = formatReport({ distRoot: root, ...summarize(results), results, scars: [] });
  assert.doesNotMatch(out, /retained-original/);
  assert.doesNotMatch(out, /shadowed-server-install/);
});

test("a scar in a sentinel's own directory is found, and an unreadable one is not fatal", () => {
  // Scoped to the dist root and each sentinel's directory: a backup sitting
  // next to the file a sentinel reads is the one that matters, and walking
  // 5000 files of a full dist to find ten backups is not worth the cost.
  const root = distRootWith({ "issues.js": "x\n" });
  writeFileSync(path.join(root, "services", "issues.js.bak-20260925T171750Z"), "orig\n");
  const found = findPatchScars(root, RUNNING_BUILD_SENTINELS);
  assert.deepEqual(
    found.map((s) => s.name),
    ["issues.js.bak-20260925T171750Z"],
  );

  // A missing or unreadable directory is already reported as drift for the
  // sentinel that wanted it; it is not evidence of a hand-patch, so the scan
  // skips it rather than failing the check.
  const exploding = () => {
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  };
  assert.deepEqual(findPatchScars(root, RUNNING_BUILD_SENTINELS, exploding), []);
});

test("the malformed-JSON sentinel separates a published release from a build with the fix", () => {
  // The asymmetry this sentinel exists for, and the reason a channel matrix had
  // to be measured by hand four separate times: the fix is on master and on no
  // published release, so "which channel do I install" cannot answer "is the
  // trap still live".
  const without = distRootWithMiddleware("res.status(500).json({ error: 'Internal server error' });\n");
  const with_ = distRootWithMiddleware("res.status(400).json({ error: 'Invalid JSON body' });\n");
  const git = gitServingAllShippedSentinels();
  const sentinelById = (results, id) => {
    const found = results.filter((r) => r.id === id);
    assert.equal(found.length, 1, `expected exactly one ${id} sentinel`);
    return found[0];
  };
  const released = sentinelById(
    evaluateSentinels(RUNNING_BUILD_SENTINELS, { distRoot: without, git }),
    "malformed-json-is-a-400",
  );
  const fixed = sentinelById(
    evaluateSentinels(RUNNING_BUILD_SENTINELS, { distRoot: with_, git }),
    "malformed-json-is-a-400",
  );
  assert.equal(released.state, "drifted");
  assert.deepEqual(released.missingFromDeployed, ["Invalid JSON body"]);
  assert.equal(fixed.state, "deployed");
  // A build that renamed the guard is a manifest bug, never a deploy finding.
  const renamed = sentinelById(
    evaluateSentinels(RUNNING_BUILD_SENTINELS, {
      distRoot: with_,
      git: gitServingAllShippedSentinels({
        "server/src/middleware/error-handler.ts": "res.status(400).json({});\n",
      }),
    }),
    "malformed-json-is-a-400",
  );
  assert.equal(renamed.state, "manifest_mismatch");
});
