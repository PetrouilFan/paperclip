#!/usr/bin/env node
/**
 * audit-merge-attribution.mjs
 * Checks a squash merge that already happened against the trailers it needed to
 * carry. Export: auditMergeAttribution({ prAuthor, commits, mergeMessage })
 *
 * `check-pr-coauthors.mjs` reports the trailers a squash needs, while the pull
 * request is open, and the file says plainly that nothing will check whether the
 * message that actually lands carried them. That is the one gap in the chain
 * this repository has: the advisory is the last thing that knows the answer, and
 * it asks before anyone can supply it.
 *
 * This is the other end. Once the merge commit exists there is a message to read
 * and a branch to read it against, so the question is finally decidable — which
 * makes the loss decidable too, and silent no longer means invisible.
 *
 * It reports six things, and they are not the same complaint:
 *
 * - `lost-credit` — the gate named a contributor and the merge message does not
 *   carry them. The contributor's commits are on master and their name is not.
 *   This is the failure `check-pr-coauthors.mjs` exists to prevent, observed at
 *   the only point where it is observable.
 * - `dropped-name` — one address arrived on the branch under more than one name
 *   and the merge message credits one of them. The gate's de-dup chose which one
 *   to keep; this reports the one it discarded, so a human can paste it. Two
 *   people sharing a generic fleet identity and one person who edited their git
 *   config are indistinguishable from the branch alone, so this names the
 *   candidates rather than deciding which reading is right.
 * - `respelled-credit` — the contributor is credited, but under a different
 *   name than the one on the branch. A `git config` display name read out of a
 *   worktree leaks into permanent history this way, and nothing downstream can
 *   tell a person's name from a machine's.
 * - `phantom-trailer` — the merge message credits someone no commit on the
 *   branch accounts for. On a repository with a declared house identity this is
 *   the normal case and is reported as such, because a sanctioned identity in
 *   the same slot as a gate-prescribed one is a convention conflict rather than a
 *   mistake, and this is the measurement that shows it.
 * - `duplicate-credit` — the same trailer line appears more than once. A paste
 *   across re-merges produces this, and the PR-time gate cannot see it, because
 *   by the time the second paste exists there is no open pull request left to
 *   comment on.
 * - `shared-address` — one address credited under several names. Nothing is
 *   repeated here, which is why it is not a duplicate: the names differ where
 *   the mailbox does not, and only one of them can be reached at it.
 *
 * Identity is matched on the address where both trailers have one, because the
 * address is the identity and the name is a label on it. Matching on the whole
 * rendered line would call every hand-edited name a lost credit and bury the real
 * ones; matching on the name would call every re-addressing a duplicate. Both of
 * those are noise that trains a reader to skip the report, and a report nobody
 * reads catches nothing.
 *
 * Nothing here can fail a merge — the merge already happened, and the only
 * actor who could fix it is the one who pressed the button. So the findings are
 * reported, and `passed` is false when a contributor lost their credit, which is
 * what a caller running this on a schedule or over a range of history acts on.
 */
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { collectCoauthors } from './check-pr-coauthors.mjs';

/** `Co-Authored-By: Name <addr>` in any case, with the line trimmed. */
const TRAILER_LINE = /^co-authored-by:\s*(.+)$/i;

/**
 * Split `Name <addr>` into its parts, case-folded and whitespace-collapsed.
 *
 * A trailer with no angle brackets keeps the whole string as the name: git
 * accepts both spellings and a merge author does use them, so the bare form has
 * to survive the round trip rather than render as an unparseable identity.
 */
export function parseTrailer(value) {
  const line = String(value ?? '').trim();
  const match = /^(.*?)\s*<([^>]*)>\s*$/.exec(line);
  const name = match ? match[1] : line;
  const email = match ? match[2] : '';
  return {
    name: name.trim().toLowerCase().replace(/\s+/g, ' '),
    email: email.trim().toLowerCase(),
    display: (match ? name.trim() : line) || email.trim() || null,
  };
}

/**
 * Every `Co-Authored-By` line in a commit message, in order and with duplicates
 * kept.
 *
 * A real trailer block is the message's last paragraph, but the whole message is
 * scanned instead, because the failure this audit exists to catch is a trailer
 * pasted into a body rather than appended as a block — which is what a re-merge
 * by hand produces. Restricting the scan to the last paragraph would make that
 * case report as "no trailers at all", which reads as a clean merge.
 */
export function readTrailers(message) {
  const out = [];
  for (const raw of String(message ?? '').split('\n')) {
    const match = TRAILER_LINE.exec(raw.trim());
    if (match) out.push(match[1].trim());
  }
  return out;
}

/** The address when there is one, else the whole rendered identity. */
function identityKey(trailer) {
  const { email, name } = parseTrailer(trailer);
  return email || name;
}

/**
 * Does the merge-message `trailer` deliver the credit `candidate` prescribed?
 *
 * The address decides. When only one side has an address the name decides
 * instead, so a bare `Co-Authored-By: someone` is not reported as a loss just
 * because the branch spelled theirs with a mailbox.
 *
 * `candidate.addresses` is every address that contributor is reachable at, which
 * for a commit GitHub matched to an account is more than the one the trailer
 * renders: the gate swaps the author's real address for the account's no-reply
 * form so the credit links to a profile, which means a squash that kept the
 * original is crediting the same person in a spelling the rendered trailer does
 * not contain. Matching the rendered address alone called that a lost credit, and
 * on this fork it fired on a merge that plainly says
 * `Co-Authored-By: Paperclip <noreply@paperclip.ing>` while the gate had asked
 * for `Paperclip <Paperclip-Paperclip@users.noreply.github.com>`. The distinction
 * that matters is whether the person is named, and they were.
 *
 * One function, called in both directions, because the answer is a relation and
 * not a test: the same question decides whether a branch credit is missing and
 * whether a merge trailer is unaccounted for. Two implementations of it drifted
 * once already — the loss side learned about alternate addresses and the phantom
 * side did not, so one merge was reported as a contributor lost *and* a trailer
 * that credited nobody.
 */
/**
 * How the merge message answered one prescribed credit.
 *
 * `exact` is the line the gate handed over, or an alternate address the person
 * is genuinely reachable at — a re-spelled name on the same mailbox is the same
 * credit and a reader should not have to care. `rejected` is the one case that is
 * not a credit at all: a machine identity's own line, which the contribution
 * rules do not accept and which this repository's history should not carry.
 * `none` is a loss.
 *
 * Exact is searched first so the verdict does not depend on the order the
 * trailers appear in the message. A message carrying both the house line and the
 * local one it replaced is credited; it is still reported, and it is reported
 * once, rather than the verdict flipping on whichever line the mergeer pasted
 * first.
 */
/** Whether two rendered lines are the same credit: the address, or the name. */
function sameCredit(a, b) {
  const want = parseTrailer(a);
  const got = parseTrailer(b);
  if (want.email && got.email) return want.email === got.email;
  return Boolean(want.name) && want.name === got.name;
}

/**
 * How the merge message answered one prescribed credit.
 *
 * Three outcomes, and the distinction between the first two is the reason this
 * function exists rather than a `find`:
 *
 *   - `exact` is the line the gate handed over. For a person that is their own
 *     line, and reaching them at a second address they own is still them — a
 *     re-spelled name on a mailbox of theirs is the same credit, and a reader
 *     should not have to care which spelling landed. The gate records those
 *     alternate addresses, so they are matched on address rather than on text.
 *   - `stray` is a line that reaches the contributor by address but is not the
 *     prescribed one. For a person that is another of their mailboxes. For a
 *     machine it is the machine's own line, and the contribution rules do not
 *     accept it — so the commits are credited while the line that delivered
 *     them publishes an address no mail outside this machine can route, and a
 *     worktree's `git config` display name, into permanent history.
 *   - `none` is a loss, and the only outcome that fails the audit.
 *
 * `stray` is searched across the whole message and reported even when an exact
 * line is present too, so a merge that pasted both the house line and the local
 * one it replaced is credited *and* reported, once, rather than the verdict
 * depending on which line the mergeer happened to paste first or the rejected
 * one passing unnoticed because a good one sat next to it.
 */
function resolveDelivery(candidate, onMerge) {
  const reaching = onMerge.filter(t =>
    sameCredit(t, candidate.identity) || (() => {
      const email = parseTrailer(t).email;
      return Boolean(email) && candidate.addresses.has(email);
    })()
  );
  if (reaching.length === 0) return { kind: 'none', line: null, stray: null };
  const exact = reaching.find(t => sameCredit(t, candidate.identity)) ?? null;
  const stray = reaching.find(t => !sameCredit(t, candidate.identity)) ?? null;
  if (exact) return { kind: 'exact', line: exact, stray };
  return { kind: 'stray', line: stray, stray };
}

function delivers(candidate, trailer) {
  const want = parseTrailer(trailer);
  const got = parseTrailer(candidate.identity);
  if (want.email && got.email) {
    const reachable = new Set([...candidate.addresses, got.email].filter(Boolean));
    return reachable.has(want.email);
  }
  return Boolean(want.name) && want.name === got.name;
}

/**
 * The names each address arrived under, across the commits the gate considered.
 *
 * "Considered" is asked of the gate rather than reimplemented here. A bot, the
 * pull request author's own commit under a local address, and a nameless commit
 * are all skipped by `collectCoauthors` for reasons that have nothing to do with
 * attribution, and a second copy of those rules is a second thing to keep
 * correct. One commit in, one commit out of the same function is the whole
 * question, and it cannot drift.
 *
 * Read from the commits rather than from the gate's own `collisions` map, because
 * the de-dup is the thing under audit: a name the de-dup dropped never reaches
 * that map as a separate entry, and this has to see it in order to report it.
 */
function namesPerAddress(commits, prAuthor) {
  const byAddress = new Map();
  for (const entry of commits ?? []) {
    const email = (entry?.commit?.author?.email ?? '').trim().toLowerCase();
    if (!email) continue;
    if (collectCoauthors([entry], prAuthor).contributors.size === 0) continue;
    const name = (entry?.commit?.author?.name ?? '').trim();
    if (!name) continue;
    if (!byAddress.has(email)) byAddress.set(email, new Map());
    const names = byAddress.get(email);
    // Original case is kept for display; membership is case-folded so
    // `Mnemosyne` and `mnemosyne` are one name with two spellings.
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return byAddress;
}

/**
 * The spellings of one address that the merge message actually credited,
 * matched on the name the branch used rather than on the rendered line — a
 * hand-corrected display name is still that person being credited.
 */
function namesPerAddressSpelling(names, onMerge, address) {
  const credited = [];
  for (const display of names.values()) {
    const hit = onMerge.some(t => identityKey(t) === address && parseTrailer(t).display === display);
    if (hit) credited.push(display);
  }
  return credited;
}

/**
 * Audit one squash merge against the branch it collapsed.
 *
 * `commits` is the `checkCoauthors` input shape — the list GitHub's
 * `/pulls/{n}/commits` returns, each entry's `author` null where GitHub matched
 * no account. `mergeMessage` is the merge commit's full message.
 *
 * `passed` is false only when a contributor's credit was lost or a name was
 * dropped. The other five findings are recorded and do not fail the audit: a
 * re-spelling is a human's editorial call, a house identity in the trailer block
 * is a convention conflict someone has to rule on, a duplicate is cosmetic, a
 * shared address is a statement about the mailbox rather than about the merge,
 * and a rejected line that landed is a rules violation in history rather than a
 * loss of credit — nobody lost anything by it, and the commits are named.
 * Folding all of them into the exit code would train a caller to ignore it, and
 * the one that matters is the one that gets ignored first.
 *
 * ## Two kinds of credit, and why the house line is one of them
 *
 * `checkCoauthors` distinguishes a person from a machine, and this audit has to
 * follow it rather than re-decide. A commit GitHub matched to an account, or
 * written with a routable address, is a person: their line is the credit, and
 * its absence is a loss. A commit whose only address is one this machine cannot
 * route is not a person, and the rules accept exactly one line for it — the
 * house identity. So a machine branch whose merge carries nothing is a
 * `lost-credit` naming the commit's real author, because "the house line is
 * missing" is not actionable and "this author is not in the history" is. Several
 * machine commits therefore report several findings over one identical
 * prescribed line, and a single house line in the message credits all of them:
 * the repetition is in the reporting, not in the credit, and collapsing it would
 * collapse the list of people to go and ask.
 *
 * A machine branch whose merge instead carries the machine's own line is a
 * different thing, and the reason this audit exists: the credit arrived, and the
 * line that delivered it publishes an unroutable address and a worktree's
 * `user.name` into permanent history. No pre-merge gate can see it, because the
 * squash body does not exist until after the merge — which is the whole reason a
 * post-merge pass is worth a second copy of the questions.
 */
export function auditMergeAttribution(input) {
  // Read through `input ?? {}` rather than a destructuring default: a `= {}`
  // default only covers `undefined`, so a caller passing `null` — which is what
  // `JSON.parse` of a null body yields — would throw on the destructure instead
  // of auditing an empty merge.
  const { prAuthor, commits, mergeMessage } = input ?? {};
  const { contributors } = collectCoauthors(commits, prAuthor);
  // `contributors` holds rendered *lines*; what gets compared is the identity
  // inside them, so the prefix comes off once here rather than in every
  // comparison below. Leaving it on would make every credit look re-spelled,
  // because the merge message has the prefix and the branch value would not.
  const prescribed = [...contributors.values()]
    .map(c => ({
      line: c.trailer,
      identity: c.trailer.replace(/^Co-Authored-By:\s*/i, ''),
      addresses: c.emails ?? new Set(),
      // A machine identity is not a person. `checkCoauthors` normalises one onto
      // the house trailer, so the line above is the credit the rules accept, and
      // the address the commit was written with is the one that must not land.
      // Both are kept: the first is what the merge owes, the second is what a
      // report has to name for a reader to be able to act on it.
      machine: Boolean(c.machine),
      branchIdentity: c.gitAddress ? `${c.name} <${c.gitAddress}>` : c.name,
    }))
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  const onMerge = readTrailers(mergeMessage);
  const findings = [];

  for (const candidate of prescribed) {
    const { identity, machine, branchIdentity } = candidate;
    const delivery = resolveDelivery(candidate, onMerge);
    if (delivery.stray && machine) {
      findings.push({
        kind: 'landed-rejected-line',
        credit: identity,
        delivered: delivery.stray,
        detail:
          `\`${delivery.stray}\` is in the merge message. The commits behind it are credited, so no ` +
          `one lost anything — but the contribution rules accept \`${identity}\` for a commit this ` +
          'machine authored, and the line above publishes an address no mail outside this machine can ' +
          'reach, together with a `git config` display name read out of a worktree. Nothing before the ' +
          'merge could have caught this: the squash body does not exist yet.',
      });
      continue;
    }
    if (delivery.kind === 'none') {
      // Named by the branch's own author even when the credit the rules want is
      // the house line, because "the house identity is missing" is not something
      // a reader can act on and "this commit's author is not in the history" is.
      findings.push({
        kind: 'lost-credit',
        credit: machine ? branchIdentity : identity,
        detail:
          `\`${machine ? branchIdentity : identity}\` is on the branch and not in the merge message, so ` +
          (machine
            ? `this commit's credit is missing. The line the contribution rules accept for it is ` +
              `\`${identity}\`, and that is the line to paste.`
            : "this contributor's commits are on the branch and their name is not in the history that " +
              'carries them.'),
      });
      continue;
    }
    if (parseTrailer(delivery.line).display !== parseTrailer(identity).display) {
      findings.push({
        kind: 'respelled-credit',
        credit: identity,
        delivered: delivery.line,
        detail:
          `\`${identity}\` on the branch is credited as \`${delivery.line}\` in the merge message. ` +
          'The address matches, so the credit is intact; the name is not the one on the commit, ' +
          'and a `git config` display name read out of a worktree lands in permanent history this way.',
      });
    }
  }

  // One address, several names, fewer names credited. The gate named the
  // collision in its advisory and the merge could act on it by hand; if it did
  // not, the losers are named here, because nothing downstream ever will.
  //
  // Reported whether or not the carried name made it into the message. When the
  // address was not credited at all, `lost-credit` already names the one the
  // de-dup kept — and stopping there is how the second name disappears: it is
  // named by no finding, so a reader sees one clean, explained loss instead of
  // two people. The condition is "not every name is credited", never "the de-dup
  // dropped one".
  for (const [address, names] of namesPerAddress(commits, prAuthor)) {
    if (names.size < 2) continue;
    const creditedHere = namesPerAddressSpelling(names, onMerge, address);
    const uncredited = [...names.entries()].filter(([, display]) => !creditedHere.includes(display));
    if (uncredited.length === 0) continue;
    const carried = creditedHere[0] ?? null;
    const others = uncredited.map(([, display]) => display);
    findings.push({
      kind: 'dropped-name',
      address,
      carried,
      dropped: others,
      detail:
        `\`${address}\` carries ${names.size} names on this branch and ` +
        (carried
          ? `only \`${carried}\` is credited in the merge message. `
          : 'the merge message credits none of them. ') +
        `${others.map(d => `\`${d}\``).join(', ')} ${others.length === 1 ? 'is' : 'are'} not in the ` +
        'history. That is one person who edited their config at least as often as it is two people ' +
        'sharing one identity, and nothing in the branch tells them apart — if the other name is a ' +
        'person, their credit is gone.',
    });
  }

  for (const trailer of onMerge) {
    if (prescribed.some(p => delivers(p, trailer))) continue;
    findings.push({
      kind: 'phantom-trailer',
      credit: trailer,
      detail:
        `\`${trailer}\` is credited in the merge message and no commit on the branch accounts for it. ` +
        'A repository-declared house identity lands here, and so does a contributor carried over from a ' +
        'previous merge of the same branch — tell them apart by reading the message, because the branch cannot.',
    });
  }

  const lineCounts = new Map();
  const addressCounts = new Map();
  for (const trailer of onMerge) {
    const key = identityKey(trailer);
    lineCounts.set(trailer, (lineCounts.get(trailer) ?? 0) + 1);
    addressCounts.set(key, (addressCounts.get(key) ?? 0) + 1);
  }
  for (const [trailer, count] of lineCounts) {
    if (count < 2) continue;
    findings.push({
      kind: 'duplicate-credit',
      credit: trailer,
      count,
      detail:
        `\`${trailer}\` appears ${count} times in the merge message. The gate de-duplicates before it ` +
        'reports, so a repeat can only have been pasted in by hand — usually by re-merging and carrying ' +
        'the previous body forward.',
    });
  }
  for (const [key, count] of addressCounts) {
    if (count < 2) continue;
    // A line repeated verbatim is already reported above; this is the other
    // shape, one address under several names, which is not a duplicate of
    // anything — nothing is repeated, the address is shared. Labelling it
    // `duplicate-credit` would say a person was credited twice when the truth is
    // that two names were pointed at one mailbox, and only one of them can be
    // reached at it.
    if ([...lineCounts].some(([t, n]) => n >= 2 && identityKey(t) === key)) continue;
    const spellings = onMerge.filter(t => identityKey(t) === key);
    findings.push({
      kind: 'shared-address',
      credit: key,
      count,
      spellings,
      detail:
        `One address carries ${count} names in the merge message: ` +
        `${spellings.map(t => `\`${t}\``).join(', ')}. Nothing is duplicated, but the names differ ` +
        'where the mailbox does not, so at most one of them is reachable at that address.',
    });
  }

  const failing = findings.filter(f => f.kind === 'lost-credit' || f.kind === 'dropped-name');
  return {
    passed: failing.length === 0,
    prescribed: prescribed.map(p => p.identity),
    onMerge,
    findings,
    counts: {
      prescribed: prescribed.length,
      credited: onMerge.length,
      lost: findings.filter(f => f.kind === 'lost-credit').length,
      droppedNames: findings.filter(f => f.kind === 'dropped-name').length,
      respelled: findings.filter(f => f.kind === 'respelled-credit').length,
      phantom: findings.filter(f => f.kind === 'phantom-trailer').length,
      duplicate: findings.filter(f => f.kind === 'duplicate-credit').length,
      sharedAddress: findings.filter(f => f.kind === 'shared-address').length,
      rejectedLines: findings.filter(f => f.kind === 'landed-rejected-line').length,
    },
  };
}

/** One line per finding, for a comment or a CLI run. */
export function formatAudit(result) {
  if (result.findings.length === 0) {
    return 'Every contributor on the branch is credited in the merge message, once, under one name.';
  }
  return result.findings.map(f => `- **${f.kind}** — ${f.detail}`).join('\n');
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/**
 * The merge commit's message, over the API rather than from the local object
 * database.
 *
 * A local `git log` is the faster read and is tried first, but it makes the tool
 * unusable on a machine that has no clone of this repository — which is most
 * machines a scheduled audit runs on, and every reviewer who has not fetched.
 * The API is the same object either way, so a fallback rather than a second
 * source of truth: `git log` is consulted, and only its failure changes the path.
 */
function mergeMessageOf(oid, repo) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%B', oid], { encoding: 'utf8' });
  } catch {
    // `gh api` takes the repository in the path and rejects `--repo`, so the
    // scoped flag below applies to `pr view` only.
    return JSON.parse(gh(['api', `repos/${repo}/commits/${oid}`])).commit.message;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const prNumber = process.env.PR_NUMBER ?? process.argv[2];
  if (!prNumber) {
    console.error('usage: audit-merge-attribution.mjs <pr-number>   (or set PR_NUMBER)');
    process.exit(2);
  }
  // Overridable, and the default is a convenience rather than the tool's scope.
  // The gate this reads is per-repository and so is the history it audits, so
  // `REPO` is how anyone points the audit at a fork; the default is only what a
  // bare `audit-merge-attribution.mjs 145` on this machine does. It is a default
  // rather than a discovery because `gh` gets its repository from the checkout it
  // is run in, and the fallback path above exists precisely for the runs that have
  // no checkout to infer one from.
  const repo = process.env.REPO ?? 'PetrouilFan/paperclip';
  // `author`, not `user`: `gh pr view` has no `user` field and exits non-zero on
  // an unknown one, so the tool failed before it could audit anything.
  const pr = JSON.parse(gh(['pr', 'view', String(prNumber), '--json', 'author,mergeCommit,mergedAt', '--repo', repo]));
  if (!pr.mergeCommit?.oid) {
    console.error(`#${prNumber} has no merge commit — it was closed without merging.`);
    process.exit(2);
  }
  const commits = JSON.parse(gh(['api', `repos/${repo}/pulls/${prNumber}/commits?per_page=100`]));
  const result = auditMergeAttribution({
    prAuthor: pr.author?.login,
    commits,
    mergeMessage: mergeMessageOf(pr.mergeCommit.oid, repo),
  });
  console.log(JSON.stringify({ pr: Number(prNumber), repo, mergeCommit: pr.mergeCommit.oid, ...result }, null, 1));
  console.error(formatAudit(result));
  process.exit(result.passed ? 0 : 1);
}
