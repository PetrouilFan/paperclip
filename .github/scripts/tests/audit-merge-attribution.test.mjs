import { test } from 'node:test';
import assert from 'node:assert/strict';

import { auditMergeAttribution, formatAudit, parseTrailer, readTrailers } from '../audit-merge-attribution.mjs';

/** A commit GitHub could not match to an account, which is the fleet's case. */
const local = (name, email) => ({ author: null, commit: { author: { name, email } } });
/** A commit GitHub could not match, but whose address can route — a person. */
const person = (name, email = `${name.toLowerCase().replace(/\W+/g, '')}@paperclip.ing`) => local(name, email);
/** A commit GitHub matched to a login. Each login gets its own address. */
const matched = (login, name) => ({
  author: { login },
  commit: { author: { name: name ?? login, email: `${login}@users.noreply.github.com` } },
});

const audit = (o) => auditMergeAttribution({ prAuthor: 'PetrouilFan', ...o });
const kinds = (r) => r.findings.map(f => f.kind).sort();

test('audit-merge-attribution: credits that landed are not reported', () => {
  const r = audit({
    commits: [person('Prometheus', 'prometheus@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: Prometheus <prometheus@paperclip.ing>\n',
  });
  assert.equal(r.passed, true);
  assert.deepEqual(r.findings, []);
  assert.equal(r.counts.lost, 0);
});

test('audit-merge-attribution: a single contributor with no trailer at all is a lost credit', () => {
  const r = audit({
    commits: [local('Prometheus', 'prometheus@paperclip.local')],
    mergeMessage: 'fix(server): something (#1)\n',
  });
  assert.equal(r.passed, false);
  assert.deepEqual(kinds(r), ['lost-credit']);
  assert.equal(r.findings[0].credit, 'Prometheus <prometheus@paperclip.local>');
});

test('audit-merge-attribution: the house identity does not satisfy a gate-prescribed credit', () => {
  // 47 of this fork's merges carry only the house identity while the branch
  // carried a named contributor. Crediting the repository is not crediting the
  // person whose commits are on the branch.
  //
  // A *person* is the whole point of this case, and the distinction is load
  // bearing. `checkCoauthors` normalises a commit whose only address is
  // unroutable onto the house line and calls that its credit, so for that shape
  // the house line is the answer, not the loss. For a commit at a routable
  // address the person's own line is the credit, and the house line credits
  // nobody in particular. Same trailer, opposite verdicts, and which applies is
  // read from the gate rather than re-decided here.
  const r = audit({
    commits: [person('Janus', 'janus@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>\n',
  });
  assert.equal(r.passed, false);
  assert.deepEqual(kinds(r), ['lost-credit', 'phantom-trailer']);
  assert.equal(r.findings.find(f => f.kind === 'lost-credit').credit, 'Janus <janus@paperclip.ing>');
});

test('audit-merge-attribution: the pull request author needs no trailer', () => {
  const r = audit({
    commits: [matched('petrouilfan'), local('PetrouilFan', 'petrouilfan@paperclip.local')],
    mergeMessage: 'fix(server): something (#1)\n',
  });
  assert.equal(r.passed, true);
  assert.deepEqual(r.findings, []);
});

test('audit-merge-attribution: a re-spelled credit is reported as re-spelled, not as a loss', () => {
  // The address is the identity. Reading the same credit as both lost and
  // delivered is what a whole-line comparison produces, and it buries the real
  // losses under every hand-edited name on the branch.
  const r = audit({
    commits: [person('athena', 'athena@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: Athena (Paperclip agent) <athena@paperclip.ing>\n',
  });
  assert.equal(r.passed, true, 'a re-spelling is not a loss of credit');
  assert.deepEqual(kinds(r), ['respelled-credit']);
  assert.equal(r.findings[0].credit, 'athena <athena@paperclip.ing>');
  assert.equal(r.findings[0].delivered, 'Athena (Paperclip agent) <athena@paperclip.ing>');
});

test('audit-merge-attribution: name comparison is case-folded, so a case edit is not a re-spelling', () => {
  const r = audit({
    commits: [person('Mnemosyne', 'mnemosyne@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: mnemosyne <mnemosyne@paperclip.ing>\n',
  });
  assert.deepEqual(kinds(r), ['respelled-credit'], 'the display names differ, so it is reported');
  assert.equal(r.passed, true, 'and it is not a lost credit');
});

test('audit-merge-attribution: one address under two names, one credited — the loser is named', () => {
  // The defect the co-author gate was changed for. The gate de-dups and reports
  // the collision; this is the check that the report was acted on.
  const r = audit({
    commits: [person('Agent A', 'agent@paperclip.ing'), person('Agent B', 'agent@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: Agent A <agent@paperclip.ing>\n',
  });
  assert.equal(r.passed, false);
  assert.deepEqual(kinds(r), ['dropped-name']);
  const f = r.findings[0];
  assert.equal(f.address, 'agent@paperclip.ing');
  assert.equal(f.carried, 'Agent A');
  assert.deepEqual(f.dropped, ['Agent B']);
  assert.match(f.detail, /`Agent B` is not in the history/);
});

test('audit-merge-attribution: a shared identity credited under every name loses nobody', () => {
  const r = audit({
    commits: [person('Agent A', 'agent@paperclip.ing'), person('Agent B', 'agent@paperclip.ing')],
    mergeMessage:
      'fix(server): something (#1)\n\n' +
      'Co-Authored-By: Agent A <agent@paperclip.ing>\n' +
      'Co-Authored-By: Agent B <agent@paperclip.ing>\n',
  });
  assert.equal(r.passed, true, 'both names credited — the de-dup cost nobody their credit');
  // Not a duplicate: nothing is repeated. One address under two names is its own
  // finding, because only one of them can be reached at that mailbox.
  assert.deepEqual(kinds(r), ['shared-address']);
  assert.deepEqual(r.findings[0].spellings, [
    'Agent A <agent@paperclip.ing>',
    'Agent B <agent@paperclip.ing>',
  ]);
});

test('audit-merge-attribution: a shared identity nobody credited names every name', () => {
  // `lost-credit` names only the one the de-dup kept. Reporting that alone reads
  // as one clean, explained loss, which is how the second person disappears —
  // the exact failure this audit exists to catch, reintroduced by the first
  // version of this function.
  const r = audit({
    commits: [person('Agent A', 'agent@paperclip.ing'), person('Agent B', 'agent@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n',
  });
  assert.equal(r.passed, false);
  assert.deepEqual(kinds(r), ['dropped-name', 'lost-credit']);
  const f = r.findings.find(x => x.kind === 'dropped-name');
  assert.equal(f.carried, null);
  assert.deepEqual(f.dropped, ['Agent A', 'Agent B']);
  assert.match(f.detail, /credits none of them/);
});

test('audit-merge-attribution: bots and the PR author never seed a shared-identity report', () => {
  // Every matched commit in a suite that shares one address would look like a
  // shared identity. Asking the gate which commits it considered keeps this
  // audit from re-deriving the gate's skip rules and drifting from them.
  //
  // The `[bot]` marker goes in the login, not the display name, because that is
  // where GitHub puts it and that is the field the gate keys on. A login without
  // the marker is a human account however machine-like its chosen name reads, so
  // a `renovate` login named `renovate[bot]` is a contributor and this test would
  // be asserting the wrong thing if it used that spelling.
  const at = (login, name) => ({ author: { login }, commit: { author: { name, email: 'shared@local' } } });
  const r = audit({
    commits: [at('renovate[bot]', 'renovate[bot]'), at('petrouilfan', 'PetrouilFan')],
    mergeMessage: 'fix(server): something (#1)\n',
  });
  assert.equal(r.passed, true);
  assert.deepEqual(r.findings, []);
});

test('audit-merge-attribution: a machine-sounding name under a human login is still a contributor', () => {
  // The control for the one above. The gate's bot rule keys on the login because
  // that is the only field GitHub sets; treating a display name as authoritative
  // would silently drop a person who chose an unlucky handle, which is the same
  // silent loss this file exists to report, reached from the other direction.
  const r = audit({
    commits: [{ author: { login: 'renovate' }, commit: { author: { name: 'renovate[bot]', email: 'shared@local' } } }],
    mergeMessage: 'fix(server): something (#1)\n',
  });
  assert.equal(r.passed, false);
  assert.deepEqual(kinds(r), ['lost-credit']);
  // The rendered credit carries the commit's git name against the account's
  // no-reply address, so a worktree's `user.name` reaches permanent history even
  // on a commit GitHub matched to a real account. That is the display-name
  // leakage this repository's history already carries, visible in one line.
  assert.equal(r.findings[0].credit, 'renovate[bot] <renovate@users.noreply.github.com>');
});

test('audit-merge-attribution: a repeated trailer line is one finding, however many times', () => {
  const message = ['fix(server): something (#1)', '']
    .concat(Array.from({ length: 4 }, () => 'Co-Authored-By: Mnemosyne <mnemosyne@paperclip.ing>'))
    .join('\n');
  const r = audit({
    commits: [person('Mnemosyne', 'mnemosyne@paperclip.ing')],
    mergeMessage: message,
  });
  assert.equal(r.counts.duplicate, 1, 'reported once, not four times');
  assert.equal(r.findings[0].count, 4);
  assert.match(r.findings[0].detail, /pasted in by hand/);
});

test('audit-merge-attribution: one address credited under two names is a shared address, not a re-spelling', () => {
  const r = audit({
    commits: [person('Mnemosyne', 'mnemosyne@paperclip.ing')],
    mergeMessage:
      'fix(server): something (#1)\n\n' +
      'Co-Authored-By: Mnemosyne <mnemosyne@paperclip.ing>\n' +
      'Co-Authored-By: mnemosyne <mnemosyne@paperclip.ing>\n',
  });
  // The branch name is credited, so the credit is intact and nothing was
  // re-spelled. What is left is one address carrying two names.
  assert.deepEqual(kinds(r), ['shared-address']);
  assert.equal(r.passed, true);
});

test('audit-merge-attribution: a bare trailer with no address still counts as a credit', () => {
  const r = audit({
    commits: [person('Agent A', 'agent@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: Agent A\n',
  });
  assert.equal(r.passed, true, 'a bare name delivers the identity when the branch has an address');
  assert.deepEqual(r.findings, []);
});

test('audit-merge-attribution: a trailer pasted into the body counts, not only a trailer block', () => {
  // A re-merge by hand carries the previous body forward, which puts the
  // trailers in the middle of the message. Scanning only the last paragraph
  // would report this merge as carrying no trailers at all.
  const message = [
    'fix(server): something (#1)',
    '',
    'Co-Authored-By: Mnemosyne <mnemosyne@paperclip.ing>',
    '',
    'A paragraph written after the paste.',
  ].join('\n');
  assert.deepEqual(readTrailers(message), ['Mnemosyne <mnemosyne@paperclip.ing>']);
  const r = audit({ commits: [person('Mnemosyne', 'mnemosyne@paperclip.ing')], mergeMessage: message });
  assert.equal(r.passed, true);
  assert.deepEqual(r.findings, []);
});

test('audit-merge-attribution: readTrailers keeps repeats and folds case on the key', () => {
  assert.deepEqual(
    readTrailers('x\nco-authored-by: A <a@b.c>\nCo-Authored-By:  A <a@b.c>  \nnot a trailer\n'),
    ['A <a@b.c>', 'A <a@b.c>']
  );
  assert.deepEqual(parseTrailer('Some One <Some@One.Example>'), {
    name: 'some one',
    email: 'some@one.example',
    display: 'Some One',
  });
  assert.deepEqual(parseTrailer('bare name'), { name: 'bare name', email: '', display: 'bare name' });
});

test('audit-merge-attribution: a branch with no contributors is clean and says so', () => {
  const r = audit({ commits: [matched('PetrouilFan')], mergeMessage: 'fix(server): something (#1)\n' });
  assert.equal(r.passed, true);
  assert.equal(r.counts.prescribed, 0);
  assert.match(formatAudit(r), /credited in the merge message, once, under one name/);
});

test('audit-merge-attribution: missing inputs do not throw and do not invent a loss', () => {
  for (const bad of [undefined, null, {}]) {
    const r = auditMergeAttribution(bad);
    assert.equal(r.passed, true);
    assert.deepEqual(r.findings, []);
  }
  assert.equal(audit({ commits: [], mergeMessage: '' }).passed, true);
  assert.equal(audit({ commits: [local('A', 'a@b.c')], mergeMessage: undefined }).passed, false,
    'a contributor the gate named and an unreadable message is a loss, not a silent pass');
});

test('audit-merge-attribution: the audit cannot pass a message that names no one at all', () => {
  // The control. An audit that reports `passed: true` for a branch whose
  // contributor appears nowhere in the message is worse than no audit, so this
  // asserts the failing direction as well as the clean one.
  const named = audit({ commits: [local('Agent A', 'a@b.c')], mergeMessage: 'Co-Authored-By: Agent A <a@b.c>\n' });
  const unnamed = audit({ commits: [local('Agent A', 'a@b.c')], mergeMessage: 'fix(server): something (#1)\n' });
  assert.equal(named.passed, true);
  assert.equal(unnamed.passed, false);
  assert.equal(named.counts.lost, 0);
  assert.equal(unnamed.counts.lost, 1);
});

test('audit-merge-attribution: bots and the PR author are not contributors', () => {
  const r = audit({
    commits: [matched('renovate[bot]'), matched('PetrouilFan'), person('Mnemosyne', 'm@paperclip.ing')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: Mnemosyne <m@paperclip.ing>\n',
  });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.prescribed, ['Mnemosyne <m@paperclip.ing>']);
});

test('audit-merge-attribution: the address a commit was written with still delivers its credit', () => {
  // Found by running the audit over this fork's real merges, not by reasoning.
  // The gate swaps a matched account's real address for its no-reply form so the
  // credit links to a profile; a squash that kept the original address credits the
  // same person. Matching the rendered address alone reported merge #93 as a lost
  // credit and, from the other direction, as a trailer crediting nobody at the
  // same time.
  const r = audit({
    commits: [
      { author: { login: 'Paperclip-Paperclip' }, commit: { author: { name: 'Paperclip', email: 'noreply@paperclip.ing' } } },
      person('athena', 'athena@paperclip.ing'),
    ],
    mergeMessage: 'fix(interactions): something (#93)\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>\n',
  });
  // `person`, and the choice is the second half of the finding this test came
  // from. At an unroutable address the gate would have read `athena` as a
  // machine and prescribed the very house line the merge carries, so the credit
  // would have arrived and there would be nothing to report. The loss in #93 was
  // real because a person was behind that address.
  assert.deepEqual(kinds(r), ['lost-credit'], 'athena really was dropped — that half stands');
  assert.equal(r.findings[0].credit, 'athena <athena@paperclip.ing>');
  assert.ok(
    !r.findings.some(f => f.credit === 'Paperclip <noreply@paperclip.ing>'),
    'the address the commit was written with delivers the credit'
  );
  assert.ok(
    !r.findings.some(f => f.kind === 'phantom-trailer'),
    'and it is not a trailer crediting nobody: the address is on the branch'
  );
});

test('audit-merge-attribution: an unrelated address is still a lost credit', () => {
  // The control. Widening which addresses count is only safe while a genuinely
  // absent contributor is still reported, so this pins the failing direction
  // against the same shape that the case above exempts.
  const r = audit({
    commits: [
      { author: { login: 'Paperclip-Paperclip' }, commit: { author: { name: 'Paperclip', email: 'noreply@paperclip.ing' } } },
    ],
    mergeMessage: 'fix(interactions): something (#93)\n\nCo-Authored-By: Paperclip <someone-else@paperclip.ing>\n',
  });
  assert.equal(r.passed, false);
  assert.deepEqual(kinds(r), ['lost-credit', 'phantom-trailer']);
  assert.equal(r.findings.find(f => f.kind === 'lost-credit').credit, 'Paperclip <Paperclip-Paperclip@users.noreply.github.com>');
});

test('audit-merge-attribution: formatAudit names every finding kind it can emit', () => {
  // One merge that trips all seven, so the list below is checked against shapes
  // the function really produces rather than against hand-built findings that
  // might drift from the real ones. An earlier version of this test credited
  // every contributor and then asserted `lost-credit` appeared, which
  // contradicted the test above it: with nothing lost, reporting a loss would be
  // the bug.
  //
  // The contributors are a deliberate mix, and not stylistic. A machine-shaped
  // commit prescribes the house line, a person-shaped one prescribes their own,
  // and which findings a merge can trip depends entirely on that distinction:
  //
  //   - `athena` is machine-shaped and her own line landed, so her commits *are*
  //     credited and the finding is about the line, not the credit.
  //   - `Custodian` is a person at a routable address and nothing credited her,
  //     so the house line would not have helped either and this is a real loss.
  //   - `Agent A`/`Agent B` are people on one address, which is the only way to
  //     reach `dropped-name` and `shared-address` at once.
  const r = audit({
    commits: [
      local('athena', 'athena@paperclip.local'),
      person('Custodian', 'c@paperclip.ing'),
      person('Agent A', 'agent@paperclip.ing'),
      person('Agent B', 'agent@paperclip.ing'),
      person('Mnemosyne', 'm@paperclip.ing'),
      person('sisyphus', 'sisyphus@paperclip.ing'),
    ],
    mergeMessage:
      'fix(server): something (#1)\n\n' +
      'Co-Authored-By: Agent A <agent@paperclip.ing>\n' +
      'Co-Authored-By: agent a <agent@paperclip.ing>\n' +
      'Co-Authored-By: Mnemosyne <m@paperclip.ing>\n' +
      'Co-Authored-By: Mnemosyne <m@paperclip.ing>\n' +
      'Co-Authored-By: Sisyphus (Paperclip agent) <sisyphus@paperclip.ing>\n' +
      'Co-Authored-By: athena <athena@paperclip.local>\n' +
      'Co-Authored-By: Nobody <nobody@nowhere.invalid>\n',
  });
  const every = [
    'lost-credit',
    'dropped-name',
    'respelled-credit',
    'phantom-trailer',
    'duplicate-credit',
    'shared-address',
    'landed-rejected-line',
  ];
  for (const kind of every) {
    assert.ok(
      r.findings.some(f => f.kind === kind),
      `the fixture produces ${kind}, or the list below is stale`
    );
    assert.match(formatAudit(r), new RegExp(`\\*\\*${kind}\\*\\*`), `${kind} is named in the report`);
  }
  assert.equal(r.passed, false, 'a lost credit and a dropped name both fail the audit');
});

test('audit-merge-attribution: a machine commit is credited by the house line, with nothing to report', () => {
  // The other half of the `landed-rejected-line` case, and the one that says the
  // finding is about the *line* rather than about the credit. Same commit, same
  // branch, the rules-approved line: clean.
  //
  // This is the shape `checkCoauthors` normalises to, so a branch whose commits
  // are all machine-shaped and whose merge carries the house line is fully
  // attributed. Reporting a loss here would train a reader to ignore the audit.
  const r = audit({
    commits: [local('athena', 'athena@paperclip.local')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>\n',
  });
  assert.equal(r.passed, true);
  assert.deepEqual(r.findings, [], 'the rules-approved line for a machine is a credit, not a gap');
  assert.deepEqual(r.prescribed, ['Paperclip <noreply@paperclip.ing>']);
});

test('audit-merge-attribution: a machine identity\'s own line is a rejected line, and does not fail the audit', () => {
  // The finding this tool exists for. The commits are credited, so no gate can
  // say anything useful and nothing is lost — but the line that delivered them
  // publishes an unroutable address and a worktree's `user.name` into permanent
  // history, and the pre-merge gate structurally could not have seen it.
  const r = audit({
    commits: [local('athena', 'athena@paperclip.local')],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: athena <athena@paperclip.local>\n',
  });
  assert.equal(r.passed, true, 'the credit arrived; a bad line is not a lost credit');
  assert.deepEqual(kinds(r), ['landed-rejected-line']);
  const f = r.findings[0];
  assert.equal(f.delivered, 'athena <athena@paperclip.local>');
  assert.equal(f.credit, 'Paperclip <noreply@paperclip.ing>');
  assert.match(f.detail, /noreply@paperclip\.ing/, 'the detail names the line that should have been used');
  assert.equal(r.counts.rejectedLines, 1);
});

test('audit-merge-attribution: a rejected line is still reported when the accepted one also landed', () => {
  // Pasting both is the natural repair — someone noticed the house line was
  // needed and added it without removing the local one. The credit is intact, so
  // this must not read as a loss, and the leftover line is still in history, so
  // it must not read as clean either. Exactly one finding, and the verdict does
  // not depend on which of the two lines the mergeer pasted first.
  const both = 'fix(server): something (#1)\n\n' +
    'Co-Authored-By: Paperclip <noreply@paperclip.ing>\n' +
    'Co-Authored-By: athena <athena@paperclip.local>\n';
  const reversed = 'fix(server): something (#1)\n\n' +
    'Co-Authored-By: athena <athena@paperclip.local>\n' +
    'Co-Authored-By: Paperclip <noreply@paperclip.ing>\n';
  for (const mergeMessage of [both, reversed]) {
    const r = audit({ commits: [local('athena', 'athena@paperclip.local')], mergeMessage });
    assert.deepEqual(kinds(r), ['landed-rejected-line'], 'one finding, whatever the order');
    assert.equal(r.passed, true);
  }
});

test('audit-merge-attribution: a person credited at the address their commit was written with is not a gap', () => {
  // The counterpart of the rule above, and the reason `stray` is not simply
  // "rejected": one verdict, two readings, decided by whether the contributor is
  // a person.
  //
  // The gate renders a matched account's trailer with the account's no-reply form
  // so the credit links to a profile, and records the address the commit was
  // really written with beside it. A squash that kept the real address credits the
  // same person, so this is delivered — reporting it as a loss would send someone
  // to re-paste a line that was already right. It is the #93 finding, and it is
  // here to say the fix is still a person after everything #136 changed.
  const r = audit({
    commits: [{
      author: { login: 'athena' },
      commit: { author: { name: 'athena', email: 'athena@paperclip.ing' } },
    }],
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: athena <athena@paperclip.ing>\n',
  });
  assert.equal(r.passed, true);
  assert.equal(r.findings.filter(f => f.kind === 'lost-credit').length, 0);
  assert.equal(r.findings.filter(f => f.kind === 'landed-rejected-line').length, 0);
});

test('audit-merge-attribution: every machine author is named when the house line is missing, and one house line credits them all', () => {
  // The normalisation in #136 puts every machine identity on the same line, so
  // the obvious thing to assume is that N machine commits collapse into one
  // prescribed credit and one finding. They do not, and that matters: the finding
  // has to name a person, and three commits written by three agents are three
  // people to go and ask. Both halves are pinned here — the list stays whole when
  // the credit is absent, and does not triple-count when it is present.
  const commits = [
    local('athena', 'athena@paperclip.local'),
    local('hestia', 'hestia@paperclip.local'),
    local('Mnemosyne', 'm@paperclip.local'),
  ];
  const missing = audit({
    commits,
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: PetrouilFan <fan@example.com>\n',
  });
  const lost = missing.findings.filter(f => f.kind === 'lost-credit');
  assert.equal(lost.length, 3, 'one finding per author, not one for the shared line');
  assert.deepEqual(
    lost.map(f => f.credit).sort(),
    ['Mnemosyne <m@paperclip.local>', 'athena <athena@paperclip.local>', 'hestia <hestia@paperclip.local>'],
    'each is named by the address their commit was actually written with'
  );
  for (const f of lost) {
    assert.match(f.detail, /noreply@paperclip\.ing/, 'and each says which line would have covered it');
  }

  const landed = audit({
    commits,
    mergeMessage: 'fix(server): something (#1)\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>\n',
  });
  assert.deepEqual(landed.findings, [], 'one line covering three commits is one credit, not three findings');
  assert.equal(landed.passed, true);
});
