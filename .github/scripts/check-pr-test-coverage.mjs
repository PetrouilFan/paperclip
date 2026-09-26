#!/usr/bin/env node
/**
 * check-pr-test-coverage.mjs
 * Checks that a PR diff includes at least one test file. Respects conventional
 * commit prefixes — skips check for docs/chore/build/ci/style/refactor PRs.
 * Also detects mismatch: docs/chore PRs that contain real source code changes.
 * Export: checkTestCoverage(files, prTitle) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

const TEST_PATTERNS = [
  /\.test\.(ts|js|tsx|jsx|mjs|cjs)$/,
  /\.spec\.(ts|js|tsx|jsx|mjs|cjs)$/,
  /(?:^|\/)tests?\//,
  /\/__tests__\//,
];

const SOURCE_CODE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Prefixes where test coverage is NOT required
const SKIP_TEST_PREFIXES = ['docs', 'chore', 'build', 'ci', 'style', 'refactor', 'revert'];

// Prefixes where source code changes are NOT expected (mismatch detection)
// Note: 'style' is excluded — formatting PRs legitimately touch source files
const NO_SOURCE_CODE_PREFIXES = ['docs', 'chore', 'build', 'ci'];

function parsePrefix(title) {
  if (!title) return null;
  const match = title.match(/^([a-z]+)(?:\([^)]*\))?:/);
  return match ? match[1].toLowerCase() : null;
}

function isSourceFile(filename) {
  if (!SOURCE_CODE_PATTERN.test(filename)) return false;
  if (TEST_PATTERNS.some(p => p.test(filename))) return false;
  return true;
}

export function checkTestCoverage(files, prTitle = '') {
  const prefix = parsePrefix(prTitle);

  // Mismatch detection: docs/chore/etc PR with real source code changes
  if (prefix && NO_SOURCE_CODE_PREFIXES.includes(prefix)) {
    const sourceChanges = files.filter(f => f.status !== 'removed' && isSourceFile(f.filename));
    if (sourceChanges.length > 0) {
      // `code` is what lets a caller tell this verdict apart from the missing-test
      // one, and it is the hook `resolveTestCoverage` below hangs the re-read on.
      // Without it a stale file list and a genuine prefix mismatch are the same
      // value, and no caller can react to one of them.
      return {
        passed: false,
        code: 'prefix_mismatch',
        failures: [
          `PR is titled \`${prefix}:\` but includes source code changes ` +
          `(${sourceChanges.slice(0, 3).map(f => f.filename).join(', ')}` +
          `${sourceChanges.length > 3 ? ', ...' : ''}` +
          // The denominator is the point. A `docs:` PR whose list holds three
          // source files reads as a real finding; the same three files inside a
          // 119-file list means the list is not this pull request's, and a
          // reviewer who cannot see that will retitle a documentation change to
          // `fix:` to satisfy a message about a diff that does not exist.
          `; ${sourceChanges.length} of ${files.length} files in the served list). ` +
          `Please retitle as \`fix:\`, \`feat:\`, or \`refactor:\` so the right gates run, ` +
          `or remove the source code changes if this is genuinely a \`${prefix}:\` PR.`,
        ],
      };
    }
  }

  // Skip test requirement for prefixes that don't change behavior
  if (prefix && SKIP_TEST_PREFIXES.includes(prefix)) {
    return { passed: true, code: 'skipped_prefix', failures: [] };
  }

  const hasTests = files.some(
    f => f.status !== 'removed' && TEST_PATTERNS.some(p => p.test(f.filename))
  );

  return {
    passed: hasTests,
    code: hasTests ? 'ok' : 'no_tests',
    failures: hasTests ? [] : [
      'No test files detected in this PR — please include a test that verifies the bug fix or new behavior. ' +
      'If this PR genuinely doesn\'t need a test (e.g. a refactor), please retitle with `refactor:` prefix.',
    ],
  };
}

/**
 * `checkTestCoverage`, with one re-read of the pull request's file list when the
 * verdict it produced is the one a stale list can fake.
 *
 * `GET /repos/{o}/{r}/pulls/{n}/files` is derived from a stored comparison, so
 * for a short window after a force-push it can answer with the *pre-rewrite*
 * diff. A one-file `docs:` pull request rebased onto current `master` was served
 * 119 files — the base branch's own recent history — and this gate read that as
 * a documentation change that had rewritten the CI scripts and the CLI. The
 * failure is self-clearing, but the message it emits names specific files and
 * prescribes retitling the pull request, so a reviewer who does not know a
 * rebase just happened acts on it: the change is relabelled `fix:`, which then
 * makes the other gates demand tests for a documentation edit.
 *
 * A `prefix_mismatch` is the only verdict worth re-reading. It is the one that
 * fires precisely when a branch is being actively worked, which is when
 * re-gating is most likely to be the thing being done, and the only one whose
 * remedy is destructive if it is wrong. The re-read is not free, so it is paid
 * only there: a `docs:` pull request that genuinely touches only Markdown never
 * reaches it, because the first verdict already passed.
 *
 * The re-read relaxes the verdict only when it *clears* the contradiction. If
 * the fresh list still reports source files, the mismatch is real and the
 * original message is returned unchanged, so this cannot mask a real finding —
 * it can only avoid asserting one on a list that did not describe the pull
 * request. The residual race (a force-push landing between the two reads) is
 * left in place deliberately: closing it needs the comparison range rather than
 * the served list, which changes what every gate sees and cannot be validated
 * without a live force-push to test against.
 */
export async function resolveTestCoverage(files, prTitle = '', refetchFiles) {
  const first = checkTestCoverage(files, prTitle);

  if (first.passed || first.code !== 'prefix_mismatch' || typeof refetchFiles !== 'function') {
    return first;
  }

  let fresh;
  try {
    fresh = await refetchFiles();
  } catch {
    // A re-read that cannot be completed is not evidence either way. The
    // original verdict stands rather than being relaxed on a failed fetch.
    return first;
  }
  if (!Array.isArray(fresh)) return first;

  const second = checkTestCoverage(fresh, prTitle);
  return second.passed ? second : first;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const title = process.env.PR_TITLE ?? '';
  const result = checkTestCoverage(files, title);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
