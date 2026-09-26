#!/usr/bin/env node
/**
 * check-pr-red-attribution.mjs
 * Answers one question about a pull request: are its red checks its own fault, or
 * are they inherited from the commit it branched off?
 *
 * This repository has no branch protection and no rulesets, so GitHub will happily
 * merge a PR whose required-looking checks are red. Its base is red too, often
 * enough: a PR branched from a commit whose CI already fails inherits every one
 * of those failures, and the only way to tell inherited from own is to read both
 * sets of CI logs by hand. That is slow, it gets skipped, and it is the reason
 * "is this red mine?" gets re-litigated per PR.
 *
 * It cuts both ways, which is why the base's own conclusion is reported. A green
 * base means every red on the PR is the PR's own, and that is a merge decision
 * worth making from a command rather than from a reading of the base's history.
 *
 * Export: attributeFailures(ownTests, baseTests) → { passed, own, inherited, fixed, failures }
 * Export: selectBaselineForJobs(runs, jobsByRun, requiredKeys) → { run, matchedJobs } | { run: null, reason }
 * Export: jobKey(name) → the comparable part of a job name
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

const BASELINE_CONCLUSIONS = new Set(['success', 'failure']);

/**
 * The comparable part of a job name.
 *
 * A pull request runs `pr.yml`, which labels its jobs `ci / …`. The same tests on
 * the base branch run under `cloud-readiness.yml`, which labels them `verify / …`.
 * The workflow prefix is the only difference, so it is dropped and the job name
 * is what gets compared.
 *
 * This does not paper over a genuinely different matrix. The base shards the
 * server suite 10 ways and a pull request 12 ways, so `General tests (server
 * (3/12))` has no counterpart and `General tests (server (3/10))` is a different
 * set of files. Those deliberately fail to match: a failure in a job with no
 * counterpart cannot be attributed, and saying so beats guessing.
 */
export function jobKey(name) {
  const marker = name.indexOf(' / ');
  return (marker === -1 ? name : name.slice(marker + 3)).trim();
}

function jobsOf(runId) {
  return JSON.parse(gh(['run', 'view', String(runId), '--json', 'jobs'])).jobs ?? [];
}

/** Newest-first list from `gh run list`, as returned by that command. */
function isUsableBaselineRun(run) {
  return run.status === 'completed' && BASELINE_CONCLUSIONS.has(run.conclusion);
}

/**
 * Pick the base run that actually ran the jobs the pull request failed.
 *
 * Reading the newest completed run on the base is not good enough. On this fork
 * that run is `Refresh Lockfile`, whose only job is `refresh` and which runs no
 * tests at all. Its failure set is empty because it ran nothing, not because
 * nothing failed, and treating that as a baseline charged PR #63 with a
 * `chat-channels` failure that a two-file change to `.github/scripts/` cannot
 * cause. An empty set from a job that never ran is not evidence, and evidence
 * that confident is how a reviewer ends up merging or blocking on a lie.
 *
 * A candidate qualifies only if it ran a counterpart of *every* failed job, and
 * each counterpart itself completed. Partial coverage is refused: a base that ran
 * one of the two failed shards says nothing about the other.
 */
export function selectBaselineForJobs(runs, jobsByRun, requiredKeys) {
  if (requiredKeys.length === 0) return { run: null, reason: 'the head run has no failed job to attribute' };
  for (const run of runs) {
    if (!isUsableBaselineRun(run)) continue;
    const baseJobs = jobsByRun[run.databaseId] ?? [];
    const covered = new Set(
      baseJobs
        .filter(j => j.conclusion === 'success' || j.conclusion === 'failure')
        .map(j => jobKey(j.name))
    );
    const missing = requiredKeys.filter(k => !covered.has(k));
    if (missing.length === 0) return { run, matchedJobs: requiredKeys.slice() };
  }
  return {
    run: null,
    reason:
      `no completed run on the base commit ran the same job as every failed job on this pull request ` +
      `(needed: ${requiredKeys.join(', ')}). The base shards its suites differently, so these runs are ` +
      `not comparable. This is NOT a pass — compare the named jobs by hand before merging.`,
  };
}

function completedRunsOn(sha) {
  return JSON.parse(gh(['run', 'list', '--commit', sha, '--limit', '20', '--json', 'databaseId,conclusion,status']));
}

function failingTestsOf(runId) {
  try {
    return parseFailingTests(gh(['run', 'view', String(runId), '--log-failed']));
  } catch {
    return new Set();
  }
}

function failingTestsOfJob(runId, jobId) {
  try {
    return parseFailingTests(gh(['run', 'view', String(runId), '--job', String(jobId), '--log-failed']));
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

  const headRuns = completedRunsOn(head);
  const failingHeadRuns = headRuns.filter(r => r.status === 'completed' && r.conclusion === 'failure');
  const pendingHeadRuns = headRuns.filter(r => r.status !== 'completed');

  if (headRuns.length === 0) {
    console.log(JSON.stringify({ passed: false, failures: [`No completed CI run found for PR head ${head}.`] }));
    process.exit(1);
  }

  if (failingHeadRuns.length === 0) {
    // Every completed run on this head is green, so there is nothing to attribute.
    // This is a pass, and it is reported as one rather than as "nothing found",
    // which is a different claim. A run still going is not a pass: the checks
    // that would catch the failure have not reported yet.
    const pendingNote = pendingHeadRuns.length > 0
      ? [`${pendingHeadRuns.length} run(s) on this head are still going, so this verdict covers only the runs that have finished. This is NOT a pass.`]
      : [];
    console.log(JSON.stringify({
      head,
      redRuns: [],
      completedRuns: headRuns.length,
      pendingRuns: pendingHeadRuns.length,
      baseJobsCompared: [],
      own: [],
      inherited: [],
      fixed: [],
      passed: pendingNote.length === 0,
      failures: pendingNote,
    }));
    process.exit(pendingNote.length === 0 ? 0 : 1);
  }

  const baseRuns = completedRunsOn(base);
  const jobsByRun = {};
  for (const run of baseRuns) {
    if (run.databaseId) jobsByRun[run.databaseId] = jobsOf(run.databaseId);
  }

  const own = new Set();
  const inherited = new Set();
  const fixed = new Set();
  const failures = [];
  const comparedJobs = [];
  const derivedOnlyJobs = [];
  const unattributableJobs = [];
  const baseTestsByRun = new Map();

  if (pendingHeadRuns.length > 0) {
    failures.push(
      `${pendingHeadRuns.length} run(s) on this head have not finished, so this verdict covers only the runs ` +
      `that have. This is NOT a pass.`
    );
  }

  const baseTestsFor = (runId) => {
    if (!baseTestsByRun.has(runId)) baseTestsByRun.set(runId, failingTestsOf(runId));
    return baseTestsByRun.get(runId);
  };

  for (const headRun of failingHeadRuns) {
    for (const job of jobsOf(headRun.databaseId).filter(j => j.conclusion === 'failure')) {
      const key = jobKey(job.name);
      const jobFailures = failingTestsOfJob(headRun.databaseId, job.databaseId);

      if (jobFailures.size === 0) {
        // A fan-in, or a gate such as the quality-gate check, that failed
        // without reporting a test of its own. It is red because something it
        // consumed or evaluated is red, so it carries no test evidence either
        // way and demanding a baseline for it would refuse every attribution on
        // a repository that has one. Named in the output rather than dropped.
        derivedOnlyJobs.push(job.name);
        continue;
      }

      const { run: baseRun, reason } = selectBaselineForJobs(baseRuns, jobsByRun, [key]);
      if (!baseRun) {
        unattributableJobs.push(job.name);
        failures.push(
          `Failed job \`${job.name}\` reported ${jobFailures.size} failing test(s), and ${reason} ` +
          `This is NOT a pass — compare that job by hand before merging.`
        );
        for (const test of jobFailures) own.add(test);
        continue;
      }

      comparedJobs.push({ job: job.name, baseRun: baseRun.databaseId, baseConclusion: baseRun.conclusion });
      const result = attributeFailures(jobFailures, baseTestsFor(baseRun.databaseId), { baselineAvailable: true });
      for (const test of result.own) own.add(test);
      for (const test of result.inherited) inherited.add(test);
      for (const test of result.fixed) fixed.add(test);
      for (const failure of result.failures) failures.push(`${job.name}: ${failure}`);
    }
  }

  if (own.size === 0 && inherited.size === 0 && failures.length === 0) {
    failures.push(
      'Every failed job on this head failed without reporting a test failure of its own, so there was ' +
      'nothing to attribute. This is NOT a pass — the run is red and the reason is not a test. Read the run.'
    );
  }

  console.log(JSON.stringify({
    head,
    redRuns: failingHeadRuns.map(r => ({ run: r.databaseId, conclusion: r.conclusion })),
    pendingRuns: pendingHeadRuns.length,
    baseJobsCompared: comparedJobs,
    derivedOnlyJobs,
    unattributableJobs,
    own: [...own].sort(),
    inherited: [...inherited].sort(),
    fixed: [...fixed].sort(),
    passed: failures.length === 0,
    failures,
  }));
  process.exit(failures.length === 0 ? 0 : 1);
}
