import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildComment,
  buildProvenanceLine,
  collectBlockingFailures,
  COMMITPERCLIP_LOGINS,
  findExistingComment,
} from '../run-quality-gates.mjs';
import { checkInternalRefs } from '../check-pr-internal-refs.mjs';

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});

test('findExistingComment: a non-app commenter is not adopted by default', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 7,
      user: { login: 'github-actions[bot]' },
      body: 'Gate output\n\n— commitperclip',
    },
  ]), 'token', 'PetrouilFan/paperclip', 32);

  assert.equal(comment, null);
});

test('findExistingComment: adopts the fallback commenter when it is named', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 7,
      user: { login: 'github-actions[bot]' },
      body: 'Gate output\n\n— commitperclip',
    },
  ]), 'token', 'PetrouilFan/paperclip', 32, [
    ...COMMITPERCLIP_LOGINS,
    'github-actions[bot]',
  ]);

  assert.equal(comment.id, 7);
});

test('findExistingComment: still ignores a signed comment from a bystander', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 8,
      user: { login: 'some-human-reviewer' },
      body: 'Quoting the gate: — commitperclip',
    },
  ]), 'token', 'PetrouilFan/paperclip', 32, [
    ...COMMITPERCLIP_LOGINS,
    'github-actions[bot]',
  ]);

  assert.equal(comment, null);
});

test('buildProvenanceLine: names the run and the gate revision that produced the verdict', () => {
  const line = buildProvenanceLine({
    runId: '36262447458',
    runUrl: 'https://github.com/PetrouilFan/paperclip/actions/runs/36262447458',
    baseSha: '16c1a701c8a5a2ad9e3d2b0a1f4c5d6e7a8b9c0d1',
    ranAt: '2026-09-26T21:34:00Z',
  });

  assert.match(line, /run 36262447458/);
  assert.ok(
    line.includes('https://github.com/PetrouilFan/paperclip/actions/runs/36262447458'),
    'the run must be a link, so a reviewer can open the run that produced the verdict',
  );
  // The gate code is read from the ref the job checks out, not the PR head, so
  // the revision is the thing that says which version of the gates ran.
  assert.match(line, /16c1a701c/);
  assert.match(line, /2026-09-26T21:34:00Z/);
});

test('buildProvenanceLine: is absent when the caller supplied nothing to stamp', () => {
  assert.equal(buildProvenanceLine(), null);
  assert.equal(buildProvenanceLine({}), null);
});

test('buildComment: stamps the provenance above the signature on a passing run', () => {
  const line = buildProvenanceLine({ runId: '1', runUrl: 'https://example.test/r/1', baseSha: 'abcdef1234' });
  const body = buildComment('someone', [], [], line);

  // Exactly one signature. `findExistingComment` locates the comment by this
  // string, so a second one would break upsert, and a comment with none would
  // never be found again.
  assert.equal(body.split('— commitperclip').length - 1, 1, 'exactly one commitperclip signature');
  assert.ok(body.endsWith('— commitperclip'), 'the signature stays last');
  assert.ok(body.includes(line), 'the provenance line is part of the comment');
  assert.match(body, /✅ All checks passing/);
});

test('buildComment: stamps the provenance on a failing run too', () => {
  const line = buildProvenanceLine({ runId: '2', runUrl: 'https://example.test/r/2', baseSha: 'abcdef1234' });
  const body = buildComment('someone', ['Missing the linked issue.'], [], line);

  assert.equal(body.split('— commitperclip').length - 1, 1, 'exactly one commitperclip signature');
  assert.ok(body.includes('Missing the linked issue.'));
  assert.ok(body.includes(line), 'a re-gate of a failing run is the case that needs the stamp most');
});

test('buildComment: omits the stamp when there is no provenance to record', () => {
  const body = buildComment('someone', [], [], null);

  assert.ok(body.endsWith('— commitperclip'));
  assert.equal(body.split('— commitperclip').length - 1, 1, 'exactly one commitperclip signature');
  assert.doesNotMatch(body, /gate revision/, 'an unstamped comment must not claim provenance');
});

test('collectBlockingFailures tolerates a gate that returned nothing', () => {
  assert.deepEqual(collectBlockingFailures([undefined, null, { failures: undefined }, { failures: ['x'] }]), ['x']);
});

test('the internal-refs gate is wired into the blocking failure list', () => {
  const source = readFileSync(fileURLToPath(new URL('../run-quality-gates.mjs', import.meta.url)), 'utf8');
  assert.match(source, /checkInternalRefs,/);
  assert.match(source, /const internalRefsResult = checkInternalRefs\(\{/);
  assert.match(source, /internalRefsResult,/);
});

test('the comment surface is wired in, and its fetch is allowed to fail', () => {
  // Three things have to be true together, and each is a way the surface can be
  // present in the file and dead in practice: the fetcher is called, the gate is
  // handed the list, and the failure flag is handed over too. A gate wired
  // without the flag reads an empty list as a clean scan — which is the exact
  // claim the comment fetch failing would otherwise manufacture.
  const source = readFileSync(fileURLToPath(new URL('../run-quality-gates.mjs', import.meta.url)), 'utf8');
  assert.match(source, /import \{ fetchAllPullRequestComments \} from '\.\/fetch-pr-comments\.mjs'/);
  assert.match(source, /comments = await fetchAllPullRequestComments\(/);
  assert.match(source, /commentsUnavailable = true/);
  assert.match(source, /^\s*comments,$/m);
  assert.match(source, /^\s*commentsUnavailable,$/m);
  // And the exempt-login answer is resolved before the gates run, not after.
  assert.ok(
    source.indexOf('const ownerLogins') < source.indexOf('const internalRefsResult'),
    'ownerLogins is resolved before the gate that needs it',
  );
});

test('the gate signature and login lists have exactly one definition', () => {
  // They moved into the gate module because the gate has to recognise its own
  // report, and importing the orchestrator to get them would be circular. Two
  // definitions would let the orchestrator overwrite one comment while the gate
  // read it, which is the loop the exemption exists to stop.
  const orchestrator = readFileSync(fileURLToPath(new URL('../run-quality-gates.mjs', import.meta.url)), 'utf8');
  const gate = readFileSync(fileURLToPath(new URL('../check-pr-internal-refs.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(orchestrator, /= '— commitperclip'/);
  assert.doesNotMatch(orchestrator, /const COMMITPERCLIP_LOGINS =/);
  assert.match(gate, /export const GATE_COMMENT_SIGNATURE = '— commitperclip'/);
  // The old name is still exported, because the orchestrator's test imports it.
  assert.match(orchestrator, /export \{ GATE_COMMENT_LOGINS as COMMITPERCLIP_LOGINS \}/);
});

test('an internal-refs failure reaches the list that decides the exit code', () => {
  // A fictional instance prefix, configured on the call, so this fixture does
  // not carry this repository's own namespace — that is what the gate it lives
  // next to refuses, and it refuses its own neighbours before it refuses
  // strangers.
  const internalRefs = checkInternalRefs({
    prTitle: 'fix(issues): refuse a checkout (TICKET-392)',
    prBranch: 'fix/blocker-edge',
    prefixes: ['TICKET'],
  });
  const clean = { failures: [] };
  const failures = collectBlockingFailures([clean, clean, internalRefs, clean]);
  assert.equal(failures.length, 1);
  // The gate masks what it matched, so the id itself is gone from the line that
  // decides the exit code — which is the point: that line is posted to the pull
  // request. The configured prefix still arrives in its genericised form, which
  // is what tells the author which namespace to look in.
  assert.equal(failures[0].includes('TICKET-392'), false, 'the finding must not carry the id it matched');
  assert.match(failures[0], /prefixes: TICKET-<number>/);
});

test('collectBlockingFailures tolerates a gate that returned nothing', () => {
  assert.deepEqual(collectBlockingFailures([undefined, null, { failures: undefined }, { failures: ['x'] }]), ['x']);
});
