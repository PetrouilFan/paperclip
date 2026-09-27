import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTROLS, identifierFindings, scanCommit } from '../scan-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'scan-report.mjs');

/**
 * The finding reduction is the one piece of this script that can rot silently.
 *
 * The gate's report string ends in a remedy that quotes `{PREFIX}-{NUMBER}`,
 * `git rebase -i` and `reword` in backticks. A reduction that scans the whole
 * string collects those as identifiers, and the resulting table lists a commit
 * as carrying `reword`. So the reduction is pinned against real gate output
 * rather than a hand-written fixture that could drift from it.
 */
test('the reduction takes ids from the finding head and not from the remedy', () => {
  // Captured from checkInternalRefs itself, not transcribed by hand.
  const real = scanCommit({
    sha: '60f3a15a38abf0f557c907a85e0bf9ccacce33af',
    message: 'fix(ci): a subject\n\nThe body names PET-9001 and PET-9002 outright.\n',
  });
  const failures = real.filter((f) => f.startsWith('A commit message body'));
  assert.ok(failures.length > 0, 'expected the shipped gate to flag this body');

  const findings = identifierFindings(real);
  assert.deepEqual(findings.surface, 'body');
  assert.deepEqual(findings.ours, ['PET-9001', 'PET-9002']);
  for (const leak of ['{PREFIX}-{NUMBER}', 'git rebase -i', 'reword', 'CONTRIBUTING.md']) {
    assert.ok(
      !findings.ours.includes(leak) && !findings.foreign.includes(leak),
      `${leak} is remedy text and must not be reported as a carried identifier`
    );
  }
});

test('a foreign namespace is separated from this instance’s own by the gate’s own wording', () => {
  const real = scanCommit({
    sha: '0db8480b1',
    message: 'fix(SAG-2595): land a filter (#9050)\n\nbody with no configured-prefix identifier\n',
  });
  const findings = identifierFindings(real);
  assert.deepEqual(findings.ours, []);
  assert.deepEqual(findings.foreign, ['SAG-2595']);
  assert.equal(findings.surface, 'subject');
});

test('the compact spelling is read as this instance’s own, not as a foreign namespace', () => {
  // The extractor this replaces was `/^[A-Z][A-Z0-9]{1,9}-\d+$/`, which cannot
  // match `pet9002`. One of this instance's own ids was about to be filed as
  // foreign on the strength of that gap.
  const real = scanCommit({
    sha: '9e4b2e7b6',
    message: 'fix(ci): scan the compact form\n\nthis one carries pet9002 in the body\n',
  });
  const findings = identifierFindings(real);
  assert.deepEqual(findings.ours, ['pet9002']);
  assert.deepEqual(findings.foreign, []);
});

test('a commit the gate accepts produces no finding at all', () => {
  const findings = identifierFindings(
    scanCommit({
      sha: 'b5b96fd79',
      message: 'fix(ci): a clean subject\n\nA body that names no identifier of any namespace.\n',
    })
  );
  assert.deepEqual(findings.ours, []);
  assert.deepEqual(findings.foreign, []);
});

/**
 * The property the whole script exists to protect: a run that reads "no
 * findings" because a leg never executed must not be able to print a report.
 *
 * The stub gate below is the shape of the mistake this issue was filed from —
 * commits handed to `checkInternalRefs` as `{sha, message}` instead of
 * `{sha, commit: {message}}`, so it reads nothing and finds nothing. A script
 * without a control reports a clean tree in that case, which is indistinguishable
 * from the truth. So the control is run against a gate that is guaranteed to be
 * blind, and the script has to refuse.
 */
test('a gate that cannot see a commit body aborts the run instead of reporting zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-report-'));
  try {
    cpSync(SCRIPT, join(dir, 'scan-report.mjs'));
    // A gate that returns a clean result for everything, and exports the two
    // names scan-report.mjs imports so the import itself resolves.
    writeFileSync(
      join(dir, 'check-pr-internal-refs.mjs'),
      [
        "export const DEFAULT_INTERNAL_REF_PREFIXES = ['PET'];",
        'export function checkInternalRefs() { return { passed: true, failures: [] }; }',
        '',
      ].join('\n')
    );

    const result = spawnSync(process.execPath, [join(dir, 'scan-report.mjs'), 'HEAD'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /POSITIVE CONTROL DEAD/);
    assert.equal(
      result.stdout.trim(),
      '',
      'a dead control must produce no report, because the report would be describing a scan that did not happen'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each control leg is separately proven live by the gate it ships against', () => {
  // One per leg, because they fail for different reasons: a subject-only
  // control passes even when the body leg is the one that went blind.
  assert.equal(CONTROLS.length, 2);
  for (const control of CONTROLS) {
    const findings = identifierFindings(scanCommit(control));
    assert.ok(
      findings.ours.includes('PET-9001'),
      `the ${control.label} control did not fire against the shipped gate, so it cannot detect that leg going blind`
    );
  }
});

test('the script is committed where the report tells a reader to run it', () => {
  // The published evidence report quotes a command with no repository-relative
  // path. A reader who pastes it gets "module not found" and concludes the
  // measurement is not reproducible.
  const source = readFileSync(SCRIPT, 'utf8');
  assert.match(source, /node \.github\/scripts\/scan-report\.mjs origin\/master/);
  // Unused import guard: execFileSync is used by readCommits.
  assert.match(source, /execFileSync\('git'/);
  assert.ok(execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim());
});
