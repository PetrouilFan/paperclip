import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWLIST,
  DEFAULT_INTERNAL_REF_PREFIXES,
  MAX_PR_FILES,
  SELF_EXEMPT_PATHS,
  checkInternalRefs,
  patchIsComplete,
  resolvePrefixes,
} from '../check-pr-internal-refs.mjs';

const CLEAN = {
  prTitle: 'fix(issues): refuse a checkout that names a finished run',
  prBody: 'A checkout naming a run that already finished is a silent no-op. Refs #123.',
  prBranch: 'fix/checkout-finished-run',
  commits: [{ commit: { message: 'fix(issues): refuse a checkout that names a finished run\n\nbody' } }],
  files: [{ filename: 'server/src/routes/issues.ts', status: 'modified', changes: 2, patch: '@@ -1,1 +1,2 @@\n a\n+b\n' }],
};

/** The negative control the issue asked for, in the form that can be automated. */
const throwawayTitle = 'chore: add a PET-999 sentinel so the gate has something to catch';

test('the clean PR passes', () => {
  const result = checkInternalRefs(CLEAN);
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
  assert.deepEqual(result.failures, []);
});

test('NEGATIVE CONTROL: an id in the PR title fails the gate', () => {
  const result = checkInternalRefs({ ...CLEAN, prTitle: throwawayTitle });
  assert.equal(result.passed, false);
  const joined = result.failures.join('\n');
  assert.match(joined, /The PR title/);
  assert.match(joined, /PET-999/);
  // The failure has to say why it matters, or it is just noise a reviewer learns to skip.
  assert.match(joined, /commit subject/);
});

test('an id in the body, the branch, or a commit subject each fail', () => {
  assert.equal(checkInternalRefs({ ...CLEAN, prBody: 'Fixes PET-334 step 2.' }).passed, false);
  assert.equal(checkInternalRefs({ ...CLEAN, prBranch: 'fix/pet392-blocker-edge' }).passed, false);
  assert.equal(
    checkInternalRefs({ ...CLEAN, commits: [{ commit: { message: 'fix(issues): a one-way door (PET-392)' } }] }).passed,
    false,
  );
});

test('the compact branch form is caught even though it carries no hyphen', () => {
  // `PET-\d+` cannot see `pet392-...`: there is no hyphen after the prefix.
  const result = checkInternalRefs({ ...CLEAN, prBranch: 'fix/pet392-blocker-edge-one-way-door' });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /pet392/);
});

test('an id in a changed file name fails, because the name is part of the change', () => {
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{ filename: 'server/src/__tests__/pet392-blocker-edge-one-way-door.test.ts', status: 'added', changes: 0 }],
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /file name/);
});

test('an id in an added diff line fails, and a removed one does not count', () => {
  const added = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'cli/src/__tests__/process-identity.test.ts',
      status: 'modified',
      changes: 2,
      patch: '@@ -370,3 +370,4 @@\n ctx\n+// (PET-334 step 2), and it is not a question this suite can answer.\n ctx2\n',
    }],
  });
  assert.equal(added.passed, false);
  assert.match(added.failures.join('\n'), /process-identity\.test\.ts/);

  const removed = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'cli/src/__tests__/process-identity.test.ts',
      status: 'modified',
      changes: 1,
      patch: '@@ -370,2 +370,1 @@\n-// (PET-334 step 2), removed by the cleanup.\n ctx\n',
    }],
  });
  assert.equal(removed.passed, true, JSON.stringify(removed.failures, null, 2));
});

test('the canonical product\'s own namespace is left alone', () => {
  // The trap the issue warns about: `PAP-1/child` is a canonical fixture and
  // `/PAP/issues/...` a canonical route across 90+ files on master. A gate that
  // flagged them would be born failing on the product.
  const result = checkInternalRefs({
    prTitle: 'fix(ui): keep the PAP-1/child mention shape',
    prBody: 'The route /PAP/issues/PAP-224 still renders. See agent://agent-pap-1.',
    prBranch: 'fix/pap-mention-shape',
    commits: [{ commit: { message: 'test: assert "PAP-1/child" survives' } }],
    files: [{
      filename: 'ui/src/lib/issue-reference.test.ts',
      status: 'modified',
      changes: 1,
      patch: '@@ -1,1 +1,2 @@\n a\n+  it("handles PAP-1/child", () => {});\n',
    }],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('a bare agent:// mention is not a link, but agent:// with the instance prefix is', () => {
  const bare = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'server/src/__tests__/authorization-service.test.ts',
      status: 'modified',
      changes: 1,
      patch: '@@ -1,1 +1,2 @@\n a\n+  body: `[@Mentioned](agent://${id})`,\n',
    }],
  });
  assert.equal(bare.passed, true, JSON.stringify(bare.failures, null, 2));

  const scoped = checkInternalRefs({
    ...CLEAN,
    prBody: 'See [the issue](agent://PET-392) for the writeup.',
  });
  assert.equal(scoped.passed, false);
});

test('an instance route link is caught', () => {
  const result = checkInternalRefs({ ...CLEAN, prBody: 'Context lives at /PET/issues/PET-392.' });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /\/PET\/issues/);
});

test('FAIL CLOSED: an empty prefix list is a failure, not a pass', () => {
  for (const bad of [[], ['', '  '], ',,']) {
    const result = checkInternalRefs({ ...CLEAN, prTitle: throwawayTitle, prefixes: bad });
    assert.equal(result.passed, false, `expected failure for ${JSON.stringify(bad)}`);
    assert.match(result.failures.join('\n'), /INTERNAL_REF_PREFIXES/);
  }
});

test('FAIL CLOSED: a malformed prefix entry is a failure, not a pass', () => {
  for (const bad of ['PE-T', '1PET', 'A', 'PET|APA', 'PAP.*']) {
    const result = checkInternalRefs({ ...CLEAN, prTitle: throwawayTitle, prefixes: bad.split(',') });
    assert.equal(result.passed, false, `expected failure for ${JSON.stringify(bad)}`);
    assert.match(result.failures.join('\n'), /identifier prefix/);
  }
});

test('FAIL CLOSED: a changed file with line changes and no patch is a failure', () => {
  // Otherwise the gate reports "no internal references" about text it never read.
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{ filename: 'scripts/big-thing.sh', status: 'modified', changes: 412, additions: 400, deletions: 12 }],
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /without readable patch content/);
});

test('a binary file or pure rename with no patch is a true negative', () => {
  const result = checkInternalRefs({
    ...CLEAN,
    files: [
      { filename: 'ui/public/logo.png', status: 'modified', changes: 0, patch: null },
      { filename: 'doc/old-name.md', status: 'renamed', changes: 0, patch: null },
    ],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('FAIL CLOSED: a truncated patch is detected and reported, not treated as clean', () => {
  // The header declares four body lines; only two arrived. GitHub truncates
  // large diffs this way and flags it nowhere in the payload.
  const truncated = '@@ -10,2 +10,4 @@\n context\n+added one\n+added two\n';
  assert.equal(patchIsComplete(truncated).complete, false);

  const result = checkInternalRefs({
    ...CLEAN,
    files: [{ filename: 'server/src/routes/issues.ts', status: 'modified', changes: 900, patch: truncated }],
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /patch truncated by the GitHub API/);
});

test('a complete patch, including one with no trailing newline, is accepted', () => {
  assert.equal(patchIsComplete('@@ -1,1 +1,2 @@\n a\n+b\n').complete, true);
  assert.equal(patchIsComplete('@@ -1,1 +1,2 @@\n a\n+b').complete, true);
  assert.equal(patchIsComplete('@@ -1,2 +1,2 @@\n a\n-b\n+c\n').complete, true);
  assert.equal(patchIsComplete('@@ -1,0 +1,1 @@\n+brand new\n').complete, true);
  // "\\ No newline at end of file" is metadata, not a body line.
  assert.equal(patchIsComplete('@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n').complete, true);
});

test('FAIL CLOSED: a diff that hit GitHub\'s file cap is a failure', () => {
  const files = Array.from({ length: MAX_PR_FILES }, (_, i) => ({
    filename: `src/f${i}.ts`,
    status: 'modified',
    changes: 1,
    patch: '@@ -1,1 +1,1 @@\n-a\n+b\n',
  }));
  const result = checkInternalRefs({ ...CLEAN, files });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /3000-file cap/);
});

test('the rule text itself is allowlisted, and the allowlist is not a loophole', () => {
  // The allowlist only exempts the *diff* scan: an id in a PR title is still a
  // failure even if the PR also edits CONTRIBUTING.md.
  const result = checkInternalRefs({
    prTitle: throwawayTitle,
    files: [
      {
        filename: 'CONTRIBUTING.md',
        status: 'modified',
        changes: 1,
        patch: '@@ -70,1 +70,2 @@\n context\n+- `PAPA-123` is also banned\n',
      },
    ],
  });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /The PR title/);

  // A non-allowlisted file with the same line still fails.
  const other = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'doc/notes.md',
      status: 'modified',
      changes: 1,
      patch: '@@ -1,1 +1,2 @@\n a\n+- PET-999 leaked here\n',
    }],
  });
  assert.equal(other.passed, false);
});

test('every allowlist entry states a path and a reason', () => {
  assert.ok(ALLOWLIST.length > 0);
  for (const entry of ALLOWLIST) {
    assert.ok(entry.path, 'allowlist entry without a path');
    assert.ok(entry.reason && entry.reason.length > 20, `allowlist entry ${entry.path} needs a real reason`);
  }
});

test('the gate exempts itself, and only itself', () => {
  for (const path of SELF_EXEMPT_PATHS) {
    const result = checkInternalRefs({
      ...CLEAN,
      files: [{
        filename: path,
        status: 'modified',
        changes: 1,
        patch: '@@ -1,1 +1,2 @@\n a\n+// PET-999 is what this file searches for\n',
      }],
    });
    assert.equal(result.passed, true, `${path} should be exempt: ${JSON.stringify(result.failures)}`);
  }
});

test('the default prefix list is this instance\'s namespace alone', () => {
  assert.deepEqual(DEFAULT_INTERNAL_REF_PREFIXES, ['PET']);
  const { prefixes } = resolvePrefixes(undefined);
  assert.deepEqual(prefixes, ['PET']);
});

test('a configured extra prefix is honoured and de-duplicated case-insensitively', () => {
  const { prefixes, configError } = resolvePrefixes('PET, pet ,PAP ,PAPA');
  assert.equal(configError, undefined);
  assert.deepEqual(prefixes, ['PET', 'PAP', 'PAPA']);

  const widened = checkInternalRefs({
    ...CLEAN,
    prefixes: ['PET', 'PAP'],
    files: [{
      filename: 'doc/x.md',
      status: 'modified',
      changes: 1,
      patch: '@@ -1,1 +1,2 @@\n a\n+PAP-224 is banned when the prefix is configured\n',
    }],
  });
  assert.equal(widened.passed, false);
});

test('one finding is reported once, not once per surface spelling', () => {
  const result = checkInternalRefs({ ...CLEAN, prTitle: 'fix: PET-392 and PET-392 and PET-334' });
  assert.equal(result.passed, false);
  assert.equal(result.failures.filter((f) => f.includes('The PR title')).length, 1);
});
