#!/usr/bin/env node
/**
 * check-pr-coauthors.mjs
 * Hands over the `Co-Authored-By` trailers a squash merge needs to keep
 * contributors credited, and fails a branch that already carries a trailer
 * this repository's contribution rules do not accept.
 * Export: checkCoauthors(commits, prAuthor, options) → { passed, failures, informational }
 *
 * This repository squash-merges, so every commit on a branch collapses into
 * one commit authored by whoever presses the button. When a branch carries
 * someone else's work — a rebase of a stale contributor PR, a port of an
 * abandoned branch, a pairing session — their name survives only if the squash
 * message carries a `Co-Authored-By` trailer for them. Nothing prompts for it,
 * and the PR page keeps showing the original author either way, so the loss is
 * invisible at exactly the moment it happens.
 *
 * ## Two questions, and why only one of them blocks
 *
 * The squash message does not exist while the PR is open. So "whose authorship
 * would a squash drop?" cannot be fixed from the PR, and answering it by failing
 * would block work on something its author has no way to satisfy. That half
 * stays informational, and it hands over the exact lines to paste.
 *
 * The commit trailers are the other half, and they do exist while the PR is open.
 * They are a property of the commits, already fetched, and the author can
 * rewrite them. So "does this branch carry a trailer the rules reject?" is
 * answerable now and is a failure when the answer is no. Before this split the
 * gate merged the two questions and answered neither: it could not emit a
 * compliant line, it never failed, and a queue grew where every trailer was
 * defective and no author had a sanctioned path to fix one.
 *
 * A missing trailer is not a failure. No trailer and no foreign authorship is
 * not a violation, and the objection the old header raised against failing
 * still holds for that case: there is nothing on the branch to reject. Only a
 * trailer that is *present and not accepted* fails, and that is always fixable
 * by the author because the trailer is theirs to rewrite.
 *
 * ## What counts as a credit, and what gets normalised
 *
 * A co-author trailer names a person. Two shapes on this fork are not a person:
 *
 * - An instance-local address. `hephaestus@paperclip.local` is a machine
 *   default that no mail outside this machine can reach, and the name beside it
 *   is an internal agent's. Publishing either is publishing an internal
 *   coordinate in permanent history.
 * - An automated mailbox. `noreply@anthropic.com` is a vendor's robot, and a
 *   third party's identity on this repository's commit is not a credit anyone
 *   here can grant.
 *
 * Both are reported as needing the one line the contribution rules accept for a
 * machine-authored commit: `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.
 * The same normalisation applies to the line this gate *hands over*, because a
 * hand-over is a proposal for what should land. A commit by an agent with no
 * GitHub account behind it is credited as `Paperclip` rather than by name — and
 * an author who followed the old hand-over exactly, writing their agent's name
 * and login into a public commit, was worse off than one who ignored it.
 *
 * Two deliberate non-cases, because a gate that invents a violation out of a
 * reading blocks correct work:
 *
 * - A matched GitHub account is never normalised away. Its address is its own
 *   and its name may be wrong, which the unverified note below reports; erasing
 *   a real contributor because their worktree held a local `user.email` is the
 *   attribution loss this file exists to prevent.
 * - A trailer with no address is not judged. A person may write their name
 *   alone, and a name alone cannot be told from an agent's.
 *
 * What this cannot compute is a model name on a routable personal-looking
 * address, which reads as a person. It is left to the reviewer, and the
 * unverified note is what puts it in front of one.
 *
 * ## Identity matching is a heuristic and is deliberately biased
 *
 * A commit GitHub could not match to an account is credited unless its name or
 * email resolves to the PR author, which will occasionally credit someone as a
 * co-author of themselves — their git config carrying a real name where the
 * comparison has only a login. That error costs a line a human drops while
 * pasting. The opposite error costs a contributor their attribution silently,
 * which is the failure this gate exists to prevent, so the bias runs towards
 * over-crediting.
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
 * The biases above govern different decisions and do not contradict each other.
 * Over-crediting answers whether to emit a trailer at all, where the answer is
 * yes even when unverified. Reporting a shared identity answers whether to
 * de-duplicate an address that arrived under two names, where collapsing it is
 * right and staying silent about the loser is not. Neither is traded away to
 * make the new blocking check quieter.
 *
 * ## A note about what a note may print
 *
 * The failure and the hand-over disagree about one thing on purpose. The
 * hand-over is a line to paste into a new permanent commit, so an instance-local
 * identity is normalised out of it. The notes are diagnostics about what is
 * already on the branch — already in the commit, already in this repository's
 * history — so they name the address they are reporting. Removing it would
 * leave a reader unable to tell which commit to rewrite, and it would add no
 * exposure the branch has not already published.
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

/** The one `Co-Authored-By` form this repository's contribution rules accept. */
export const SANCTIONED_TRAILER = 'Co-Authored-By: Paperclip <noreply@paperclip.ing>';

const SANCTIONED_TRAILER_NAME = 'paperclip';
const SANCTIONED_TRAILER_EMAIL = 'noreply@paperclip.ing';

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


/**
 * `Token: value`, which is what a git trailer line is.
 *
 * A token is a word of letters, digits and hyphens, so `Signed-off-by:` and
 * `Co-Authored-By:` both match and `http://example.com` in prose does not start
 * a trailer. Case is deliberately not constrained here — the key comparison
 * below is case-insensitive, as git's own trailer parsing is.
 */
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/;

/**
 * Local parts that are a machine's mailbox, never a person's.
 *
 * A co-author trailer exists to credit a person, and each entry here is a
 * mailbox that a mail system answers rather than a human. `noreply` and
 * `no-reply` are what a vendor or a bot puts in the position a co-author's
 * address occupies, and the domain it is on does not change that: the identity
 * being credited is the vendor's mail relay either way. `users.noreply.github.com`
 * is deliberately not matched by this — GitHub's per-login no-reply address
 * carries the login as its local part, so a real contributor's line is
 * `stubbi@users.noreply.github.com` and reads as the person it is.
 */
const AUTOMATED_MAILBOX = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'notifications',
  'automated',
  'bounces',
  'mailer-daemon',
]);

function isAutomatedMailbox(email) {
  const at = (email ?? '').lastIndexOf('@');
  if (at < 1) return false;
  return AUTOMATED_MAILBOX.has(email.slice(0, at).toLowerCase());
}

/**
 * Splits a trailer value into its display name and address.
 *
 * `Name <address>` is git's own shape, and a value that is a bare address has
 * no name to render. Returns `{ name, email }` with either part possibly null,
 * because "no name" and "no address" are both real on this fork's history and
 * both have to survive to the classifier to be told apart from a violation.
 */
function parseTrailerValue(value) {
  const text = (value ?? '').trim();
  const angled = /^(.*?)\s*<([^<>]*)>\s*$/.exec(text);
  if (angled) {
    return { name: angled[1].trim() || null, email: angled[2].trim() || null };
  }
  return text.includes('@') ? { name: null, email: text } : { name: text || null, email: null };
}

/**
 * Reads the `Co-Authored-By` trailers out of one commit message.
 *
 * Git's own rule, kept whole: a trailer block is the message's last paragraph,
 * and a line in that paragraph that is not `Token: value` means the paragraph is
 * prose. Both halves are load-bearing. Scanning every line of the message would
 * read this repository's own documentation of the rule as a violation of it —
 * a commit whose last line is "add the `Co-Authored-By:` trailer to every commit"
 * is a sentence, not a trailer. Requiring the whole final paragraph to be
 * trailers is what makes the read conservative in the one direction that costs:
 * a prose paragraph is never read as a trailer, so a message that discusses the
 * rule cannot manufacture a failure out of it.
 *
 * @returns {Array<{name: string|null, email: string|null, raw: string}>}
 */
export function readCoauthorTrailers(message) {
  if (typeof message !== 'string' || message.trim() === '') return [];

  const paragraphs = message.trim().split(/\n[ \t]*\n/);
  const lines = paragraphs[paragraphs.length - 1]
    .split(/\r?\n/)
    .filter(line => line.trim() !== '');

  if (lines.length === 0) return [];
  if (!lines.every(line => TRAILER_LINE.test(line))) return [];

  const found = [];
  for (const line of lines) {
    const match = TRAILER_LINE.exec(line);
    if (!match || match[1].toLowerCase() !== 'co-authored-by') continue;
    const { name, email } = parseTrailerValue(match[2]);
    found.push({ name, email, raw: line.trim() });
  }
  return found;
}

/**
 * Decides whether a trailer the branch already carries is one this repository
 * accepts.
 *
 * - `compliant` — a person, or the sanctioned line itself. GitHub's per-login
 *   no-reply address is a person's, so it lands here.
 * - `instance-local` — the address cannot leave this machine, so it names no one
 *   outside it. `isLocalOnlyIdentity` already carries the RFC citations for the
 *   domain list.
 * - `machine-mailbox` — the address is a mail system, not a person.
 * - `agent-name` — the sanctioned address carrying a different name. The
 *   contribution rules ask for the line exactly and ask for no agent name on it,
 *   so the address being right does not settle the trailer.
 * - `unaddressed` — a name with no address. Not a violation: a person may write
 *   their name alone, and this gate cannot tell that from an agent.
 */
function classifyTrailer({ name, email }) {
  if (!email) return { verdict: 'unaddressed', name, email };

  const address = email.trim().toLowerCase();
  if (address === SANCTIONED_TRAILER_EMAIL) {
    return {
      verdict: (name ?? '').trim().toLowerCase() === SANCTIONED_TRAILER_NAME
        ? 'compliant'
        : 'agent-name',
      name,
      email,
    };
  }
  if (isLocalOnlyIdentity(address)) return { verdict: 'instance-local', name, email };
  if (isAutomatedMailbox(address)) return { verdict: 'machine-mailbox', name, email };
  return { verdict: 'compliant', name, email };
}

/**
 * Why one rejected shape is a violation, in the words its own fix needs.
 *
 * Full clauses, capitalised, because the report joins one or two of them into a
 * sentence of their own after the list of offending lines — a fragment spliced
 * into the middle of a report is the kind of thing a reviewer reads past.
 */
const REJECTION = {
  'instance-local':
    'An address that cannot leave this machine names nobody outside it, and the name beside it is an internal agent\'s',
  'machine-mailbox':
    'An automated mailbox is a mail system, not a person, and a third party\'s identity is not a credit this repository grants',
  'agent-name':
    'The sanctioned address carrying an agent name puts the internal name the contribution rules ask to leave out',
};

/** Renders a trailer back to its canonical `Name <address>` form for a report. */
function renderTrailer({ name, email }) {
  if (name && email) return `${name} <${email}>`;
  return name ?? email ?? '(empty)';
}

/**
 * @param {Array<object>} [commits]  entries of `/pulls/{n}/commits`
 * @param {string} prAuthor  the PR author's login
 * @param {object} [options]
 * @param {boolean} [options.commitsUnavailable]  the commit fetch failed, so
 *   this gate read no trailers at all and must not report a clean scan
 * @returns {{passed: boolean, failures: string[], informational: string[]}}
 */
/**
 * Who a squash merge of this branch would drop, and which of them are names
 * whose credit rests on nothing but the committing tree's git config.
 *
 * The reporting half lives in `checkCoauthors`. This is the question both that
 * gate and the post-merge audit need answered identically.
 *
 * @param {Array<object>} [commits]  entries of `/pulls/{n}/commits`
 * @param {string} prAuthor  the PR author's login
 * @returns {{contributors: Map, collisions: Map, unverified: object[]}}
 */
export function collectCoauthors(commits, prAuthor) {
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
    // The committer is whoever applied the commit, which on a rebase or a
    // cherry-pick is not the author. It is read for the machine-identity
    // decision below and for nothing else: crediting the committer would credit
    // whoever ran the rebase.
    const committerEmail = entry?.commit?.committer?.email ?? null;

    // The PR author's own commits need no trailer — the squash is already
    // theirs. Compared case-insensitively because GitHub logins are.
    if (login && author && login.toLowerCase() === author) continue;

    // Bots author plenty of commits and crediting them is noise. Keyed on the
    // login, and only the login, on purpose: GitHub does not always put the
    // `[bot]` marker there. The Copilot coding agent commits as
    // `copilot-swe-agent[bot]` under the account `Copilot`, so this rule reads
    // that commit as a person — and a display name is not a safe substitute,
    // because a person whose `git config user.name` reads `renovate[bot]` under
    // their own login would be dropped, which is the silent loss the co-author
    // gate exists to prevent, reached from the other side. The account type is
    // the discriminating evidence and it is not an input this function has.
    //
    // So the line is prescribed, and `plan-merge-attribution.mjs` annotates it
    // rather than deciding it. A person is never dropped here on the strength of
    // a name.
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

    // A machine identity, and the one thing this file normalises. No GitHub
    // account resolved the commit, so both the name and the address are whatever
    // the local tree carried; when the address is one nothing outside this
    // machine can route, there is no person to credit and the line that can land
    // is the sanctioned one.
    //
    // The committer is corroboration here, not a second trigger. A rebase
    // rewrites it, so on this fork it is an instance-local address on almost
    // every rebased commit, and letting it trigger on its own would erase the
    // credit of a real author whose branch happened to be rebased — the exact
    // attribution loss this file exists to prevent. It is read only when the
    // author side names no address at all, where it is the only one the commit
    // carries.
    const machineIdentity = !login && (
      isLocalOnlyIdentity(gitEmail) ||
      (gitEmail == null && isLocalOnlyIdentity(committerEmail))
    );

    contributors.set(key, {
      trailer: machineIdentity ? SANCTIONED_TRAILER : `Co-Authored-By: ${displayName} <${email}>`,
      name: displayName,
      machine: machineIdentity,
      // Every address this contributor is reachable at, not just the one rendered
      // above. A commit GitHub matched to an account is written with the
      // author's real address, and the trailer deliberately replaces it with the
      // account's no-reply form so the credit links to a profile — which means a
      // squash that kept the original address credits the same person and reads,
      // to anything matching on address alone, as somebody who was never on the
      // branch. Additive and unread by `checkCoauthors`; a post-merge audit needs
      // it to tell that apart from a real loss.
      emails: new Set([emailKey, email.toLowerCase()].filter(Boolean)),
      // The address the commit was actually written with, kept beside the line
      // above because a machine identity's line replaces it. A post-merge report
      // has to name the real author to be actionable; handing it the house
      // identity it was normalised to would name nobody in particular, which is
      // the failure the whole file is written against.
      gitAddress: gitEmail ?? '',
    });
  }

  return { contributors, collisions, unverified };
}

/**
 * The `Co-Authored-By` trailers this branch already carries that the
 * contribution rules do not accept, keyed on the rendered line.
 *
 * A second pass over the same commits, for the reason in `checkCoauthors`: the
 * collection loop above is deciding who a squash would drop, and a defective
 * trailer is a different question with different exclusions.
 */
function readRejectedTrailers(commits) {
  const rejected = new Map();
  // The second question, and a second pass on purpose. The loop above skips the
  // PR author's own commits and bots on the way to deciding who a squash would
  // drop; a rejected trailer is a different question and has no such exclusion.
  // The most common instance is the PR author's own commit carrying someone
  // else's machine identity, which that loop never sees.
  for (const entry of commits ?? []) {
    for (const trailer of readCoauthorTrailers(entry?.commit?.message)) {
      const { verdict } = classifyTrailer(trailer);
      if (verdict === 'compliant' || verdict === 'unaddressed') continue;
      const key = renderTrailer(trailer);
      const prior = rejected.get(key);
      if (prior) {
        prior.commits += 1;
        continue;
      }
      // The key is the identity, so two spellings of one bad credit collapse into
      // one finding; the line reported is the commit's own, because that is the
      // text the author has to find and rewrite.
      rejected.set(key, {
        verdict,
        reason: REJECTION[verdict],
        commits: 1,
        line: trailer.raw || `Co-Authored-By: ${key}`,
      });
    }
  }

  return rejected;
}

export function checkCoauthors(commits, prAuthor, { commitsUnavailable = false } = {}) {
  if (commitsUnavailable) {
    // The gate has a verdict now, so it cannot be the one gate that stays silent
    // about a fetch it did not get. This is the same trade the internal-reference
    // gate makes on the same request, and the same cost: a transient 5xx turns
    // this one result red until the gate is re-run. Reported as a failure rather
    // than a pass because "no trailer on this branch" is a claim this run did not
    // earn, and a defective trailer passing quietly is the defect this half of
    // the gate exists to catch.
    return {
      passed: false,
      failures: [
        'The commit list could not be read, so no `Co-Authored-By` trailer on this branch was checked and this ' +
        'result is not a clean scan. The `/pulls/{n}/commits` fetch is allowed to fail so a transient 5xx cannot ' +
        'take down the gates that do block; the cost is that this gate then has nothing to read. Re-run the gate ' +
        'once the API is reachable. Do not read `passed: true` here as "every trailer on this branch is accepted".',
      ],
      informational: [],
    };
  }

  // The collection half is a separate export because the post-merge audit in
  // `audit-merge-attribution.mjs` has to ask the same question this file asks
  // and get the same answer. Re-deriving "who would a squash drop" here would be
  // a second copy of the skip rules — bots, the pull request author's own commit,
  // a nameless commit — and a second copy is a second thing to keep correct.
  const { contributors, collisions, unverified } = collectCoauthors(commits, prAuthor);
  // The second question, and a second pass on purpose. The collection loop skips
  // the PR author's own commits and bots on the way to deciding who a squash
  // would drop; a rejected trailer is a different question and has no such
  // exclusion. The most common instance is the PR author's own commit carrying
  // someone else's machine identity, which that loop never sees.
  const rejected = readRejectedTrailers(commits);
  const informational = [];

  if (contributors.size > 0) {
    const entries = [...contributors.values()];
    // De-duplicated after the map, not before: a machine identity and a real
    // contributor both normalise onto the same sanctioned line, and the squash
    // body takes that line once. Two commits that collapse to one line are the
    // correct output, not a lost second credit — there is no second person.
    const trailers = [...new Set(entries.map(c => c.trailer))].sort();
    const names = [...new Set(entries.map(c => c.name))].sort();
    const who = names.length === 1 ? names[0] : `${names.length} other contributors`;
    const machineCount = entries.filter(c => c.machine).length;
    // Named here, named by name only — the address is already in the commit and
    // the unverified note below reports it, so nothing is withheld, and the
    // sentence stays true: the branch does carry commits by these names.
    const normalised = machineCount > 0
      ? `\n\n${machineCount} of the ${entries.length} ` +
        `${entries.length === 1 ? 'identity is' : 'identities are'} an address that exists only on this ` +
        'machine, so it is credited as Paperclip rather than by name. That line is the one this ' +
        "repository's contribution rules accept, and a line naming an internal agent does not survive review."
      : '';

    informational.push(
      `This branch carries commits by ${who}. Squash-merging drops that authorship unless ` +
      'the squash message carries their trailers, and nothing else will notice if it does not. ' +
      'Add to the squash body when merging:\n\n' +
      trailers.map(line => `      ${line}`).join('\n') +
      normalised
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

  const failures = [];
  if (rejected.size > 0) {
    // One failure, not one per line: the gate's comment renders each failure as
    // its own checklist item, and an author with five bad trailers has one thing
    // to do. Capped at five lines because a branch that generated more than that
    // has a systematic problem the count states on its own.
    const shown = [...rejected.entries()].slice(0, 5);
    const listed = shown.map(([, { line, commits }]) =>
      `\`${line}\`${commits > 1 ? ` (on ${commits} commits)` : ''}`
    );
    // The reason is stated once, above the list, because it is the same class of
    // mistake in every case and repeating it per line buries the fix.
    const reasons = [...new Set(shown.map(([, { reason }]) => reason))];

    failures.push(
      `A \`Co-Authored-By\` trailer on this branch credits an identity that is not a person: ` +
      `${listed.join('; ')}${rejected.size > shown.length ? `; and ${rejected.size - shown.length} more` : ''}. ` +
      `${reasons.length === 1 ? reasons[0] : reasons.join('. ')}. ` +
      `This repository's contribution rules accept exactly one form for a commit an agent wrote: ` +
      `\`${SANCTIONED_TRAILER}\`. ` +
      'Rewrite the trailer on the commits that carry it and force-push, or drop the trailer and paste the ' +
      'sanctioned line into the squash body when merging. A trailer naming a real contributor is not ' +
      'affected — this only fires on an address that resolves to this machine or to a mail robot.'
    );
  }

  return { passed: failures.length === 0, failures, informational };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commits = JSON.parse(process.env.PR_COMMITS ?? '[]');
  const result = checkCoauthors(commits, process.env.PR_AUTHOR ?? '', {
    commitsUnavailable: process.env.PR_COMMITS_UNAVAILABLE === 'true',
  });
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
