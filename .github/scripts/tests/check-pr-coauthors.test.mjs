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
  // carries their trailer. Asserted on the trailers note specifically: a matched
  // account whose git name is its human name also gets the unverified-name note
  // below, and that is a separate claim with its own tests.
  const result = checkCoauthors(
    [commit('stubbi', 'Jannes Stubbemann'), commit('tonio-alucema')],
    'tonio-alucema'
  );

  const note = trailersNote(result);
  assert.ok(note, 'the trailer is handed over');
  assert.match(note, /Jannes Stubbemann/);
  assert.match(note, /Co-Authored-By: Jannes Stubbemann <stubbi@users\.noreply\.github\.com>/);
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

/** The trailer hand-over specifically — the other notes quote its lines. */
function trailersNote(result) {
  return result.informational.find(line => line.includes('Squash-merging drops that authorship'));
}

function unverifiedIdentities(result) {
  return [...(unverifiedNote(result) ?? '').matchAll(/`([^`]+ <[^`]+>)`/g)].map(m => m[1]);
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
  assert.match(note, /credit the others by hand/);
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

test('checkCoauthors: says the ADDRESS is verified when GitHub matched it, and the name is not', () => {
  // The address here is GitHub's own, and that part is verified. The name is
  // still `user.name` out of the committing tree, and a per-agent worktree
  // outlives the task that configured it — so the note now fires, and fires on
  // the name rather than on the address.
  //
  // This test previously asserted the opposite, on the reasoning that a resolved
  // account settles the credit. That is true of the address and false of the
  // name, which is the same unverified-name shape as the worktree case below.
  // Accepted cost: a human co-author whose real name differs from their handle
  // now gets this line too. The gate cannot tell a real name from a leaked
  // worktree name without a heuristic, and this file's stated bias is to say so
  // rather than stay silent. `passed` is unaffected either way, so it cannot
  // block the PR.
  const result = checkCoauthors(
    [commit('stubbi', 'Jannes Stubbemann', 'jannes@paperclip.local')],
    'tonio-alucema'
  );

  const note = unverifiedNote(result);
  assert.ok(note, 'the unverified name is reported');
  assert.match(note, /Jannes Stubbemann <stubbi@users\.noreply\.github\.com>/);
  assert.match(note, /name on it is unverified/);
  // Still emitted, and still pointing at the account GitHub resolved.
  assert.match(
    trailersNote(result),
    /Co-Authored-By: Jannes Stubbemann <stubbi@users\.noreply\.github\.com>/
  );
});

test('checkCoauthors: does not call a real name on a matched account unverified', () => {
  // The control for the test above, and the one that keeps the note affordable.
  // When the git name IS the login there is no unverified name to report, so the
  // ordinary matched commit stays a single note.
  const result = checkCoauthors(
    [commit('stubbi', 'stubbi', 'jannes@paperclip.local')],
    'tonio-alucema'
  );

  assert.equal(unverifiedNote(result), undefined);
});

test('checkCoauthors: reports a worktree name attached to a real account', () => {
  // B3. The trailer links to the right account and is labelled with whatever
  // configured the tree. `wt-pet211-ultron1-build` is the kind of name
  // `git worktree` leaves behind, and the file header cites worktrees outliving
  // their task as the reason this defect exists — yet the name was read out of
  // that same config in the matched path too, where nothing flagged it.
  const result = checkCoauthors(
    [commit('stubbi', 'wt-pet211-ultron1-build', 'build@box.local')],
    'tonio-alucema'
  );

  assert.match(
    trailersNote(result),
    /Co-Authored-By: wt-pet211-ultron1-build <stubbi@users\.noreply\.github\.com>/
  );
  const note = unverifiedNote(result);
  assert.ok(note, 'the name is reported as unverified');
  assert.match(note, /name on it is unverified/);
  assert.match(note, /worktree keeps its config across tasks/);
});

test('checkCoauthors: falls back to the address when a commit carries no usable name', () => {
  // A name that is only whitespace is not a name. Rendering it produces a
  // trailer nobody can read, and for a matched account the address's local part
  // is the login, which is the identity exactly.
  const matched = checkCoauthors(
    [commit('stubbi', '   ', 'jannes@paperclip.local')],
    'tonio-alucema'
  );

  assert.match(trailersNote(matched), /Co-Authored-By: stubbi <stubbi@users\.noreply\.github\.com>/);
  assert.equal(unverifiedNote(matched), undefined);
});

test('checkCoauthors: does not call one account\'s git rename a shared identity', () => {
  // B1. One person, one account, one address, two git names — a config edit.
  // The account de-dup is what collapses them, and it is right to: the note's
  // remedy is to hand-paste the second name, which for a matched account means
  // a second trailer for a contributor who already has one, the exact thing the
  // de-dup exists to prevent.
  const localAddress = checkCoauthors(
    [
      commit('stubbi', 'Jannes Stubbemann', 'build@box.local'),
      commit('stubbi', 'J. Stubbemann', 'build@box.local'),
    ],
    'tonio-alucema'
  );
  const routableAddress = checkCoauthors(
    [
      commit('stubbi', 'Jannes Stubbemann', 'jannes@example.com'),
      commit('stubbi', 'J. Stubbemann', 'jannes@example.com'),
    ],
    'tonio-alucema'
  );

  assert.equal(collisionNote(localAddress), undefined);
  assert.equal(collisionNote(routableAddress), undefined);
  assert.equal(
    (trailersNote(localAddress).match(/Co-Authored-By:/g) ?? []).length,
    1
  );
});

test('checkCoauthors: still reports two unmatched agents on one address after the account guard', () => {
  // The regression the account guard must not introduce. Gating the collision on
  // `!contributors.has(key)` — the obvious form — silences THIS case, because an
  // unmatched commit's key falls back to the address, so the second agent
  // collides with the first on the key and the note never fires. That is the
  // exact loss this issue was filed for, so the guard is on the login instead.
  const result = checkCoauthors(
    [unmatched('Agent A', 'agent@paperclip.local'), unmatched('Agent B', 'agent@paperclip.local')],
    'tonio-alucema'
  );

  const note = collisionNote(result);
  assert.ok(note, 'the second agent is still reported');
  assert.match(note, /`Agent B`/);
});

test('checkCoauthors: does not call names that differ only in case two people', () => {
  // B2. Every other identity comparison in the file is case-folded; this one
  // was not, so a person whose name is capitalised differently on one commit
  // read as two contributors sharing an address.
  const caseOnly = checkCoauthors(
    [unmatched('Agent A', 'agent@paperclip.local'), unmatched('agent a', 'agent@paperclip.local')],
    'tonio-alucema'
  );
  const trailingSpace = checkCoauthors(
    [unmatched('Agent A', 'agent@paperclip.local'), unmatched('Agent A ', 'agent@paperclip.local')],
    'tonio-alucema'
  );

  assert.equal(collisionNote(caseOnly), undefined);
  assert.equal(collisionNote(trailingSpace), undefined);
});

test('checkCoauthors: does not call a matched-then-unmatched pair two people', () => {
  // B2 again, on the case the `seenEmails` map exists for: one commit matched to
  // the account, the next authored with an address GitHub does not know, same
  // address, same name. The email de-dup drops the second, which is correct —
  // it is one person — so calling it a collision sends the merger to paste a
  // duplicate trailer.
  const result = checkCoauthors(
    [
      commit('alice', 'Alice', 'a@box.local'),
      unmatched('alice', 'a@box.local'),
    ],
    'tonio-alucema'
  );

  assert.equal(collisionNote(result), undefined);
  assert.equal((trailersNote(result).match(/Co-Authored-By:/g) ?? []).length, 1);
});

test('checkCoauthors: renders a name without the whitespace it was authored with', () => {
  // The comparison fix has to reach the rendered line too, or the squash body
  // carries a trailer git will not parse as a name.
  const result = checkCoauthors(
    [unmatched('  Agent A  ', 'agent@paperclip.local')],
    'tonio-alucema'
  );

  assert.match(trailersNote(result), /Co-Authored-By: Agent A <agent@paperclip\.local>$/m);
});

test('checkCoauthors: lists three names on one address as a list, and says how many', () => {
  // N1. `a` and `b` and `c` reads as a chain of pairs, and the sentence claimed
  // "two names" whatever the count was.
  const result = checkCoauthors(
    [
      unmatched('Alice', 'shared@paperclip.local'),
      unmatched('Bob', 'shared@paperclip.local'),
      unmatched('Carol', 'shared@paperclip.local'),
    ],
    'tonio-alucema'
  );

  const note = collisionNote(result);
  assert.match(note, /`Alice`, `Bob`, and `Carol`/);
  assert.match(note, /One address under 3 names/);
});

test('checkCoauthors: does not name the premise as a local identity when one side is an account', () => {
  // One commit matched to an account, the next not, same address, genuinely
  // different names. This fires, and it should: the second name is a lost
  // credit. But the note must not claim both are "sharing a local git
  // identity" — one of them is a GitHub account — and its remedy must be the
  // one that adds a line, not the one that replaces one.
  const result = checkCoauthors(
    [commit('alice', 'Alice', 'a@box.local'), unmatched('Bob', 'a@box.local')],
    'tonio-alucema'
  );

  const note = collisionNote(result);
  assert.ok(note, 'the lost name is reported');
  assert.doesNotMatch(note, /sharing a local git identity/);
  assert.match(note, /so only `Alice` is carried above/);
  // The carried trailer is the matched account's, so following the remedy adds
  // Bob's raw address rather than a second line for Alice.
  assert.match(trailersNote(result), /Co-Authored-By: Alice <alice@users\.noreply\.github\.com>$/m);
});

test('checkCoauthors: names the party it carried rather than calling it the first', () => {
  // N2. "the first" meant first in commit order; the trailer block above is
  // sorted, so a reader scanning it top-down reads the note backwards.
  const result = checkCoauthors(
    [unmatched('Zeta', 'z@x.local'), unmatched('Alpha', 'z@x.local')],
    'tonio-alucema'
  );

  const note = collisionNote(result);
  assert.match(note, /so only `Zeta` is carried above/);
  assert.doesNotMatch(note, /only the first/);
});

test('checkCoauthors: treats the reserved special-use domains as local identities', () => {
  // B4. The docstring claimed these were covered; `.localhost` was the only one
  // listed. `example.com` and `@users.noreply.github.com` must stay quiet.
  for (const domain of ['example.test', 'example.invalid', 'example.example', 'box.lan', 'host.localdomain']) {
    const result = checkCoauthors([unmatched('H', `e@${domain}`)], 'tonio-alucema');

    assert.ok(
      unverifiedNote(result),
      `${domain} cannot carry mail, so nothing outside the machine has seen it`
    );
  }

  assert.equal(unverifiedNote(checkCoauthors([unmatched('H', 'e@example.com')], 'tonio-alucema')), undefined);
  assert.equal(
    unverifiedNote(checkCoauthors([commit('stubbi', 'stubbi', 'e@users.noreply.github.com')], 'tonio-alucema')),
    undefined
  );
});

test('checkCoauthors: reports each unverified trailer once, and says which part is unverified', () => {
  // Two commits by two agents on two unroutable addresses, one of which GitHub
  // matched. The reasons differ, so they are stated apart rather than flattened
  // into a claim that both are unroutable.
  const result = checkCoauthors(
    [
      unmatched('Hephaestus', 'hephaestus@paperclip.local'),
      commit('stubbi', 'Hephaestus Renamed', 'other@paperclip.local'),
    ],
    'tonio-alucema'
  );

  const identities = unverifiedIdentities(result);
  assert.equal(new Set(identities).size, identities.length);
  assert.equal(identities.length, 2);
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
