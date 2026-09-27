import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  ALLOWLIST,
  DEFAULT_INTERNAL_REF_PREFIXES,
  DEFAULT_PRODUCT_OWNED_PREFIXES,
  MAX_PR_COMMENTS,
  MAX_PR_FILES,
  MAX_SCANNED_FILE_BYTES,
  SELF_EXEMPT_PATHS,
  checkInternalRefs,
  filesNeedingWholeContent,
  findInstanceHosts,
  findUnknownInternalRefs,
  isContentExempt,
  isGateComment,
  maskInlineCodeSpans,
  patchIsComplete,
  redactMatches,
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
  'PET-9006',
  'PET9006',
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

/**
 * Assert the report never reproduces what it matched, and hand back the joined
 * findings so the caller can go on asserting about them.
 *
 * This is the assertion whose absence let the amplification loop ship: the
 * suite checked *that* a rule fired and, where it went further, checked that the
 * finding named the identifier — so the one behaviour that had to be wrong was
 * the one behaviour the tests pinned. Every site that used to assert a literal
 * in the output now asserts its absence through here, and the property test
 * further down runs it over all seven surfaces at once.
 *
 * @param {{passed: boolean, failures: string[]}} result
 * @param {string[]} secrets  every string the run was expected to match
 * @returns {string} the joined findings
 */
const assertNoEcho = (result, secrets) => {
  const joined = result.failures.join('\n');
  for (const secret of secrets) {
    assert.equal(
      joined.includes(secret),
      false,
      `the finding reproduces "${secret}" verbatim, so posting it makes it a new finding:\n${joined}`
    );
  }
  return joined;
};

test('the clean PR passes', () => {
  const result = checkInternalRefs(CLEAN);
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
  assert.deepEqual(result.failures, []);
});

test('NEGATIVE CONTROL: an id in the PR title fails the gate', () => {
  const result = checkInternalRefs({ ...CLEAN, prTitle: throwawayTitle });
  assert.equal(result.passed, false);
  const joined = assertNoEcho(result, ['PET-9000']);
  assert.match(joined, /The PR title/);
  // The count replaces the enumeration: the author needs to know how many to go
  // and find, not which, because naming which is what made this a new finding.
  assert.match(joined, /carries 1 internal issue identifier/);
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
  // The surface label quotes the branch name it is naming, so the branch name is
  // itself a leak site and not only the identifier list is masked.
  assertNoEcho(result, ['pet9002']);
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
  // The `↳ found in` preview is a slice of the added line, and that slice is
  // where the identifier usually sits, so the preview is masked and the file
  // name still identifies the line to open.
  const joined = assertNoEcho(result, ['pet9002']);
  assert.match(joined, /listening-port-owner\.test\.ts/);
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
  // The route is the matched text: `findAll(..., link)` returns the whole
  // `/PET/issues/PET-9002` span, and an enumeration of it would have put the
  // route back into the very comment the finding is about.
  const joined = assertNoEcho(result, ['/PET/issues/PET-9002', 'PET-9002']);
  assert.match(joined, /The PR description/);
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

// ---------------------------------------------------------------------------
// The second reader.
//
// The case below is the one that made this necessary, measured rather than
// imagined: a drizzle migration snapshot added by `pnpm db:generate` is ~1.3 MB
// and ~48k changed lines, GitHub returns `patch: null` for a file that size, and
// `AGENTS.md` section 6 makes that file the normal outcome of a data-model
// change. The gate's answer was "this gate cannot certify this diff" — true, and
// identical for every correct schema change, which is how a correct gate earns a
// reputation for being wrong.
//
// These tests pin the three properties that make the fix a read rather than an
// exemption. If any of them is dropped, one of these fails.
// ---------------------------------------------------------------------------

/** The reported shape, so the fixture is not a hand-written approximation of it. */
const snapshot = (...lines) =>
  ['{', '  "version": "7",', '  "dialect": "postgresql",', '  "tables": {', ...lines, '  }', '}'].join('\n');

test('a generated file with no patch is scanned whole, not refused', () => {
  const clean = snapshot('    "t": { "columns": {} }');
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'packages/db/src/migrations/meta/0286_snapshot.json',
      status: 'added',
      changes: 48503,
      additions: 48503,
      deletions: 0,
      patch: null,
    }],
    fileContents: { 'packages/db/src/migrations/meta/0286_snapshot.json': clean },
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
  assert.deepEqual(result.wholeFileScans, ['packages/db/src/migrations/meta/0286_snapshot.json']);
});

test('the whole-file read is a scan, not an exemption: an id in a snapshot still fails', () => {
  // The reason this is a reader and not a shape proof. A proof that the file
  // parses as a drizzle snapshot says the file is machine-generated; it does not
  // look inside, and it cannot be made to. The reader looks, so a hand-typed
  // identifier in a generated file is caught rather than argued about.
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'packages/db/src/migrations/meta/0286_snapshot.json',
      status: 'added',
      changes: 48503,
      patch: null,
    }],
    fileContents: {
      'packages/db/src/migrations/meta/0286_snapshot.json': snapshot('    "note": "see PET-9001"'),
    },
  });
  assert.equal(result.passed, false);
  const joined = assertNoEcho(result, ['PET-9001']);
  assert.match(joined, /The diff/);
  // The location has to say the line came from the published file, or the author
  // goes looking for a line the diff never showed them.
  assert.match(joined, /whole file, the patch was not delivered/);
});

test('the whole-file read scans every line, not only the ones the change added', () => {
  // A whole file cannot say which lines this pull request added. Counting the
  // whole of it is the direction that reports, which is the same direction the
  // fail-closed rule commits to everywhere else in this gate.
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'packages/db/src/migrations/meta/0286_snapshot.json',
      status: 'added',
      changes: 48503,
      patch: null,
    }],
    fileContents: {
      'packages/db/src/migrations/meta/0286_snapshot.json': [
        'context line that is unchanged and carries PET-9002',
        '  "tables": {}',
      ].join('\n'),
    },
  });
  assert.equal(result.passed, false);
  assertNoEcho(result, ['PET-9002']);
});

test('FAIL CLOSED: the second reader missing leaves the file unscannable', () => {
  // The property that keeps this from being a hole. The supplementary fetch is
  // allowed to fail, so an unavailable fetch must land exactly where the gate
  // was before it existed — never on a pass.
  const withoutContent = checkInternalRefs({
    ...CLEAN,
    files: [{
      filename: 'packages/db/src/migrations/meta/0286_snapshot.json',
      status: 'added',
      changes: 48503,
      patch: null,
    }],
  });
  assert.equal(withoutContent.passed, false);
  assert.match(withoutContent.failures.join('\n'), /without readable patch content/);
  assert.deepEqual(withoutContent.wholeFileScans, []);

  // Same verdict for every shape of "the read did not arrive", so a caller
  // cannot pass a placeholder and read it as coverage.
  for (const [label, fileContents] of [
    ['empty string', { 'packages/db/src/migrations/meta/0286_snapshot.json': '' }],
    ['wrong type', { 'packages/db/src/migrations/meta/0286_snapshot.json': 42 }],
    ['null', { 'packages/db/src/migrations/meta/0286_snapshot.json': null }],
    ['a different path', { 'some/other/file.json': snapshot() }],
  ]) {
    const result = checkInternalRefs({
      ...CLEAN,
      files: [{
        filename: 'packages/db/src/migrations/meta/0286_snapshot.json',
        status: 'added',
        changes: 48503,
        patch: null,
      }],
      fileContents,
    });
    assert.equal(result.passed, false, `expected failure for ${label}`);
  }
});

test('FAIL CLOSED: a file above the whole-file cap is refused rather than sampled', () => {
  const oversize = 'x'.repeat(MAX_SCANNED_FILE_BYTES + 1);
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{ filename: 'fixtures/huge.txt', status: 'modified', changes: 10, patch: null }],
    fileContents: { 'fixtures/huge.txt': oversize },
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.wholeFileScans, []);
  // The number is in the message, so an author who hits it can tell a real
  // limit from a mysterious red.
  assert.match(result.failures.join('\n'), new RegExp(String(MAX_SCANNED_FILE_BYTES)));
});

/**
 * One NUL, written as an escape so this file stays text.
 *
 * It is a real character and not the two characters `\` and `0`, because the
 * implementation's guard is `content.includes('\u0000')` and a fixture holding
 * a spelled-out escape would not exercise it at all. It is a constant rather
 * than an inline escape for the same reason the file is checked for stray NULs
 * elsewhere: a literal one in a source file is invisible in review and breaks
 * every tool that reads the file as text.
 */
const NUL = '\u0000';

test('FAIL CLOSED: a payload carrying a NUL is not scanned as text', () => {
  // The contents endpoint answers base64 for a path GitHub considers binary.
  // Scanning that as UTF-8 would either raise mid-gate or report a finding about
  // base64 that means nothing.
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{ filename: 'ui/public/logo.png', status: 'modified', changes: 8, patch: null }],
    fileContents: { 'ui/public/logo.png': `PNG${NUL.repeat(4)}${'A'.repeat(32)}` },
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.wholeFileScans, []);
});

test('NO REGRESSION: a file with a readable patch is not read whole, and its verdict is unchanged', () => {
  // The bound on the whole change. The fallback runs only where the gate would
  // otherwise have refused a file, so every patch-bearing file keeps the
  // patch-only, added-lines-only answer it gave before — including the case
  // where a whole-file read would have *found* something and thereby changed a
  // pass into a failure.
  const files = [{ filename: 'server/src/routes/issues.ts', status: 'modified', changes: 2, patch: '@@ -1,1 +1,2 @@\n a\n+b\n' }];
  const fileContents = { 'server/src/routes/issues.ts': 'PET-9003 lives on line 1 of this file\n' };

  const plain = checkInternalRefs({ ...CLEAN, files });
  const withContent = checkInternalRefs({ ...CLEAN, files, fileContents });

  assert.equal(plain.passed, true, JSON.stringify(plain.failures, null, 2));
  assert.equal(withContent.passed, true, JSON.stringify(withContent.failures, null, 2));
  assert.deepEqual(withContent.wholeFileScans, []);
  assert.deepEqual(withContent.failures, plain.failures);
});

test('a truncated patch is covered by the whole file when one arrives', () => {
  const truncated = '@@ -10,2 +10,4 @@\n context\n+added one\n+added two\n';
  const filename = 'server/src/routes/issues.ts';
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{ filename, status: 'modified', changes: 900, patch: truncated }],
    fileContents: { [filename]: 'line one\nline two\nline three\nline four\n' },
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
  assert.deepEqual(result.wholeFileScans, [filename]);
});

test('a truncated patch is still read for what arrived, alongside the whole file', () => {
  // The patch is the start of the change, so an id inside the delivered part is
  // a finding whether or not the rest could be read.
  const truncated = '@@ -10,2 +10,4 @@\n context\n+see PET-9004 for the shape\n+added two\n';
  const filename = 'server/src/routes/issues.ts';
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{ filename, status: 'modified', changes: 900, patch: truncated }],
    fileContents: { [filename]: 'line one\nline two\n' },
  });
  assert.equal(result.passed, false);
  assertNoEcho(result, ['PET-9004']);
});

test('a deleted file is never asked to be read whole', () => {
  // There is no content at the head commit for a path the pull request removes,
  // so a fetch for one can only come back empty, and a removal carries no added
  // lines to scan.
  assert.deepEqual(
    filesNeedingWholeContent([
      { filename: 'doc/removed.md', status: 'removed', changes: 40, patch: null },
      { filename: 'doc/kept.md', status: 'modified', changes: 40, patch: null },
    ]),
    ['doc/kept.md']
  );
});

test('filesNeedingWholeContent asks for exactly the files the gate cannot read', () => {
  // If this predicate drifts from the loop's, the fetch silently stops covering
  // the file the gate is about to refuse. It is asserted against the gate's own
  // behaviour rather than against a second copy of the rule.
  const cases = [
    [{ filename: 'a.txt', status: 'modified', changes: 4, patch: null }, true],
    [{ filename: 'b.txt', status: 'modified', changes: 0, patch: null }, false],
    [{ filename: 'c.txt', status: 'modified', changes: 2, patch: '@@ -1,1 +1,2 @@\n a\n+b\n' }, false],
    [{ filename: 'd.txt', status: 'modified', changes: 2, patch: '@@ -1,2 +1,4 @@\n a\n+b\n' }, true],
    [{ filename: 'e.txt', status: 'renamed', changes: 7, previous_filename: 'f.txt', patch: null }, true],
  ];
  for (const [file, expected] of cases) {
    assert.deepEqual(
      filesNeedingWholeContent([file]).length,
      expected ? 1 : 0,
      `mismatch for ${file.filename} status=${file.status}`
    );
    // Same answer, asked the other way: does the gate actually refuse it?
    const result = checkInternalRefs({ ...CLEAN, files: [file] });
    assert.equal(
      result.passed,
      !expected,
      `${file.filename}: the predicate and the gate disagree about whether it is readable`
    );
  }
  // A malformed entry is skipped rather than becoming a fetch for `(unnamed)`.
  assert.deepEqual(filesNeedingWholeContent([{ status: 'modified', changes: 4, patch: null }]), []);
  assert.deepEqual(filesNeedingWholeContent(undefined), []);
});

test('the gate names the file it read whole in the run log, not only in a finding', () => {
  // The audit trail for a review: a file the gate admits it could not see as a
  // diff has to be discoverable without a finding existing.
  const filename = 'packages/db/src/migrations/meta/0286_snapshot.json';
  const result = checkInternalRefs({
    ...CLEAN,
    files: [{ filename, status: 'added', changes: 48503, patch: null }],
    fileContents: { [filename]: snapshot() },
  });
  assert.deepEqual(result.wholeFileScans, [filename]);
});

test('the reported case, at its reported size: a 1.3 MB snapshot is read, not refused', () => {
  // The reproduction, at the scale it was reported. A drizzle migration snapshot
  // on this fork is 1,380,194 bytes across 48,491 lines; the number is measured,
  // not rounded, because "it is a big file" is exactly the claim that would be
  // comfortable to hand-wave and the one that decides whether the whole-file read
  // is viable in a gate's time budget.
  //
  // The snapshot's own filename changes with every migration, so this builds the
  // bytes rather than reading one out of the tree — a fixture pinned to
  // `0284_snapshot.json` would stop existing the day 0285 landed and the test
  // would quietly stop testing the case it exists for.
  const column = '        "created_at": { "name": "created_at", "type": "timestamp", "notNull": true }';
  const lines = ['{', '  "version": "7",', '  "dialect": "postgresql",', '  "tables": {'];
  let bytes = lines.reduce((n, l) => n + l.length + 1, 0);
  let i = 0;
  while (bytes < 1_380_000) {
    const line = `    "public.table_${i}": { "columns": { ${column} } },`;
    lines.push(line);
    bytes += line.length + 1;
    i += 1;
  }
  lines.push('  }', '}');
  const content = lines.join('\n');
  const filename = 'packages/db/src/migrations/meta/9000_snapshot.json';
  const files = [{ filename, status: 'added', changes: 48503, additions: 48503, deletions: 0, patch: null }];

  // Before the second reader existed, this is the verdict: true, and useless.
  const refused = checkInternalRefs({ ...CLEAN, files });
  assert.equal(refused.passed, false);
  assert.match(refused.failures.join('\n'), /without readable patch content/);

  const read = checkInternalRefs({ ...CLEAN, files, fileContents: { [filename]: content } });
  assert.equal(read.passed, true, JSON.stringify(read.failures, null, 2));
  assert.deepEqual(read.wholeFileScans, [filename]);

  // The same bytes, with an identifier in one of the 20k generated lines, and it
  // is found. This is the difference between reading the file and proving what
  // shape it has: a shape proof has nothing to say about line 19,994.
  const tampered = content.replace('"public.table_7": ', '"public.table_7": "see PET-9005", ');
  assert.notEqual(tampered, content, 'the tamper must land on a real line');
  const caught = checkInternalRefs({ ...CLEAN, files, fileContents: { [filename]: tampered } });
  assert.equal(caught.passed, false);
  assertNoEcho(caught, ['PET-9005']);
});

test('a content-exempt file is never fetched whole', () => {
  // Found by running the shipped gate against this pull request's own diff: the
  // compare payload reports `patch: null` for this test file, because it is
  // 113,621 bytes. The gate exempts it, so it never looks inside — and a fetch
  // list that ignored the exemption spent an API request and a 113 KB transfer
  // on bytes the run then discarded. On a repository where the largest file in
  // every pull request that edits this gate would be read and thrown away.
  const exempt = '.github/scripts/tests/check-pr-internal-refs.test.mjs';
  assert.equal(filesNeedingWholeContent([
    { filename: exempt, status: 'modified', changes: 309, patch: null },
  ]).length, 0);

  // And the predicate the loop uses to skip the content is the same one.
  assert.equal(isContentExempt(exempt), true);
  assert.equal(isContentExempt('CONTRIBUTING.md'), true);
  assert.equal(isContentExempt('packages/db/src/migrations/meta/0286_snapshot.json'), false);
});

test('the allowlist exempts a path only when it carries a reason', () => {
  // A reason-less ALLOWLIST entry is reported as a failure, so it must go on
  // exempting nothing. Reading the array instead of the reduced map would make a
  // malformed entry quietly restore an exemption, which is the one thing the
  // mandatory-reason rule exists to prevent — and it would be invisible, because
  // the entry is still reported.
  const allowed = new Map([['doc/rule.md', 'quotes the banned shapes']]);
  assert.equal(isContentExempt('doc/rule.md', allowed), true);
  assert.equal(isContentExempt('doc/rule.md', new Map()), false);

  // The shipped ALLOWLIST agrees with the shipped exemption, entry for entry.
  for (const entry of ALLOWLIST) {
    const hasBoth = Boolean(entry?.path && entry?.reason);
    assert.equal(
      isContentExempt(entry.path),
      hasBoth,
      `${entry.path} is in ALLOWLIST but exempts ${hasBoth ? 'nothing' : 'the file'}`
    );
  }
  for (const path of SELF_EXEMPT_PATHS) {
    assert.equal(isContentExempt(path), true, `${path} is self-exempt but does not exempt`);
  }
});

test('the clean-PR result shape is unchanged for a caller that only reads passed and failures', () => {
  // The orchestrator consumes `.passed` and `.failures` and nothing else; the
  // added field must not disturb that, and the two early-return paths must carry
  // it too so a caller never has to guard for its absence.
  assert.deepEqual(Object.keys(checkInternalRefs(CLEAN)).sort(), ['failures', 'passed', 'wholeFileScans']);
  for (const bad of ['', ',,']) {
    const result = checkInternalRefs({ ...CLEAN, prefixes: bad.split(',') });
    assert.equal(result.passed, false);
    assert.deepEqual(result.wholeFileScans, []);
  }
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
  const joined = assertNoEcho(result, ['TASK-482']);
  assert.match(joined, /The PR description/);
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
  assertNoEcho(past, ['TASK-482']);
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
  const joined = assertNoEcho(past, ['TASK-482']);
  assert.match(joined, /A commit message body/);
  // The short sha is the locator that survives redaction: it is not the matched
  // text, and it is what a maintainer pastes into `git show`.
  assert.match(joined, /a1b2c3d4/);
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
  const joined = assertNoEcho(oneOf, ['PET-9004']);
  assert.match(joined, /bbbbbbbb/);
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
    assertNoEcho(result, ['TASK-482']);
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
  const joined = assertNoEcho(separated, ['TASK-482']);
  assert.match(joined, /branch name/);

  // ...and the cost of that choice, stated rather than hidden: a standards-named
  // branch does fail. The remedy is a rename, which costs nothing before the
  // branch is pushed and nothing after.
  const standards = checkInternalRefs({ ...CLEAN, prBranch: 'fix/UTF-8-normalization' });
  assert.equal(standards.passed, false);
  // On this surface the branch name *is* the match, so masking it costs
  // nothing: the gate comment is attached to the pull request, whose head
  // branch is one click away and is the only thing a reader needs to rename.
  const standardsJoined = assertNoEcho(standards, ['UTF-8']);
  assert.match(standardsJoined, /branch name/);

  // The product's own namespace stays exempt on this surface too.
  const product = checkInternalRefs({ ...CLEAN, prBranch: 'fix/PAP-1-child-mention' });
  assert.equal(product.passed, true, JSON.stringify(product.failures, null, 2));
});

test('a commit body quotes an identifier shape in a code span, and that is not a reference', () => {
  // The measurement this came from: the open tier's path rule fired on six
  // commit bodies across the 4678 commits on master, and two of the six were
  // commits whose subject matter IS the shape, written as a code span. A body
  // is the one authored surface where quoting a token is the whole point, and
  // a 3-of-6 false-positive rate on a tier is the rate at which a gate gets
  // switched off. Both of the two are named here as they appear in history.
  for (const body of [
    // bc0a076e — the commit is the rule about the token.
    'That renderer auto-links any `IDENT-123`-shaped token to an internal\n`/issues/IDENT-123` link',
    // d6bee62f — the commit is the bug report about the route.
    '`/api/issues/PC1897-1` skipped identifier lookup and fell through as a',
  ]) {
    const result = checkInternalRefs({ ...CLEAN, commits: [{ commit: { message: `fix: x\n\n${body}` } }] });
    assert.equal(result.passed, true, `expected a quoted shape to pass: ${JSON.stringify(result.failures)}`);
  }
});

test('NEGATIVE CONTROL: masking a quoted shape does not become a general escape hatch', () => {
  // Each of these is a path or an id a reader could act on, so each has to keep
  // failing. The exemption is one rule on one surface, and a change that reads
  // as "code spans are exempt" instead of "a quoted *path shape* is not a
  // reference" is the change that would have quietly opened this gate.
  const mustFail = [
    // The configured half is not masked at all: this instance's own id is a
    // finding in a code span, in a path, in a link, in any spelling.
    ['the instance id in a code span', 'the value is `PET-9003`'],
    ['the instance id in a path', 'POST /api/issues/PET-9003/checkout returned 409'],
    // A fenced block is a runnable artifact, so a path inside one is pasteable
    // and stays a finding. Backtick and tilde fences alike.
    ['a curl in a backtick fence', 'fix: x\n\n```\nPOST /api/issues/TASK-482/checkout\n```'],
    ['a curl in a tilde fence', 'fix: x\n\n~~~\nPOST /api/issues/TASK-482/checkout\n~~~'],
    // The other two open-tier rules read the unmasked text, so a verb or a `#`
    // inside a code span is still a reference.
    ['a verb inside a code span', 'the body says `Closes TASK-482` verbatim'],
    ['a hash inside a code span', 'the body says `#TASK-482` verbatim'],
    // An unterminated backtick is not a span, so nothing is masked and the path
    // is read. Treating it as a span would make "forgot the closing backtick"
    // a way to hide a reference.
    ['an unterminated backtick', '`/api/issues/TASK-482 and the quote never closes'],
    // Only the span's *interior* is masked. An id between two spans is outside
    // both, and a masker that ran to the end of the line would lose it.
    ['an id between two spans', '`a` then /api/issues/TASK-482 then `b`'],
    // A link destination is a path the commit points at, not one it quotes.
    ['a link destination', 'see [TASK-482](/issues/TASK-482)'],
  ];
  for (const [label, body] of mustFail) {
    const result = checkInternalRefs({ ...CLEAN, commits: [{ commit: { message: `fix: x\n\n${body}` } }] });
    assert.equal(result.passed, false, `expected ${label} to fail`);
  }
});

test('the three real leaks the quoted-shape rule was measured against all still fail', () => {
  // A narrowing that drops false positives by dropping coverage is not a fix.
  // These are the three bodies that the same replay showed to be genuine, and
  // each exercises a different rule: a Markdown link destination, and two verb
  // positions that the masking never touched.
  //
  // The assertion is that each is still caught and that no finding echoes the
  // identifier. `result.passed === false` is the coverage half; the echo check is
  // what keeps the finding safe to post as a comment, which is the whole point
  // of redacting it.
  const mustFail = [
    ['5320a440', 'Paperclip work item: [ZOL-5477](/ZOL/issues/ZOL-5477).'],
    ['bb6e7215', 'Closes RUS-56'],
    ['f6f5fee2', 'Fixes: LAS-101'],
  ];
  for (const [sha, body] of mustFail) {
    const result = checkInternalRefs({ ...CLEAN, commits: [{ sha, commit: { message: `fix: x\n\n${body}` } }] });
    assert.equal(result.passed, false, `expected ${sha} to still fail: ${JSON.stringify(result.failures)}`);
    const joined = assertNoEcho(result, ['ZOL-5477', 'RUS-56', 'LAS-101']);
    assert.match(joined, /A commit message body refers to 1 issue identifier/);
  }
});

test('the fourth body, kept deliberately, and the cost of keeping it', () => {
  // af0e05f3 names the path in running prose with no code span around it, and
  // it still fails. That is the intended boundary rather than an oversight: a
  // bare path in prose is a path a reader could paste, and the remedy for it is
  // to genericise the id (`/JAR/issues/<id>`), which is the same fix the gate
  // asks for everywhere else. One commit in 4678 is a different proposition
  // from the three in six that the masking removes.
  const result = checkInternalRefs({
    ...CLEAN,
    commits: [{ commit: { message: 'fix: x\n\nAfter onboarding the wizard navigated to the newly created issue\n(e.g. /JAR/issues/JAR-1). useCompanyPageMemory then saved this path,' } }],
  });
  assert.equal(result.passed, false);
  const joined = assertNoEcho(result, ['JAR-1']);
  assert.match(joined, /A commit message body refers to 1 issue identifier/);
});

test('only the commit body masks: every other authored surface still reads a quoted path', () => {
  // A pull request title, description and comment are not documents whose topic
  // is a URL shape, so the exemption stops at the one surface it was measured
  // on. A body-only rule that leaked onto the other three would have cost
  // coverage on 736 files' worth of ordinary prose for no measured reason.
  const quoted = 'the renderer emits a `/issues/TASK-482` link';
  const bodies = [
    ['title', { prTitle: quoted }],
    ['description', { prBody: quoted }],
    ['comment', { comments: [{ body: quoted, kind: 'issue', user: { login: 'someone' } }] }],
  ];
  for (const [surface, override] of bodies) {
    const result = checkInternalRefs({ ...CLEAN, ...override });
    assert.equal(result.passed, false, `expected the ${surface} surface to still fail`);
    const joined = assertNoEcho(result, ['TASK-482']);
    assert.match(joined, /refers to 1 issue identifier/);
  }
});

test('maskInlineCodeSpans preserves length and line breaks, and leaves fences alone', () => {
  // The masker is a filter over the same string, not a rewrite: a length or
  // offset change would move every capture the other two rules make on the same
  // text, which is a much harder failure to see than a wrong finding.
  const cases = [
    'plain `code` text',
    '`a` and `b`',
    '``double `inner` double``',
    'unterminated `code',
    '```\nfenced `code`\n```',
    '~~~\nfenced `code`\n~~~',
    'no backticks at all',
    '',
  ];
  for (const input of cases) {
    const masked = maskInlineCodeSpans(input);
    assert.equal(masked.length, input.length, `length changed for ${JSON.stringify(input)}`);
    assert.equal(
      (masked.match(/\n/g) || []).length,
      (input.match(/\n/g) || []).length,
      `line count changed for ${JSON.stringify(input)}`,
    );
  }

  // The fence interior survives verbatim, including its backticks.
  const fenced = maskInlineCodeSpans('```\nPOST /api/issues/TASK-482/x\n```');
  assert.match(fenced, /TASK-482/);
  // ...and an inline span's interior does not.
  assert.doesNotMatch(maskInlineCodeSpans('a `/issues/TASK-482` b'), /TASK-482/);
  assert.equal(maskInlineCodeSpans('a `/issues/TASK-482` b').length, 'a `/issues/TASK-482` b'.length);
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
  const joined = assertNoEcho(result, ['PET-9005']);
  assert.match(joined, /A commit message body carries/);
  // The subject was clean, so the subject surface must not be blamed.
  assert.doesNotMatch(joined, /A commit subject carries/);
  // And the remedy has to be the one that fits a body.
  assert.match(joined, /Edit the commit message/);
});

test('an address in a commit body is the change being described, so the body is not scanned for one', () => {
  // The commit *is* the address. `b83e14ad` is "stop the readiness probe from
  // stealing the guest exposure port" and its body is the `127.0.0.1:42000`
  // that collided; the remedy this gate would ask for — write the endpoint as a
  // shape — deletes the sentence that makes the commit worth having. Measured
  // over the 4670 commits on `master`, the address half flags 31 bodies and
  // every one is that case.
  const result = checkInternalRefs({
    ...CLEAN,
    commits: [
      { sha: 'bbb22222', commit: { message: 'fix(api): survive a restart\n\nReached at http://localhost:3100/api/health\n' } },
    ],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('the identifier half still reads a commit body, so narrowing the address half did not take the surface with it', () => {
  // The narrowing is the *half*, not the surface. A body that names an internal
  // id is a finding, and if this ever passes the identifier half has silently
  // inherited the address half's exemption.
  const result = checkInternalRefs({
    ...CLEAN,
    commits: [
      { sha: 'ccc33333', commit: { message: 'fix(api): survive a restart\n\nCarries on from PET-9001.\n' } },
    ],
  });
  assert.equal(result.passed, false, JSON.stringify(result.failures, null, 2));
  const joined = assertNoEcho(result, ['PET-9001']);
  assert.match(joined, /A commit message body carries/);
});

test('the address half stays off the commit body, and masking the body is not what put it there', () => {
  // Two independent decisions meet on this one loop, and this test is the
  // boundary between them.
  //
  // `60f3a15a3` removed `findInstanceHosts` from the commit body on its own
  // reasoning, recorded in that commit: the address half flags 31 bodies over
  // the commits on `master` and all 31 are a commit whose subject matter is the
  // address. Separately, `e03b8e508` added `maskInlineCodeSpans` and passed
  // `{ maskInlineCode: true }` to the *identifier* half's call on the same
  // loop, so a quoted shape in a body is not a reference.
  //
  // Those are different halves of one rule, and a later reader must not be able
  // to conclude that the masking is what stopped the address half. The
  // assertion below is the address half's; stripping the mask leaves it green,
  // and re-adding `findInstanceHosts` reds it. Non-vacuity by mutation.
  const result = checkInternalRefs({
    ...CLEAN,
    commits: [
      { sha: 'ddd44444', commit: { message: 'fix(api): survive a restart\n\nReached at http://localhost:3100/api/health\n' } },
    ],
  });
  assert.equal(result.passed, true, 'the address half must not reach the commit body');
  const joined = result.failures.join('\n');
  assert.doesNotMatch(joined, /an address that resolves to one machine/);
  assert.doesNotMatch(joined, /localhost/);
});

test('masking the commit body does not mask the identifier half, so a declared id in a code span is still a finding', () => {
  // The exemption is the open-shape tier's *path* rule and nothing else. If the
  // mask ever reached the configured tier, a commit body could name this
  // instance's own identifiers freely, which is a real leak and not a
  // judgement call — so this has to fail loudly rather than drift.
  //
  // Paired with the test above: the mask must not switch the address half off,
  // and it must not switch the configured half off either. The body is masked
  // for one tier only, and the other two tiers are untouched.
  const result = checkInternalRefs({
    ...CLEAN,
    commits: [
      { sha: 'eee55555', commit: { message: 'fix(api): survive a restart\n\nCarries on from `PET-9001` in the handoff.\n' } },
    ],
  });
  assert.equal(result.passed, false, 'a declared identifier in a code span is still a finding');
  // The finding must not print what it matched. A report that quoted the
  // literal would be a comment carrying the reference, so the next run finds
  // it and the pull request stays red. The mask is asserted below as well, so a
  // finding that matched nothing and printed nothing cannot pass this vacuously.
  const joined = assertNoEcho(result, ['PET-9001']);
  assert.match(joined, /A commit message body carries/);
  assert.match(joined, /███████/, 'the mask is visible in the report, so it is a mask and not a deletion');
});

test('narrowing the commit body did not take the address coverage off the other three surfaces', () => {
  // The regression this change could plausibly introduce, and the one worth a
  // test: the same address in a title, a description and a commit subject must
  // all still fail. A body exemption implemented by dropping the surface rather
  // than the half would pass the test above and quietly pass these three.
  const address = 'http://localhost:3100/api/health';

  const title = checkInternalRefs({ ...CLEAN, prTitle: `fix(api): ${address} returned 500` });
  assert.equal(title.passed, false, 'the PR title must still carry the address half');
  assert.match(title.failures.join('\n'), /instance-local address/);

  const description = checkInternalRefs({ ...CLEAN, prBody: `Reproduce with curl ${address}.` });
  assert.equal(description.passed, false, 'the PR description must still carry the address half');
  assert.match(description.failures.join('\n'), /instance-local address/);

  const subject = checkInternalRefs({
    ...CLEAN,
    commits: [{ sha: 'ddd44444', commit: { message: `fix(api): ${address} returned 500 on boot` } }],
  });
  assert.equal(subject.passed, false, 'a commit subject must still carry the address half');
  assert.match(subject.failures.join('\n'), /A commit subject carries/);
  assert.match(subject.failures.join('\n'), /instance-local address/);
});

test('a squash-merge subject is the PR title, so the string that becomes permanent history keeps the address half', () => {
  // The coverage argument for exempting only the body. Under a squash merge the
  // commit subject *is* the PR title, so a title that carries an address is
  // covered on the surface it was written on and the surface it lands on. If
  // this ever fails, the text that becomes permanent has lost its check.
  const title = 'fix(api): http://localhost:3100/api/health returned 500 on boot';
  const titleScan = checkInternalRefs({ ...CLEAN, prTitle: title });
  const squashed = checkInternalRefs({
    ...CLEAN,
    commits: [{ sha: 'eee55555', commit: { message: title } }],
  });
  assert.equal(titleScan.passed, false);
  assert.equal(squashed.passed, false);
  assert.match(squashed.failures.join('\n'), /A commit subject carries/);
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

// --- The comment surface ----------------------------------------------------
//
// A comment is the seventh surface `CONTRIBUTING.md` names and the one the gate
// did not read. The header's section "Pull request comments: the seventh
// surface" carries the measurement — 131 findings across 367 comments on the
// 100 most recently updated pull requests, 125 of them written by the pull
// request's own author — and the controls below are the shape the existing five
// surfaces already use: the leak fails, the same string somewhere it belongs
// still passes, and each way the surface can go unread fails rather than passes.

const CLEAN_COMMENT = {
  kind: 'issue comment',
  user: { login: 'an-author' },
  html_url: 'https://github.com/o/r/pull/1#issuecomment-1',
  body: 'Confirmed on a clean checkout: the rebase drops the second hunk.',
};

test('a clean comment passes', () => {
  const result = checkInternalRefs({ ...CLEAN, comments: [CLEAN_COMMENT] });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('an id in a pull request comment fails the gate', () => {
  const result = checkInternalRefs({
    ...CLEAN,
    comments: [{ ...CLEAN_COMMENT, body: 'Carried on from PET-9006 — see the plan in /PET/issues/PET-9006.' }],
  });
  assert.equal(result.passed, false, JSON.stringify(result.failures, null, 2));
  const joined = assertNoEcho(result, ['PET-9006']);
  assert.match(joined, /A pull request comment carries/);
});

test('an address in a comment is a leak, and a comment is not a diff line', () => {
  // The same pair the commit-body surface has: the string fails in authored
  // text, and the control below proves the diff surface is untouched.
  const result = checkInternalRefs({
    ...CLEAN,
    comments: [{ ...CLEAN_COMMENT, body: 'Reproduced at http://localhost:3100/api/health' }],
  });
  assert.equal(result.passed, false, JSON.stringify(result.failures, null, 2));
  const joined = assertNoEcho(result, ['http://localhost']);
  assert.match(joined, /A pull request comment carries 1 instance-local address/);
});

test('a comment that names the loopback interface is not a leak; one that links to it is', () => {
  // The control for the test above, and it is the same split the body surface
  // makes: prose that merely names `127.0.0.1` is somebody explaining the e2e
  // harness, and a URL pointing at it is a coordinate a reviewer on github.com
  // cannot route to. The same string in a diff line stays left alone entirely,
  // which the control after this one holds.
  const result = checkInternalRefs({
    ...CLEAN,
    comments: [{ ...CLEAN_COMMENT, body: 'The e2e harness reaches this fixture over 127.0.0.1 by design.' }],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('the same string in a diff line is still left alone', () => {
  // If this ever starts failing, the comment surface has started reading like a
  // diff and the gate is born failing on 664 files of correct code.
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

test('an unconfigured namespace in a comment is reported by the open matcher', () => {
  // The second tier has to reach the comment surface too, or a `TASK-482`
  // pasted into a reply walks straight through the one surface nobody reads.
  const result = checkInternalRefs({
    ...CLEAN,
    comments: [{ ...CLEAN_COMMENT, body: 'Same shape as the one in /issues/TASK-482.' }],
  });
  assert.equal(result.passed, false, JSON.stringify(result.failures, null, 2));
  const joined = assertNoEcho(result, ['TASK-482']);
  assert.match(joined, /A pull request comment refers to 1 issue identifier/);
});

test('prose that names a shape is still not a reference, in a comment either', () => {
  // The reference-position requirement is what keeps the open matcher from
  // claiming every model name in a long review thread. Dropping it on this
  // surface would be the difference between a gate and noise.
  const result = checkInternalRefs({
    ...CLEAN,
    comments: [{ ...CLEAN_COMMENT, body: 'Re-ran the Model Used section; GPT-5 and PROJ-123 are both expected here.' }],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('the finding names the comment, its author and its link', () => {
  // The remedy is "edit that comment", so the finding has to identify which one
  // and — for the measured 6-in-131 case where the author cannot edit it — who
  // wrote it. A pooled finding with one location does neither.
  const result = checkInternalRefs({
    ...CLEAN,
    comments: [
      { ...CLEAN_COMMENT, body: 'Nothing here.' },
      { ...CLEAN_COMMENT, kind: 'review body', user: { login: 'a-reviewer' }, body: 'Blocked on PET-9006.' },
    ],
  });
  assert.equal(result.passed, false, JSON.stringify(result.failures, null, 2));
  const joined = result.failures.join('\n');
  assert.match(joined, /a review body by a-reviewer/);
  assert.match(joined, /https:\/\/github\.com\/o\/r\/pull\/1#issuecomment-1/);
  // And the report has to warn about the reflex that re-creates the finding.
  assert.match(joined, /Do not reply about the leak/);
  assert.match(joined, /you cannot edit it/);
});

test('one leaking comment is one finding, not one per surface', () => {
  // All three matchers see the same string, and the author gets one thing to
  // fix rather than three paragraphs about one comment.
  const result = checkInternalRefs({
    ...CLEAN,
    comments: [{ ...CLEAN_COMMENT, body: 'Blocked on PET-9006 and on http://localhost:3100.' }],
  });
  assert.equal(result.passed, false, JSON.stringify(result.failures, null, 2));
  const joined = result.failures.join('\n');
  assert.equal((joined.match(/A pull request comment carries/g) ?? []).length, 2);
  // The unconfigured-namespace report must not re-report the configured id.
  assert.doesNotMatch(joined, /refers to `PET-9006`/);
});

test("the gate's own report is not read as content", () => {
  // The loop this surface would otherwise have. The gate's report quotes the
  // literals it found, so a gate that read its own report would fail on its own
  // output on the next run — with a finding the author cannot act on, because
  // the author did not write it.
  const ownReport = [
    'Hey @author! Before this PR can be reviewed, a few things need attention:',
    '',
    '**Missing or incomplete:**',
    '- [ ] A pull request comment carries `PET-9006` — internal issue identifier.',
    '',
    'Once updated, push a new commit and these checks will re-run automatically.',
    '',
    'Gates ran 2026-09-27T00:00:00Z from gate revision `abc123456`.',
    '',
    '— commitperclip',
  ].join('\n');

  const result = checkInternalRefs({
    ...CLEAN,
    comments: [{ kind: 'issue comment', user: { login: 'commitperclip[bot]' }, body: ownReport }],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));

  // The same body, one login over. The agents whose comments produced 6 of the
  // 131 findings post under a bot login, so the pair — same bytes, different
  // author — is the whole argument for the exemption existing in this form.
  const asAgent = checkInternalRefs({
    ...CLEAN,
    comments: [{ kind: 'issue comment', user: { login: 'github-actions[bot]' }, body: ownReport }],
  });
  assert.equal(asAgent.passed, false, 'the same report text is content when it is not the gate\'s own');
  assert.match(asAgent.failures.join('\n'), /A pull request comment carries/);
});

test('the exemption needs the signature as well as the login', () => {
  // The pair that makes the exemption load-bearing rather than convenient. A
  // bot login alone would exempt an agent's own review comment — and on this
  // repository those arrive under a bot login, which is exactly the case the
  // signature half exists for. The signature alone is something a human can
  // type, so it cannot be the whole test either.
  const leaking = 'Blocked on PET-9006.';

  const both = checkInternalRefs({
    ...CLEAN,
    comments: [{ kind: 'issue comment', user: { login: 'commitperclip[bot]' }, body: `${leaking}\n\n— commitperclip` }],
  });
  assert.equal(both.passed, true, `bot login plus signature is the gate's own report: ${JSON.stringify(both.failures)}`);

  const loginOnly = checkInternalRefs({
    ...CLEAN,
    comments: [{ kind: 'issue comment', user: { login: 'commitperclip[bot]' }, body: leaking }],
  });
  assert.equal(loginOnly.passed, false, 'a bot login alone does not exempt a comment');

  const signatureOnly = checkInternalRefs({
    ...CLEAN,
    comments: [{ kind: 'issue comment', user: { login: 'a-human' }, body: `${leaking}\n\n— commitperclip` }],
  });
  assert.equal(signatureOnly.passed, false, 'the signature alone does not exempt a comment');
});

test('an agent comment under the workflow login is not mistaken for the gate report', () => {
  // The measured case, and the reason the signature half is not redundant: on
  // this repository the agents' own review comments reach the API as
  // `github-actions[bot]`, six of them carrying findings in the population the
  // header measures. Without the signature half, exempting by login would have
  // silently discarded the six findings that were not the gate's own.
  const leaking = 'Held on PET-9006 until the rebase lands.';

  const asAgent = checkInternalRefs({
    ...CLEAN,
    comments: [{ kind: 'issue comment', user: { login: 'github-actions[bot]' }, body: leaking }],
  });
  assert.equal(asAgent.passed, false, 'an agent comment is content');

  const agentQuotingTheSignature = checkInternalRefs({
    ...CLEAN,
    commentLogins: ['github-actions[bot]'],
    comments: [{ kind: 'issue comment', user: { login: 'github-actions[bot]' }, body: leaking }],
  });
  assert.equal(agentQuotingTheSignature.passed, false, 'and it is content without the signature, even once the login is named');
});

test("the gate's own report is exempt under the deployment's commenter login", () => {
  // A repository that posts as a login neither default list names still gets the
  // exemption, because the predicate follows the identity the orchestrator
  // already uses rather than duplicating it.
  const own = 'Blocked on PET-9006.\n\n— commitperclip';
  const asDefault = checkInternalRefs({ ...CLEAN, comments: [{ user: { login: 'custom-app[bot]' }, body: own }] });
  assert.equal(asDefault.passed, false, 'not exempt until the deployment names the login');

  const asDeployment = checkInternalRefs({
    ...CLEAN,
    commentLogins: ['custom-app[bot]'],
    comments: [{ user: { login: 'custom-app[bot]' }, body: own }],
  });
  assert.equal(asDeployment.passed, true, JSON.stringify(asDeployment.failures, null, 2));
});

test('an unreadable comment list fails closed instead of reporting a clean scan', () => {
  // The comment fetch is allowed to fail so a transient 5xx cannot take down the
  // gates that block. That makes an empty list ambiguous, and this is the
  // surface where the permissive reading would cost the most.
  const result = checkInternalRefs({ ...CLEAN, comments: [], commentsUnavailable: true });
  assert.equal(result.passed, false);
  const joined = result.failures.join('\n');
  assert.match(joined, /comment list could not be read/);
  assert.match(joined, /not a clean scan/);
  assert.match(joined, /Do not read `passed: true`/);
});

test('an empty comment list from a healthy fetch is not a failure', () => {
  // The counterpart, so the fail-closed leg cannot be satisfied by passing
  // `commentsUnavailable: true` on every call and disabling the surface. Two of
  // the 100 pull requests in the measured population genuinely have no comments.
  const result = checkInternalRefs({ ...CLEAN, comments: [] });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('an unavailable comment list still scans the surfaces it can read', () => {
  // Failing closed must not become failing blind.
  const result = checkInternalRefs({
    ...CLEAN,
    prTitle: 'fix(issues): a blocker edge (PET-9006)',
    comments: [],
    commentsUnavailable: true,
  });
  assert.equal(result.passed, false);
  const joined = assertNoEcho(result, ['PET-9006']);
  assert.match(joined, /The PR title carries 1 internal issue identifier/);
  assert.match(joined, /comment list could not be read/);
});

test('a comment list past the cap fails closed rather than scanning a prefix', () => {
  // The same principle as the 3000-file cap, on the surface that now has the
  // most findings on it: a truncated read is not a clean read.
  const result = checkInternalRefs({
    ...CLEAN,
    comments: Array.from({ length: MAX_PR_COMMENTS }, (_, i) => ({ ...CLEAN_COMMENT, body: `note ${i}` })),
  });
  assert.equal(result.passed, false);
  const joined = result.failures.join('\n');
  assert.match(joined, new RegExp(`${MAX_PR_COMMENTS}-comment cap`));
  assert.match(joined, /not fully scanned|rather than a clean result/);
});

test('an empty comment body is not a comment', () => {
  // `/pulls/{n}/reviews` returns a row per review event and an approval carries
  // no text; the fetcher filters those, and the gate does not have to.
  const result = checkInternalRefs({
    ...CLEAN,
    comments: [{ ...CLEAN_COMMENT, body: '   ' }, { ...CLEAN_COMMENT, body: null }, { ...CLEAN_COMMENT }],
  });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
});

test('isGateComment is a predicate on identity, and it is total', () => {
  // Exported, so it is part of the module's surface and gets a direct control
  // rather than only being exercised through the scan. The last four cases are
  // the ones a malformed payload produces, and every one of them has to read as
  // "not the gate's own" — the permissive answer there is an exemption nobody
  // granted.
  assert.equal(isGateComment({ user: { login: 'commitperclip[bot]' }, body: 'x\n— commitperclip' }), true);
  assert.equal(isGateComment({ user: { login: 'commitperclip' }, body: 'x\n— commitperclip' }), true);
  assert.equal(isGateComment({ user: { login: 'commitperclip[bot]' }, body: 'x' }), false, 'no signature');
  assert.equal(isGateComment({ user: { login: 'someone' }, body: 'x\n— commitperclip' }), false, 'wrong login');
  assert.equal(isGateComment({ user: { login: 'someone' }, body: 'x', }, ['someone']), false, 'no signature even when named');
  assert.equal(isGateComment(null), false);
  assert.equal(isGateComment(undefined), false);
  assert.equal(isGateComment({}), false);
  assert.equal(isGateComment({ user: {}, body: 'x\n— commitperclip' }), false);
  assert.equal(isGateComment({ user: { login: 'commitperclip[bot]' } }), false, 'no body');
  assert.equal(isGateComment({ user: { login: 'commitperclip[bot]' }, body: 42 }), false, 'body is not a string');
  assert.equal(isGateComment({ user: { login: '' }, body: 'x\n— commitperclip' }), false, 'blank login');
  // A non-string in the deployment list must not make every comment exempt.
  assert.equal(isGateComment({ user: { login: 'someone' }, body: 'x\n— commitperclip' }, [null, undefined, '']), false, 'a junk deployment list exempts nothing');
});

test('the comment surface did not cost the diff surface its exemption', () => {
  // `SELF_EXEMPT_PATHS` has to stay closed through this change. A comment has
  // no path, so the exclusion is an identity, and the two files the gate and
  // its test live in must still be the only paths the diff scan skips.
  assert.deepEqual(SELF_EXEMPT_PATHS, [
    '.github/scripts/check-pr-internal-refs.mjs',
    '.github/scripts/tests/check-pr-internal-refs.test.mjs',
  ]);
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
  const joined = assertNoEcho(result, ['PET-9005']);
  assert.match(joined, /The PR title carries 1 internal issue identifier/);
  assert.match(joined, /commit list could not be read/);
});

test('the address rule reports how many addresses, and one finding once per surface', () => {
  const result = checkInternalRefs({
    ...CLEAN,
    prBody: 'Try http://localhost:3101 then http://localhost:3101 again, or 10.0.0.1:5432.',
  });
  assert.equal(result.passed, false);
  // The address half was the same amplification loop as the identifier half: an
  // `http://localhost` in the remediation is a comment carrying the address, so
  // the count replaces the enumeration here too. Two distinct addresses, not one
  // finding per occurrence.
  const joined = assertNoEcho(result, ['http://localhost', '10.0.0.1:5432']);
  assert.match(joined, /carries 2 instance-local addresses/);
  assert.match(joined, /scheme:\/\/<host>:<port>/);
  assert.equal(result.failures.filter((f) => f.includes('addresses that resolve to one machine')).length, 1);
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

test('PROPERTY: no finding on any surface may contain the text it matched', () => {
  // The invariant, over every surface at once rather than as a case per rule.
  //
  // The suite above already checks that each rule fires. What it did not check
  // — for three release cycles — is that the finding is safe to post, and the
  // two are different properties. A finding that quotes its own match is a new
  // comment carrying the reference, so the next gate run finds it and posts
  // again: the comment surface is scanned *and written*, which makes the gate
  // its own worst finding and pins the gate red on any pull request it has ever
  // fired on. Measured on pull request 131 across four runs, the matched-string
  // count went 3, 4, 6, 8 while an author cleaning their own comments never
  // moved it.
  //
  // One case per surface is not enough on its own, because a leak is a property
  // of a *reporting site*, and a new site appears whenever a report starts
  // interpolating something — the branch-name surface quotes the branch name,
  // which is not an identifier and so is invisible to a per-rule eyeball. So:
  // one payload per surface, each carrying a distinct declared synthetic id, and
  // every finding string checked against every id.
  const surfaces = [
    ['the PR title', { prTitle: 'fix(issues): a blocker edge (PET-9000)' }, ['PET-9000']],
    ['the PR description', { prBody: 'Carries on from PET-9001 step 2.' }, ['PET-9001']],
    ['the branch name', { prBranch: 'fix/pet9002-blocker-edge' }, ['pet9002']],
    [
      'a commit subject',
      { commits: [{ sha: 'd0d0d0d0', commit: { message: 'fix(issues): a one-way door (PET-9003)' } }] },
      ['PET-9003'],
    ],
    [
      'a commit body',
      { commits: [{ sha: 'e0e0e0e0', commit: { message: 'fix(issues): a one-way door\n\nCarried on from PET-9004.' } }] },
      ['PET-9004'],
    ],
    [
      'a pull request comment',
      { comments: [{ ...CLEAN_COMMENT, body: 'Same shape as the one in /issues/PET-9005.' }] },
      ['PET-9005'],
    ],
    [
      'the diff',
      {
        files: [{
          filename: 'server/src/__tests__/pet9006-blocker-edge.test.ts',
          status: 'modified',
          changes: 1,
          patch: '@@ -1,1 +1,2 @@\n a\n+// (PET-9006 step 2), the edge this suite is about.\n',
        }],
      },
      ['PET-9006', 'pet9006'],
    ],
  ];

  for (const [name, payload, secrets] of surfaces) {
    const result = checkInternalRefs({ ...CLEAN, ...payload });
    assert.equal(result.passed, false, `expected a finding on ${name}`);
    assertNoEcho(result, secrets);
  }

  // The control that keeps the property from passing vacuously: a gate that
  // matched nothing and printed nothing satisfies "no finding contains its
  // match" trivially. Every surface above asserted `passed === false`, and this
  // asserts the mask is actually *in* the output, so a redaction that silently
  // deleted the whole finding would fail here rather than pass.
  //
  // The comment surface is the one that proves the mask is doing work rather
  // than that the count merely replaced an enumeration. The title finding has
  // no locator line, so it would satisfy this control with the mask absent.
  const masked = checkInternalRefs({
    ...CLEAN,
    comments: [{ ...CLEAN_COMMENT, body: 'Same shape as the one in /issues/PET-9005.' }],
  });
  assert.match(masked.failures.join('\n'), /███████/, 'the mask is visible in the report, so it is a mask and not a deletion');
});

test('redaction preserves length, so a preview still lines up with the comment', () => {
  // The reason the mask is a run of same-width characters and not `[REDACTED]`:
  // the `↳ found in` line quotes a 72-character slice of the offending comment
  // and is the only thing that tells a maintainer where inside it the match is.
  // A fixed-width marker shorter than the match it replaced would shift every
  // character after the match, so the preview would stop lining up and the
  // locator would become a lie — strictly worse than the leak for anyone
  // actually debugging one.
  const body = `Carried on from PET-9005 — the comment is deliberately padded past the seventy-two character preview window so the match sits early and the tail is what would shift.`;
  const result = checkInternalRefs({ ...CLEAN, comments: [{ ...CLEAN_COMMENT, body }] });
  assert.equal(result.passed, false, JSON.stringify(result.failures, null, 2));
  const joined = assertNoEcho(result, ['PET-9005']);

  const preview = joined.split('\n').find((f) => f.includes('found in'));
  assert.ok(preview, `expected a locator line in:\n${joined}`);

  // The quoted body slice is 72 characters, whitespace-collapsed. Redaction
  // changes none of that: the masked preview is the same length as the slice it
  // replaced, so the same characters sit under the same columns.
  const quoted = body.trim().slice(0, 72).replace(/\s+/g, ' ');
  const open = preview.indexOf(': "') + 3;
  const shown = preview.slice(open, preview.lastIndexOf('"'));
  assert.equal(shown.length, quoted.length, `preview drifted: ${shown.length} vs ${quoted.length}`);
  // Same columns, not just the same count. Stated without pinning the mask
  // glyph, because the glyph is an implementation choice and the property is
  // not: the run that replaced the match is the *only* difference between the
  // preview and the comment slice it quotes, and it is exactly as long as what
  // it replaced. A fixed-width `[REDACTED]` marker fails this on both counts,
  // which is why the mask is a run of the match's own width.
  const at = [...quoted].findIndex((ch, i) => shown[i] !== ch);
  assert.notEqual(at, -1, 'expected the match to be replaced, not copied through');
  assert.equal(shown.slice(0, at), quoted.slice(0, at), 'the preview matches the slice up to the first redacted character');
  const runEnd = [...shown].findIndex((ch, i) => i >= at && ch === quoted[i]);
  assert.ok(runEnd > at, 'expected a redacted run, and the slice to resume after it');
  assert.equal(
    shown.slice(runEnd),
    quoted.slice(runEnd),
    'the preview must resume at the same offset, so a maintainer can line it up with the comment'
  );
  assert.equal(
    shown.slice(at, runEnd).length,
    quoted.slice(at, runEnd).length,
    'the mask is exactly as wide as the match it replaced'
  );
});

test('redactMatches masks nested hits, is length preserving, and is total', () => {
  // The three properties the report layer depends on, tested directly rather
  // than only through a finding, because a report-level test cannot reach a
  // branch that only fires for an unconfigured prefix or for a nested hit.
  const out = redactMatches('seen TASK-1 and TASK-12 and http://localhost:3101', [
    'TASK-1',
    'TASK-12',
    'http://localhost',
    '',
    null,
  ]);
  assert.equal(out.includes('TASK-1'), false, 'the short hit is masked');
  assert.equal(out.includes('TASK-12'), false, 'the long hit is masked');
  assert.equal(out.includes('http://localhost'), false, 'the address is masked');
  // Longest first, so masking the short hit does not leave a stray `2` behind.
  assert.equal(out.includes('2 and'), false, 'no character of a nested hit survives: ' + JSON.stringify(out));
  assert.equal(out.length, 'seen TASK-1 and TASK-12 and http://localhost:3101'.length, 'length is preserved');

  // Total, because it runs over whatever a fetch returned and `undefined` must
  // not turn a finding into a thrown gate.
  assert.equal(redactMatches(undefined, ['TASK-1']), undefined);
  assert.equal(redactMatches('', ['TASK-1']), '');
  assert.equal(redactMatches('nothing matched', []), 'nothing matched');
  assert.equal(redactMatches('nothing matched', undefined), 'nothing matched');
});

/**
 * The comment URLs a report blames, in order, taken from the `↳ found in` lines.
 *
 * The offender count is the number the loop moved, and the report is the only
 * place it is observable — the gate returns prose, not a structured offender
 * list. One line per blamed comment, so a report that blamed two comments on
 * one surface is counted twice and cannot quietly pass as one.
 */
function reportLocators(failures) {
  return failures
    .filter((f) => f.includes('found in'))
    .map((f) => (f.match(/\((https?:\/\/[^)]+)\)/) ?? [])[1] ?? f.trim());
}

test('CONVERGES: posting the finding does not create a new finding', () => {
  // The loop, closed and asserted as arithmetic rather than as a shape.
  //
  // This gate reads pull request comments and writes its findings onto pull
  // request comments. While the finding quoted what it matched, the remediation
  // was itself a comment carrying the reference, so each run added an offender
  // and removed none: the offender set grew 3, 4, 6, 8 across four measured
  // runs on pull request 131, and the gate could never return to green. This
  // simulates the whole cycle — run the gate, post what it said, run it again —
  // and asserts the count is a fixed point rather than a fixed number.
  const author = { kind: 'issue comment', user: { login: 'an-author' }, html_url: 'https://github.com/o/r/pull/1#issuecomment-1' };
  const comments = [{ ...author, body: 'Same shape as the one in /issues/PET-9005.' }];
  const runOnce = (list) => checkInternalRefs({ ...CLEAN, comments: list }).failures;

  const first = runOnce(comments);
  // The control: the seeded comment really is a finding, so an empty second run
  // is convergence and not a gate that stopped looking. Asserted as a non-empty
  // report rather than as one naming the identifier — the report not naming it
  // is the whole change, and the assertion below depends on this one holding.
  assert.ok(first.length > 0, 'the control: the seeded comment is a real finding');
  assertNoEcho({ passed: false, failures: first }, ['PET-9005']);

  // Post the report the way the *fallback* path does, which is the one that
  // actually loops on this fork: `COMMITPERCLIP_KEY` is absent here, so the
  // workflow runs under `GITHUB_TOKEN`, the comment is attributed to
  // `github-actions[bot]`, and `isGateComment` does not recognise it. So the
  // report is scanned as an ordinary comment — which is why masking it is the
  // fix and the self-exemption is not. Modelled with no gate signature and a
  // login outside `GATE_COMMENT_LOGINS`, so the test would pass only if the
  // report is genuinely clean.
  const fallback = (body, i) => ({
    kind: 'issue comment',
    user: { login: 'github-actions[bot]' },
    html_url: `https://github.com/o/r/pull/1#issuecomment-${100 + i}`,
    body,
  });

  // Run the gate, post what it said, run it again.
  //
  // The seeded comment stays in the thread, so the honest property is not "the
  // gate goes quiet" — it is that the offender count is a *fixed point*. One
  // hand-written offender remains one hand-written offender however many times
  // the gate runs, and no remediation comment ever joins it. That is the whole
  // difference: the measured failure grew 3, 4, 6, 8 across four runs.
  const offendersOf = (list) => reportLocators(runOnce(list));

  let previous = offendersOf([...comments]);
  assert.deepEqual(
    previous,
    [author.html_url],
    'the control: exactly the seeded comment is an offender, once'
  );

  for (let i = 1; i <= 4; i++) {
    const posted = first.map((body, k) => fallback(body, i * 10 + k));
    const now = offendersOf([...comments, ...posted]);
    assert.deepEqual(
      now,
      previous,
      `run ${i + 1} changed the offender set, so posting the report re-armed the gate:\n${now.join(', ')}`
    );
  }
});

