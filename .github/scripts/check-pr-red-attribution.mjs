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
 * Export: headRunVerdict(run) → 'success' | 'failure' | 'pending' | 'no-verdict'
 * Export: headJobVerdict(job) → 'success' | 'failure' | 'skipped' | 'no-verdict'
 * Export: partitionLaneJobs(jobs, runId) → { failed, unmeasured }
 *
 * `HEAD_RUN_ID` narrows the head side to one run's jobs — the pull-request
 * lane's own, named by the `red_attribution` job in pr-trusted.yml. Unset, the
 * head side is every workflow on the commit, which is what a human running this
 * by hand wants.
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

/**
 * Conclusions that answer the question on the head side, at run granularity.
 *
 * `success` and `failure` are the only two answers. `queued` and `in_progress`
 * have not run yet; `cancelled`, `timed_out` and `skipped` stopped partway or
 * never started. None of those is evidence that the pull request's tests passed,
 * and reading one of them as a pass hands a red pull request a green attribution
 * verdict — the same defect as a missing baseline, arrived at from the other
 * direction. `no-verdict` is its own bucket so the caller can name the run that
 * did not answer rather than fold it into a success.
 */
export function headRunVerdict(run) {
  if (run.status !== 'completed') return 'pending';
  return BASELINE_CONCLUSIONS.has(run.conclusion) ? run.conclusion : 'no-verdict';
}

/**
 * Conclusions that answer the question on the head side, at job granularity.
 *
 * The gate job runs *inside* the pull-request lane's run, so the run's own status
 * is `in_progress` throughout and carries no information — every job it depends
 * on has settled, and those are the evidence. The unit that matters is the job.
 *
 * `skipped` is a verdict here even though it is not one at run level: a lane the
 * lane itself switched off — the test matrix on a middle pull request in a stack
 * — is the designed state, and `verify` is what asserts it. A lane that was
 * `cancelled` or timed out is a different thing: it stopped partway, so it
 * measured nothing, and treating its silence as a pass is the defect this whole
 * tool exists to remove. Note that a job still going reports an empty
 * conclusion, not a missing one, so it lands here too.
 */
const HEAD_JOB_VERDICTS = new Set(['success', 'failure', 'skipped']);

export function headJobVerdict(job) {
  return HEAD_JOB_VERDICTS.has(job.conclusion) ? job.conclusion : 'no-verdict';
}

/**
 * Partition the pull-request lane's own jobs into what can be attributed and
 * what never reported.
 *
 * `failed` carries the run id alongside each job because the base comparison and
 * the log fetch are both addressed to the run, not to the job.
 */
export function partitionLaneJobs(jobs, runId) {
  return {
    failed: jobs.filter(j => headJobVerdict(j) === 'failure').map(j => ({ ...j, runId })),
    unmeasured: jobs.filter(j => headJobVerdict(j) === 'no-verdict'),
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

  // Two reads of the head side, one per caller, and the caller says which.
  //
  // The gate job runs *inside* the pull-request lane's own run, so that run is
  // `in_progress` for as long as the gate is looking at it and its status says
  // nothing; the unit that carries evidence is the job, and every job the gate
  // depends on has already settled. `HEAD_RUN_ID` names that run.
  //
  // Unset is the hand-run path, where every workflow on the head is in scope: a
  // human reading the JSON wants the whole picture and is the one deciding what
  // to compare. The scope difference is also why the strict no-verdict rule below
  // applies only to the named run — in the unscoped path this list would hold
  // `Storybook Visual`, which is `skipped` on nearly every pull request here.
  const laneRunId = process.env.HEAD_RUN_ID;
  const laneScoped = laneRunId !== undefined && String(laneRunId).trim() !== '';
  const lane = laneScoped ? partitionLaneJobs(jobsOf(laneRunId), Number(laneRunId)) : null;

  const headRuns = laneScoped ? [] : completedRunsOn(head);
  const failingHeadRuns = headRuns.filter(r => headRunVerdict(r) === 'failure');
  const pendingHeadRuns = headRuns.filter(r => headRunVerdict(r) === 'pending');
  // Reported, not failed on. In this scope a completed-but-cancelled run is
  // usually some other workflow's, and the hand-run path has no way to tell
  // which — so it is named in the JSON and the reader decides. The gate's own
  // path has no such ambiguity, which is why `unmeasuredJobs` above can be a
  // failure.
  const noVerdictHeadRuns = headRuns.filter(r => headRunVerdict(r) === 'no-verdict');

  // The failed jobs to attribute, each carrying the run its log is read from.
  const failedJobs = lane
    ? lane.failed
    : failingHeadRuns.flatMap(run =>
        jobsOf(run.databaseId)
          .filter(j => j.conclusion === 'failure')
          .map(j => ({ ...j, runId: run.databaseId })));

  // Evidence the lane never produced. A lane that was cancelled or timed out
  // measured nothing, and its silence is not a green lane. This is the same rule
  // the base side applies through `selectBaselineForJobs`, arrived at from the
  // head: a comparison that cannot be made is reported, never assumed.
  const unmeasuredJobs = lane ? lane.unmeasured : [];

  // In lane mode the run being read is itself the red one, so `redRuns` names it
  // rather than reporting an empty list beside a non-empty `own`, which would be
  // a report that contradicts itself. The run's own `conclusion` is not asked
  // for: it is `in_progress` for as long as this job is reading it.
  const redRuns = () =>
    lane && failedJobs.length > 0
      ? [{ run: Number(laneRunId), conclusion: 'failure' }]
      : failingHeadRuns.map(r => ({ run: r.databaseId, conclusion: r.conclusion }));

  const unmeasuredFailures = unmeasuredJobs.map(
    job =>
      `Lane job \`${job.name}\` finished \`${job.conclusion || 'in_progress'}\`, which reports nothing about whether ` +
      `the tests passed. A lane that stopped partway is not a green lane, and a green lane is the strongest ` +
      `evidence there is. This is NOT a pass — re-run CI, or read that job before merging.`
  );

  if (!laneScoped && headRuns.length === 0) {
    console.log(JSON.stringify({ passed: false, failures: [`No completed CI run found for PR head ${head}.`] }));
    process.exit(1);
  }

  if (failedJobs.length === 0) {
    // Nothing in scope is red, so there is nothing to attribute. This is a pass,
    // and it is reported as one rather than as "nothing found", which is a
    // different claim. A run still going is not a pass: the checks that would
    // catch the failure have not reported yet.
    const pendingNote = [
      ...(pendingHeadRuns.length > 0
        ? [`${pendingHeadRuns.length} run(s) on this head are still going, so this verdict covers only the runs that have finished. This is NOT a pass.`]
        : []),
      ...unmeasuredFailures,
    ];
    console.log(JSON.stringify({
      head,
      laneRun: laneScoped ? Number(laneRunId) : null,
      redRuns: redRuns(),
      completedRuns: headRuns.length,
      pendingRuns: pendingHeadRuns.length,
      unmeasuredJobs: unmeasuredJobs.map(j => ({ job: j.name, conclusion: j.conclusion })),
      noVerdictRuns: noVerdictHeadRuns.map(r => ({ run: r.databaseId, conclusion: r.conclusion })),
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
  const failures = [...unmeasuredFailures];
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

  for (const job of failedJobs) {
    const key = jobKey(job.name);
    const jobFailures = failingTestsOfJob(job.runId, job.databaseId);

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
      // `reason` is already a whole sentence that ends in its own "This is NOT
      // a pass" and the action to take, so nothing is appended to it. A gate
      // check's output is read by a person deciding whether to merge, and the
      // same instruction twice reads as two findings.
      failures.push(
        `Failed job \`${job.name}\` reported ${jobFailures.size} failing test(s), and ${reason}`
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

  if (own.size === 0 && inherited.size === 0 && failures.length === 0) {
    failures.push(
      'Every failed job on this head failed without reporting a test failure of its own, so there was ' +
      'nothing to attribute. This is NOT a pass — the run is red and the reason is not a test. Read the run.'
    );
  }

  console.log(JSON.stringify({
    head,
    laneRun: laneScoped ? Number(laneRunId) : null,
    redRuns: redRuns(),
    pendingRuns: pendingHeadRuns.length,
    unmeasuredJobs: unmeasuredJobs.map(j => ({ job: j.name, conclusion: j.conclusion })),
    noVerdictRuns: noVerdictHeadRuns.map(r => ({ run: r.databaseId, conclusion: r.conclusion })),
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
