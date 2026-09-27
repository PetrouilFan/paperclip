#!/usr/bin/env node
/**
 * Report committed-but-undeployed fixes on the running build.
 *
 * "The fix is committed" and "the fix is running" look identical on the board:
 * both are a green PR, and a reinstall that keeps an older artifact looks like a
 * successful deploy. One case hit exactly that — PR #15 merged
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
 * A third question is reported alongside the two, and it is the one a deploy
 * decision actually turns on: "present" and "durably present" are different
 * answers. A fix applied by editing the installed `dist` in place reads as
 * deployed here and is deleted by the next `npm install`, so the report also
 * counts the `.bak-*` / `.pre-*` scars such an edit leaves and says which
 * sentinels are being held by a hand-patch rather than by a release. Without
 * that, the natural reading of a green line is "a reinstall is safe", which is
 * the one conclusion that turns a healthy plane into a regression. See
 * `docs/deploy/shadowed-server-install.md`.
 *
 * Exit codes: 0 no drift, 1 drift found, 2 the check could not be evaluated
 * (no running build found, a manifest/source mismatch, or an unreadable source
 * tree — the last two are bugs in this file, not deploy states). Every
 * unevaluated path returns 2, never 1, so a broken check can never be read as
 * a deploy finding.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    // it is listed last because it is the tree a developer edits, and an edited
    // tree is not the deployed one in either direction. Preferring it does not
    // "mask" a stale deploy — measured on this host it manufactures false drift:
    // ~/Projects/paperclipai/paperclip/server/dist is behind the installed
    // artifact, and resolving it first reports 4 findings where the running
    // build has 2, the extra 2 being sentinels that are genuinely deployed.
    // The ordering exists so the report means "what the server loads", and
    // blaming a healthy deploy on a developer's stale tree is the more dangerous
    // direction to get wrong.
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
    // `no_context_source_and_target_unbound` is a reason-code string literal,
    // so it survives compilation unconditionally — which means it also survives
    // in builds that predate everything this guard has since grown. A build
    // that names the reason and nothing else satisfied this sentinel on its
    // own, so it read `ok` on a build missing the payload and the exemption
    // below. Requiring a payload key as well keeps the reason string necessary
    // without letting it be sufficient on its own.
    id: "cross-issue-403-names-the-gate",
    sinceCommit: "f80a08c00",
    sourcePath: "server/src/services/cross-issue-influence-limit.ts",
    distPath: "services/cross-issue-influence-limit.js",
    markers: ["no_context_source_and_target_unbound", "targetAssignedToOtherActor"],
    summary: "the 403 details carry the reason that fired",
  },
  {
    // The self-assigned-target exemption. An agent writing to the issue it is
    // assigned needs no run to attribute the write to, and the guard used to
    // refuse it as `no_context_source_and_target_unbound` after the permission
    // layer had already said yes. Every `blocked` issue was affected, because a
    // blocked issue cannot check out and so can never reach a binding.
    //
    // Both payload keys are required: either alone is carried by builds that
    // name the holder but not the binding, or the binding but not the
    // assignee, and neither state is the fix.
    id: "run-context-allows-self-assigned-target",
    sinceCommit: "1220016a",
    sourcePath: "server/src/services/cross-issue-influence-limit.ts",
    distPath: "services/cross-issue-influence-limit.js",
    markers: ["targetAssignedToOtherActor", "targetHeldByAnotherRun"],
    summary: "the assignee may write the issue it is assigned without a run to attribute it to",
  },
  {
    // `blockedByIssueIds` used to be write-only: PATCH accepted it, and no read
    // path returned it. The write and the read were one field, so an issue that
    // had just been given a blocker read back as having none — which is how a
    // ticket with a legitimate first-class blocker gets reported as a blocked
    // issue with nothing behind it.
    //
    // The single-issue read and the list read are separate code paths that were
    // fixed separately, so each is guarded on its own marker: a build that
    // carried one and not the other would still be half-readable, and the
    // symptom is a false "no blockers" that a sweep acts on.
    id: "blocked-issue-ids-readable-on-single-read",
    sinceCommit: "725a8ed3",
    sourcePath: "server/src/routes/issues.ts",
    distPath: "routes/issues.js",
    markers: ["sortedRelationIds"],
    summary: "GET /issues/{id} returns the blockers it was given",
  },
  {
    id: "blocked-issue-ids-readable-on-list-read",
    sinceCommit: "725a8ed3",
    sourcePath: "server/src/services/issues.ts",
    distPath: "services/issues.js",
    markers: ["blockedByIdsMapForIssues"],
    summary: "the issue list returns the blockers each issue was given",
  },
  {
    // The sentinel above is satisfied by the *superseded* variant of the
    // fallback, so a build that predates the widened fix reports green. That
    // variant exempts only the target issue and then fails closed; it never
    // derives a source from the binding, so a context-less run bound to one
    // issue still cannot write to another, and it reports a terminal run under
    // the generic `no_context_source_and_target_unbound` rather than the
    // distinct `terminal_status`. These markers are absent from that variant
    // and present in the committed one, so they separate the two.
    //
    // `terminal_status` is a reason-code string literal, which survives
    // compilation unconditionally; `boundSourceIssueId` is the identifier that
    // carries the source attribution. Both are required, so losing either one
    // reports drift.
    id: "run-bound-fallback-attributes-source",
    sinceCommit: "d17e7ee1e",
    sourcePath: "server/src/services/cross-issue-influence-limit.ts",
    distPath: "services/cross-issue-influence-limit.js",
    markers: ["boundSourceIssueId", "terminal_status"],
    summary: "the run-bound fallback attributes a write to the bound issue and names a terminal run",
  },
  {
    // This one reads as drift on every published release, and the reason
    // matters: a malformed request body has to be distinguishable from a
    // server fault, because the run contract tells an agent to stop retrying a
    // control-plane write after two failures of the same write. A `500
    // {"error":"Internal server error"}` names no field, no offset and no
    // parser message, so it reads as a server fault and spends the retries on
    // a client-side typo. The fix turns that into a `400` carrying
    // `Invalid JSON body`, which is the same string the server's own tests
    // assert on.
    id: "malformed-json-is-a-400",
    sinceCommit: "3ff3b34e1",
    sourcePath: "server/src/middleware/error-handler.ts",
    distPath: "middleware/error-handler.js",
    markers: ["Invalid JSON body"],
    summary: "a malformed request body is a 400, not an unnamed 500",
  },
  {
    // The embedded-database stop path. A unit using `KillMode=control-group`
    // takes the requested stop of its own database with it, and if the
    // supervisor reads that as an unexpected exit it relaunches what was just
    // deliberately stopped. This existed on the `default` plane only as a
    // hand-patch, which made it invisible to this check *and* deletable by any
    // reinstall: the reported release could not restore it, because no
    // published channel ever carried it.
    id: "embedded-postgres-shutdown-intent",
    sinceCommit: "6a92f523a",
    sourcePath: "server/src/embedded-postgres-supervisor.ts",
    distPath: "embedded-postgres-supervisor.js",
    markers: ["markShutdownIntent", "onRecoveryExhausted"],
    summary: "a requested database stop is not read as an unexpected exit",
  },
];

/** First candidate root that actually holds a server dist. */
export function resolveRunningServerDist(candidates, exists = existsSync) {
  for (const candidate of candidates) {
    if (exists(join(candidate, "services", "issues.js"))) return candidate;
  }
  return null;
}

/** Filename suffixes a hand-edit of the installed dist leaves behind. */
export const PATCH_SCAR_SUFFIXES = [".bak-", ".bak.", ".pre-", ".orig"];

/**
 * Files under the dist root that look like the retained original of a
 * hand-edited file.
 *
 * A packaged install is the ground truth agents stop reasoning about, so
 * editing it in place is invisible everywhere except here: the version string
 * still says the release, and the fix reads as deployed. The retained original
 * is the tell, because a hand-edit almost always keeps the file it replaced
 * next to the file it replaced it with. Reporting the scars is what turns
 * "deployed" into "deployed, and one `npm install` from gone" — and the second
 * half is the half that decides whether a reinstall is safe.
 *
 * Scoped to the directories a sentinel actually reads plus the dist root
 * itself. Walking all 5000 files of a full dist to find ten backups is not
 * worth the cost, and a sentinel reading a clean file is not made safer by a
 * scar somewhere else in the tree.
 */
export function findPatchScars(
  distRoot,
  sentinels = RUNNING_BUILD_SENTINELS,
  readdir = readdirSync,
) {
  const dirs = new Set([distRoot, ...sentinels.map((s) => join(distRoot, s.distPath, ".."))]);
  const scars = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdir(dir, { withFileTypes: true });
    } catch {
      // A sentinel whose directory cannot be listed is already reported as
      // drift, and an unreadable directory is not evidence of a hand-patch.
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (PATCH_SCAR_SUFFIXES.some((suffix) => entry.name.includes(suffix))) {
        scars.push({ dir, name: entry.name });
      }
    }
  }
  return scars.sort((a, b) => a.name.localeCompare(b.name));
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
  if (report.scars && report.scars.length > 0) {
    lines.push(
      "",
      `${report.scars.length} retained-original file(s) in the dist root — this install was`,
      "edited in place, so the fixes above are held by a hand-patch and not by a release:",
      ...report.scars.map((scar) => `  ${scar.name}`),
      "",
      "An npm install of any channel deletes these and restores the released files, which",
      "silently reverts every fix the scars were carrying. Port them to source and merge",
      "that instead, or install a build that already contains them. See",
      "docs/deploy/shadowed-server-install.md.",
    );
  }
  return lines.join("\n");
}

export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_UNEVALUATED = 2;

/**
 * The whole check, as a function of its inputs, returning an exit code.
 *
 * Every path that cannot answer the question returns `EXIT_UNEVALUATED`, never
 * `EXIT_DRIFT`. A `git show HEAD:<file>` failure (the wrong working directory,
 * a detached or missing checkout) used to escape as an uncaught exception, and
 * Node exits an uncaught exception with status 1 — the same code that means
 * "drift found". A board consumer reading the exit code would have read a
 * broken check as a deploy finding, which is the one confusion this file
 * exists to rule out.
 */
export function runCheck({
  asJson = false,
  distRoot,
  git,
  exists = existsSync,
  readdir = readdirSync,
  sentinels = RUNNING_BUILD_SENTINELS,
  write = (text) => process.stdout.write(text),
} = {}) {
  const emit = (payload, text) =>
    write(asJson ? `${JSON.stringify(payload, null, 2)}\n` : `${text}\n`);

  if (!distRoot) {
    emit(
      { error: "no running @paperclipai/server dist found", unevaluated: true },
      "no running @paperclipai/server dist found; cannot evaluate deploy state",
    );
    return EXIT_UNEVALUATED;
  }

  let results;
  try {
    results = evaluateSentinels(sentinels, { distRoot, git, exists });
  } catch (error) {
    // The source half could not be read. That is a broken check, not a deploy
    // state, and it must not borrow the drift code.
    const reason = error instanceof Error ? error.message : String(error);
    emit(
      { error: `could not read the source tree at HEAD: ${reason}`, unevaluated: true },
      `could not read the source tree at HEAD: ${reason}`,
    );
    return EXIT_UNEVALUATED;
  }

  // Reported, never fatal. A hand-edited install is a fact about the plane, and
  // the exit code already carries the question this check was asked to answer
  // — borrowing the drift code for it would report a reinstall hazard as a
  // deploy finding and train readers to ignore the code.
  const report = {
    distRoot,
    ...summarize(results),
    results,
    scars: findPatchScars(distRoot, sentinels, readdir),
  };
  write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
  if (report.manifestMismatch.length > 0) return EXIT_UNEVALUATED;
  return report.drifted.length > 0 ? EXIT_DRIFT : EXIT_OK;
}

function main(argv) {
  const asJson = argv.includes("--json");
  const distRoot = resolveRunningServerDist(runningServerDistCandidates());
  const git = (args) => execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  return runCheck({ asJson, distRoot, git });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
