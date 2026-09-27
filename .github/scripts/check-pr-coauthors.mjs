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
 * Two ways of losing credit silently are reported rather than resolved, because
 * neither has a correct answer this gate can compute:
 *
 * - A shared identity. When one address arrives under two different names, that
 *   is two people sharing a generic local identity as often as it is one person
 *   who changed their git config. De-duplicating is right; dropping the second
 *   name is still a lost attribution, so both spellings are named.
 * - An unverified local identity. A trailer built from an address that cannot be
 *   a real mail domain came from whatever `git config` the committing tree
 *   carried, and a per-agent worktree outlives the task that configured it. The
 *   trailer is still emitted — it is the best guess available — but the note
 *   says plainly that nothing verified it.
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
 * `.local` and `.localhost` are the mDNS names; the rest are the reserved
 * special-use names. A domain with no dot at all is the same story.
 */
const LOCAL_ONLY_DOMAIN = /\.(local|localhost|internal|home\.arpa)$/i;

function isLocalOnlyIdentity(email) {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  // No `@`, or a leading one: not an address, so nothing could have verified it.
  if (at < 1) return true;
  const domain = email.slice(at + 1);
  if (!domain.includes('.')) return true;
  return LOCAL_ONLY_DOMAIN.test(domain);
}

export function checkCoauthors(commits, prAuthor) {
  const author = (prAuthor ?? '').toLowerCase();
  const contributors = new Map();
  // Emails already accounted for, mapped to the display name credited for them.
  // One person can appear both ways in the same branch — some commits matched to
  // their account, some authored with an email GitHub does not know — and keying
  // on login alone would then emit two trailers for them.
  const seenEmails = new Map();
  // Addresses that arrived under more than one name, mapped to those names. Two
  // people sharing one generic local identity is indistinguishable here from one
  // person who edited their git config, so the names are reported rather than
  // resolved: whoever the de-dup drops has still lost their credit.
  const collisions = new Map();
  // Trailers whose credit rests on a local git config rather than on anything
  // GitHub verified, in the order first seen.
  const unverified = new Set();

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
    // question the de-dup is answering.
    const displayName = gitName && login ? gitName : name;

    // Keyed on identity, not on the rendered line. One person whose git config
    // name changed across commits is still one person, and emitting them twice
    // would put two trailers for the same contributor into the squash body.
    const key = (login ?? gitEmail ?? name).toLowerCase();
    const emailKey = (gitEmail ?? '').toLowerCase();

    // The same address already credited under a different name. Checked ahead
    // of the de-dup so it also fires when the `key` de-dup is what would drop
    // this commit — which is the whole case when neither commit was matched to
    // an account, since then `key` is the address itself.
    if (emailKey && seenEmails.has(emailKey) && displayName && seenEmails.get(emailKey) !== displayName) {
      // Seeded with the name already credited, so the note names both parties:
      // the one whose trailer was emitted and the one whose credit is now in
      // question.
      if (!collisions.has(emailKey)) collisions.set(emailKey, new Set([seenEmails.get(emailKey)]));
      collisions.get(emailKey).add(displayName);
    }

    if (contributors.has(key)) continue;
    if (emailKey && seenEmails.has(emailKey)) continue;
    if (emailKey) seenEmails.set(emailKey, displayName ?? '');

    // Only a trailer built from the raw git author can be unverified: a matched
    // login means GitHub resolved this person to an account regardless of what
    // the commit's own email field says.
    if (!login && isLocalOnlyIdentity(gitEmail)) {
      unverified.add(`${displayName} <${gitEmail}>`);
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

  for (const [address, names] of collisions) {
    const named = [...names].filter(Boolean).sort();
    if (named.length < 2) continue;
    informational.push(
      `\`${address}\` is credited to ${named.map(n => `\`${n}\``).join(' and ')}, so only ` +
      'the first is carried above. One address under two names is two people sharing a local ' +
      'git identity as often as it is one person who edited their config, and this cannot tell ' +
      'them apart — credit the second by hand, or set a distinct `user.email` per contributor.'
    );
  }

  if (unverified.size > 0) {
    const one = unverified.size === 1;
    informational.push(
      `Nothing verified ${one ? 'this trailer' : 'these trailers'}: ` +
      `${[...unverified].map(id => `\`${id}\``).join(', ')} ` +
      `${one ? 'is not a routable address' : 'are not routable addresses'}, so the name came from ` +
      '`git config` in the tree the commit was made in rather than from a GitHub account. A ' +
      'worktree keeps its config across tasks, so this credits whoever configured it. Re-author ' +
      'with `git -c user.name=... -c user.email=...` and force-push if the name is wrong.'
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
