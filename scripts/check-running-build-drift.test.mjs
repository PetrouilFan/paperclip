import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  EXIT_DRIFT,
  EXIT_OK,
  EXIT_UNEVALUATED,
  RUNNING_BUILD_SENTINELS,
  evaluateSentinels,
  formatReport,
  refFromArgv,
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

/**
 * A `git show <ref>:<path>` stub that serves the whole shipped manifest, so a
 * test driving every sentinel does not have to be edited each time one is
 * added. `overrides` pins the paths whose contents the test actually reasons
 * about; every other source path is served a body carrying exactly the markers
 * its own sentinels assert on, which is what "the source has the fix" means.
 *
 * Without this, adding a sentinel breaks every full-manifest test with an
 * "unexpected git invocation" error that says nothing about the sentinel, which
 * is how a manifest grows a guard nobody notices is untested.
 */
function gitServingManifest(overrides = {}, ref = "HEAD") {
  const bodies = new Map(Object.entries(overrides));
  return (args) => {
    const spec = args[1];
    if (spec === "rev-parse") return "abc1234\n";
    const prefix = `${ref}:`;
    if (typeof spec === "string" && spec.startsWith(prefix)) {
      const path = spec.slice(prefix.length);
      if (bodies.has(path)) return bodies.get(path);
      const sentinels = RUNNING_BUILD_SENTINELS.filter(
        (s) => s.sourcePath === path,
      );
      if (sentinels.length > 0) {
        return sentinels
          .map((s) => s.markers.map((m) => `${m} /* present */`).join("\n"))
          .join("\n");
      }
    }
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
  assert.equal(
    resolveRunningServerDist(["/a"], () => false),
    null,
  );
});

test("candidate roots do not contain duplicates, so one artifact is not checked twice", () => {
  const candidates = runningServerDistCandidates({ HOME: "/home/tester" });
  assert.equal(new Set(candidates).size, candidates.length);
  // The CLI's nested install must be preferred over a repo checkout. The reason
  // is not that a checkout "drifts ahead": measured, a checkout can also be
  // behind, and preferring it then reports sentinels as drifted that the
  // running build genuinely has. The order exists so the report describes what
  // the server loads.
  assert.ok(
    candidates[0].includes(
      path.join("node_modules", "@paperclipai", "server", "dist"),
    ),
  );
  // ...and the bare repo checkout stays last, behind every installed tree.
  assert.equal(
    candidates[candidates.length - 1],
    path.resolve(
      path.join(
        "/home/tester",
        "Projects",
        "paperclipai",
        "paperclip",
        "server",
        "dist",
      ),
    ),
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
  assert.ok(
    sources.includes("server/src/services/cross-issue-influence-limit.ts"),
  );
  assert.ok(sources.includes("server/src/services/issues.ts"));
  for (const sentinel of RUNNING_BUILD_SENTINELS) {
    assert.ok(
      sentinel.markers.length > 0,
      `${sentinel.id} needs at least one marker`,
    );
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
  // below; every other path is served a body carrying its own markers.
  const git = gitServingManifest({
    [path]: source,
    "server/src/services/issues.ts":
      "function assertCheckoutRunIsActive() {}\n",
  });
  const root = distRootWith({
    "cross-issue-influence-limit.js": supersededVariant,
    "issues.js": "function assertCheckoutRunIsActive() {}\n",
  });
  const results = evaluateSentinels(RUNNING_BUILD_SENTINELS, {
    distRoot: root,
    git,
  });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  // The pre-existing sentinel is fooled by this variant; that is the bug.
  assert.equal(byId["run-bound-fallback-scoped"].state, "deployed");
  // The new one is not.
  assert.equal(byId["run-bound-fallback-attributes-source"].state, "drifted");
  assert.deepEqual(
    byId["run-bound-fallback-attributes-source"].missingFromDeployed,
    ["boundSourceIssueId", "terminal_status"],
  );
  assert.ok(
    summarize(results).drifted.includes("run-bound-fallback-attributes-source"),
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
  const deployed = distRootWith({
    "example.js": "function GUARD_SYMBOL() {}\n",
  });
  const stale = distRootWith({ "example.js": "nothing here\n" });
  const serving = gitServing(FIXTURE.sourcePath, "const GUARD_SYMBOL = 1;\n");
  const quiet = () => {};
  assert.equal(
    runCheck({
      distRoot: deployed,
      git: serving,
      sentinels: [FIXTURE],
      write: quiet,
    }),
    EXIT_OK,
  );
  assert.equal(
    runCheck({
      distRoot: stale,
      git: serving,
      sentinels: [FIXTURE],
      write: quiet,
    }),
    EXIT_DRIFT,
  );
  // A drifted build is still not an unevaluated check, and vice versa.
  assert.notEqual(EXIT_UNEVALUATED, EXIT_DRIFT);
  assert.notEqual(EXIT_UNEVALUATED, EXIT_OK);
});

test("the run shape of the live build reports every measured finding, not a subset", () => {
  // Guards against a refactor changing what the check measures. The fixture is
  // the artifact measured on this host at PET-497: the checkout guard is gone,
  // the fallback is the superseded narrow variant, and the whole
  // execution-recovery settlement module is absent — the build predates
  // 381f051f14a, d4ed244a6ae and 7f8c05af28c.
  //
  // Five drifts is the measured number, and it is asserted as a count rather
  // than a spot check so that a manifest that silently stops guarding a file
  // fails here instead of making the board greener.
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
  const git = gitServingManifest({
    "server/src/services/cross-issue-influence-limit.ts": crossSource,
    "server/src/services/issues.ts":
      "function assertCheckoutRunIsActive() {}\n",
  });
  const root = distRootWith({
    "cross-issue-influence-limit.js": crossSupersededVariant,
    "issues.js": "// build predates the checkout guard\n",
    // The recovery files as the running build actually has them: present, and
    // each missing exactly the marker its commit introduced.
    "routable-blocked.js": "export function isRoutable() { return true; }\n",
    "execution-blocker.js": "export const EXECUTION_HOLD_CAUSES = [];\n",
    // `execution-recovery-identity.js` is absent entirely, as measured: the
    // fix introduced a new module, so a build predating it has no such file.
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
  // PET-497: the re-mint loop's own three fixes, all committed and none running.
  assert.match(out, /DRIFT settle-keyed-on-run-and-issue/);
  assert.match(out, /DRIFT stranded-settle-names-its-exit/);
  assert.match(out, /DRIFT live-watch-exempt-from-recovery-pin/);
  // The two sentinels the superseded variant does satisfy stay green, which is
  // the discrimination the check exists to make.
  assert.match(out, /ok   run-bound-fallback-scoped/);
  assert.match(out, /ok   cross-issue-403-names-the-gate/);
  assert.doesNotMatch(out, /BUG  /);
  assert.match(out, /5 fix\(es\) are committed/);
  // Every shipped sentinel is accounted for, so a new guard cannot be added
  // without this fixture being updated to say what the live build does with it.
  const evaluated = evaluateSentinels(RUNNING_BUILD_SENTINELS, {
    distRoot: root,
    git,
  });
  assert.equal(evaluated.length, RUNNING_BUILD_SENTINELS.length);
  for (const result of evaluated) {
    assert.ok(
      out.includes(result.id),
      `${result.id} is missing from the report`,
    );
  }
});

test("a build that has the recovery settlement module reports it deployed", () => {
  // The other direction: the sentinel must not be a one-way ratchet. A build
  // that does carry all three recovery fixes has to read green, or the check
  // would be reporting drift forever after the deploy that actually fixes it.
  const git = gitServingManifest();
  const root = distRootWith({
    "issues.js": "function assertCheckoutRunIsActive() {}\n",
    "cross-issue-influence-limit.js": [
      "const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(['succeeded', 'failed']);",
      "let boundSourceIssueId = null;",
      "throw crossIssueInfluenceRunContextError('terminal_status');",
      "throw crossIssueInfluenceRunContextError('no_context_source_and_target_unbound');",
      "const sourceIssueId = contextSourceIssueId ?? boundSourceIssueId;",
    ].join("\n"),
    "execution-recovery-identity.js": [
      "const EXECUTION_RECOVERY_DISPOSITION_KEY = 'executionRecoveryDisposition';",
      "const SETTLED_AUTOMATIC_RECOVERY_REPLAYS = ['blocked'];",
      "function isExecutionRecoveryAlreadySettled() {}",
      "function settledExecutionRecoveryActionCondition() {}",
    ].join("\n"),
    "routable-blocked.js": "function strandedRunUnblockDescriptor() {}\n",
    "execution-blocker.js": "const liveWatchExemptCondition = () => null;\n",
  });
  let out = "";
  const code = runCheck({
    distRoot: root,
    git,
    write: (text) => {
      out += text;
    },
  });
  assert.equal(code, EXIT_OK);
  assert.doesNotMatch(out, /DRIFT/);
  assert.doesNotMatch(out, /BUG  /);
  assert.match(out, /every guarded fix is present in the running build/);
});

test("the source half is answered against a named ref, and the report says which", () => {
  // Measured on PET-497: the check was run from a checkout 21 commits behind
  // `origin/master`, so a sentinel whose fix had landed on master read as
  // `manifest_mismatch` — the same state as a manifest that is genuinely
  // broken. Both are EXIT_UNEVALUATED, so the exit code was safe, but the two
  // send a reader to opposite places, and only one of them is a bug in this
  // file. The ref is therefore explicit and printed.
  const root = distRootWith({ "example.js": "stale\n" });
  const seen = [];
  const git = (args) => {
    seen.push(args.join(" "));
    if (args[0] === "rev-parse") return "abc1234\n";
    return "const GUARD_SYMBOL = 1;\n";
  };
  let out = "";
  const code = runCheck({
    distRoot: root,
    git,
    ref: "origin/master",
    sentinels: [FIXTURE],
    write: (text) => {
      out += text;
    },
  });
  assert.equal(code, EXIT_DRIFT);
  assert.ok(seen.includes("show origin/master:server/src/services/example.ts"));
  assert.ok(!seen.some((c) => c.startsWith("show HEAD:")));
  assert.match(out, /compared against: origin\/master \(abc1234\)/);
});

test("a ref the checkout cannot resolve is unevaluated and names the ref it tried", () => {
  // Without the ref in the message, a reader who ran this from a stale checkout
  // has no way to tell "the ref does not exist here" from "the manifest is
  // wrong", which is the same ambiguity the ref was added to remove.
  const root = distRootWith({ "example.js": "stale\n" });
  let out = "";
  const code = runCheck({
    distRoot: root,
    git: () => {
      throw new Error(
        "fatal: ambiguous argument 'origin/nope': unknown revision",
      );
    },
    ref: "origin/nope",
    sentinels: [FIXTURE],
    write: (text) => {
      out += text;
    },
  });
  assert.equal(code, EXIT_UNEVALUATED);
  assert.notEqual(code, EXIT_DRIFT);
  assert.match(out, /could not read the source tree at origin\/nope/);
  assert.doesNotMatch(out, /DRIFT/);
});

test("a manifest mismatch names the ref and both causes, not just 'fix the manifest'", () => {
  // The single-cause message is what makes a stale checkout look like a bug in
  // this file. The reader is now told which of the two it is looking at.
  const root = distRootWith({ "example.js": "function GUARD_SYMBOL() {}\n" });
  let out = "";
  const code = runCheck({
    distRoot: root,
    git: gitServingManifest(
      { [FIXTURE.sourcePath]: "const RENAMED = 1;\n" },
      "origin/master",
    ),
    ref: "origin/master",
    sentinels: [FIXTURE],
    write: (text) => {
      out += text;
    },
  });
  assert.equal(code, EXIT_UNEVALUATED);
  assert.match(out, /marker not in .* at origin\/master: GUARD_SYMBOL/);
  assert.match(out, /the checkout is behind the fix/);
  assert.match(out, /--ref origin\/master/);
});

test("--ref needs a value, and says so instead of silently using HEAD", () => {
  // The failure mode this rules out: `--ref` typed with no argument quietly
  // compares against HEAD, which is the exact stale baseline the flag exists to
  // avoid, and the report looks perfectly normal.
  assert.throws(() => refFromArgv(["--ref"]), /--ref needs a ref name/);
  assert.throws(
    () => refFromArgv(["--json", "--ref"]),
    /--ref needs a ref name/,
  );
  assert.equal(refFromArgv([]), "HEAD");
  assert.equal(refFromArgv(["--json"]), "HEAD");
  assert.equal(refFromArgv(["--ref", "origin/master"]), "origin/master");
  assert.equal(
    refFromArgv(["--ref", "origin/master", "--json"]),
    "origin/master",
  );
});

test("every sentinel's markers are present in its own source file at master", () => {
  // The manifest's source half is the thing that keeps it honest, and the only
  // way to keep it honest is to check it against a real tree rather than a stub.
  // This is the test that would have caught a marker typo on the PET-497
  // sentinels at commit time instead of reporting a permanent phantom drift.
  const manifestPath = fileURLToPath(
    new URL("check-running-build-drift.mjs", import.meta.url),
  );
  const repoRoot = resolve(dirname(manifestPath), "..");
  const sourceFiles = [
    ...new Set(RUNNING_BUILD_SENTINELS.map((s) => s.sourcePath)),
  ];
  for (const sourcePath of sourceFiles) {
    let body;
    try {
      body = execFileSync("git", ["show", `origin/master:${sourcePath}`], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // A clone with no `origin/master` ref cannot answer this. Skipping is the
      // safe direction: the live run of the check reports EXIT_UNEVALUATED
      // rather than green, so an unanswered test is never a false pass.
      continue;
    }
    for (const sentinel of RUNNING_BUILD_SENTINELS.filter(
      (s) => s.sourcePath === sourcePath,
    )) {
      for (const marker of sentinel.markers) {
        assert.ok(
          body.includes(marker),
          `${sentinel.id}: marker ${marker} is not in ${sourcePath} at origin/master`,
        );
      }
    }
  }
});

test("each PET-497 sentinel is anchored to a commit that is an ancestor of master", () => {
  // `sinceCommit` is what a reader uses to decide whether a finding is a deploy
  // gap or a not-yet-landed fix, so a sentinel added here has to be anchored to
  // a commit a fresh clone can resolve. Verified by hand for the four
  // pre-existing sentinels too, and three of them (`5b9f94eee`, `73784955c`,
  // `f80a08c00`) are *not*: master was rewritten under them, so those shas are
  // dangling local objects and the report's "committed at <sha>" cannot be
  // checked from a clean clone. That is pre-existing and tracked separately
  // rather than re-pointed here, because the honest replacement is the commit
  // the content actually landed in and that is a judgement call, not a lookup.
  const manifestPath = fileURLToPath(
    new URL("check-running-build-drift.mjs", import.meta.url),
  );
  const repoRoot = resolve(dirname(manifestPath), "..");
  for (const id of [
    "settle-keyed-on-run-and-issue",
    "stranded-settle-names-its-exit",
    "live-watch-exempt-from-recovery-pin",
  ]) {
    const sentinel = RUNNING_BUILD_SENTINELS.find((s) => s.id === id);
    assert.ok(sentinel, `sentinel ${id} is missing from the manifest`);
    try {
      execFileSync(
        "git",
        ["merge-base", "--is-ancestor", sentinel.sinceCommit, "origin/master"],
        {
          cwd: repoRoot,
          stdio: "ignore",
        },
      );
    } catch {
      // A clone without `origin/master` cannot answer, so only fail when the
      // question is actually answerable here.
      let known = true;
      try {
        execFileSync(
          "git",
          ["cat-file", "-e", `${sentinel.sinceCommit}^{commit}`],
          {
            cwd: repoRoot,
            stdio: "ignore",
          },
        );
      } catch {
        known = false;
      }
      assert.ok(
        !known,
        `${id}: sinceCommit ${sentinel.sinceCommit} is known locally but is not an ancestor of origin/master`,
      );
    }
  }
});
