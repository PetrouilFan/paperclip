#!/usr/bin/env node
/**
 * Report committed-but-undeployed fixes on the running build.
 *
 * "The fix is committed" and "the fix is running" look identical on the board:
 * both are a green PR, and a reinstall that keeps an older artifact looks like a
 * successful deploy. PET-227 hit the concrete case — PR #15 merged
 * `assertCheckoutRunIsActive`, the endpoint kept answering `200` for a run the
 * server had itself marked `failed`, and nothing on the board said so.
 *
 * A mtime is not a deploy signal. Three build trees can exist for one package
 * (a repo `server/dist`, a workspace install, and the nested install the CLI
 * actually loads), and a hand-patched artifact rewrites mtime without changing
 * provenance. So this check asserts *content*: a fix is deployed when a stable
 * identifier it introduced is present in the artifact the server loads.
 *
 * Each sentinel is checked twice, and both halves must hold:
 *
 *   1. source — the marker must appear in the named source file at HEAD, so a
 *      renamed or deleted guard fails here instead of silently passing forever;
 *   2. deployed — the marker must appear in the running artifact.
 *
 * Check 1 is what keeps this honest. Without it the manifest is a hand-typed
 * list that drifts from the code and reports a permanently green board.
 *
 * Exit codes: 0 no drift, 1 drift found, 2 the check could not be evaluated
 * (no running build found, or a manifest/source mismatch — which is a bug in
 * this file, not a deploy state, and must never be read as "all clear").
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Candidate roots for the `@paperclipai/server` artifact the CLI actually
 * loads. Order matters: the first root that holds a `dist` wins, and the CLI's
 * nested install is listed before the top-level one because that is the tree
 * `require("@paperclipai/server")` resolves to from inside the published CLI.
 */
export function runningServerDistCandidates(env = process.env) {
  const home = env.HOME || homedir();
  const cliRoot = env.PAPERCLIP_CLI_ROOT || join(home, ".npm-global", "lib", "node_modules", "paperclipai");
  return [
    // What `require("@paperclipai/server")` resolves to from inside the CLI.
    join(cliRoot, "node_modules", "@paperclipai", "server", "dist"),
    // A pnpm/npm workspace install of the repo itself.
    join(home, "Projects", "paperclipai", "paperclip", "node_modules", "@paperclipai", "server", "dist"),
    // A repo checkout is a legitimate running build for a source install, but
    // it is listed last: it is the tree a developer edits, so it drifts ahead
    // of the deployed one and would mask a stale deploy.
    resolve(join(home, "Projects", "paperclipai", "paperclip", "server", "dist")),
  ];
}

/**
 * Sentinels are identifiers a fix introduced. They are deliberately function
 * names and reason codes rather than line numbers or hashes: a compiled
 * artifact cannot be diffed against a `.ts` file, but a symbol survives
 * compilation, and a rename that drops the guard drops the symbol with it.
 */
export const RUNNING_BUILD_SENTINELS = [
  {
    id: "checkout-refuses-terminal-run",
    sinceCommit: "5b9f94eee",
    sourcePath: "server/src/services/issues.ts",
    distPath: "services/issues.js",
    markers: ["assertCheckoutRunIsActive"],
    summary: "POST /checkout refuses a run whose status is terminal",
  },
  {
    id: "run-bound-fallback-scoped",
    sinceCommit: "73784955c",
    sourcePath: "server/src/services/cross-issue-influence-limit.ts",
    distPath: "services/cross-issue-influence-limit.js",
    markers: ["TERMINAL_HEARTBEAT_RUN_STATUSES"],
    summary: "the run-bound cross-issue fallback only trusts an active run",
  },
  {
    id: "cross-issue-403-names-the-gate",
    sinceCommit: "f80a08c00",
    sourcePath: "server/src/services/cross-issue-influence-limit.ts",
    distPath: "services/cross-issue-influence-limit.js",
    markers: ["no_context_source_and_target_unbound"],
    summary: "the 403 details carry the reason that fired",
  },
];

/** First candidate root that actually holds a server dist. */
export function resolveRunningServerDist(candidates, exists = existsSync) {
  for (const candidate of candidates) {
    if (exists(join(candidate, "services", "issues.js"))) return candidate;
  }
  return null;
}

function readSourceAtHead(sourcePath, git) {
  return git(["show", `HEAD:${sourcePath}`]);
}

/**
 * Evaluate every sentinel against a running dist root.
 *
 * `git` is injected so the test can drive this without a repository, and so a
 * git failure is distinguishable from a missing marker.
 */
export function evaluateSentinels(sentinels, { distRoot, git, exists = existsSync }) {
  return sentinels.map((sentinel) => {
    const sourceMissingFromHead = sentinel.markers.filter(
      (marker) => !readSourceAtHead(sentinel.sourcePath, git).includes(marker),
    );
    const distFile = join(distRoot, sentinel.distPath);
    const deployedExists = exists(distFile);
    const deployedText = deployedExists ? readFileSync(distFile, "utf8") : "";
    const missingFromDeployed = deployedExists
      ? sentinel.markers.filter((marker) => !deployedText.includes(marker))
      : [...sentinel.markers];

    return {
      ...sentinel,
      distFile,
      deployedExists,
      missingFromDeployed,
      sourceMissingFromHead,
      state:
        // A manifest that no longer matches the source is a defect in this
        // file. It is reported as its own state so it can never be confused
        // with "deployed and current".
        sourceMissingFromHead.length > 0
          ? "manifest_mismatch"
          : missingFromDeployed.length > 0
            ? "drifted"
            : "deployed",
    };
  });
}

export function summarize(results) {
  return {
    total: results.length,
    deployed: results.filter((r) => r.state === "deployed").length,
    drifted: results.filter((r) => r.state === "drifted").map((r) => r.id),
    manifestMismatch: results.filter((r) => r.state === "manifest_mismatch").map((r) => r.id),
  };
}

export function formatReport(report) {
  const lines = [`running build: ${report.distRoot ?? "(not found)"}`];
  for (const result of report.results) {
    const mark = result.state === "deployed" ? "ok  " : result.state === "drifted" ? "DRIFT" : "BUG  ";
    lines.push(
      `  ${mark} ${result.id} — ${result.summary}` +
        (result.state === "drifted"
          ? `\n         committed at ${result.sinceCommit} but absent from ${result.distFile}`
          : "") +
        (result.state === "manifest_mismatch"
          ? `\n         marker not in ${result.sourcePath} at HEAD: ${result.sourceMissingFromHead.join(", ")}`
          : ""),
    );
  }
  if (report.manifestMismatch.length > 0) {
    lines.push(
      "",
      "This is a bug in check-running-build-drift.mjs: a sentinel no longer matches the",
      "source it claims to guard. Fix the manifest before trusting any result here.",
    );
  } else if (report.drifted.length > 0) {
    lines.push(
      "",
      `${report.drifted.length} fix(es) are committed and not in the running build.`,
      "Redeploy the release; a reinstall that keeps an older artifact is not a deploy.",
    );
  } else {
    lines.push("", "every guarded fix is present in the running build.");
  }
  return lines.join("\n");
}

function main(argv) {
  const asJson = argv.includes("--json");
  const distRoot = resolveRunningServerDist(runningServerDistCandidates());
  if (!distRoot) {
    const message = "no running @paperclipai/server dist found; cannot evaluate deploy state";
    process.stdout.write(asJson ? `${JSON.stringify({ error: message }, null, 2)}\n` : `${message}\n`);
    return 2;
  }

  const git = (args) => execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  const results = evaluateSentinels(RUNNING_BUILD_SENTINELS, { distRoot, git });
  const report = { distRoot, ...summarize(results), results };

  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
  if (report.manifestMismatch.length > 0) return 2;
  return report.drifted.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
