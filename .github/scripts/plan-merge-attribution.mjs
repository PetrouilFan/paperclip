#!/usr/bin/env node
/**
 * plan-merge-attribution.mjs
 * Checks the squash body a merge is about to carry, while it can still be edited.
 * Export: planMergeAttribution({ prAuthor, commits, mergeMessage })
 *
 * ## The gap this fills
 *
 * `check-pr-coauthors.mjs` says which `Co-Authored-By` trailers a squash needs,
 * and says it in a comment on an open pull request. `audit-merge-attribution.mjs`
 * checks the message that landed, and finds the credit missing. Between them the
 * two halves of the chain do not meet, and the loss happens in the gap: nobody
 * holds the body, so nobody can check it, and the only report of a lost credit is
 * produced after the history it concerns already exists.
 *
 * The measure of that gap is the history of this repository. Every merge whose
 * body omitted a prescribed trailer lost the credit permanently, and on this fork
 * that has been a repeated event on pull requests where the gate ran, named the
 * contributor, and asked for the line. The gate's own comment is accurate. The
 * gate cannot be wrong about this and still be right about it: the squash body
 * does not exist while the pull request is open.
 *
 * ## Why this is not a second implementation
 *
 * The post-merge audit is a pure predicate over two things — the branch's commits
 * and a commit message. It does not read the merge state, so a message that has
 * not been written answers it exactly as well as one that has. This file is that
 * predicate asked one moment earlier, against the body the merger is about to
 * write, and the two cannot disagree because there is only one of them. A second
 * copy of the attribution rules is exactly the failure mode that put this gap
 * here: two implementations of "who would a squash drop" drift, and the drift
 * reads as a clean result rather than as a bug.
 *
 * ## What it reports
 *
 * The audit's own findings, unchanged, because a caller that has to learn a
 * second vocabulary to read a pre-merge report learns neither. What is added is
 * the missing piece the post-merge half has no way to produce: the exact trailer
 * block to paste. A check that reports a loss without handing over the line that
 * fixes it has moved the work rather than removed it, and the work is the part
 * that did not get done.
 *
 * ## What it does not do
 *
 * It does not decide whether a merge may proceed. `verdict` is a fact about the
 * body, and a caller is free to act on it or ignore it. Wiring this into a merge
 * path so that a body which loses a credit cannot be written at all is a change
 * to how this repository is merged, and that is a decision for the people who own
 * it — not something a tool that can express the decision should quietly make.
 * `--enforce` exists so that such a wrapper can demand a body rather than
 * silently accepting an unjudged merge; it is the hook for that decision, and it
 * takes no decision itself.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { auditMergeAttribution, formatAudit, parseTrailer, readTrailers } from './audit-merge-attribution.mjs';

/**
 * The trailer lines a merge of this branch owes, in the order to paste them.
 *
 * Sorted and de-duplicated, because the block is compared against what the
 * merger typed and a set that changes order between two runs of the same pull
 * request is a diff nobody can read. A machine identity and a person can
 * normalise onto one line, and one line is one credit — there is no second
 * person to hand it to.
 */
export function prescribedBlock(prescribed) {
  return [...new Set((prescribed ?? []).map(id => `Co-Authored-By: ${id}`))].sort();
}

/**
 * Lines in the owed block whose author name carries a robot marker.
 *
 * Reported, not removed. GitHub does not always put `[bot]` on the account — the
 * Copilot coding agent commits as `copilot-swe-agent[bot]` under the account
 * `Copilot` — so the gate's bot rule, which keys on the login alone, prescribes a
 * credit for it. Filtering on the name instead would also drop a person whose
 * `git config user.name` happens to read `renovate[bot]`, and that is the same
 * silent loss this tool exists to report, reached from the other side. The
 * evidence that separates the two is the account's type, which the gate is not
 * given.
 *
 * So the line stays in the block and carries a warning. Deciding is left to the
 * person reading it, which is the only party here who can tell a robot from a
 * person with an unlucky handle.
 */
export function robotMarkers(prescribed) {
  return (prescribed ?? []).filter(identity => /\[bot\]$/i.test(parseTrailer(identity).name));
}

/**
 * A complete, correct merge body for this pull request.
 *
 * The pull request's own text, then a blank line, then the trailer block. The
 * trailer block goes last because that is where git reads it from, and a
 * hand-pasted line in the middle of prose is read as prose. Written by a tool
 * rather than by hand because the whole failure is a paste that did not happen,
 * and a paste is a step that can be made not to be a step.
 */
export function mergeBody({ title, description, trailers }) {
  const parts = [title ?? ''];
  const prose = String(description ?? '').trim();
  if (prose) parts.push(prose);
  parts.push(addTrailers(trailers, prose).join('\n'));
  return `${parts.join('\n\n')}\n`;
}

/** The address decides, or the name where only one side has one. */
function sameIdentity(a, b) {
  const want = parseTrailer(a);
  const got = parseTrailer(b);
  if (want.email && got.email) return want.email === got.email;
  return Boolean(want.name) && want.name === got.name;
}

/**
 * The trailer block, minus anything the description already carries.
 *
 * A description often ends with the trailer block already on it — the author
 * pasted it where the gate asked for it — and appending the same line a second
 * time writes a duplicate into permanent history, which the audit then reports
 * on a merge nobody made a mistake on. The block is not simply dropped, because
 * this function does not get to decide that the description's copy was the right
 * one; it is recognised and not repeated.
 *
 * The judgement is not made here either. `planMergeAttribution` re-reads the body
 * this writes and reports whatever it finds, so a line this function believed it
 * had deduplicated and got wrong shows up as a finding rather than as silence.
 */
export function addTrailers(trailers, description = '') {
  const already = new Set(readTrailers(description).map(identityKey));
  return (trailers ?? []).filter(t => !already.has(identityKey(t)));
}

/** The address when there is one, else the whole rendered identity. */
function identityKey(trailer) {
  const { email, name } = parseTrailer(trailer);
  return email || name;
}

/**
 * Ask the post-merge audit about a body that has not been written yet.
 *
 * `mergeMessage` is the body under test. Omit it and the question is not
 * answered rather than answered yes: `verdict` is `unverified`, because a pull
 * request with no proposed body has lost nothing yet and reporting otherwise
 * would let a caller read a clean result out of a question never asked.
 *
 * `verdict` is derived from the audit's own `passed`, not recomputed from the
 * finding list. Two derivations of the same rule is the drift this file exists
 * to avoid, and a test asserts the two cannot come apart.
 */
export function planMergeAttribution(input) {
  const { prAuthor, commits, mergeMessage, prNumber = null } = input ?? {};
  const audit = auditMergeAttribution({ prAuthor, commits, mergeMessage });
  const trailers = prescribedBlock(audit.prescribed);
  const judged = typeof mergeMessage === 'string';
  return {
    pr: prNumber,
    passed: judged ? audit.passed : null,
    verdict: !judged ? 'unverified' : audit.passed ? 'clean' : 'loss',
    prescribed: audit.prescribed,
    trailers,
    flagged: robotMarkers(audit.prescribed),
    onMerge: audit.onMerge,
    findings: audit.findings,
    counts: audit.counts,
  };
}

/** A report a merger can act on, and the paste when one is owed. */
export function formatPlan(result) {
  const lines = [];
  if (result.prescribed.length === 0) {
    lines.push(
      'This branch carries no contributor outside the pull request author, so the merge body owes no trailer.'
    );
  } else {
    lines.push(`This merge body owes ${result.trailers.length} trailer line${result.trailers.length === 1 ? '' : 's'}:`);
    lines.push('');
    for (const t of result.trailers) lines.push(`  ${t}`);
    lines.push('');
    lines.push('Write them into the last paragraph of the squash body, as a block:');
    lines.push('');
    lines.push(`  gh pr merge ${result.pr ?? '<pr>'} --squash --body-file <file>`);
  }

  if ((result.flagged ?? []).length > 0) {
    lines.push('');
    lines.push('Read these before pasting them:');
    for (const id of result.flagged) {
      lines.push(`  - \`${id}\` is credited by a commit whose author name carries a robot marker, and the`);
      lines.push('    account it matched to does not. On this fork that is usually a machine, but a');
      lines.push('    person can have the same name, so nothing here decides it.');
    }
  }

  if (result.verdict === 'unverified') {
    lines.push('');
    lines.push('No merge body was supplied, so nothing was judged. The block above is what the body owes.');
  } else if (result.verdict === 'clean') {
    lines.push('');
    lines.push('The proposed body delivers every prescribed credit.');
  } else {
    lines.push('');
    lines.push('The proposed body loses a credit. The merge is still possible, and the commit that lands will not name the contributor above.');
  }

  const advisories = result.findings.length > 0
    ? `\n\n${formatAudit({ findings: result.findings })}`
    : '';
  return lines.join('\n') + advisories;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** The body under test: `--body`, `--body-file`, or `--stdin`, in that order. */
function readProposedBody(argv, env) {
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? null : argv[at + 1] ?? '';
  };
  const inline = flag('--body');
  if (inline !== null) return inline;
  const path = flag('--body-file');
  if (path !== null) return readFileSync(path, 'utf8');
  if (argv.includes('--stdin')) return readFileSync(0, 'utf8');
  // A caller that has already assembled the body in an environment variable —
  // a wrapper reading it back from `gh pr merge` — should not have to write a
  // file to ask the question.
  return env.MERGE_BODY ?? undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const env = process.env;
  const enforce = argv.includes('--enforce');
  const asJson = argv.includes('--format') && argv[process.argv.indexOf('--format') + 1] === 'json';
  const writeTo = (() => {
    const at = argv.indexOf('--write-body');
    return at === -1 ? null : argv[at + 1] ?? null;
  })();
  const positional = argv.filter((a, i) => /^\d+$/.test(a))[0];

  const prNumber = Number(positional ?? env.PR_NUMBER);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('usage: plan-merge-attribution.mjs <pr-number> [--body <text> | --body-file <path> | --stdin] [--write-body <path>] [--enforce] [--format json]');
    process.exit(2);
  }
  const repo = env.REPO ?? 'PetrouilFan/paperclip';

  let pr;
  try {
    pr = JSON.parse(gh(['pr', 'view', String(prNumber), '--json', 'author,title,body,state', '--repo', repo]));
  } catch (error) {
    console.error(`could not read #${prNumber} in ${repo}: ${error.message}`);
    process.exit(2);
  }
  // An open pull request is the only state in which a body can still be edited,
  // so it is the only state in which this tool has anything to say. `--allow-merged`
  // exists to run the check over a merge that already happened, which is how a
  // reader can see the verdict the merge in fact received.
  if (pr.state !== 'OPEN' && !argv.includes('--allow-merged')) {
    console.error(`#${prNumber} is ${pr.state.toLowerCase()}, so there is no body left to write. Pass --allow-merged to audit the merge it got.`);
    process.exit(2);
  }

  let commits;
  try {
    commits = JSON.parse(gh(['api', `repos/${repo}/pulls/${prNumber}/commits?per_page=100`]));
  } catch (error) {
    // Failing closed rather than reporting a clean scan. An empty commit list
    // prescribes no trailers, and a prescribed-trailer list built from commits
    // that never arrived is the exact shape of a clean report about text the
    // tool did not read.
    console.error(`could not read the commits on #${prNumber}: ${error.message}`);
    process.exit(2);
  }

  const result = planMergeAttribution({
    prAuthor: pr.author?.login,
    commits,
    mergeMessage: readProposedBody(argv, env),
    prNumber,
  });

  if (writeTo) {
    writeFileSync(writeTo, mergeBody({ title: pr.title, description: pr.body, trailers: result.trailers }));
    console.error(`wrote a merge body to ${writeTo}`);
  }

  if (asJson) console.log(JSON.stringify({ repo, state: pr.state, ...result }, null, 1));
  else console.log(formatPlan(result));

  if (enforce && result.verdict === 'unverified') {
    console.error('\n--enforce: no merge body was supplied, so the merge was never checked. Refusing.');
    process.exit(2);
  }
  process.exit(result.verdict === 'loss' ? 1 : 0);
}
