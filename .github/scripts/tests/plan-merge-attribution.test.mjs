import { test } from 'node:test';
import assert from 'node:assert/strict';

import { auditMergeAttribution } from '../audit-merge-attribution.mjs';
import { addTrailers, formatPlan, mergeBody, planMergeAttribution, prescribedBlock } from '../plan-merge-attribution.mjs';

/** A commit GitHub could not match to an account, written at a local address. */
const local = (name, email) => ({ author: null, commit: { author: { name, email } } });
/** A commit GitHub could not match, but whose address can route — a person. */
const person = (name, email = `${name.toLowerCase().replace(/\W+/g, '')}@paperclip.ing`) => local(name, email);

const plan = (o) => planMergeAttribution({ prAuthor: 'PetrouilFan', ...o });

test('plan-merge-attribution: no merge body means unjudged, not clean', () => {
  // The distinction the whole tool rests on. A pull request with no proposed body
  // has lost nothing yet, and a caller that reads "no findings" as "no problem"
  // would report a clean result for a question nobody asked.
  const r = plan({ commits: [person('Prometheus', 'prometheus@paperclip.ing')] });
  assert.equal(r.verdict, 'unverified');
  assert.equal(r.passed, null);
  assert.equal(r.onMerge.length, 0);
  assert.deepEqual(r.trailers, ['Co-Authored-By: Prometheus <prometheus@paperclip.ing>']);
});

test('plan-merge-attribution: the owed block is derived from the branch, not from the gate comment', () => {
  const r = plan({ commits: [person('Prometheus', 'prometheus@paperclip.ing')] });
  assert.deepEqual(r.trailers, ['Co-Authored-By: Prometheus <prometheus@paperclip.ing>']);
  assert.match(formatPlan(r), /owes 1 trailer line:/);
  assert.match(formatPlan(r), /Co-Authored-By: Prometheus <prometheus@paperclip\.ing>/);
});

test('plan-merge-attribution: a body carrying every owed line is clean', () => {
  const r = plan({
    commits: [person('Prometheus', 'prometheus@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: Prometheus <prometheus@paperclip.ing>\n',
  });
  assert.equal(r.verdict, 'clean');
  assert.equal(r.passed, true);
  assert.deepEqual(r.findings, []);
});

test('plan-merge-attribution: a body with no trailer at all is a loss, and the line to paste is given', () => {
  // The seven merges on this fork that lost a credit where the gate had named
  // the contributor: the body went out without the line, and the only report
  // came from the post-merge audit. This is that case, asked one moment earlier.
  const r = plan({
    commits: [person('Prometheus', 'prometheus@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n',
  });
  assert.equal(r.verdict, 'loss');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, 'lost-credit');
  assert.equal(r.findings[0].credit, 'Prometheus <prometheus@paperclip.ing>');
  assert.match(formatPlan(r), /Co-Authored-By: Prometheus <prometheus@paperclip\.ing>/);
  assert.match(formatPlan(r), /will not name the contributor above/);
});

test('plan-merge-attribution: a machine identity is owed the house line, not its own', () => {
  const r = plan({
    commits: [local('Episkopos', 'episkopos@paperclip.local')],
    mergeMessage: 'fix(server): something (#1)\n',
  });
  assert.equal(r.verdict, 'loss');
  assert.deepEqual(r.trailers, ['Co-Authored-By: Paperclip <noreply@paperclip.ing>']);
  assert.match(formatPlan(r), /Co-Authored-By: Paperclip <noreply@paperclip\.ing>/);
});

test('plan-merge-attribution: the house line does not credit a person the branch names', () => {
  // 47 merges on this fork carry only the house identity over a named
  // contributor. Inheriting that rule from the post-merge audit is the point:
  // a pre-merge check with its own idea of who a person is would clear exactly
  // the body it exists to catch.
  const r = plan({
    commits: [person('Janus', 'janus@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>\n',
  });
  assert.equal(r.verdict, 'loss');
  assert.deepEqual(r.trailers, ['Co-Authored-By: Janus <janus@paperclip.ing>']);
});

test('plan-merge-attribution: a branch with no contributor outside the PR author owes nothing', () => {
  const r = plan({
    commits: [{ author: { login: 'PetrouilFan' }, commit: { author: { name: 'Petros', email: 'petros@paperclip.local' } } }],
    mergeMessage: 'fix(server): something (#1)\n',
  });
  assert.equal(r.verdict, 'clean');
  assert.deepEqual(r.trailers, []);
  assert.match(formatPlan(r), /owes no trailer/);
});

test('plan-merge-attribution: a repeated line in the body is reported, not silently accepted', () => {
  // A paste carried forward from a previous merge of the same branch. The
  // credit is intact, so this does not fail the plan, and a reader is told.
  const r = plan({
    commits: [person('Prometheus', 'prometheus@paperclip.ing')],
    mergeMessage:
      'fix(server): something (#1)\n\n' +
      'Co-Authored-By: Prometheus <prometheus@paperclip.ing>\n' +
      'Co-Authored-By: Prometheus <prometheus@paperclip.ing>\n',
  });
  assert.equal(r.verdict, 'clean');
  assert.deepEqual(r.findings.map(f => f.kind), ['duplicate-credit']);
  assert.match(formatPlan(r), /duplicate-credit/);
});

test('plan-merge-attribution: the pre-merge verdict cannot come apart from the post-merge one', () => {
  // The reason this file asks the same function rather than holding its own copy
  // of the attribution rules. Every body below is judged by both surfaces and
  // they must agree, including on the bodies that only one of them is aimed at.
  const bodies = [
    'fix(server): something (#1)\n',
    'fix(server): something (#1)\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>\n',
    'fix(server): something (#1)\n\nCo-Authored-By: Prometheus <prometheus@paperclip.ing>\n',
    'fix(server): something (#1)\n\nCo-Authored-By: Prometheus (Paperclip agent) <prometheus@paperclip.ing>\n',
  ];
  const branches = [
    [person('Prometheus', 'prometheus@paperclip.ing')],
    [local('Episkopos', 'episkopos@paperclip.local')],
    [person('Agent A', 'agent@paperclip.ing'), person('Agent B', 'agent@paperclip.ing')],
    [{ author: { login: 'PetrouilFan' }, commit: { author: { name: 'Petros', email: 'petros@paperclip.local' } } }],
  ];
  for (const commits of branches) {
    for (const mergeMessage of bodies) {
      const before = plan({ commits, mergeMessage });
      const after = auditMergeAttribution({ prAuthor: 'PetrouilFan', commits, mergeMessage });
      assert.equal(
        before.verdict === 'clean',
        after.passed,
        `disagreement on ${JSON.stringify(mergeMessage)}: plan says ${before.verdict}, audit says ${after.passed}`
      );
    }
  }
});

test('plan-merge-attribution: a re-spelled credit is credited, and the plan says so', () => {
  const r = plan({
    commits: [person('athena', 'athena@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: Athena (Paperclip agent) <athena@paperclip.ing>\n',
  });
  assert.equal(r.verdict, 'clean');
  assert.deepEqual(r.findings.map(f => f.kind), ['respelled-credit']);
});

test('plan-merge-attribution: the block is sorted and de-duplicated, so it does not diff against itself', () => {
  assert.deepEqual(prescribedBlock(['b <b@x>', 'a <a@x>', 'b <b@x>']), [
    'Co-Authored-By: a <a@x>',
    'Co-Authored-By: b <b@x>',
  ]);
  assert.deepEqual(prescribedBlock(undefined), []);
});

test('plan-merge-attribution: a written body keeps the pull request text and puts the trailers last', () => {
  // Git reads the trailer block out of the last paragraph. A line pasted into
  // the middle of a description is read as prose, which is a credit that looks
  // present and is not.
  const body = mergeBody({
    title: 'fix(server): something (#1)',
    description: 'What changed and why.',
    trailers: ['Co-Authored-By: Paperclip <noreply@paperclip.ing>'],
  });
  assert.equal(
    body,
    'fix(server): something (#1)\n\nWhat changed and why.\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>\n'
  );
  // And the body this function writes is one the plan then accepts.
  assert.equal(plan({ commits: [local('Episkopos', 'episkopos@paperclip.local')], mergeMessage: body }).verdict, 'clean');
});

test('plan-merge-attribution: a body with an empty description is still a well-formed block', () => {
  const body = mergeBody({ title: 'fix(server): something (#1)', description: '   \n  ', trailers: [] });
  assert.equal(body, 'fix(server): something (#1)\n\n\n');
});

test('plan-merge-attribution: a robot-marker name is flagged, never silently dropped', () => {
  // GitHub matches the Copilot coding agent's commits to the account `Copilot`
  // and carries `[bot]` on the commit's author name, so the gate's login-keyed
  // bot rule prescribes a credit for it. The gate is not given the account type
  // that would settle it, and filtering on the name instead would drop a person
  // whose `git config user.name` reads `renovate[bot]`. So the line is prescribed,
  // annotated, and left to the reader — a person is never dropped on the
  // strength of a name here.
  const commits = [{
    author: { login: 'Copilot' },
    commit: { author: { name: 'copilot-swe-agent[bot]', email: '198982749+Copilot@users.noreply.github.com' } },
  }];
  const r = plan({ commits });
  assert.deepEqual(r.flagged, ['copilot-swe-agent[bot] <Copilot@users.noreply.github.com>']);
  // Still owed, still in the block. The tool does not decide who is a person.
  assert.deepEqual(r.trailers, ['Co-Authored-By: copilot-swe-agent[bot] <Copilot@users.noreply.github.com>']);
  assert.match(formatPlan(r), /Read these before pasting them/);
  assert.match(formatPlan(r), /carries a robot marker/);

  // A person is not flagged, and a bot the gate already skips is not prescribed
  // at all, so there is nothing to flag.
  assert.deepEqual(plan({ commits: [person('Prometheus', 'prometheus@paperclip.ing')] }).flagged, []);
  assert.deepEqual(
    plan({ commits: [{ author: { login: 'renovate[bot]' }, commit: { author: { name: 'renovate[bot]', email: 'bot@renovate.example' } } }] }).flagged,
    []
  );
  // And a flagged credit is still judged like any other, so dropping it is the
  // merger's decision and the report says what dropping it costs.
  const dropped = plan({ commits, mergeMessage: 'fix(server): something (#1)\n' });
  assert.equal(dropped.verdict, 'loss');
  assert.deepEqual(dropped.findings.map(f => f.kind), ['lost-credit']);
});

test('plan-merge-attribution: a person beside a flagged robot is still lost when the body omits them', () => {
  const commits = [
    { author: { login: 'Copilot' }, commit: { author: { name: 'copilot-swe-agent[bot]', email: '198982749+Copilot@users.noreply.github.com' } } },
    local('Episkopos', 'episkopos@paperclip.local'),
  ];
  const r = plan({ commits, mergeMessage: 'fix(server): something (#1)\n' });
  assert.equal(r.verdict, 'loss');
  // Both are owed, so both are lost. The machine's loss is reported under the
  // name its commit was written with, because "the house identity is missing" is
  // not something a reader can act on.
  assert.deepEqual(r.findings.map(f => f.kind), ['lost-credit', 'lost-credit']);
  assert.deepEqual(r.findings.map(f => f.credit).sort(), [
    'Episkopos <episkopos@paperclip.local>',
    'copilot-swe-agent[bot] <Copilot@users.noreply.github.com>',
  ]);
  assert.match(r.findings.find(f => f.credit.startsWith('Episkopos')).detail, /Paperclip <noreply@paperclip\.ing>/);
  assert.deepEqual(r.flagged, ['copilot-swe-agent[bot] <Copilot@users.noreply.github.com>']);
});

test('plan-merge-attribution: a description that already carries the line does not get it twice', () => {
  // Authors paste the trailer block into the description where the gate asked for
  // it, and a writer that appends it again writes a duplicate into permanent
  // history that the audit then reports on a merge nobody got wrong.
  const line = 'Co-Authored-By: Paperclip <noreply@paperclip.ing>';
  assert.deepEqual(addTrailers([line], `fix(server): x\n\n${line}\n`), []);
  // The address is the identity, so a re-spelled copy of the same credit is not
  // appended either. A different address is a different credit and is appended.
  assert.deepEqual(addTrailers([line], 'fix(server): x\n\nCo-Authored-By: Paperclip (agent) <noreply@paperclip.ing>\n'), []);
  assert.deepEqual(addTrailers([line], 'fix(server): x\n\nCo-Authored-By: Paperclip <other@paperclip.ing>\n'), [line]);
  // And the body this function writes is one the plan then reports as clean,
  // with no duplicate finding to explain.
  const body = mergeBody({
    title: 'fix(server): x (#1)',
    description: `What changed.\n\n${line}`,
    trailers: [line],
  });
  const r = plan({ commits: [local('Episkopos', 'episkopos@paperclip.local')], mergeMessage: body });
  assert.equal(r.verdict, 'clean');
  assert.deepEqual(r.findings, []);
  assert.equal((body.match(/Co-Authored-By/g) ?? []).length, 1);
});
