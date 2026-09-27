import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCoauthors, fetchAllPullRequestCommits } from '../check-pr-coauthors.mjs';

function commit(login, name = null, email = null) {
  return {
    author: login ? { login } : null,
    commit: { author: { name: name ?? login, email: email ?? `${login}@users.noreply.github.com` } },
  };
}

test('checkCoauthors: says nothing when every commit is the PR author\'s own', () => {
  const result = checkCoauthors(
    [commit('tonio-alucema'), commit('tonio-alucema')],
    'tonio-alucema'
  );

  assert.equal(result.passed, true);
  assert.deepEqual(result.informational, []);
});

test('checkCoauthors: hands over the trailer when the branch carries someone else\'s commit', () => {
  // The case this exists for: a stale contributor PR rebased and landed by a
  // maintainer. Squash-merging drops the contributor unless the squash body
  // carries their trailer.
  const result = checkCoauthors(
    [commit('stubbi', 'Jannes Stubbemann'), commit('tonio-alucema')],
    'tonio-alucema'
  );

  assert.equal(result.informational.length, 1);
  assert.match(result.informational[0], /Jannes Stubbemann/);
  assert.match(
    result.informational[0],
    /Co-Authored-By: Jannes Stubbemann <stubbi@users\.noreply\.github\.com>/
  );
});

test('checkCoauthors: never fails the PR, because the squash message does not exist yet', () => {
  // Informational only. The author of the PR cannot satisfy this from the PR,
  // so failing here would block work on something unfixable at that point.
  const result = checkCoauthors([commit('stubbi')], 'tonio-alucema');

  assert.equal(result.passed, true);
});

test('checkCoauthors: matches the PR author case-insensitively', () => {
  // GitHub logins are case-insensitive, and PR_AUTHOR does not always arrive
  // in the same case as the commit author login.
  const result = checkCoauthors([commit('Tonio-Alucema')], 'tonio-alucema');

  assert.deepEqual(result.informational, []);
});

test('checkCoauthors: ignores bots', () => {
  const result = checkCoauthors(
    [commit('github-actions[bot]'), commit('dependabot[bot]')],
    'tonio-alucema'
  );

  assert.deepEqual(result.informational, []);
});

test('checkCoauthors: lists each contributor once, however many commits they wrote', () => {
  const result = checkCoauthors(
    [commit('stubbi', 'Jannes Stubbemann'), commit('stubbi', 'Jannes Stubbemann')],
    'tonio-alucema'
  );

  const trailers = result.informational[0].match(/Co-Authored-By:/g) ?? [];
  assert.equal(trailers.length, 1);
});

test('checkCoauthors: falls back to the raw git author when GitHub matched no account', () => {
  // A commit authored with an email GitHub cannot resolve still deserves a
  // trailer — that is precisely the identity most likely to be lost.
  const result = checkCoauthors(
    [{ author: null, commit: { author: { name: 'Ada Lovelace', email: 'ada@example.com' } } }],
    'tonio-alucema'
  );

  assert.match(result.informational[0], /Co-Authored-By: Ada Lovelace <ada@example\.com>/);
});

test('checkCoauthors: skips an unattributable commit rather than emitting a broken trailer', () => {
  const result = checkCoauthors(
    [{ author: null, commit: { author: { name: 'Nameless', email: null } } }],
    'tonio-alucema'
  );

  assert.deepEqual(result.informational, []);
});

test('checkCoauthors: names the count rather than everyone when several contributed', () => {
  const result = checkCoauthors(
    [commit('stubbi', 'Jannes Stubbemann'), commit('elJayAdvisor', 'LJ')],
    'tonio-alucema'
  );

  assert.match(result.informational[0], /2 other contributors/);
  assert.match(result.informational[0], /Jannes Stubbemann/);
  assert.match(result.informational[0], /LJ/);
});

test('checkCoauthors: tolerates a PR with no commits', () => {
  assert.deepEqual(checkCoauthors([], 'tonio-alucema').informational, []);
  assert.deepEqual(checkCoauthors(undefined, 'tonio-alucema').informational, []);
});

test('fetchAllPullRequestCommits: pages until a short batch', async () => {
  const seen = [];
  const commits = await fetchAllPullRequestCommits(async (path) => {
    seen.push(path);
    if (path.endsWith('page=1')) return Array.from({ length: 100 }, () => commit('stubbi'));
    return [commit('tonio-alucema')];
  }, 'paperclipai/paperclip', 9900, 'token');

  assert.equal(commits.length, 101);
  assert.equal(seen.length, 2);
});

test('fetchAllPullRequestCommits: stops at the API ceiling instead of looping', async () => {
  // `/pulls/{n}/commits` caps at 250 and keeps returning full pages of nothing
  // new past that. A branch that large is not what this gate is about, but it
  // must not spin.
  let calls = 0;
  const commits = await fetchAllPullRequestCommits(async () => {
    calls += 1;
    return Array.from({ length: 100 }, () => commit('stubbi'));
  }, 'paperclipai/paperclip', 9900, 'token');

  assert.equal(calls, 3);
  assert.equal(commits.length, 300);
});

test('checkCoauthors: counts one person once when their git name varies across commits', () => {
  // People change their git config. Keying the dedup on the rendered trailer
  // would put two lines for the same contributor into the squash body.
  const result = checkCoauthors(
    [commit('stubbi', 'Jannes Stubbemann'), commit('stubbi', 'J. Stubbemann')],
    'tonio-alucema'
  );

  const trailers = result.informational[0].match(/Co-Authored-By:/g) ?? [];
  assert.equal(trailers.length, 1);
  assert.doesNotMatch(result.informational[0], /other contributors/);
});

test('checkCoauthors: does not credit the PR author as a co-author of themselves', () => {
  // Their own commit, authored with an email GitHub could not match to the
  // account. Without the guard they appear in their own trailer list.
  const byName = checkCoauthors(
    [{ author: null, commit: { author: { name: 'tonio-alucema', email: 'tonio@example.com' } } }],
    'tonio-alucema'
  );
  const byEmail = checkCoauthors(
    [{ author: null, commit: { author: { name: 'Tonio', email: 'tonio-alucema@users.noreply.github.com' } } }],
    'tonio-alucema'
  );

  assert.deepEqual(byName.informational, []);
  assert.deepEqual(byEmail.informational, []);
});

test('checkCoauthors: counts one person once when some commits matched their account and some did not', () => {
  // The mixed case: GitHub resolved one commit to the login and left another
  // unmatched, both carrying the same email. Keying on login alone emits two
  // trailers for one contributor.
  const result = checkCoauthors(
    [
      commit('stubbi', 'Jannes Stubbemann', 'jannes@example.com'),
      { author: null, commit: { author: { name: 'Jannes Stubbemann', email: 'jannes@example.com' } } },
    ],
    'tonio-alucema'
  );

  const trailers = result.informational[0].match(/Co-Authored-By:/g) ?? [];
  assert.equal(trailers.length, 1);
});

function unmatched(name, email) {
  return { author: null, commit: { author: { name, email } } };
}

/** The collision note specifically — the trailer block quotes the same address. */
function collisionNote(result) {
  return result.informational.find(line => line.includes('is credited to'));
}

function unverifiedNote(result) {
  return result.informational.find(line => line.includes('Nothing verified'));
}

test('checkCoauthors: names both parties when two people share one local identity', () => {
  // The failure this gate exists to prevent, reached through its own de-dup. Two
  // distinct agents configured with the same generic fleet identity: the second
  // is genuinely a duplicate of the first *address*, and genuinely a person whose
  // credit then disappears. Before this, `Agent B` was absent and the note read
  // as though only `Agent A` had ever contributed.
  const result = checkCoauthors(
    [unmatched('Agent A', 'agent@paperclip.local'), unmatched('Agent B', 'agent@paperclip.local')],
    'tonio-alucema'
  );

  const note = collisionNote(result);
  assert.ok(note, 'the shared address is reported');
  assert.match(note, /`agent@paperclip\.local`/);
  assert.match(note, /`Agent A`/);
  assert.match(note, /`Agent B`/);
  assert.match(note, /credit the second by hand/);
});

test('checkCoauthors: says nothing about a collision when the shared identity is one person', () => {
  // The control for the test above. Same address, same name, twice: a real
  // duplicate, and reporting it would be noise on every rebase of a branch. The
  // unverified note still fires — that is the separate defect — so this asserts
  // on the collision specifically.
  const result = checkCoauthors(
    [unmatched('Agent A', 'agent@paperclip.local'), unmatched('Agent A', 'agent@paperclip.local')],
    'tonio-alucema'
  );

  assert.equal(collisionNote(result), undefined);
  const trailers = result.informational[0].match(/Co-Authored-By:/g) ?? [];
  assert.equal(trailers.length, 1);
});

test('checkCoauthors: names both parties when two GitHub accounts share one git email', () => {
  // The same loss reached through the other de-dup key. Two different accounts
  // carrying the same `user.email`; keying on login keeps the first, and the
  // email de-dup would have dropped the second without a word.
  const result = checkCoauthors(
    [
      commit('alice', 'Alice', 'shared@paperclip.local'),
      commit('bob', 'Bob', 'shared@paperclip.local'),
    ],
    'tonio-alucema'
  );

  const note = collisionNote(result);
  assert.ok(note, 'the shared address is reported');
  assert.match(note, /`Alice`/);
  assert.match(note, /`Bob`/);
  // GitHub resolved both accounts, so neither trailer is an unverified guess.
  assert.equal(unverifiedNote(result), undefined);
});

test('checkCoauthors: does not call a git rename by one person a collision', () => {
  // The false positive this must avoid. One account, two display names, two
  // different git emails — that is a person editing their config, already
  // covered by the one-person-one-trailer rule. No address was shared, so
  // nothing collided.
  const result = checkCoauthors(
    [
      commit('stubbi', 'Jannes Stubbemann', 'jannes@example.com'),
      commit('stubbi', 'J. Stubbemann', 'jannes@work.example.com'),
    ],
    'tonio-alucema'
  );

  assert.equal(collisionNote(result), undefined);
  const trailers = result.informational[0].match(/Co-Authored-By:/g) ?? [];
  assert.equal(trailers.length, 1);
});

test('checkCoauthors: warns that a local identity was never verified, and still emits the trailer', () => {
  // Defect 1. Every agent here works out of a per-agent worktree, and the
  // repo-local identity in one is whatever the last `git config` left there — so
  // a commit can be credited to whichever agent configured the tree rather than
  // the one who wrote it. Nothing at PR time can resolve that, but it must not
  // pass unremarked in a gate whose stated purpose is not losing credit.
  const result = checkCoauthors([unmatched('Hephaestus', 'hephaestus@paperclip.local')], 'tonio-alucema');

  assert.match(result.informational[0], /Co-Authored-By: Hephaestus <hephaestus@paperclip\.local>/);
  const note = result.informational.find(line => line.includes('Nothing verified'));
  assert.ok(note, 'the unverified identity is reported');
  assert.match(note, /Hephaestus <hephaestus@paperclip\.local>/);
  assert.match(note, /worktree keeps its config across tasks/);
});

test('checkCoauthors: does not warn about a routable address GitHub could not match', () => {
  // The control for the test above. An unmatched commit with a real mail
  // domain is the ordinary case the fallback exists for; warning on it would
  // fire on every human contributor.
  const result = checkCoauthors([unmatched('Ada Lovelace', 'ada@example.com')], 'tonio-alucema');

  assert.equal(unverifiedNote(result), undefined);
  assert.match(result.informational[0], /Co-Authored-By: Ada Lovelace <ada@example\.com>/);
});

test('checkCoauthors: does not warn about a local address GitHub matched to an account', () => {
  // GitHub resolved this person, so the credit does not rest on the tree's
  // config whatever the commit's own email field happens to say.
  const result = checkCoauthors(
    [commit('stubbi', 'Jannes Stubbemann', 'jannes@paperclip.local')],
    'tonio-alucema'
  );

  assert.equal(unverifiedNote(result), undefined);
  assert.match(
    result.informational[0],
    /Co-Authored-By: Jannes Stubbemann <stubbi@users\.noreply\.github\.com>/
  );
});

test('checkCoauthors: treats a bare domain as a local identity', () => {
  // `user.email = hephaestus@paperclip` has no dot to be a mail domain. It is
  // the same unverified machine default, spelled without the mDNS suffix.
  const result = checkCoauthors([unmatched('Hephaestus', 'hephaestus@paperclip')], 'tonio-alucema');

  assert.ok(unverifiedNote(result), 'the unverified identity is reported');
});

test('checkCoauthors: stays quiet when the branch is the PR author\'s own work on a local identity', () => {
  // The fleet authors its own commits with local identities, so the unverified
  // note must not fire on every single PR this repository opens.
  const result = checkCoauthors(
    [unmatched('prometheus', 'prometheus@paperclip.local')],
    'prometheus'
  );

  assert.deepEqual(result.informational, []);
});

test('checkCoauthors: reports an unshared second person rather than dropping them', () => {
  // The case the original de-dup got right and must keep getting right, next to
  // the one it got wrong: two distinct routable addresses are two trailers and no
  // collision note.
  const result = checkCoauthors(
    [unmatched('Ada Lovelace', 'ada@example.com'), unmatched('Grace Hopper', 'grace@example.org')],
    'tonio-alucema'
  );

  assert.equal(collisionNote(result), undefined);
  assert.equal(unverifiedNote(result), undefined);
  const trailers = result.informational[0].match(/Co-Authored-By:/g) ?? [];
  assert.equal(trailers.length, 2);
  assert.match(result.informational[0], /2 other contributors/);
});
