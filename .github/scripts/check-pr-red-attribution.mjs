#!/usr/bin/env node
/**
 * check-pr-red-attribution.mjs
 * Answers one question about a pull request: are its red checks its own fault, or
 * are they inherited from the commit it branched off?
 *
 * This repository has no branch protection and no rulesets, so GitHub will happily
 * merge a PR whose required-looking checks are red. It also has a red base: at
 * 27f0c59c6 the `Cloud readiness` run on master is already failing. Every PR
 * branched from that commit therefore inherits the same red checks, and the only
 * way to tell inherited from own is to read both sets of CI logs by hand. That is
 * slow, it gets skipped, and it is the reason "is this red mine?" has been
 * re-litigated per PR.
 *
 * Export: attributeFailures(ownTests, baseTests) → { passed, own, inherited, fixed, failures }
 */
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// `gh run view --log-failed` emits ANSI colour two different ways depending on
// whether it thinks it is writing to a TTY: a real ESC byte, or the literal
// caret-bracket form `^[[41m`. A stripper that only handles the first one
// silently returns the colour codes glued to the test name, and every
// comparison downstream becomes a string mismatch that reads as "no failures".
// Both forms have to go.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\^\[\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI, '');
}

// A failing line looks like:
//   <ts>  FAIL  @paperclipai/server src/__tests__/foo.test.ts > suite name > case name
// but some reporters put a source location between the file and the first `>`:
//   <ts>  FAIL  @paperclipai/server src/__tests__/foo.test.ts:15986:3 > suite name > case name
// Vitest does exactly that for stack-bearing cases. The location is dropped so
// the same case is one identity whether or not it carried a location, otherwise
// a case that is red on the base and on the PR would look like two failures and
// the attribution would call it the PR's own.
// The package label is optional and dropped, because two cases in the same file
// are different failures and must not collapse together.
const FAIL_LINE = / FAIL .*?([\w@/.-]+\.test\.ts)(?::\d+(?::\d+)?)?\s*>\s*(.+?)\s*$/;

export function parseFailingTests(log) {
  const tests = new Set();
  for (const rawLine of stripAnsi(log).split('\n')) {
    const match = FAIL_LINE.exec(stripAnsi(rawLine).replace(/\r$/, ''));
    if (!match) continue;
    const name = match[2].trim();
    if (name) tests.add(`${match[1]} > ${name}`);
  }
  return tests;
}

/**
 * Partition the PR's failing tests against the base commit's.
 *
 * `fixed` is a plain set difference and is reported for information only — it
 * never affects `passed`. Read it with care: a flaky base failure that simply did
 * not reproduce also lands in `fixed`, so that bucket is evidence the PR is
 * clean, not evidence the PR fixed anything.
 *
 * Fails open only in the sense that a missing baseline is an error, never a pass:
 * an attribution tool that reports "clean" when it could not read the base would
 * be worse than no tool, because the merge decision would rest on it.
 */
export function attributeFailures(ownTests, baseTests, { baselineAvailable = true } = {}) {
  const own = [...ownTests].filter(t => !baseTests.has(t)).sort();
  const inherited = [...ownTests].filter(t => baseTests.has(t)).sort();
  const fixed = [...baseTests].filter(t => !ownTests.has(t)).sort();

  const failures = [];
  if (!baselineAvailable) {
    failures.push(
      'Could not read a completed CI run for the base commit, so inherited failures ' +
      'cannot be separated from your own. This is NOT a pass. Re-run once the base ' +
      'branch has a completed run, or compare by hand before merging.'
    );
  }
  for (const test of own) {
    failures.push(`Failing test not present on the base commit — this PR's own failure: ${test}`);
  }

  return { passed: failures.length === 0, own, inherited, fixed, failures };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function latestCompletedRun(sha) {
  const runs = JSON.parse(gh(['run', 'list', '--commit', sha, '--limit', '20', '--json', 'databaseId,conclusion,status']));
  return runs.find(r => r.status === 'completed' && r.conclusion === 'failure') ?? null;
}

function failingTestsOf(runId) {
  try {
    return parseFailingTests(gh(['run', 'view', String(runId), '--log-failed']));
  } catch {
    return new Set();
  }
}

function resolveBaseSha(prNumber) {
  return JSON.parse(gh(['pr', 'view', String(prNumber), '--json', 'baseRefOid'])).baseRefOid;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const prNumber = process.env.PR_NUMBER ?? process.argv[2];
  if (!prNumber) {
    console.error('usage: check-pr-red-attribution.mjs <pr-number>   (or set PR_NUMBER)');
    process.exit(2);
  }
  const base = resolveBaseSha(prNumber);
  const head = JSON.parse(gh(['pr', 'view', String(prNumber), '--json', 'headRefOid'])).headRefOid;

  const baseRun = latestCompletedRun(base);
  const headRun = latestCompletedRun(head);
  if (!headRun) {
    console.log(JSON.stringify({ passed: false, failures: [`No completed CI run found for PR head ${head}.`] }));
    process.exit(1);
  }

  const own = failingTestsOf(headRun.databaseId);
  const inheritedBase = baseRun ? failingTestsOf(baseRun.databaseId) : null;
  const result = attributeFailures(own, inheritedBase ?? new Set(), { baselineAvailable: inheritedBase !== null });
  console.log(JSON.stringify({ head, headRun: headRun.databaseId, baseRun: baseRun?.databaseId ?? null, ...result }));
  process.exit(result.passed ? 0 : 1);
}
