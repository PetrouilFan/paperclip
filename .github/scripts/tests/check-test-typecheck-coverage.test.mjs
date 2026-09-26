import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUncoveredSources, patternToRegExp } from '../check-test-typecheck-coverage.mjs';

const SERVER = { name: 'server/tsconfig.json', dir: 'server', include: ['src'], exclude: ['src/__tests__'] };
const TESTS = { name: 'server/tsconfig.tests.json', dir: 'server', include: ['src'], exclude: [] };
const SERVER_SRC = 'server/src/services/issues.ts';
const SERVER_TEST = 'server/src/__tests__/issues.test.ts';

// The glob layer, because every assertion above it depends on it.

test('a bare directory covers the whole subtree', () => {
  assert.equal(patternToRegExp('src').test('src/a.ts'), true);
  assert.equal(patternToRegExp('src').test('src/a/b/c.ts'), true);
});

test('a bare directory does not cover a sibling with a shared prefix', () => {
  assert.equal(patternToRegExp('src').test('src-legacy/a.ts'), false);
  assert.equal(patternToRegExp('src/__tests__').test('src/__tests__-old/a.ts'), false);
});

test('* stops at a separator and ** does not', () => {
  assert.equal(patternToRegExp('src/*.ts').test('src/a.ts'), true);
  assert.equal(patternToRegExp('src/*.ts').test('src/a/b.ts'), false);
  assert.equal(patternToRegExp('src/**/*.ts').test('src/a/b.ts'), true);
});

test('dots are literal, not wildcards', () => {
  assert.equal(patternToRegExp('src/a.ts').test('src/axts'), false);
});

// A bug this file's own first draft shipped: reading a config's include as
// repo-relative marks the entire package uncovered, because `include: ["src"]`
// in server/tsconfig.json means server/src, not src.

test('a config dir qualifies its patterns', () => {
  assert.equal(patternToRegExp('server/src').test('server/src/a.ts'), true);
  assert.equal(patternToRegExp('server/src').test('src/a.ts'), false);
});

test('a wrong dir is reported as uncovered rather than silently matching', () => {
  const misdir = { name: 'wrong', dir: 'packages', include: ['src'], exclude: [] };
  const result = findUncoveredSources([SERVER_SRC], [misdir]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.uncovered, [SERVER_SRC]);
});

test('an omitted dir still works for repo-relative patterns', () => {
  const flat = { name: 'flat', include: ['src'], exclude: [] };
  assert.equal(findUncoveredSources(['src/a.ts'], [flat]).passed, true);
});

// The regression this gate exists for: the shape that shipped.

test('the shipped config leaves the whole test suite invisible', () => {
  const result = findUncoveredSources([SERVER_TEST], [SERVER]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.uncovered, [SERVER_TEST]);
});

test('one gate config alone still leaves the test suite invisible', () => {
  // The failure is not "the exclude exists", it is "nothing else picks it up".
  const result = findUncoveredSources([SERVER_SRC, SERVER_TEST], [SERVER]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.uncovered, [SERVER_TEST]);
  assert.equal(result.failures.length, 1);
});

test('a companion config that includes the tests closes the gap', () => {
  const result = findUncoveredSources([SERVER_SRC, SERVER_TEST], [SERVER, TESTS]);
  assert.equal(result.passed, true);
  assert.deepEqual(result.uncovered, []);
  assert.deepEqual(result.failures, []);
});

test('a config that includes nothing covers nothing', () => {
  const result = findUncoveredSources([SERVER_SRC], [{ name: 'empty', dir: 'server', include: [], exclude: [] }]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.uncovered, [SERVER_SRC]);
});

test('exclude wins over include within one config', () => {
  const result = findUncoveredSources([SERVER_TEST], [TESTS]);
  assert.equal(result.passed, true);
  const excluded = { name: 'x', dir: 'server', include: ['src'], exclude: ['src/__tests__'] };
  assert.equal(findUncoveredSources([SERVER_TEST], [excluded]).passed, false);
});

test('the failure message names files and says the claim is not evidence', () => {
  const { failures } = findUncoveredSources([SERVER_TEST], [SERVER]);
  assert.match(failures[0], /issues\.test\.ts/);
  assert.match(failures[0], /not evidence/);
});

test('the message truncates long lists without dropping the count', () => {
  const many = Array.from({ length: 9 }, (_, i) => `server/src/__tests__/t${i}.test.ts`);
  const { failures, uncovered } = findUncoveredSources(many, [SERVER]);
  assert.equal(uncovered.length, 9);
  assert.match(failures[0], /9 TypeScript file\(s\)/);
  assert.match(failures[0], /\.\.\./);
});

test('non-TypeScript files are out of scope', () => {
  const result = findUncoveredSources(['server/src/styles.css', 'README.md'], [SERVER]);
  assert.equal(result.passed, true);
});

test('an empty source list passes', () => {
  assert.equal(findUncoveredSources([], [SERVER]).passed, true);
});

test('the real repository configs leave no server file uncovered', () => {
  // Guards the fix against regressing: these are the two configs as committed.
  const { passed, uncovered } = findUncoveredSources([SERVER_SRC, SERVER_TEST], [SERVER, TESTS]);
  assert.equal(passed, true, `unexpectedly uncovered: ${uncovered.join(', ')}`);
});
