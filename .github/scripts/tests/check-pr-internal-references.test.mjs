import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkInternalReferences,
  findInstanceIds,
  findInstanceLinks,
  auditTicketShapedReferences,
  DEFAULT_INSTANCE_ISSUE_PREFIXES,
} from '../check-pr-internal-references.mjs';

const BODY = `
## What happened

The recovery sweeper re-mints a fresh action id every 30s, so the block is a
self-renewing lease rather than a hold anyone can clear.

## Steps to reproduce

1. Let the sweeper run
2. Watch the block re-apply

## Deployment mode

Single instance
`;

/** A PR that would pass every other gate, so these tests isolate this one. */
function cleanPr(overrides = {}) {
  return {
    prTitle: 'fix(issues): a blocker edge must not be a one-way door',
    prBody: BODY,
    branch: 'fix/blocker-edge-one-way-door',
    commits: [
      { sha: 'abc1234', commit: { message: 'fix(issues): a blocker edge is not a one-way door\n\nbody' } },
    ],
    files: [
      {
        filename: 'server/src/services/issues.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n+  const ok = true;',
      },
    ],
    ...overrides,
  };
}

test('a clean PR passes with no failures', () => {
  const result = checkInternalReferences(cleanPr());
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('the default prefix list is the two this instance mints', () => {
  assert.deepEqual(DEFAULT_INSTANCE_ISSUE_PREFIXES, ['PET', 'PAPA']);
});

test('an instance id in the PR title fails, as the landed PET-392 subject did', () => {
  const result = checkInternalReferences(
    cleanPr({ prTitle: 'fix(issues): a blocker edge must not be a one-way door (PET-392)' })
  );
  assert.equal(result.passed, false);
  assert.match(result.failures[0], /PET-392/);
  assert.match(result.failures[0], /PR title/);
});

test('an instance id in a commit subject fails even when the PR title is clean', () => {
  const result = checkInternalReferences(
    cleanPr({
      commits: [
        { sha: 'deadbee', commit: { message: 'fix(issues): a blocker edge is not a one-way door (PET-392)' } },
      ],
    })
  );
  assert.equal(result.passed, false);
  assert.match(result.failures[0], /PET-392/);
  assert.match(result.failures[0], /commit deadbee/);
});

test('a squash subject is the PR title, so both surfaces are reported', () => {
  const result = checkInternalReferences(
    cleanPr({
      prTitle: 'fix(issues): a blocker edge is not a one-way door (PET-392)',
      commits: [
        { sha: 'feed001', commit: { message: 'fix(issues): a blocker edge is not a one-way door (PET-392) (#62)' } },
      ],
    })
  );
  assert.equal(result.passed, false);
  assert.equal(result.failures.length, 2, 'title and commit subject are separate surfaces');
});

test('an instance id in the body fails', () => {
  const result = checkInternalReferences(
    cleanPr({ prBody: `${BODY}\nSee [PET-334](/Paperclip/issues/PET-334) for the regression test.\n` })
  );
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /PET-334/.test(f)));
});

test('an instance id added in a diff comment fails, including in a test file', () => {
  const result = checkInternalReferences(
    cleanPr({
      files: [
        {
          filename: 'cli/src/__tests__/process-identity.test.ts',
          status: 'modified',
          patch: '@@ -370,2 +370,3 @@\n+  // worktree checkout (the directory PAPA-358 reported as nuked).\n   const dir = tmp();',
        },
      ],
    })
  );
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /PAPA-358/.test(f) && /process-identity\.test\.ts/.test(f)));
});

test('an instance id in a workflow sentinel string fails — the PET-259 case', () => {
  const result = checkInternalReferences(
    cleanPr({
      files: [
        {
          filename: '.github/workflows/e2e-service-leg.yml',
          status: 'modified',
          patch: '+            Description=Planted paperclipai.service sentinel (PET-259)',
        },
      ],
    })
  );
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /PET-259/.test(f)));
});

test('a removed line is not the PR result, so it is not reported', () => {
  const result = checkInternalReferences(
    cleanPr({
      files: [
        {
          filename: 'server/src/routes/issues.ts',
          status: 'modified',
          patch: '@@ -1,2 +0,0 @@\n-// tracked as PET-255\n+// the refactor below',
        },
      ],
    })
  );
  assert.equal(result.passed, true);
});

test('the rule documents and the gate itself are exempt from the diff scan', () => {
  const result = checkInternalReferences(
    cleanPr({
      files: [
        { filename: 'CONTRIBUTING.md', status: 'modified', patch: '@@ -1 +1 @@\n+- `PAPA-123`, `PAP-224`' },
        { filename: '.github/PULL_REQUEST_TEMPLATE.md', status: 'modified', patch: '@@ -1 +1 @@\n+  ids like PAPA-123' },
        {
          filename: '.github/scripts/check-pr-internal-references.mjs',
          status: 'modified',
          patch: '@@ -1 +1 @@\n+// PET-392 is the worked example',
        },
      ],
    })
  );
  assert.equal(result.passed, true);
});

test('a public tracker id passes everywhere, including on a branch', () => {
  const result = checkInternalReferences(
    cleanPr({
      prBody: `${BODY}\nMirrors the public issue PAP-759 discussion.\n`,
      branch: 'fix/pap759-clarify-limits',
    })
  );
  assert.equal(result.passed, true);
});

test('a branch name carrying an instance id fails — the Branch Naming section', () => {
  // The exact branch the finding reported: lowercased, and with the separator
  // gone, so a rule that required an uppercase hyphenated id would miss it.
  const result = checkInternalReferences(
    cleanPr({ branch: 'fix/pet392-blocker-edge-one-way-door' })
  );
  assert.equal(result.passed, false);
  // Reported as authored, so the author can grep their own branch for it.
  assert.match(result.failures[0], /pet392/);
  assert.doesNotMatch(result.failures[0], /pet-392/);
  assert.match(result.failures[0], /Branch Naming/);
  assert.match(result.failures[0], /git branch -m/, 'the message carries the rename snippet');
});

test("CONTRIBUTING's own branch-name example shape is caught", () => {
  const result = checkInternalReferences(cleanPr({ branch: 'PAPA-42-why-did-this-break' }));
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /PAPA-42/.test(f)));
});

test('a kebab-case branch with no instance id passes', () => {
  for (const branch of ['fix/sandbox-secret-resolution', 'fix/react18-support', 'feat/next14-migration']) {
    assert.equal(checkInternalReferences(cleanPr({ branch })).passed, true, branch);
  }
});

test('a longer token is not split into an instance id', () => {
  assert.deepEqual(findInstanceIds('SNAP-PET-1 and fooPET-1', { instanceIssuePrefixes: 'PET' }), []);
});

test('a longer number is not split', () => {
  assert.deepEqual(findInstanceIds('PET-12345678', { instanceIssuePrefixes: 'PET' }), []);
});

test('a prefix match is case-insensitive but exact — no substring prefix', () => {
  const hits = findInstanceIds('pet392 and PAPA-358 and PET334', { instanceIssuePrefixes: 'PET' });
  assert.deepEqual(hits.map(h => h.id), ['pet392', 'PET334']);
});

test('the same id repeated on several lines is reported once', () => {
  const hits = findInstanceIds('PAPA-349 says\nnothing new\nbut PAPA-349 again', {
    instanceIssuePrefixes: 'PAPA',
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'PAPA-349');
  assert.equal(hits[0].lineNumber, 1);
});

test('a fork declares its own prefixes and they are then enforced', () => {
  const clean = checkInternalReferences(cleanPr({ prTitle: 'fix: handle ACME-12 payloads' }));
  assert.equal(clean.passed, true, 'undeclared, so not this instance concern');
  const declared = checkInternalReferences(
    cleanPr({ prTitle: 'fix: handle ACME-12 payloads' }),
    { instanceIssuePrefixes: 'ACME' }
  );
  assert.equal(declared.passed, false);
  assert.match(declared.failures[0], /ACME-12/);
});

test('the shape audit counts the shared namespace the design comment claims', () => {
  // Reproduces the measurement that justifies a prefix-declared gate: these
  // tokens all match `{ALLCAPS}-{NUMBER}` and only two prefixes are leaks.
  const shapeOnly = auditTicketShapedReferences(
    'UTF-8 and SHA-256 and GPT-4 and TASK-482 and MCK-1 and US-1 and STRESS-1 and PET-392'
  );
  // Sorted by count, then token, so the expectation is order-stable.
  assert.deepEqual(
    shapeOnly.map(t => t.token),
    ['GPT-4', 'MCK-1', 'PET-392', 'SHA-256', 'STRESS-1', 'TASK-482', 'US-1', 'UTF-8']
  );
  // Every one of them is a hit for a shape-based gate; the declared-prefix gate
  // sees only the last.
  const shapeAsFailures = checkInternalReferences(
    cleanPr({
      files: [
        {
          filename: 'server/src/encoding.ts',
          status: 'modified',
          patch: '+// handles UTF-8 and SHA-256 digests (MCK-1, GPT-4 parity)',
        },
      ],
    })
  );
  assert.equal(shapeAsFailures.passed, true);
});

test('the template guidance inside an HTML comment is not read as author content', () => {
  const body = `<!--\nDo not use internal ticket ids like PAPA-123 / PAP-224.\n-->\n${BODY}`;
  assert.equal(checkInternalReferences(cleanPr({ prBody: body })).passed, true);
});

test('an instance deep link in authored text fails', () => {
  const result = checkInternalReferences(
    cleanPr({ prBody: `${BODY}\nTracked at /Paperclip/issues/PET-404.\n` })
  );
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /instance ui link/i.test(f)));
});

test('an agent:// link in authored text fails', () => {
  const result = checkInternalReferences(cleanPr({ prBody: `${BODY}\nThe agent is agent://janus/1.\n` }));
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /agent:\/\//.test(f)));
});

test('an instance URL in authored text fails', () => {
  const result = checkInternalReferences(
    cleanPr({ prBody: `${BODY}\nReproduced on http://localhost:3101 and at http://100.106.178.69:3101.\n` })
  );
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => /instance-only url/i.test(f)));
});

test('a public tracker URL in authored text is not an instance link', () => {
  const result = checkInternalReferences(
    cleanPr({ prBody: `${BODY}\nSee https://github.com/paperclipai/paperclip/issues/123\n` })
  );
  assert.equal(result.passed, true);
});

test('a localhost URL in a source diff is not flagged — a binding test is correct code', () => {
  const result = checkInternalReferences(
    cleanPr({
      files: [
        {
          filename: 'server/src/index.ts',
          status: 'modified',
          patch: '@@ -1 +1 @@\n+  await fetch("http://127.0.0.1:3101/api/health");',
        },
      ],
    })
  );
  assert.equal(result.passed, true);
});

test('findInstanceLinks reports the kind so the message can name the bullet', () => {
  const kinds = findInstanceLinks('/Paperclip/issues/PET-1 and agent://x/1 and http://localhost:9/').map(
    l => l.kind
  );
  assert.deepEqual(kinds.sort(), ['agent:// link', 'instance URL', 'instance path link']);
});

test('each problem becomes exactly one single-line failure for the orchestrator comment', () => {
  const result = checkInternalReferences(
    cleanPr({ prTitle: 'fix: one way door (PET-392)', branch: 'fix/pet392-door' })
  );
  assert.equal(result.passed, false);
  assert.equal(result.failures.length, 2);
  for (const line of result.failures) {
    assert.ok(!line.includes('\n'), 'the orchestrator renders one line per failure');
  }
});

test('a file with no patch (binary, or beyond GitHub truncation) does not throw', () => {
  const result = checkInternalReferences(
    cleanPr({ files: [{ filename: 'ui/public/logo.png', status: 'added' }, { filename: 'a.txt' }] })
  );
  assert.equal(result.passed, true);
});

test('an empty PR is not a false positive', () => {
  assert.equal(checkInternalReferences({}).passed, true);
});

/**
 * The gate is only worth its false-positive budget if it is actually invoked and
 * actually blocking. `run-quality-gates.mjs` keeps `main()` unexported, so this
 * asserts on its source — the same way the workflow-wiring tests in this
 * directory already hold `pr.yml` and the release workflows to their contracts.
 *
 * It is here because "a gate file that exists but is not in the failure list" is
 * the same class of defect as the one this gate addresses: a rule that is
 * present in the repository and inert at the moment it matters.
 */
test('the orchestrator runs the gate and counts its failures as blocking', () => {
  const source = readFileSync(new URL('../run-quality-gates.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ checkInternalReferences \} from '\.\/check-pr-internal-references\.mjs';/);
  assert.match(source, /checkInternalReferences\(\s*\{ prTitle, prBody, branch, commits, files \}/);
  assert.match(source, /instanceIssuePrefixes: process\.env\.INSTANCE_ISSUE_PREFIXES/);
  assert.match(
    source,
    /\.\.\.refsResult\.failures,/,
    'the gate result must be in allFailures, not only in the informational list'
  );
  // The informational list is what a reviewer reads but cannot be blocked on.
  assert.doesNotMatch(source, /\.\.\.refsResult\.informational/);
});
