#!/usr/bin/env node
/**
 * run-quality-gates.mjs
 * Orchestrates all quality gates. Fetches PR data once, runs all gates,
 * posts or updates a single consolidated comment via commitperclip.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH
 * Exit: 0 if all quality gates pass, 1 if any fail.
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { fetchAllPullRequestFiles, fetchWholeFileContents } from './fetch-pr-files.mjs';
import { fetchAllPullRequestComments } from './fetch-pr-comments.mjs';
import { checkTemplate } from './check-pr-template.mjs';
import { checkLinkedIssue } from './check-pr-linked-issue.mjs';
import { checkDedupSearch } from './check-pr-dedup-search.mjs';
import { resolveTestCoverage } from './check-pr-test-coverage.mjs';
import { checkLockfile } from './check-pr-lockfile.mjs';
import { checkDependencies } from './check-pr-dependencies.mjs';
import { checkReleaseBootstrap } from './check-pr-release-bootstrap.mjs';
import { checkCoauthors, fetchAllPullRequestCommits } from './check-pr-coauthors.mjs';
import {
  GATE_COMMENT_LOGINS,
  GATE_COMMENT_SIGNATURE as COMMENT_SIGNATURE,
  checkInternalRefs,
  filesNeedingWholeContent,
} from './check-pr-internal-refs.mjs';

export { GATE_COMMENT_LOGINS as COMMITPERCLIP_LOGINS };

/**
 * The provenance line stamped under the gate detail.
 *
 * The comment is upserted, so on its own it cannot tell a reader whether it was
 * rewritten by the push they are looking at or left behind by an earlier one.
 * That matters most for a `workflow_dispatch` re-gate: its whole purpose is to
 * replace a verdict the head commit is still carrying, and if the comment is
 * not stamped it is indistinguishable from the verdict it is replacing. Naming
 * the run and the gate revision makes the recency checkable instead of assumed.
 *
 * Returns null when the caller supplied nothing to stamp, which is the case
 * for any invocation outside the workflow. The line is placed above the
 * signature, so the comment still contains exactly one `— commitperclip` and
 * `findExistingComment` still recognises it.
 */
export function buildProvenanceLine({ runId, runUrl, baseSha, ranAt } = {}) {
  if (!runId && !runUrl && !baseSha) return null;

  const parts = [];
  if (ranAt) parts.push(`Gates ran ${ranAt}`);
  else parts.push('Gates ran');

  if (baseSha) parts.push(`from gate revision \`${String(baseSha).slice(0, 9)}\``);
  if (runUrl) parts.push(`[run ${runId ?? '?'}](${runUrl})`);
  else if (runId) parts.push(`(run ${runId})`);

  return `${parts.join(' ')}.`;
}

function withProvenance(body, provenance) {
  if (!provenance) return body;
  // The signature is the last line of every body this function builds.
  const at = body.lastIndexOf(COMMENT_SIGNATURE);
  if (at === -1) return `${body}\n\n${provenance}\n${COMMENT_SIGNATURE}`;
  return `${body.slice(0, at)}${provenance}\n\n${body.slice(at)}`;
}

export function buildComment(author, failures, informational, provenance = null) {
  const body = (() => {
    if (failures.length === 0 && informational.length === 0) {
      return '✅ All checks passing — ready for Greptile review and maintainer approval.';
    }

    const lines = [
      `Hey @${author}! Before this PR can be reviewed, a few things need attention:\n`,
    ];

    if (failures.length > 0) {
      lines.push('**Missing or incomplete:**');
      for (const f of failures) lines.push(`- [ ] ${f}`);
    }

    if (informational.length > 0) {
      if (failures.length > 0) lines.push('');
      lines.push('**Informational:**');
      for (const i of informational) lines.push(`- ${i}`);
    }

    lines.push('\nOnce updated, push a new commit and these checks will re-run automatically.');

    return lines.join('\n');
  })();

  return withProvenance(`${body}\n\n${COMMENT_SIGNATURE}`, provenance);
}

export async function findExistingComment(fetchFromGitHub, token, repo, prNumber, commenterLogins = GATE_COMMENT_LOGINS) {
  const owners = new Set(commenterLogins);

  for (let page = 1; ; page += 1) {
    const comments = await fetchFromGitHub(
      `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      token
    );

    const existing = comments.find(
      (c) => owners.has(c.user?.login) && c.body.includes(COMMENT_SIGNATURE)
    );
    if (existing) return existing;

    if (comments.length < 100) return null;
  }
}

async function upsertComment(token, repo, prNumber, body, existing) {
  if (existing) {
    await ghFetch(`/repos/${repo}/issues/comments/${existing.id}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  } else {
    await ghFetch(`/repos/${repo}/issues/${prNumber}/comments`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }
}

/**
 * Flattens the gates' failures into the one list that decides the exit code.
 *
 * Exported so the wiring is testable: a gate that is imported and run but never
 * added to this list passes every run while appearing in the orchestrator, and
 * that is the one failure mode a gate cannot detect about itself.
 */
export function collectBlockingFailures(results) {
  return results.flatMap((result) => result?.failures ?? []);
}

async function main() {
  const { GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_BRANCH } = process.env;

  if (!GH_TOKEN || !GH_REPO || !PR_NUMBER) {
    console.error('ERROR: GH_TOKEN, GH_REPO, PR_NUMBER env vars required');
    process.exit(1);
  }

  // Sanitize inputs before use in URL construction (prevents SSRF)
  const prNumber = parseInt(PR_NUMBER, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('ERROR: PR_NUMBER must be a positive integer');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GH_REPO)) {
    console.error('ERROR: GH_REPO must be in owner/repo format');
    process.exit(1);
  }

  // Fetch PR data once — gates use this, no redundant API calls
  const [pr, files] = await Promise.all([
    ghFetch(`/repos/${GH_REPO}/pulls/${prNumber}`, GH_TOKEN),
    fetchAllPullRequestFiles(ghFetch, GH_REPO, prNumber, GH_TOKEN),
  ]);

  // Separate, and allowed to fail. Neither gate that reads commits can fail a PR
  // because the commit *list* did not arrive: sharing the Promise.all above
  // would let one transient 5xx on this request take down every gate, including
  // the ones that block.
  //
  // The fetch staying optional does not make the surface optional. Both gates
  // that read commits are handed the empty list and `commitsUnavailable`, and
  // each fails closed on it rather than reporting a clean scan about text it
  // never saw — a `Co-Authored-By` trailer it could not check is exactly the
  // defect the co-author gate exists to catch, and a silent pass there reads as
  // evidence.
  let commits = [];
  let commitsUnavailable = false;
  try {
    commits = await fetchAllPullRequestCommits(ghFetch, GH_REPO, prNumber, GH_TOKEN);
  } catch (error) {
    commitsUnavailable = true;
    console.error(`co-author lookup skipped: ${error.message}`);
  }

  // Same shape, and for the same reason, on the surface that carries the most
  // findings: the comment list is allowed to fail, and its failure is a gate
  // failure rather than a clean scan. 131 of the 367 comments on the 100 most
  // recently updated pull requests on this fork carry a finding, so this is the
  // fetch whose silent empty list would cost the most.
  let comments = [];
  let commentsUnavailable = false;
  try {
    comments = await fetchAllPullRequestComments(ghFetch, GH_REPO, prNumber, GH_TOKEN);
  } catch (error) {
    commentsUnavailable = true;
    console.error(`comment lookup skipped: ${error.message}`);
  }

  // The second reader, for the one file class GitHub will not produce a patch
  // for. Kept out of the `Promise.all` above and given its own allowed-to-fail
  // handling for the same reason the commit and comment fetches are: a
  // supplementary read must not be able to take down the gates that do block.
  //
  // It is also allowed to come back empty without consequence beyond coverage.
  // The gate is handed the files it managed to read and reports the rest as
  // unscannable, which is the verdict it gave before this existed — so the
  // worst outcome of this fetch failing is the behaviour this repository already
  // ships, and its absence cannot turn a red into a green.
  const fileContents = await fetchWholeFileContents(
    ghFetch,
    GH_REPO,
    filesNeedingWholeContent(files),
    pr.head?.sha,
    GH_TOKEN
  );
  const wholeFileCount = Object.keys(fileContents).length;
  if (wholeFileCount > 0) {
    console.error(`internal-reference gate: read ${wholeFileCount} file(s) whole because the patch did not arrive`);
  }

  // The deployment's own commenter login, if it has one. The gate needs it for
  // the same reason `findExistingComment` does: on a repository that posts as a
  // login neither default list names, that login's comment is the gate's own
  // and must not be read as content.
  const commenter = process.env.GH_COMMENTER_LOGIN?.trim();
  const ownerLogins = commenter
    ? [...new Set([...GATE_COMMENT_LOGINS, commenter])]
    : GATE_COMMENT_LOGINS;

  const prBody = pr.body ?? '';
  const author = PR_AUTHOR ?? pr.user.login;
  const branch = PR_BRANCH ?? pr.head.ref;

  // A repository with GitHub issues disabled has no issue to link, so the
  // linked-issue gate must not advise the author to write `Refs #NNN`. The
  // pull payload already carries the flag, so this costs no extra API call.
  // Default to `true` when the field is absent, so the gate keeps the upstream
  // guidance rather than silently dropping the issue-link route.
  const repoHasIssues = pr.base?.repo?.has_issues !== false;

  // Run all quality gates (pure functions run sync, deps check is async)
  const prTitle = pr.title ?? '';
  const [templateResult, issueResult, dedupResult, testResult, lockfileResult, depsResult, bootstrapResult] =
    await Promise.all([
      Promise.resolve(checkTemplate(prBody)),
      Promise.resolve(checkLinkedIssue(prBody, prTitle, { repoHasIssues })),
      Promise.resolve(checkDedupSearch(prBody, prTitle)),
      // Given a re-read, because a `prefix_mismatch` is the one verdict a
      // stale `pulls/{n}/files` response can manufacture. See
      // `resolveTestCoverage` for why only that verdict is re-read.
      resolveTestCoverage(files, prTitle, () =>
        fetchAllPullRequestFiles(ghFetch, GH_REPO, prNumber, GH_TOKEN)),
      Promise.resolve(checkLockfile(files, author, branch)),
      checkDependencies(files, GH_TOKEN, GH_REPO, prNumber, pr.base?.ref),
      checkReleaseBootstrap(files, GH_TOKEN, GH_REPO, prNumber, pr.base?.ref),
    ]);
  // Kept out of the Promise.all above for the same reason as the co-author
  // lookup: `commits` and `comments` are populated by fetches that are allowed
  // to fail, and a gate that needs them must see the empty lists rather than
  // never run at all. On empty lists this gate still scans the title, the body,
  // the branch and the whole diff — the commit-message and comment legs are the
  // only things it loses, which is why `commitsUnavailable` and
  // `commentsUnavailable` make it say so rather than pass quietly.
  const internalRefsResult = checkInternalRefs({
    prTitle,
    prBody,
    prBranch: branch,
    commits,
    commitsUnavailable,
    comments,
    commentsUnavailable,
    commentLogins: ownerLogins,
    files,
    fileContents,
    prefixes: process.env.INTERNAL_REF_PREFIXES,
    productOwnedPrefixes: process.env.PRODUCT_OWNED_REF_PREFIXES,
  });
  // A second gate on the same list, on the same fail-closed rule. Its trailer
  // check reads the commit messages, and the informational hand-over below reads
  // the commit authors; the two halves answer different questions and the second
  // one blocks, so both need the list and both need to know it is missing.
  const coauthorResult = checkCoauthors(commits, author, { commitsUnavailable });

  const allFailures = collectBlockingFailures([
    templateResult,
    issueResult,
    dedupResult,
    testResult,
    lockfileResult,
    internalRefsResult,
    coauthorResult,
  ]);
  const informational = [
    ...(depsResult.informational ?? []),
    ...(bootstrapResult.informational ?? []),
    ...coauthorResult.informational,
  ];
  const allPassed = allFailures.length === 0;

  const commentBody = buildComment(author, allFailures, informational, buildProvenanceLine({
    runId: process.env.GATE_RUN_ID,
    runUrl: process.env.GATE_RUN_URL,
    baseSha: process.env.GATE_BASE_SHA,
    ranAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  }));

  // Post comment if there are failures/informational, or update existing comment.
  // `ownerLogins` is resolved above, before the gates run, because the
  // internal-reference gate needs the same answer this line does: a comment
  // matching that predicate is the gate's own, and the gate does not read it.
  const existing = await findExistingComment(ghFetch, GH_TOKEN, GH_REPO, prNumber, ownerLogins);
  if (allFailures.length > 0 || informational.length > 0 || existing) {
    await upsertComment(GH_TOKEN, GH_REPO, prNumber, commentBody, existing);
  }

  console.log(JSON.stringify({ passed: allPassed, failures: allFailures, informational }));
  process.exit(allPassed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
