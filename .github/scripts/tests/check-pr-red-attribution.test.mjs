import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeFailures,
  jobKey,
  parseFailingTests,
  selectBaselineForJobs,
  stripAnsi,
} from '../check-pr-red-attribution.mjs';

test('strips a real ESC byte', () => {
  assert.equal(stripAnsi('\x1b[41m\x1b[1m FAIL \x1b[22m'), ' FAIL ');
});

test('strips the caret-bracket form gh emits when it is not a TTY', () => {
  // This is the form that actually comes back from `gh run view --log-failed`
  // piped into a file. A stripper that only handles \x1b returns the colour
  // codes glued to the test name and every comparison becomes a mismatch.
  assert.equal(stripAnsi('^[[41m^[[1m FAIL ^[[22m^[[49m'), ' FAIL ');
});

test('parses a failing line into file > suite > case', () => {
  const log = [
    '2026-09-26T15:23:24.2390801Z ^[[41m^[[1m FAIL ^[[22m^[[49m ^[[30m^[[45m @paperclipai/server ^[[49m^[[39m ' +
      "src/__tests__/issue-stale-execution-lock-routes.test.ts^[[2m > ^[[22mstale issue execution lock routes^[[2m > " +
      "^[[22mpreserves 'done' when releasing a non-in_progress issue",
  ].join('\n');
  assert.deepEqual([...parseFailingTests(log)], [
    "src/__tests__/issue-stale-execution-lock-routes.test.ts > stale issue execution lock routes > preserves 'done' when releasing a non-in_progress issue",
  ]);
});

test('a case carrying a source location is normalised, not kept as a distinct failure', () => {
  const a = parseFailingTests(' FAIL  @paperclipai/server src/__tests__/chat-channels.integration.test.ts:15986:3 > suite > case\n');
  const b = parseFailingTests(' FAIL  @paperclipai/server src/__tests__/chat-channels.integration.test.ts > suite > case\n');
  assert.deepEqual([...a], [...b]);
});

test('two cases in one file stay two failures', () => {
  const log = [
    ' FAIL  @paperclipai/db src/migration-snapshot-drift.test.ts > migration snapshot drift > keeps the newest snapshot in sync',
    ' FAIL  @paperclipai/db src/migration-snapshot-drift.test.ts > migration snapshot drift > rejects a stale snapshot',
  ].join('\n');
  assert.equal(parseFailingTests(log).size, 2);
});

test('a line that is not a test failure contributes nothing', () => {
  const log = [
    '2026-09-26T15:21:55.8398784Z Error: EACCES: spool dir is busy',
    ' PASS  @paperclipai/server src/__tests__/foo.test.ts > suite > case',
    '##[error]AssertionError: expected { status: done } to deeply equal { status: done }',
  ].join('\n');
  assert.equal(parseFailingTests(log).size, 0);
});

test('a fully green PR passes', () => {
  const r = attributeFailures(new Set(), new Set(['a.test.ts > b > c']));
  assert.equal(r.passed, true);
  assert.deepEqual(r.fixed, ['a.test.ts > b > c']);
});

test('a failure present on the base is inherited, not the PR own fault', () => {
  const shared = 'src/__tests__/x.test.ts > suite > case';
  const r = attributeFailures(new Set([shared]), new Set([shared]));
  assert.equal(r.passed, true);
  assert.deepEqual(r.inherited, [shared]);
  assert.deepEqual(r.own, []);
});

test('a failure absent from the base is the PR own fault and blocks', () => {
  const mine = 'src/__tests__/y.test.ts > suite > case';
  const r = attributeFailures(new Set([mine]), new Set());
  assert.equal(r.passed, false);
  assert.deepEqual(r.own, [mine]);
  assert.ok(r.failures[0].includes(mine));
});

test('a PR that both inherits and adds a failure reports both, and still blocks', () => {
  const shared = 'src/__tests__/x.test.ts > suite > case';
  const mine = 'src/__tests__/y.test.ts > suite > case';
  const r = attributeFailures(new Set([shared, mine]), new Set([shared]));
  assert.equal(r.passed, false);
  assert.deepEqual(r.inherited, [shared]);
  assert.deepEqual(r.own, [mine]);
  assert.equal(r.failures.length, 1, 'only the own failure is reported as a failure');
});

test('a missing baseline is never reported as a pass', () => {
  // The fail-open trap. Reporting "clean" because the base run could not be
  // read would make the merge decision rest on a tool that never checked.
  const r = attributeFailures(new Set(), new Set(), { baselineAvailable: false });
  assert.equal(r.passed, false);
  assert.match(r.failures[0], /NOT a pass/);
});

test('a missing baseline still names the own failures it did find', () => {
  const mine = 'src/__tests__/y.test.ts > suite > case';
  const r = attributeFailures(new Set([mine]), new Set(), { baselineAvailable: false });
  assert.equal(r.passed, false);
  assert.deepEqual(r.own, [mine]);
  assert.equal(r.failures.length, 2);
});

test('a base failure the PR does not reproduce lands in `fixed` and never blocks', () => {
  // The real case on this fork: the chat-channels flake is red on master and
  // green on the PR. `fixed` is a set difference reported for information only,
  // so a flake that did not reproduce is credited the same way and, crucially,
  // cannot turn into a pass/fail signal in either direction.
  const flake = 'src/__tests__/chat-channels.integration.test.ts > suite > case';
  const r = attributeFailures(new Set(), new Set([flake]));
  assert.equal(r.passed, true);
  assert.deepEqual(r.fixed, [flake]);
  assert.deepEqual(r.failures, []);
});

test('a green base run is a baseline, not a missing one', () => {
  // The bug this fixes, live: master went green at 655aad958 and the tool then
  // reported "Could not read a completed CI run for the base commit ... NOT a
  // pass" for PR #63, because the baseline search only accepted `failure`. A
  // green base is the strongest baseline available — an empty failure set.
  const jobsByRun = { 36256015450: [{ name: 'verify / General tests (chat (1/3))', conclusion: 'success' }] };
  const r = selectBaselineForJobs(
    [{ status: 'completed', conclusion: 'success', databaseId: 36256015450 }],
    jobsByRun,
    ['General tests (chat (1/3))']
  );
  assert.equal(r.run?.databaseId, 36256015450);
});

test('a red base run is still a baseline', () => {
  const red = { status: 'completed', conclusion: 'failure', databaseId: 36250110096 };
  const jobsByRun = { [red.databaseId]: [{ name: 'verify / General tests (chat (1/3))', conclusion: 'failure' }] };
  const r = selectBaselineForJobs([red], jobsByRun, ['General tests (chat (1/3))']);
  assert.equal(r.run?.databaseId, 36250110096);
});

test('a run that never finished is passed over for the next completed one', () => {
  // `gh run list --commit` interleaves every workflow on the commit, so the
  // newest completed run is often a skipped or cancelled one that says nothing
  // about tests. Those cannot report what failed, so they are not baselines.
  for (const conclusion of ['cancelled', 'skipped', 'timed_out']) {
    const finished = { status: 'completed', conclusion: 'failure', databaseId: 7 };
    const dead = { status: 'completed', conclusion, databaseId: 8 };
    const jobsByRun = { [finished.databaseId]: [{ name: 'verify / x', conclusion: 'failure' }] };
    assert.equal(
      selectBaselineForJobs([dead, finished], jobsByRun, ['x']).run?.databaseId,
      7,
      `${conclusion} is skipped`
    );
  }
});

test('no completed signal at all is no baseline, which is not a pass', () => {
  assert.equal(selectBaselineForJobs(
    [
      { status: 'in_progress', conclusion: null, databaseId: 9 },
      { status: 'completed', conclusion: 'skipped', databaseId: 10 },
    ],
    {},
    ['anything']
  ).run, null);

  const r = attributeFailures(new Set(), new Set(), { baselineAvailable: false });
  assert.equal(r.passed, false);
  assert.match(r.failures[0], /NOT a pass/);
});

test('with a green base, a red on the PR is the PR own failure and nothing else', () => {
  // End to end over the green-base case: the baseline failure set is empty, so
  // there is no inherited bucket to fill and no "no baseline" failure to raise.
  const mine = 'src/__tests__/chat-channels.integration.test.ts > suite > case';
  const r = attributeFailures(new Set([mine]), new Set(), { baselineAvailable: true });
  assert.equal(r.passed, false);
  assert.deepEqual(r.own, [mine]);
  assert.deepEqual(r.inherited, []);
  assert.equal(r.failures.length, 1, 'only the own failure, and no missing-baseline complaint');
});

test('the workflow prefix is dropped so a pull request job matches its base counterpart', () => {
  // The real pair on this fork, read off the live runs.
  assert.equal(jobKey('ci / General tests (chat (1/3))'), 'General tests (chat (1/3))');
  assert.equal(jobKey('verify / General tests (chat (1/3))'), 'General tests (chat (1/3))');
  assert.equal(jobKey('refresh'), 'refresh', 'a job with no prefix is its own key');
});

test('a differently sharded job deliberately does not match its base counterpart', () => {
  // The base splits the server suite 10 ways, a pull request 12. Matching
  // `server (3/12)` to `server (3/10)` would compare two different sets of
  // files and call the difference a result.
  assert.notEqual(jobKey('ci / General tests (server (3/12))'), jobKey('verify / General tests (server (3/10))'));
});

const greenBase = { status: 'completed', conclusion: 'success', databaseId: 36256015450 };
const lockfileRun = { status: 'completed', conclusion: 'success', databaseId: 36256014923 };

test('a base run that ran none of the failed jobs is not a baseline', () => {
  // The defect, live: the newest completed run on master was `Refresh Lockfile`,
  // whose only job is `refresh`. Its failure set is empty because it ran no
  // tests, and the tool read that as "the base is clean" and charged PR #63 with
  // a chat-channels failure a `.github/scripts/` change cannot cause.
  const jobsByRun = {
    [lockfileRun.databaseId]: [{ name: 'refresh', conclusion: 'success' }],
  };
  const r = selectBaselineForJobs([lockfileRun], jobsByRun, ['General tests (chat (1/3))']);
  assert.equal(r.run, null);
  assert.match(r.reason, /NOT a pass/);
  assert.match(r.reason, /General tests \(chat \(1\/3\)\)/, 'the reason names the job it could not find');
});

test('the base run that ran the failed job is the baseline, green or red', () => {
  const jobsByRun = {
    [lockfileRun.databaseId]: [{ name: 'refresh', conclusion: 'success' }],
    [greenBase.databaseId]: [{ name: 'verify / General tests (chat (1/3))', conclusion: 'success' }],
  };
  const required = ['General tests (chat (1/3))'];
  assert.equal(selectBaselineForJobs([lockfileRun, greenBase], jobsByRun, required).run?.databaseId, 36256015450);
  assert.equal(selectBaselineForJobs([greenBase, lockfileRun], jobsByRun, required).run?.databaseId, 36256015450);
});

test('a base job that never completed does not cover the head job that failed', () => {
  const skipped = { status: 'completed', conclusion: 'success', databaseId: 3 };
  const jobsByRun = {
    [skipped.databaseId]: [{ name: 'verify / General tests (chat (1/3))', conclusion: 'skipped' }],
  };
  const r = selectBaselineForJobs([skipped], jobsByRun, ['General tests (chat (1/3))']);
  assert.equal(r.run, null, 'a skipped counterpart ran nothing, so it says nothing');
});

test('partial coverage is refused rather than read as a clean base', () => {
  // The head failed two shards and the base ran one of them. Reading the empty
  // half as "clean" is how an own failure gets invented out of a missing run.
  const partial = { status: 'completed', conclusion: 'success', databaseId: 4 };
  const jobsByRun = {
    [partial.databaseId]: [{ name: 'verify / General tests (chat (1/3))', conclusion: 'success' }],
  };
  const r = selectBaselineForJobs([partial], jobsByRun, [
    'General tests (chat (1/3))',
    'General tests (server (3/12))',
  ]);
  assert.equal(r.run, null);
  assert.match(r.reason, /server \(3\/12\)/);
  assert.match(r.reason, /not comparable/);
});

test('a head run with no failed job has nothing to attribute', () => {
  const r = selectBaselineForJobs([greenBase], { [greenBase.databaseId]: [] }, []);
  assert.equal(r.run, null);
  assert.match(r.reason, /no failed job/);
});
