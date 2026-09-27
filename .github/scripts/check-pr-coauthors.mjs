#!/usr/bin/env node
/**
 * check-pr-coauthors.mjs
 * Surfaces the `Co-Authored-By` trailers a squash merge needs to keep
 * contributors credited.
 * Export: checkCoauthors(commits, prAuthor) → { passed, informational }
 *
 * This repository squash-merges, so every commit on a branch collapses into
 * one commit authored by whoever presses the button. When a branch carries
 * someone else's work — a rebase of a stale contributor PR, a port of an
 * abandoned branch, a pairing session — their name survives only if the squash
 * message carries a `Co-Authored-By` trailer for them. Nothing prompts for it,
 * and the PR page keeps showing the original author either way, so the loss is
 * invisible at exactly the moment it happens.
 *
 * Identity matching is a heuristic and is deliberately biased. A commit GitHub
 * could not match to an account is credited unless its name or email resolves
 * to the PR author, which will occasionally credit someone as a co-author of
 * themselves — their git config carrying a real name where the comparison has
 * only a login. That error costs a line a human drops while pasting. The
 * opposite error costs a contributor their attribution silently, which is the
 * failure this gate exists to prevent, so the bias runs towards over-crediting.
 *
 * Two things that cost a contributor their credit are reported rather than
 * resolved, because neither has a correct answer this gate can compute:
 *
 * - A shared identity. When one address arrives under two names that differ,
 *   that is two people sharing a generic local identity as often as it is one
 *   person who changed their git config. De-duplicating is right; dropping the
 *   second name is still a lost attribution, so both spellings are named.
 *   The one case this resolves rather than reports is when both commits
 *   resolve to the same login: the de-dup there is collapsing one account, so
 *   a name change under it is a config edit, and the note's remedy would add a
 *   second trailer for a contributor who already has one.
 * - An unverified credit. A GitHub match proves an *address* belongs to an
 *   account; it says nothing about `user.name`, and the name is read out of
 *   whatever `git config` the committing tree carried either way. A per-agent
 *   worktree outlives the task that configured it, so the name on a trailer can
 *   be a different agent's. The trailer is still emitted — it is the best guess
 *   available — but the note says plainly that nothing verified it, and which of
 *   the two things was unverified.
 *
 * The two biases above govern different decisions and do not contradict each
 * other. Over-crediting answers whether to emit a trailer at all, where the
 * answer is yes even when unverified. Reporting a shared identity answers
 * whether to de-duplicate an address that arrived under two names, where
 * collapsing it is right and staying silent about the loser is not.
 *
 * Informational rather than a failure, on purpose. The squash message does not
 * exist while the PR is open, so this cannot be verified here and cannot be
 * fixed here either. Failing the PR would block work on something its author
 * has no way to satisfy. What this can do is notice that the situation applies
 * and hand over the exact lines to paste.
 */
import { fileURLToPath } from 'node:url';

/**
 * Fetches every commit on a PR across GitHub pagination.
 *
 * Capped at the API's own ceiling: `/pulls/{n}/commits` returns at most 250
 * commits and silently stops. A branch that large is not the case this gate is
 * about, and a partial list still surfaces the contributors it did see.
 */
export async function fetchAllPullRequestCommits(ghFetchFn, repo, prNumber, token) {
  const commits = [];

  for (let page = 1; page <= 3; page += 1) {
    const batch = await ghFetchFn(
      `/repos/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`,
      token
    );
    commits.push(...batch);

    if (batch.length < 100) break;
  }

  return commits;
}

/** GitHub's own no-reply address for a login, which is what trailers should use. */
function noReplyEmail(login) {
  return `${login}@users.noreply.github.com`;
}

/**
 * Domains that cannot carry someone's mail, so an address in one is a machine
 * default rather than an identity anything outside the machine has verified.
 * `.local` is the mDNS name (RFC 6762 §3); `.localhost`, `.test`, `.invalid` and
 * `.example` are RFC 6761 §6; `home.arpa` is RFC 8375; and `.internal` is
 * reserved from delegation by ICANN Board Resolution 2024.07.29.06 — a root-zone
 * reservation, not a special-use designation, which is why it is not in IANA's
 * special-use registry. `localdomain` is a single-label name with no delegation
 * in the root zone, so a bare `localdomain` is caught by the no-dot rule below
 * and `host.localdomain` by this regex, and `.lan` is ad-hoc private use with no
 * reservation and no root-zone entry (RFC 6762 Appendix G); both are unroutable
 * for want of a reservation rather than by one. A domain with no dot at all is
 * the same story.
 */
const LOCAL_ONLY_DOMAIN =
  /\.(localdomain|localhost|local|internal|home\.arpa|test|invalid|example|lan)$/i;

function isLocalOnlyIdentity(email) {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  // No `@`, or a leading one: not an address, so nothing could have verified it.
  if (at < 1) return true;
  const domain = email.slice(at + 1);
  if (!domain.includes('.')) return true;
  return LOCAL_ONLY_DOMAIN.test(domain);
}

/**
 * Whether two spellings are one name. Every other identity comparison in this
 * file is case-folded because GitHub logins and mail domains are; a name is no
 * different, and a trailing space is not part of anyone's name.
 */
function sameName(a, b) {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

/** `a` and `b`, or `a`, `b`, and `c` — past two a bare `and` reads as pairs. */
function listNames(names) {
  const quoted = names.map(n => `\`${n}\``);
  if (quoted.length === 2) return quoted.join(' and ');
  return `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`;
}

export function checkCoauthors(commits, prAuthor) {
  const author = (prAuthor ?? '').toLowerCase();
  const contributors = new Map();
  // Emails already accounted for, mapped to the display name credited for them.
  // One person can appear both ways in the same branch — some commits matched to
  // their account, some authored with an email GitHub does not know — and keying
  // on login alone would then emit two trailers for them, so both keys are
  // checked. That only collapses the pair when the unmatched commit carries the
  // same address; a matched commit at one address and an unmatched commit at
  // another still emits both. Pre-existing, and out of scope for the collision
  // work — noted here so the next reader does not assume the guarantee is wider
  // than the key it is keyed on.
  const seenEmails = new Map();
  // Addresses that arrived under more than one name, mapped to the name already
  // credited for them plus every name seen. Two people sharing one generic
  // local identity is indistinguishable here from one person who edited their
  // git config, so the names are reported rather than resolved: whoever the
  // de-dup drops has still lost their credit.
  const collisions = new Map();
  // Trailers whose credit rests on the committing tree's git config rather than
  // on anything GitHub verified, in the order first seen. Two reasons, because
  // they are two different failures: an address nothing can route means no mail
  // has ever reached it and the address is a machine default, while a matched
  // address with a name from the tree means the account is right and the label
  // on it may belong to a stale worktree. Each reason is scoped to what its
  // evidence covers — the address is unverified in the first case, the name in
  // the second — because a matched commit in the same block may already have
  // put a verified address for the same person two lines up.
  const unverified = [];
  const unverifiedIds = new Set();

  for (const entry of commits ?? []) {
    const login = entry?.author?.login ?? null;
    const gitName = entry?.commit?.author?.name ?? null;
    const gitEmail = entry?.commit?.author?.email ?? null;

    // The PR author's own commits need no trailer — the squash is already
    // theirs. Compared case-insensitively because GitHub logins are.
    if (login && author && login.toLowerCase() === author) continue;

    // Bots author plenty of commits and crediting them is noise.
    if (login && /\[bot\]$/.test(login)) continue;
    if (!login && !gitName) continue;

    // A commit GitHub could not match to an account may still be the PR
    // author's own — their git config carrying an email GitHub does not know.
    // Without this they are listed as a co-author of themselves.
    if (!login && author) {
      const nameMatches = gitName && gitName.toLowerCase() === author;
      const emailMatches = gitEmail && gitEmail.toLowerCase().startsWith(`${author}@`);
      if (nameMatches || emailMatches) continue;
    }

    // Prefer the GitHub identity, so the trailer links to a profile. Fall back
    // to the raw git author for a commit GitHub could not match to an account.
    const name = login ?? gitName;
    const email = login ? noReplyEmail(login) : gitEmail;
    if (!email) continue;

    // Resolved before the de-dup, because deciding whether a name is new is the
    // question the de-dup is answering. Trimmed first: surrounding whitespace is
    // not part of an identity, and a trailer rendered with it is malformed. A
    // name that is empty or only whitespace falls back to the address's local
    // part — which for a matched account is the login, i.e. exactly right — and
    // the commit is dropped if even that is empty, rather than emitting a
    // trailer nobody can read.
    const rawDisplayName = gitName && login ? gitName : name;
    const displayName = (rawDisplayName ?? '').trim() || email.split('@')[0].trim() || null;
    if (!displayName) continue;

    // Keyed on identity, not on the rendered line. One person whose git config
    // name changed across commits is still one person, and emitting them twice
    // would put two trailers for the same contributor into the squash body.
    const key = (login ?? gitEmail ?? name).toLowerCase();
    const emailKey = (gitEmail ?? '').toLowerCase();

    // The same address already credited under a different name. Checked ahead
    // of the de-dup so it also fires when the `key` de-dup is what would drop
    // this commit — which is the whole case when neither commit was matched to
    // an account, since then `key` is the address itself.
    //
    // Except when the de-dup about to run is an *account* de-dup: this commit
    // resolves to a login already credited, so one person wrote both under two
    // git names. That is a config edit, not a shared identity, and calling it a
    // collision would tell the merger to hand-paste a second trailer for a
    // contributor who already has one — the exact thing the de-dup below exists
    // to prevent, with two notes in one function contradicting each other.
    // Gating on the login, not on `contributors.has(key)`: for an unmatched
    // commit the key *is* the address, so keying on it would silence the
    // shared-identity case this note exists for.
    const droppedByAccountDedup = Boolean(login) && contributors.has(key);
    if (
      !droppedByAccountDedup &&
      emailKey &&
      seenEmails.has(emailKey) &&
      !sameName(seenEmails.get(emailKey), displayName)
    ) {
      // Seeded with the name already credited, so the note names both parties:
      // the one whose trailer was emitted and the one whose credit is now in
      // question.
      if (!collisions.has(emailKey)) {
        const carried = seenEmails.get(emailKey) || displayName;
        collisions.set(emailKey, { carried, names: new Set([carried]) });
      }
      collisions.get(emailKey).names.add(displayName);
    }

    if (contributors.has(key)) continue;
    if (emailKey && seenEmails.has(emailKey)) continue;
    if (emailKey) seenEmails.set(emailKey, displayName);

    // Nothing verified this trailer. A GitHub match proves the address belongs
    // to an account and says nothing about the name, which is read out of the
    // committing tree in both branches above — so the note is about the name,
    // and the two reasons are recorded apart because they read differently to
    // whoever is fixing them.
    if (login) {
      if (!sameName(displayName, login)) {
        const id = `${displayName} <${email}>`;
        if (!unverifiedIds.has(id)) {
          unverifiedIds.add(id);
          unverified.push({ id, reason: 'unverified-name' });
        }
      }
    } else if (isLocalOnlyIdentity(gitEmail)) {
      const id = `${displayName} <${gitEmail}>`;
      if (!unverifiedIds.has(id)) {
        unverifiedIds.add(id);
        unverified.push({ id, reason: 'unroutable-address' });
      }
    }

    contributors.set(key, {
      trailer: `Co-Authored-By: ${displayName} <${email}>`,
      name: displayName,
    });
  }

  const informational = [];

  if (contributors.size > 0) {
    const trailers = [...contributors.values()].map(c => c.trailer).sort();
    const names = [...new Set([...contributors.values()].map(c => c.name))].sort();
    const who = names.length === 1 ? names[0] : `${names.length} other contributors`;

    informational.push(
      `This branch carries commits by ${who}. Squash-merging drops that authorship unless ` +
      'the squash message carries their trailers, and nothing else will notice if it does not. ' +
      'Add to the squash body when merging:\n\n' +
      trailers.map(line => `      ${line}`).join('\n')
    );
  }

  for (const [address, { carried, names }] of collisions) {
    const named = [...names].filter(Boolean).sort();
    if (named.length < 2) continue;
    // The carried party is named rather than called "the first": the trailer
    // block above is sorted, so "first" does not mean what a reader scanning
    // that list top-down takes it to mean.
    //
    // Both fallbacks below are unreachable. `carried` is seeded from a name that
    // only reached `seenEmails` after the empty-name skip, and `names` is seeded
    // with it, so neither list can hold an empty entry. They are kept so that a
    // future change which stores an empty name degrades to naming a real party
    // rather than rendering `undefined` into a note a merger pastes by hand.
    const carriedName = carried ? `\`${carried}\`` : `\`${named[0]}\``;
    informational.push(
      `\`${address}\` is credited to ${listNames(named)}, so only ${carriedName} is carried above. ` +
      `One address under ${named.length} names is one person who edited their config at least as ` +
      'often as it is two people sharing a generic identity, and this cannot tell them apart — ' +
      'credit the others by hand, or set a distinct `user.email` per contributor.'
    );
  }

  if (unverified.length > 0) {
    const one = unverified.length === 1;
    const reasons = unverified.map(({ id, reason }) =>
      reason === 'unroutable-address'
        ? `\`${id}\` has no routable address, so nothing outside the machine has ever seen this address`
        : `\`${id}\` is a GitHub account's own address, but the name on it is unverified`
    );
    informational.push(
      `Nothing verified ${one ? 'this trailer' : 'these trailers'}: ${reasons.join('; ')}. ` +
      'A GitHub match proves an address belongs to an account and says nothing about `user.name`, ' +
      'and a worktree keeps its config across tasks — so an unverified name can credit whichever ' +
      'agent configured the tree rather than the one who wrote the commit. Re-author with ' +
      '`git -c user.name=... -c user.email=...` and force-push if a name is wrong.'
    );
  }

  if (informational.length === 0) return { passed: true, informational: [] };

  return { passed: true, informational };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commits = JSON.parse(process.env.PR_COMMITS ?? '[]');
  const result = checkCoauthors(commits, process.env.PR_AUTHOR ?? '');
  console.log(JSON.stringify(result));
  process.exit(0);
}
