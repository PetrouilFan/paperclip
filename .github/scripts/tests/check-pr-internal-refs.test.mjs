import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  ALLOWLIST,
  DEFAULT_INTERNAL_REF_PREFIXES,
  DEFAULT_PRODUCT_OWNED_PREFIXES,
  MAX_PR_FILES,
  SELF_EXEMPT_PATHS,
  checkInternalRefs,
  findInstanceHosts,
  findUnknownInternalRefs,
  patchIsComplete,
  resolvePrefixes,
  resolveProductOwnedPrefixes,
} from '../check-pr-internal-refs.mjs';

const CLEAN = {
  prTitle: 'fix(issues): refuse a checkout that names a finished run',
  prBody: 'A checkout naming a run that already finished is a silent no-op. Refs #123.',
  prBranch: 'fix/checkout-finished-run',
  commits: [{ commit: { message: 'fix(issues): refuse a checkout that names a finished run\n\nbody' } }],
  files: [{ filename: 'server/src/routes/issues.ts', status: 'modified', changes: 2, patch: '@@ -1,1 +1,2 @@\n a\n+b\n' }],
};

/** The negative control the issue asked for, in the form that can be automated. */
const throwawayTitle = 'chore: add a PET-9000 sentinel so the gate has something to catch';

/**
 * The only instance-shaped identifiers the two self-exempt files may contain.
 *
 * `SELF_EXEMPT_PATHS` exists because those files *are* the rule and have to
 * quote the shapes they ban. The cost of that exemption is that the diff scan
 * never looks inside them, so a real ticket id copied out of a bug report into
 * a fixture reaches a public repository with no gate in front of it — which is
 * exactly how this repository came to carry two live identifiers inside the
 * very script written to remove them. Declaring the set here gives the
 * exemption a floor: an undeclared literal is a failure, so adding one is a
 * deliberate act and reusing a real one is caught.
 *
 * Membership is the weaker half of the rule. The stronger half — that an entry
 * is a number this instance never issued — is enforced as a number by
 * `MIN_SYNTHETIC_ID` below, because a comment asking for it is not a control:
 * a live id declared once would otherwise be indistinguishable from a
 * synthetic one forever after, and the next contributor would copy it.
 */
const DECLARED_FIXTURE_IDS = new Set([
  'PET-9000',
  'PET9000',
  'PET-9001',
  'PET-9002',
  'PET9002',
  'PET-9003',
  'PET9003',
  'PET-9004',
  'PET9004',
  'PET-9005',
  'PET9005',
]);

/**
 * The floor that makes "synthetic" checkable instead of promised.
 *
 * The instance had issued 490 real issues when this was written, so anything
 * at or below this bound could be a coordinate and is refused. It sits four
 * orders of magnitude above the live range, which means it is not a number
 * anyone has to revisit: raising the instance's issue count to 9,000 is the
 * only thing that can make it stale.
 */
const MIN_SYNTHETIC_ID = 9000;

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
  assert.match(joined, /PET-9000/);
  // The failure has to say why it matters, or it is just noise a reviewer learns to skip.
  assert.match(joined, /commit subject/);
});

test('an id in the body, the branch, or a commit subject each fail', () => {
  assert.equal(checkInternalRefs({ ...CLEAN, prBody: 'Fixes PET-9001 step 2.' }).passed, false);
  assert.equal(checkInternalRefs({ ...CLEAN, prBranch: 'fix/pet9002-blocker-edge' }).passed, false);
  assert.equal(
    checkInternalRefs({ ...CLEAN, commits: [{ commit: { message: 'fix(issues): a one-way door (PET-9002)' } }] }).passed,
    false,
  );
});

test('the compact branch form is caught even though it carries no hyphen', () => {
  // `PET-\d+` cannot see `pet9002-...`: there is no hyphen after the prefix.
  const result = checkInternalRefs({ ...CLEAN, prBranch: 'fix/pet9002-blocker-edge-one-way-door' });
  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /pet9002/);
});

test('an id in a changed file name fails, because the name is part of the change', () => {
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{ filename: 'server/src/__tests__/pet9002-blocker-edge-one-way-door.test.ts', status: 'added', changes: 0 }],
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
      patch: '@@ -370,3 +370,4 @@\n ctx\n+// (PET-9001 step 2), and it is not a question this suite can answer.\n ctx2\n',
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
      patch: '@@ -370,2 +370,1 @@\n-// (PET-9001 step 2), removed by the cleanup.\n ctx\n',
    }],
  });
  assert.equal(removed.passed, true, JSON.stringify(removed.failures, null, 2));
});

test('the compact form is caught on an added diff line, not only on a branch name', () => {
  // The hole this closes: `separated` + `link` over added lines could not see a
  // bare compact identifier, which is the shape a temp-directory prefix and a
  // systemd unit name both arrive as.
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'server/src/listening-port-owner.test.ts',
      status: 'modified',
      changes: 1,
      patch: '@@ -1,1 +1,2 @@\n a\n+  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "pet9002-proc-"));\n',
    }],
  });
  assert.equal(result.passed, false, 'a compact id on an added line must fail');
  assert.match(result.failures.join('\n'), /pet9002/);
  assert.match(result.failures.join('\n'), /listening-port-owner\.test\.ts/);
});

test('FLOOR: every leak shape the compact scan was measured against is caught', () => {
  // Non-vacuous by construction: each line below reproduces a real added line
  // from this repository's own history, one per shape the measurement found.
  // The *identifiers* are synthetic stand-ins, not the live coordinates the
  // shapes came from: SELF_EXEMPT_PATHS covers this file, so the floor above
  // refuses any id the instance could have issued. The shape is what the
  // matcher keys on and it is preserved exactly; the number is not load-bearing
  // for any assertion. A refactor that quietly narrows the matcher again fails
  // here, rather than passing because the suite never used the compact form on
  // a diff line.
  const shapes = [
    ['server/src/listening-port-owner.test.ts', '+const root = mkdtempSync(join(tmpdir(), "pet9002-proc-"));'],
    ['server/src/embedded-postgres-ownership.test.ts', '+  const dataDir = await makeTempDir("pet9002-orphan-db-");'],
    ['cli/src/__tests__/install-store-shim-location.test.ts', '+  root = fs.mkdtempSync(path.join(os.tmpdir(), "pet9003-"));'],
    ['scripts/e2e-install-lifecycle-isolation.test.mjs', '+  const directory = mkdtempSync(join(tmpdir(), "pet9000-template-"));'],
    ['scripts/paperclip-unit-guardian-freeze-proof.sh', '+U2=pet9005-heal.service'],
    ['scripts/paperclip-unit-guardian.test.mjs', '+  const dir = mkdtempSync(join(tmpdir(), "pet9005-"));'],
    ['docs/deploy/shadowed-server-install.md', '+Eight `.pre-pet9004-20260925T171750Z` files are left behind.'],
  ];
  for (const [filename, added] of shapes) {
    const result = checkInternalRefs({
      ...CLEAN,
      files: [{ filename, status: 'modified', changes: 1, patch: `@@ -1,1 +1,2 @@\n ctx\n${added}\n` }],
    });
    assert.equal(result.passed, false, `expected a failure for ${filename}: ${added}`);
  }
  // And the floor is a floor: the same scan set over a clean diff passes, so the
  // test above is proving the matcher fires and not that the gate fails always.
  const clean = checkInternalRefs({
    ...CLEAN,
    files: [{ filename: 'scripts/paperclip-unit-guardian.test.mjs', status: 'modified', changes: 1, patch: '@@ -1,1 +1,2 @@\n ctx\n+  const dir = mkdtempSync(join(tmpdir(), "unit-guardian-"));\n' }],
  });
  assert.equal(clean.passed, true, JSON.stringify(clean.failures, null, 2));
});

test('NEGATIVE CONTROL: the compact scan needs a token start and two digits', () => {
  // The two constraints that make the measurement's zero-false-positive result
  // a property of the matcher rather than of luck. `petrichor12` must not fire
  // because the match has to begin the token, and `pet1` must not fire because
  // the floor is two digits.
  for (const line of [
    '+const label = "petrichor12";',
    '+const digest = "a3f9c1b2deadbeef00pet12cafe";',
    '+const threshold = "pet1";',
    '+const vintage = "pet99s";',
  ]) {
    const result = checkInternalRefs({
      ...CLEAN,
      files: [{ filename: 'server/src/routes/issues.ts', status: 'modified', changes: 1, patch: `@@ -1,1 +1,2 @@\n ctx\n${line}\n` }],
    });
    assert.equal(result.passed, true, `expected a pass for ${line}: ${JSON.stringify(result.failures, null, 2)}`);
  }
});

test('a removed compact identifier does not count, exactly as a removed separated one does not', () => {
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'server/src/listening-port-owner.test.ts',
      status: 'modified',
      changes: 1,
      patch: '@@ -1,2 +1,1 @@\n-  const root = mkdtempSync(join(tmpdir(), "pet9002-proc-"));\n ctx\n',
    }],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
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
    prBody: 'See [the issue](agent://PET-9002) for the writeup.',
  });
  assert.equal(scoped.passed, false);
});

test('an instance route link is caught', () => {
  const result = checkInternalRefs({ ...CLEAN, prBody: 'Context lives at /PET/issues/PET-9002.' });
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
      patch: '@@ -1,1 +1,2 @@\n a\n+- PET-9000 leaked here\n',
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
        patch: '@@ -1,1 +1,2 @@\n a\n+// PET-9000 is what this file searches for\n',
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
  const result = checkInternalRefs({ ...CLEAN, prTitle: 'fix: PET-9002 and PET-9002 and PET-9001' });
  assert.equal(result.passed, false);
  assert.equal(result.failures.filter((f) => f.includes('The PR title')).length, 1);
});

// --- the open identifier shape, in authored text only ---------------------
//
// The finding this exists for: PR #85 merged to `master` as `1220016a0` with
// `TASK-482` written three times in its *Steps to reproduce*, the `review` gate
// green, because the identifier half of this gate matched a configured prefix
// list and the rule text bans a shape. The negative controls below are
// load-bearing in the same way the address controls are: the bare shape flags
// `GPT-5` in four **Model Used** sections, and a matcher that fails the pull
// request documenting the model that wrote it gets disabled.

/** The three *Steps to reproduce* lines from #85, verbatim. */
const PR85_REPRO = [
  '1. Give agent B a task `TASK-482`; leave it assigned to agent B.',
  '3. From that run, comment on or update `TASK-482`.',
  '5. Follow the advice: call `POST /api/issues/{TASK-482}/checkout` as agent A.',
].join('\n');

test('the merged #85 body fails the gate it passed', () => {
  // The positive control. If this ever passes again, the open matcher has
  // stopped seeing references and the finding is unrepeatable.
  const result = checkInternalRefs({ ...CLEAN, prBody: `**Steps to reproduce**\n\n${PR85_REPRO}` });
  assert.equal(result.passed, false, JSON.stringify(result.failures, null, 2));
  const joined = result.failures.join('\n');
  assert.match(joined, /The PR description/);
  assert.match(joined, /TASK-482/);
  // The failure has to name the fix. An author who reads "add TASK to the prefix
  // list" has closed this instance's hole and left the next tool's open.
  assert.match(joined, /Restate what the issue was in plain English/);
});

test('one unopenable id is one finding, not one per rule that saw it', () => {
  // `TASK-482` here is in all three reference positions at once, and the
  // de-duplication is per finding rather than per rule.
  const result = checkInternalRefs({ ...CLEAN, prBody: 'See #TASK-482, or POST /api/issues/TASK-482, or fix TASK-482.' });
  assert.equal(result.passed, false);
  assert.equal(
    result.failures.filter((f) => f.includes('namespace this repository has no exemption')).length,
    1,
    result.failures.join('\n'),
  );
});

test('an id the configured list already caught is not reported twice', () => {
  // `fix` is both a reference verb and a conventional-commit type, so
  // `fix: PET-9003` is visible to both tiers. One id is one paragraph.
  const result = checkInternalRefs({ ...CLEAN, prTitle: 'fix: PET-9003 and PET-9004' });
  assert.equal(result.passed, false);
  assert.equal(result.failures.filter((f) => f.includes('The PR title')).length, 1, result.failures.join('\n'));
  // ...and the one finding is the configured-prefix one, which is the report
  // text that has existed all along.
  assert.match(result.failures.join('\n'), /internal issue identifier/);
});

test('a commit subject is de-duplicated like every other surface', () => {
  // The same collision, on the surface most likely to produce it. `fix:` is a
  // reference verb, and a conventional-commit subject is the form an author
  // writes without thinking — so this is where the two tiers meet most often.
  // Before the handoff this reported twice, and the second paragraph claimed a
  // namespace the repository has an exemption for was one it has none for.
  const result = checkInternalRefs({
    ...CLEAN,
    commits: [{ commit: { message: 'fix: PET-9003 edge case' } }],
  });
  assert.equal(result.passed, false);
  assert.equal(
    result.failures.filter((f) => f.includes('A commit subject')).length,
    1,
    `one id is one finding on every surface, including this one:\n${result.failures.join('\n')}`,
  );
  assert.match(result.failures.join('\n'), /internal issue identifier/);
  // The false second copy is the specific thing worth asserting: it named the
  // configured prefix as unconfigured.
  assert.doesNotMatch(
    result.failures.join('\n'),
    /namespace this repository has no exemption/,
    `a configured prefix must never be reported as unconfigured:\n${result.failures.join('\n')}`,
  );
  // An id past the configured list is still reported on this surface — the
  // handoff de-duplicates, it does not mute the surface.
  const past = checkInternalRefs({
    ...CLEAN,
    commits: [{ commit: { message: 'fix: TASK-482 edge case' } }],
  });
  assert.equal(past.passed, false);
  assert.match(past.failures.join('\n'), /TASK-482/);
  // ...and a commit that carries no configured id is still visited, which is
  // what a shared subject list has to get right.
  assert.equal(
    checkInternalRefs({ ...CLEAN, commits: [{ commit: { message: 'fix: TASK-482 edge' } }] }).failures
      .filter((f) => f.includes('A commit subject')).length,
    1,
  );
});

test('a commit message body is de-duplicated like every other surface', () => {
  // The subject/author that split the body off to give it its own remedy also
  // left it handing the open tier an empty `alreadyFound`, so the same
  // collision that was fixed on the subject was still live one line below it.
  // A body is authored text on exactly the terms a subject is, so `fix:` — both
  // a conventional-commit type and a reference verb — reaches both matchers here
  // too, and the second paragraph is the same false one.
  const result = checkInternalRefs({
    ...CLEAN,
    commits: [{ sha: 'a1b2c3d4', commit: { message: 'chore(shared): tidy\n\ncarries on from fix: PET-9003' } }],
  });
  assert.equal(result.passed, false);
  assert.equal(
    result.failures.filter((f) => f.includes('A commit message body')).length,
    1,
    `one id is one finding on every surface, the body included:\n${result.failures.join('\n')}`,
  );
  assert.doesNotMatch(
    result.failures.join('\n'),
    /namespace this repository has no exemption/,
    `a configured prefix must never be reported as unconfigured:\n${result.failures.join('\n')}`,
  );
  // The handoff subtracts; it does not mute the surface. An id past the
  // configured list is still reported from a body.
  const past = checkInternalRefs({
    ...CLEAN,
    commits: [{ sha: 'a1b2c3d4', commit: { message: 'chore(shared): tidy\n\ncarries on from fix: TASK-482' } }],
  });
  assert.equal(past.passed, false);
  assert.match(past.failures.join('\n'), /A commit message body/);
  assert.match(past.failures.join('\n'), /TASK-482/);
});

test('two commits carrying the same text are one finding, not two', () => {
  // The subject list is keyed by the subject text, so a rebase that replays
  // `fix: <same subject>` across a series — the common shape for a fix-up
  // series, not an exotic one — does not produce one paragraph per commit. The
  // same holds for the body. Before the key was the text, each commit in the
  // series reported separately and the author was told the same thing N times.
  const shared = checkInternalRefs({
    ...CLEAN,
    commits: [
      { sha: 'aaaaaaaa', commit: { message: 'fix: PET-9003 edge case' } },
      { sha: 'bbbbbbbb', commit: { message: 'fix: PET-9003 edge case' } },
      { sha: 'cccccccc', commit: { message: 'fix: PET-9003 edge case' } },
    ],
  });
  assert.equal(shared.passed, false);
  assert.equal(
    shared.failures.filter((f) => f.includes('A commit subject')).length,
    1,
    `a repeated subject is one finding:\n${shared.failures.join('\n')}`,
  );
  const sharedBody = checkInternalRefs({
    ...CLEAN,
    commits: [
      { sha: 'aaaaaaaa', commit: { message: 'chore: tidy\n\ncarries on from PET-9003' } },
      { sha: 'bbbbbbbb', commit: { message: 'chore: tidy\n\ncarries on from PET-9003' } },
    ],
  });
  assert.equal(sharedBody.passed, false);
  assert.equal(
    sharedBody.failures.filter((f) => f.includes('A commit message body')).length,
    1,
    `a repeated body is one finding:\n${sharedBody.failures.join('\n')}`,
  );
  // Collapsing is not muting: an id that appears on only one of the two
  // commits is still found, and it is still attributed to that commit.
  const oneOf = checkInternalRefs({
    ...CLEAN,
    commits: [
      { sha: 'aaaaaaaa', commit: { message: 'chore: tidy\n\nnothing here' } },
      { sha: 'bbbbbbbb', commit: { message: 'chore: tidy\n\ncarries on from PET-9004' } },
    ],
  });
  assert.equal(oneOf.passed, false);
  assert.match(oneOf.failures.join('\n'), /PET-9004/);
  assert.match(oneOf.failures.join('\n'), /bbbbbbbb/);
});

test('every reference position fires, and each is one an id is written into', () => {
  const cases = [
    ['#TASK-482', 'a `#` reference'],
    ['/issues/TASK-482', 'an issue-router path'],
    ['/api/issues/{TASK-482}/checkout', 'a URL template, which is how #85 wrote it'],
    ['Fixes TASK-482', 'a reference verb, no quoting'],
    ['give agent B a task `TASK-482`', 'a reference verb, backtick-quoted'],
    ['see "TASK-482" for context', 'a reference verb, quote-wrapped'],
    ['Ref TASK-482', 'a reference verb, abbreviated'],
    ['fix(shared): TASK-482', 'a reference verb behind a conventional-commit scope'],
    ['fix(ui): TASK-482', 'the same, on a one-word scope'],
  ];
  for (const [body, why] of cases) {
    const result = checkInternalRefs({ ...CLEAN, prBody: body });
    assert.equal(result.passed, false, `expected failure (${why}) for: ${body}\n${JSON.stringify(result.failures)}`);
    assert.match(result.failures.join('\n'), /TASK-482/, `expected the id itself in the report for: ${body}`);
  }
});

test('an unopenable reference fails in the title, the branch and a commit subject', () => {
  const title = checkInternalRefs({ ...CLEAN, prTitle: 'fix(shared): route the write at the ticket TASK-482' });
  assert.equal(title.passed, false);
  assert.match(title.failures.join('\n'), /The PR title/);

  const branch = checkInternalRefs({ ...CLEAN, prBranch: 'fix/TASK-482-unbound-target' });
  assert.equal(branch.passed, false);
  assert.match(branch.failures.join('\n'), /branch name/);

  const subject = checkInternalRefs({
    ...CLEAN,
    commits: [{ commit: { message: 'fix(shared): the advice named ticket TASK-482\n\nbody' } }],
  });
  assert.equal(subject.passed, false);
  assert.match(subject.failures.join('\n'), /A commit subject/);
});

// --- the negative controls -------------------------------------------------
//
// These are what make the open shape usable. Each one is a real string that
// appeared on this fork and would fail a naive open matcher.

test('NEGATIVE CONTROL: the model name in Model Used is not an issue reference', () => {
  // This is the finding that shaped the matcher. `- Model: GPT-5 (codex)` is
  // required content in a required section, and the bare open shape flags it on
  // four of the last sixty pull requests.
  const result = checkInternalRefs({
    ...CLEAN,
    prTitle: 'fix(e2e): report the real cause when no run appears',
    prBody: [
      '## Model Used',
      '',
      '- Provider: OpenAI',
      '- Model: GPT-5 (codex)',
      '- Context window: 400k',
      '- Reasoning mode: high',
    ].join('\n'),
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('NEGATIVE CONTROL: an identifier given as an example is not a reference', () => {
  // From #67: the config field is documented by naming its *shape*, and the
  // shape happens to look like an id. A code span is where an author quotes a
  // value, which is not the same as pointing at a ticket.
  const result = checkInternalRefs({
    ...CLEAN,
    prBody: 'It reads `runtimeConfig.heartbeat.standingWatchIssueId`. The value can be a UUID or an issue identifier such as `PROJ-123`.',
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('NEGATIVE CONTROL: a standard or protocol token is not an issue reference', () => {
  for (const body of [
    'The payload is UTF-8 and the digest is SHA-256.',
    'The status line is HTTP-404 and the retry is HTTP-503.',
    'Conforming to RFC-2119 and ISO-8601 is the whole requirement.',
    'The wire format is HTTP/1.1 and the encoding is UTF-8.',
  ]) {
    const result = checkInternalRefs({ ...CLEAN, prBody: body });
    assert.equal(result.passed, true, `expected pass for: ${body}\n${JSON.stringify(result.failures, null, 2)}`);
  }
});

test('NEGATIVE CONTROL: the product\'s own namespace is exempt in a reference position too', () => {
  // The exemption is the reason the open shape is usable at all. `/PAP/issues/...`
  // is a canonical route across 90+ files, and #85's own diff is full of it.
  for (const body of [
    'The route /PAP/issues/PAP-224 still renders.',
    'The canonical fixture is PAP-1/child and it must keep working.',
    'Fixes PAPA-123 is the product\'s own namespace, not ours.',
  ]) {
    const result = checkInternalRefs({ ...CLEAN, prBody: body });
    assert.equal(result.passed, true, `expected pass for: ${body}\n${JSON.stringify(result.failures, null, 2)}`);
  }
});

test('NEGATIVE CONTROL: the open matcher does not reach the diff', () => {
  // The same surface split as the address rule. 736 files on master carry
  // `PAP-`/`PAPA-` legitimately, and the configured list is what covers them.
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'server/src/routes/issues.ts',
      status: 'modified',
      changes: 1,
      patch: '@@ -1,1 +1,2 @@\n a\n+  // issue-router path shape: /issues/PROJ-1 is documented, not linked\n',
    }],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('NEGATIVE CONTROL: the compact open form is not used, because SHA256 is a branch name', () => {
  // `fix/SHA256-digest` is a perfectly good branch name and no open compact
  // form separates it from `fix/task482-thing`. The configured list still
  // catches the instance's own lowercase prefix — see the test above — so the
  // gap this leaves is narrow, and naming `SHA256` is cheaper than the
  // blocklist that would be needed to exclude it.
  for (const name of ['fix/SHA256-digest', 'feat/HTTP2-push', 'docs/UTF8-normalization']) {
    const result = checkInternalRefs({ ...CLEAN, prBranch: name });
    assert.equal(result.passed, true, `expected ${name} to pass: ${JSON.stringify(result.failures)}`);
  }
});

test('the branch surface takes the bare shape, because a branch name is the reference', () => {
  // A branch name has no verb, no `#` and no path, so the reference rules can
  // never fire on it. Measured over the 96 branch names that have been a pull
  // request head on this fork, the bare separated shape flags none of them.
  const separated = checkInternalRefs({ ...CLEAN, prBranch: 'fix/TASK-482-unbound-target' });
  assert.equal(separated.passed, false);
  assert.match(separated.failures.join('\n'), /TASK-482/);
  assert.match(separated.failures.join('\n'), /branch name/);

  // ...and the cost of that choice, stated rather than hidden: a standards-named
  // branch does fail. The remedy is a rename, which costs nothing before the
  // branch is pushed and nothing after.
  const standards = checkInternalRefs({ ...CLEAN, prBranch: 'fix/UTF-8-normalization' });
  assert.equal(standards.passed, false);
  assert.match(standards.failures.join('\n'), /UTF-8/);

  // The product's own namespace stays exempt on this surface too.
  const product = checkInternalRefs({ ...CLEAN, prBranch: 'fix/PAP-1-child-mention' });
  assert.equal(product.passed, true, JSON.stringify(product.failures, null, 2));
});

test('FAIL CLOSED: an unusable product-owned exemption list is a failure, not a pass', () => {
  // The failure mode here is silent and points the dangerous way: an empty list
  // makes every honest mention of /PAP/issues/PAP-1 a failure, which is how a
  // gate earns a reputation for noise.
  for (const bad of [[], ['', '  '], ',,']) {
    const result = checkInternalRefs({ ...CLEAN, prBody: 'The route /PAP/issues/PAP-224 renders.', productOwnedPrefixes: bad });
    assert.equal(result.passed, false, `expected failure for ${JSON.stringify(bad)}`);
    assert.match(result.failures.join('\n'), /PRODUCT_OWNED_REF_PREFIXES/);
  }
  for (const bad of ['P-P', '1PAP', 'P', 'PAP.*']) {
    const result = checkInternalRefs({ ...CLEAN, prBody: 'The route /PAP/issues/PAP-224 renders.', productOwnedPrefixes: bad.split(',') });
    assert.equal(result.passed, false, `expected failure for ${JSON.stringify(bad)}`);
    assert.match(result.failures.join('\n'), /identifier prefix/);
  }
  const wrongType = checkInternalRefs({ ...CLEAN, prBody: 'The route /PAP/issues/PAP-224 renders.', productOwnedPrefixes: { a: 1 } });
  assert.equal(wrongType.passed, false);
  assert.match(wrongType.failures.join('\n'), /PRODUCT_OWNED_REF_PREFIXES/);
});

test('the exemption list is a default, and a deployment can widen it', () => {
  assert.deepEqual(DEFAULT_PRODUCT_OWNED_PREFIXES, ['PAP', 'PAPA']);
  const { owned, configError } = resolveProductOwnedPrefixes(undefined);
  assert.equal(configError, undefined);
  assert.deepEqual(owned, ['pap', 'papa']);

  // A fork that has its own product namespace names it, and that namespace
  // stops being reported without anyone touching the matchers.
  const widened = checkInternalRefs({
    ...CLEAN,
    prBody: 'The canonical route is /UPSTREAM/issues/UPSTREAM-9 and it must survive.',
    productOwnedPrefixes: ['PAP', 'PAPA', 'UPSTREAM'],
  });
  assert.equal(widened.passed, true, JSON.stringify(widened.failures, null, 2));
});

test('findUnknownInternalRefs states its own boundaries', () => {
  // Exported so a caller can get the finding without the report text, and so
  // the boundaries are a unit under test rather than a claim in a comment.
  assert.deepEqual(findUnknownInternalRefs('see #TASK-482'), ['TASK-482']);
  assert.deepEqual(findUnknownInternalRefs('/api/issues/{TASK-482}/checkout'), ['TASK-482']);
  assert.deepEqual(findUnknownInternalRefs('the model is GPT-5'), []);
  assert.deepEqual(findUnknownInternalRefs('such as `PROJ-123`'), []);
  assert.deepEqual(findUnknownInternalRefs('the payload is UTF-8'), []);
  assert.deepEqual(findUnknownInternalRefs('a public ref like #123 stays'), []);
  assert.deepEqual(findUnknownInternalRefs('a heading ## Checklist'), []);
  assert.deepEqual(findUnknownInternalRefs('the route /PAP/issues/PAP-224'), []);
  // The conventional-commit scope is a single unspaced token, so a prose aside
  // in parentheses is not a reference position. `see TASK-482` inside it fires
  // on `see` alone, which is the verb list doing its job, not the scope group.
  assert.deepEqual(findUnknownInternalRefs('the fix (with TASK-482) is gone'), []);
  assert.deepEqual(findUnknownInternalRefs('chore(shared): TASK-482'), []);
  assert.deepEqual(findUnknownInternalRefs('bump the thing (TASK-482)'), []);
  assert.deepEqual(findUnknownInternalRefs(''), []);
  assert.deepEqual(findUnknownInternalRefs(undefined), []);
  // What the configured tier already reported is not reported again.
  assert.deepEqual(findUnknownInternalRefs('fix: PET-9003', undefined, ['PET-9003']), []);
  // ...and a different id on the same surface still is.
  assert.deepEqual(findUnknownInternalRefs('fix: PET-9003 and ticket TASK-482', undefined, ['PET-9003']), ['TASK-482']);
  // The branch surface drops the reference-position requirement, and only that.
  assert.deepEqual(findUnknownInternalRefs('fix/TASK-482-unbound', undefined, [], { requireReference: false }), ['TASK-482']);
  assert.deepEqual(findUnknownInternalRefs('fix/TASK-482-unbound'), []);
});

// --- the instance-local address rule, in authored text only ----------------
//
// The negative controls here are the ones that decide whether this rule is
// usable at all. 664 files on master use `localhost` legitimately, so a
// matcher that fires on the word is a matcher that gets disabled. The controls
// that must PASS are as load-bearing as the ones that must fail.

// NEGATIVE CONTROL, required by the issue: naming the loopback interface in
// prose is not a leak. It is how a reviewer is told the service is not public.
test('NEGATIVE CONTROL: `localhost` in prose passes', () => {
  const result = checkInternalRefs({
    ...CLEAN,
    prTitle: 'fix(service): bind the loopback interface only',
    prBody: [
      'The unit listened on every interface, so two instances on one host could collide.',
      '',
      'It now binds localhost, and the e2e service leg passes against it.',
      'The health probe reads the JSON body rather than the status code.',
    ].join('\n'),
    prBranch: 'fix/bind-loopback-only',
    commits: [{ commit: { message: 'fix(service): bind localhost and keep the port check' } }],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('NEGATIVE CONTROL: a loopback or private address as prose passes', () => {
  for (const body of [
    'The socket binds 127.0.0.1 before the port is published.',
    'A wildcard bind (0.0.0.0:3100) is the second half of the collision.',
    'Node picks an ephemeral port on 127.0.0.1, so the fixture cannot hardcode one.',
    'The upstream address 1.2.3.4 and the resolver 8.8.8.8 are public and stay.',
    '172.32.0.1 is outside RFC1918, and so is 192.169.0.1.',
  ]) {
    const result = checkInternalRefs({ ...CLEAN, prBody: body });
    assert.equal(result.passed, true, `expected pass for: ${body}\n${JSON.stringify(result.failures, null, 2)}`);
  }
});

test('NEGATIVE CONTROL: the diff is not scanned for addresses', () => {
  // This is the distinction the whole rule rests on. A test asserting a
  // service binds 127.0.0.1 is the code working, and a config fixture holding
  // a loopback baseURL is the subject matter, not a leak. Scoping the rule to
  // authored text is what keeps it from being born failing.
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'e2e/service-smoke/fixture.json',
      status: 'added',
      changes: 1,
      patch: '@@ -0,0 +1,1 @@\n+{"baseURL": "http://127.0.0.1:8099/v1"}\n',
    }],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

// The positive control the issue asks for, and the class it was written for:
// PR #22 on this fork carried a loopback baseURL in its body, copy-pasted out
// of a config, and it is exactly as permanent as a commit subject.
test('NEGATIVE CONTROL: a loopback URL in the body fails', () => {
  const result = checkInternalRefs({ ...CLEAN, prBody: 'Reproduce with `curl http://localhost:3000/api/health`.' });
  assert.equal(result.passed, false);
  const joined = result.failures.join('\n');
  assert.match(joined, /The PR description/);
  assert.match(joined, /scheme:\/\/<host>:<port>/, 'the failure must name the fix, or the author deletes the sentence instead');
});

test('every address class the issue names is caught in the body', () => {
  const cases = [
    ['http://localhost:3000/api/health', 'loopback by name'],
    ['http://127.0.0.1:8099/v1', 'loopback by address'],
    ['http://[::1]:3100/api/health', 'IPv6 loopback'],
    ['http://0.0.0.0:3100/api/health', 'wildcard bind, as a URL'],
    ['postgres://agent:hunter2@10.0.0.7:5432/paperclip', 'RFC1918 10/8, behind credentials'],
    ['ssh -p 2222 admin@192.168.1.20:22', 'RFC1918 192.168/16, as an ssh target'],
    ['http://172.16.0.9:8080', 'RFC1918 172.16/12, low end'],
    ['http://172.31.255.1:8080', 'RFC1918 172.16/12, high end'],
    ['tailscale ssh box.tail1234.ts.net', 'MagicDNS with no scheme'],
    ['http://100.101.102.103:3101', 'a tailnet node by its CGNAT address'],
    ['the gateway is at 192.168.1.20:8080', 'a bare authority, no scheme'],
  ];
  for (const [body, why] of cases) {
    const result = checkInternalRefs({ ...CLEAN, prBody: `Observed on the instance: ${body}` });
    assert.equal(result.passed, false, `expected failure (${why}) for: ${body}`);
  }
});

test('a bare private address with neither a scheme nor a port is not claimed', () => {
  // The boundary of the rule, stated as a test because a reviewer will ask.
  // `10.0.0.7` alone is indistinguishable from a version, a fixture id or a
  // doc cross-reference, and a matcher that reached for it would fire on
  // correct work. The port or the scheme is what makes it an address, and that
  // is the same reason `agent://` alone is not an issue link.
  for (const body of ['the fixture is 10.0.0.7 in the sample data', 'build 192.168.0.0 of the matrix']) {
    const result = checkInternalRefs({ ...CLEAN, prBody: body });
    assert.equal(result.passed, true, `expected pass for: ${body}\n${JSON.stringify(result.failures, null, 2)}`);
  }
});

test('a wildcard bind in prose is not a leak, but in a URL it is', () => {
  // The one asymmetry in the host list, and it is deliberate: a wildcard is a
  // socket description in one position and a target in the other.
  const prose = checkInternalRefs({ ...CLEAN, prBody: 'The unit has `ListenStream=0.0.0.0:3100`, which is the collision.' });
  assert.equal(prose.passed, true, JSON.stringify(prose.failures, null, 2));
  const url = checkInternalRefs({ ...CLEAN, prBody: 'Curl `http://0.0.0.0:3100/api/health` to reproduce.' });
  assert.equal(url.passed, false);
});

test('an address in the title, the branch or a commit subject each fail', () => {
  const title = checkInternalRefs({ ...CLEAN, prTitle: 'fix(api): the instance at http://10.1.2.3 answered 500' });
  assert.equal(title.passed, false);
  assert.match(title.failures.join('\n'), /The PR title/);

  // A branch naming the machine fails, and so would one carrying an authority.
  // A branch carrying only the bare interface name does not, and should not:
  // `fix/localhost-bind-only` describes the change accurately and leaks no
  // coordinate — the same boundary the prose surfaces hold to, because a name
  // is not a sentence either.
  const branch = checkInternalRefs({ ...CLEAN, prBranch: 'fix/box.tail1234.ts.net-reboot' });
  assert.equal(branch.passed, false);
  assert.match(branch.failures.join('\n'), /branch name/);

  const bareName = checkInternalRefs({ ...CLEAN, prBranch: 'fix/localhost-bind-only' });
  assert.equal(bareName.passed, true, JSON.stringify(bareName.failures, null, 2));

  // A port written with a hyphen is a description, not an authority: a hyphen is
  // how a branch name separates its words, so reading `-3000-` as a port would
  // mean matching most names that contain three digits.
  for (const name of ['fix/localhost-3000-bind', 'fix/10.0.0.7-8099-rebind']) {
    const hyphenPort = checkInternalRefs({ ...CLEAN, prBranch: name });
    assert.equal(hyphenPort.passed, true, `expected ${name} to pass: ${JSON.stringify(hyphenPort.failures)}`);
  }

  const subject = checkInternalRefs({
    ...CLEAN,
    commits: [{ commit: { message: 'fix(api): http://localhost:3101 returned 500 on boot\n\nbody' } }],
  });
  assert.equal(subject.passed, false);
  assert.match(subject.failures.join('\n'), /A commit subject/);
});

test('the address rule cannot fire on a branch authority, because git forbids one', () => {
  // Not a design choice — a property of refnames, and the reason the branch leg
  // of the address rule is quiet. `git check-ref-format` rejects `:`, `//` and
  // `@{`, which is every character an authority needs, so of the address shapes
  // the gate knows, a branch name can only carry a bare one. Relaxing the path
  // lookbehind for this surface would therefore buy nothing while reading as
  // though it did. Measured over the 84 branch names that have ever been a head
  // on this fork, the branch surface reported 16 findings and all 16 were
  // identifiers.
  for (const name of ['fix/localhost:3000', 'fix/http://localhost', 'fix/root@localhost:3000']) {
    assert.throws(
      () => execFileSync('git', ['check-ref-format', `refs/heads/${name}`], { stdio: 'pipe' }),
      `expected git to reject ${name} as a refname`,
    );
  }

  // The one address shape a branch can carry, it does catch.
  const tailnet = checkInternalRefs({ ...CLEAN, prBranch: 'fix/box.tail1234.ts.net-reboot' });
  assert.equal(tailnet.passed, false);
  assert.match(tailnet.failures.join('\n'), /branch name/);

  // A bare private address stays unclaimed, by the header's second exclusion.
  const bare = checkInternalRefs({ ...CLEAN, prBranch: 'fix/10.0.0.7-rebind' });
  assert.equal(bare.passed, true, JSON.stringify(bare.failures, null, 2));
});

test('a commit body is authored text, so both halves of the rule apply to it', () => {
  // The subject and the body are separate surfaces with separate remedies, so
  // they are reported separately and an id in both is two findings.
  const result = checkInternalRefs({
    ...CLEAN,
    commits: [
      { sha: 'aaa11111', commit: { message: 'fix(api): survive a restart\n\nCarries on from PET-9005 and the\nplan in /PET/issues/PET-9005.\n' } },
    ],
  });
  assert.equal(result.passed, false, JSON.stringify(result.failures, null, 2));
  const joined = result.failures.join('\n');
  assert.match(joined, /A commit message body carries/);
  assert.match(joined, /PET-9005/);
  // The subject was clean, so the subject surface must not be blamed.
  assert.doesNotMatch(joined, /A commit subject carries/);
  // And the remedy has to be the one that fits a body.
  assert.match(joined, /Edit the commit message/);
});

test('an address in a commit body is a leak too, and the body is not a diff line', () => {
  // The gate's own stated principle: "Authored text is where the address is a
  // leak; a diff line is where it is usually the subject matter." A commit
  // body is authored text, so the address half applies even though the same
  // string in a diff line is left alone.
  const result = checkInternalRefs({
    ...CLEAN,
    commits: [
      { sha: 'bbb22222', commit: { message: 'fix(api): survive a restart\n\nReached at http://localhost:3100/api/health\n' } },
    ],
  });
  assert.equal(result.passed, false, JSON.stringify(result.failures, null, 2));
  const joined = result.failures.join('\n');
  assert.match(joined, /A commit message body carries/);
  assert.match(joined, /localhost/);
});

test('the same string in a diff line is still left alone', () => {
  // The control for the test above: if this ever starts failing, the diff
  // surface has started reading like authored text, and the gate is born
  // failing on 664 files of correct code.
  const result = checkInternalRefs({
    ...CLEAN,
    files: [
      {
        filename: 'server/src/e2e/rebind.test.ts',
        changes: 2,
        patch: '@@ -1 +1 @@\n-await http.get("http://127.0.0.1:8099/v1")\n+await http.get(baseUrl)\n',
      },
    ],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('an id in the subject is one finding, not one per surface', () => {
  // The body scan uses `lines.slice(1)`, so a subject id is never re-reported
  // as a body id. An author who fixed the subject and got two paragraphs
  // learns to skip the gate.
  const result = checkInternalRefs({
    ...CLEAN,
    commits: [{ sha: 'ccc33333', commit: { message: 'fix(issues): a blocker edge (PET-9005)\n\nNo id down here.\n' } }],
  });
  assert.equal(result.passed, false, JSON.stringify(result.failures, null, 2));
  const joined = result.failures.join('\n');
  assert.match(joined, /A commit subject carries/);
  assert.doesNotMatch(joined, /A commit message body carries/);
  assert.equal((joined.match(/A commit (?:subject|message body) carries/g) ?? []).length, 1);
});

test('a commit message that is only a subject is not scanned twice', () => {
  const result = checkInternalRefs({
    ...CLEAN,
    commits: [{ sha: 'ddd44444', commit: { message: 'fix(api): survive a restart' } }],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('an unreadable commit list fails closed instead of reporting a clean scan', () => {
  // The commit fetch is allowed to fail so a transient 5xx cannot take down the
  // gates that block. That makes an empty list ambiguous, and the ambiguous
  // reading must not be the permissive one.
  const result = checkInternalRefs({ ...CLEAN, commits: [], commitsUnavailable: true });
  assert.equal(result.passed, false);
  const joined = result.failures.join('\n');
  assert.match(joined, /commit list could not be read/);
  assert.match(joined, /not a clean scan/);
  assert.match(joined, /Do not read `passed: true`/);
});

test('an empty commit list from a healthy fetch is not a failure', () => {
  // The counterpart, so the fail-closed leg cannot be satisfied by passing
  // `commitsUnavailable: true` on every call and disabling the surface.
  const result = checkInternalRefs({ ...CLEAN, commits: [] });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('an unavailable commit list still scans the surfaces it can read', () => {
  // Failing closed must not become failing blind: the title, body, branch and
  // diff are all still read, and a leak in one of them is still reported.
  const result = checkInternalRefs({
    ...CLEAN,
    prTitle: 'fix(issues): a blocker edge (PET-9005)',
    commits: [],
    commitsUnavailable: true,
  });
  assert.equal(result.passed, false);
  const joined = result.failures.join('\n');
  assert.match(joined, /The PR title carries `PET-9005`/);
  assert.match(joined, /commit list could not be read/);
});

test('the address rule reports the address, and one finding once per surface', () => {
  const result = checkInternalRefs({
    ...CLEAN,
    prBody: 'Try http://localhost:3101 then http://localhost:3101 again, or 10.0.0.1:5432.',
  });
  assert.equal(result.passed, false);
  const joined = result.failures.join('\n');
  assert.match(joined, /10\.0\.0\.1:5432/);
  assert.match(joined, /scheme:\/\/<host>:<port>/);
  assert.equal(result.failures.filter((f) => f.includes('an address that resolves to one machine')).length, 1);
});

test('findInstanceHosts is the whole rule, and it explains its own boundaries', () => {
  assert.deepEqual(findInstanceHosts('http://localhost:3101/api'), ['http://localhost']);
  assert.deepEqual(findInstanceHosts('reached at localhost:3101'), ['localhost:3101']);
  assert.deepEqual(findInstanceHosts('nothing here at all'), []);
  assert.deepEqual(findInstanceHosts(''), []);
  assert.deepEqual(findInstanceHosts(undefined), []);
  // A glob is documentation, not a hostname: `*.ts.net` is how the rule text
  // itself has to name the class, and it must not match itself.
  assert.deepEqual(findInstanceHosts('bans *.ts.net and <host>:<port> shapes'), []);
  // A longer public name that merely ends in a covered word is not a hit.
  assert.deepEqual(findInstanceHosts('see docs.example.com and 172.15.0.1'), []);
});


test('the self-exempt files carry no identifier outside the declared set', async () => {
  // Built from the default prefix list rather than hardcoded, so the floor
  // follows configuration. Only this instance's namespace is checked: the
  // canonical `PAP-`/`PAPA-` fixtures are inherited legitimately from the
  // product, which is the whole reason the default list is the instance prefix
  // alone. Both spellings the gate matches are covered, so the compact form
  // that a branch name actually uses is caught too.
  const escaped = DEFAULT_INTERNAL_REF_PREFIXES
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join('|');
  const shapes = [new RegExp(String.raw`\b(?:${escaped})-\d+\b`, 'gi'), new RegExp(String.raw`\b(?:${escaped})\d{2,}\b`, 'gi')];

  // Walks `SELF_EXEMPT_PATHS` rather than naming the two files, so the floor
  // follows the exemption list if it ever grows.
  for (const relPath of SELF_EXEMPT_PATHS) {
    const source = await readFile(new URL(`../../../${relPath}`, import.meta.url), 'utf8');
    const found = new Set(shapes.flatMap((re) => source.match(re) ?? []).map((id) => id.toUpperCase()));
    const undeclared = [...found].filter((id) => !DECLARED_FIXTURE_IDS.has(id));
    assert.deepEqual(
      undeclared,
      [],
      `${relPath} carries undeclared identifiers from this instance's namespace: ${undeclared.join(', ')}\n`
        + 'Declare a synthetic one in DECLARED_FIXTURE_IDS, or use a prefix the gate does not scan.',
    );
  }
});

test('a declared identifier may not be a number the instance could have issued', () => {
  // The half of the rule that membership cannot express. Without this, the
  // declared set is a permanent amnesty: a real id pasted in once would be
  // indistinguishable from a synthetic one on every future run, and the doc
  // comment asking for synthetic ids would be the only thing standing between
  // the next contributor and the pattern. Comparing the number against a floor
  // above the live range turns that comment into a control.
  const below = [...DECLARED_FIXTURE_IDS]
    .map((id) => [id, Number(id.replace(/^[A-Za-z]+-?/, ''))])
    .filter(([, n]) => !Number.isFinite(n) || n < MIN_SYNTHETIC_ID)
    .map(([id]) => id);
  assert.deepEqual(
    below,
    [],
    `declared identifiers at or below MIN_SYNTHETIC_ID (${MIN_SYNTHETIC_ID}) could be real: ${below.join(', ')}\n`
      + 'Pick a synthetic number above the floor instead.',
  );
});
