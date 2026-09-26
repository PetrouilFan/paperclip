import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeFailures, parseFailingTests, stripAnsi } from '../check-pr-red-attribution.mjs';

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
