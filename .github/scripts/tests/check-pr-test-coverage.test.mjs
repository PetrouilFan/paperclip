import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTestCoverage, resolveTestCoverage } from '../check-pr-test-coverage.mjs';

const makeFiles = (filenames) =>
  filenames.map(filename => ({ filename, status: 'modified' }));

// Existing tests with title parameter added (fix: prefix means test required)

test('passes when .test.ts file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.test.ts', 'src/foo.ts']), 'fix: bug').passed, true);
});

test('passes when .spec.js file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/bar.spec.js']), 'fix: bug').passed, true);
});

test('passes when .test.mjs file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['scripts/foo.test.mjs', 'scripts/foo.mjs']), 'fix: bug').passed, true);
});

test('passes when .test.cjs file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['scripts/bar.test.cjs']), 'fix: bug').passed, true);
});

test('passes when file under tests/ is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['tests/unit/baz.ts']), 'fix: bug').passed, true);
});

test('passes when file under __tests__ is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/__tests__/qux.ts']), 'fix: bug').passed, true);
});

test('fails when fix: PR has no tests', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts', 'src/bar.ts']), 'fix: bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('test'));
});

test('fails when feat: PR has no tests', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts']), 'feat: new feature');
  assert.equal(result.passed, false);
});

test('fails with empty file list and fix: prefix', () => {
  assert.equal(checkTestCoverage([], 'fix: bug').passed, false);
});

test('ignores removed test files', () => {
  const files = [
    { filename: 'src/foo.test.ts', status: 'removed' },
    { filename: 'src/foo.ts', status: 'modified' },
  ];
  assert.equal(checkTestCoverage(files, 'fix: bug').passed, false);
});

// New tests for prefix-aware skip behavior

test('skips test requirement for docs: prefix (markdown only)', () => {
  assert.equal(checkTestCoverage(makeFiles(['README.md', 'docs/setup.md']), 'docs: update guide').passed, true);
});

test('skips test requirement for chore: prefix (config only)', () => {
  assert.equal(checkTestCoverage(makeFiles(['.gitignore', '.github/labels.yml']), 'chore: cleanup').passed, true);
});

test('skips test requirement for refactor: prefix', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.ts']), 'refactor: rename function').passed, true);
});

test('skips test requirement for style: prefix', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.ts']), 'style: format').passed, true);
});

// New tests for mismatch detection

test('flags docs: PR with source code changes', () => {
  const result = checkTestCoverage(makeFiles(['src/api.ts', 'README.md']), 'docs: update docs');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('docs:'));
  assert.ok(result.failures[0].includes('source code'));
});

test('flags chore: PR with source code changes', () => {
  const result = checkTestCoverage(makeFiles(['src/server.ts']), 'chore: cleanup');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('chore:'));
});

test('does NOT flag chore: PR with only config files', () => {
  const result = checkTestCoverage(makeFiles(['package.json', '.eslintrc.js']), 'chore: bump');
  // .eslintrc.js is a .js file but it's config — current rule will flag it. This documents that.
  // For now we err on the side of flagging — contributor can retitle if needed.
  assert.equal(result.passed, false);
});

test('does NOT flag refactor: PR with source code (refactor expects source changes)', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts']), 'refactor: rename');
  assert.equal(result.passed, true);
});

test('requires test when no prefix used', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts']), 'Some PR with no prefix');
  assert.equal(result.passed, false);
});

test('handles scoped prefix like fix(server):', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.test.ts', 'src/foo.ts']), 'fix(server): bug').passed, true);
});

// --- A stale `pulls/{n}/files` response -------------------------------
//
// `GET /repos/{o}/{r}/pulls/{n}/files` is derived from a stored comparison, so
// for a short window after a force-push it can answer with the pre-rewrite
// diff. A one-file `docs:` pull request rebased onto `master` was served 119
// files — the base branch's own recent history — and the gate read that as a
// documentation change that had rewritten the CI scripts. The message it emits
// names files and prescribes retitling, so a reviewer who does not know a
// rebase just happened relabels a documentation edit to `fix:`.

test('a docs: mismatch names how much of the served list is source', async () => {
  // The denominator is what lets a reviewer tell a real prefix mismatch from
  // a stale read: three source files out of three is a finding, the same three
  // out of 119 means the list is not this pull request's.
  const one = checkTestCoverage(makeFiles(['src/api.ts']), 'docs: update docs');
  assert.equal(one.code, 'prefix_mismatch');
  assert.ok(
    one.failures[0].includes('1 of 1 files'),
    `the message must carry the list size: ${one.failures[0]}`,
  );

  const many = checkTestCoverage(
    makeFiles(['README.md', 'src/api.ts', 'cli/src/checks/index.ts']),
    'docs: update docs',
  );
  assert.ok(
    many.failures[0].includes('2 of 3 files'),
    `the message must carry the list size: ${many.failures[0]}`,
  );
});

test('a stale file list does not fail a docs: pull request', async () => {
  // The observed incident: a re-gate fired about four minutes after the first
  // push and read the pre-rewrite diff.
  const stale = makeFiles([
    'README.md',
    '.github/scripts/check-pr-linked-issue.mjs',
    '.github/scripts/run-quality-gates.mjs',
    'cli/src/checks/index.ts',
  ]);
  const settled = makeFiles(['README.md']);

  assert.equal(checkTestCoverage(stale, 'docs: update guide').passed, false);

  const result = await resolveTestCoverage(stale, 'docs: update guide', async () => settled);
  assert.equal(result.passed, true, 'a re-read that clears the contradiction must not fail the pull request');
});

test('a genuine prefix mismatch still fails after the re-read', async () => {
  // The re-read relaxes the verdict only when it clears the contradiction. If
  // the fresh list still reports source files the mismatch is real, so this
  // must not become a way to talk a `docs:` pull request past the gate.
  const genuine = makeFiles(['src/api.ts', 'README.md']);

  const result = await resolveTestCoverage(genuine, 'docs: update docs', async () => genuine);
  assert.equal(result.passed, false, 'a real mismatch must survive the re-read');
  assert.equal(result.code, 'prefix_mismatch');
  assert.ok(result.failures[0].includes('retitle'), 'the remedy must still be offered');
});

test('the re-read is only spent on the verdict a stale list can fake', async () => {
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return makeFiles(['README.md']);
  };

  // A docs: pull request that touches only Markdown passes on the first read,
  // so the re-read must not be paid for at all. This is the cost the design
  // turns on: an unconditional re-read would add an API call to every run of
  // every gate.
  assert.equal((await resolveTestCoverage(makeFiles(['README.md']), 'docs: x', counting)).passed, true);
  assert.equal(calls, 0, 'a passing docs: verdict must not trigger a re-read');

  // The missing-test verdict is not re-read either. It cannot be manufactured
  // by extra files appearing in the list, so re-reading it would spend a call
  // to learn nothing.
  assert.equal(
    (await resolveTestCoverage(makeFiles(['src/foo.ts']), 'feat: x', counting)).passed,
    false,
  );
  assert.equal(calls, 0, 'the missing-test verdict must not trigger a re-read');

  // Only the prefix mismatch reaches it.
  assert.equal(
    (await resolveTestCoverage(makeFiles(['src/foo.ts']), 'docs: x', counting)).passed,
    true,
  );
  assert.equal(calls, 1, 'a prefix mismatch must be re-read exactly once');
});

test('a re-read that cannot be completed leaves the original verdict standing', async () => {
  // A failed fetch is not evidence either way. Relaxing on it would turn an
  // API problem into a green gate, which is the opposite of this change.
  const list = makeFiles(['src/api.ts', 'README.md']);

  const threw = await resolveTestCoverage(list, 'docs: x', async () => {
    throw new Error('HTTP 502');
  });
  assert.equal(threw.passed, false, 'a failed re-read must not clear the finding');
  assert.equal(threw.code, 'prefix_mismatch');

  const notAnArray = await resolveTestCoverage(list, 'docs: x', async () => null);
  assert.equal(notAnArray.passed, false, 'a re-read that is not a file list must not clear the finding');
});

test('without a re-read function the verdict is unchanged', async () => {
  // The resolver is called from a gate runner, but the pure function is also
  // used directly. Omitting the re-read must degrade to the old behaviour
  // rather than throwing or silently passing.
  const result = await resolveTestCoverage(makeFiles(['src/api.ts']), 'docs: x');
  assert.equal(result.passed, false);
  assert.equal(result.code, 'prefix_mismatch');
});

test('every verdict carries a code, so a caller can tell them apart', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/api.ts']), 'docs: x').code, 'prefix_mismatch');
  assert.equal(checkTestCoverage(makeFiles(['src/foo.ts']), 'feat: x').code, 'no_tests');
  assert.equal(checkTestCoverage(makeFiles(['src/foo.test.ts']), 'feat: x').code, 'ok');
  // A skipped prefix is its own verdict, not a silent undefined code: it is
  // the one pass that happened without the list being consulted at all.
  assert.equal(checkTestCoverage(makeFiles(['README.md']), 'docs: x').code, 'skipped_prefix');
});
