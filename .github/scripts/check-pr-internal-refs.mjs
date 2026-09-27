#!/usr/bin/env node
/**
 * check-pr-internal-refs.mjs
 * Enforces CONTRIBUTING.md's "No Internal Issue References" and "Branch
 * Naming" sections, which until now were enforced only by a human reading each
 * PR. Both sections are stated in detail, with copy-paste remediation, and
 * nothing checked them — so an id in a title survived an explicit review note
 * and became a permanent commit subject.
 *
 * Export: checkInternalRefs(input) → { passed, failures }
 *
 * ## Why the prefix list is an input and not a constant
 *
 * The rule bans identifiers from *your own instance's* namespace, and this
 * repository is a fork. The canonical product's own identifier namespace is
 * `PAP-`/`PAPA-`, and the fork inherits it legitimately: on this repository's
 * master, `\b(PAP|PAPA)-[0-9]+` matches 736 files including the whole `ui/`
 * tree, because `PAP-1/child` is a canonical test fixture in
 * `cli/src/__tests__/common.test.ts` and a canonical route in 90+ files
 * (`/PAP/issues/...`). A gate written as "PET, PAP or PAPA" is born failing on
 * the product, gets disabled within a day, and a disabled gate reads as "we
 * checked". So the default list is the instance prefix alone, and a deployment
 * that wants more prefixes names them.
 *
 * ## Why there is a second, open matcher, and what it is not allowed to match
 *
 * The list above is closed by construction, and the rule text is not. It bans
 * "any `{PREFIX}-{NUMBER}` identifier that isn't a public GitHub issue number",
 * which is a shape, not a list — so a prefix nobody configured walks straight
 * through. It is not hypothetical: PR #85 merged to `master` as `1220016a0`
 * with `TASK-482` written three times in its *Steps to reproduce*, `review`
 * green, and a reviewer on github.com unable to open any of them.
 *
 * Widening `DEFAULT_INTERNAL_REF_PREFIXES` to name more prefixes does not fix
 * it, for the reason the section above already gives: every prefix added is a
 * prefix that has to be guessed, and the ones this repository does not name are
 * unbounded. So the second matcher matches the *shape* instead of a list. What
 * keeps that from being born failing is measured, not argued — see
 * "the measurement" below.
 *
 * ### the measurement
 *
 * Replayed over the 60 most recent pull requests on this fork, the bare shape
 * `[A-Z][A-Z0-9]+-\d+` applied to title and body flags 10 of the 60. Eight of
 * those are already caught by the configured prefix. The tokens it reaches
 * *past* the configured list are exactly three, and two of them are the reason
 * this matcher is not just the bare shape:
 *
 * - `GPT-5`, in four pull requests (#48, #67, #75, #87), every one of them in a
 *   **Model Used** section naming the model. A matcher that fails the pull
 *   request that documents the model which wrote it is a matcher that gets
 *   disabled within a day, and a disabled gate reads as "we checked".
 * - `PROJ-123`, in #67, where it is the *shape* of a config value being
 *   documented rather than a ticket being pointed at.
 * - `TASK-482`, in #85, which is the one that is real.
 *
 * The fix is a second condition, not a longer blocklist: the shape only counts
 * where an id is being *referred to*. Three positions qualify, and they are
 * all positions a ticket id is written into rather than mentioned in:
 *
 * - an issue-router path — `/issues/TASK-482`, `/api/issues/{TASK-482}/checkout`
 * - a `#` reference — `#TASK-482`
 * - a reference verb — `Fixes TASK-482`, `ticket TASK-482`, `see TASK-482`
 *
 * Under that rule the same 60 pull requests produce exactly one finding from
 * this tier: #85, `TASK-482`. `GPT-5` and `PROJ-123` both pass, and no branch
 * name in the population produces one. That is the property worth having — a
 * gate that adds one true positive and zero false positives to sixty real pull
 * requests can be merged without anyone having to decide whether to trust it.
 *
 * This is the same split the address rule below rests on, one level up: there,
 * prose that names `127.0.0.1` passes and a URL pointing at it fails; here,
 * prose that names `GPT-5` passes and a path pointing at `TASK-482` fails.
 *
 * ### the boundaries this matcher does not claim
 *
 * Stated as boundaries rather than left to be discovered, because each one is a
 * real case a reviewer will try:
 *
 * - **Not case-insensitive.** `utf-8`, `sha-256`, `http-404` and `gpt-5` are
 *   ordinary prose, and a case-insensitive open shape matches all four. A
 *   lowercase ticket prefix is still caught, by the configured list, which is
 *   case-insensitive precisely because it knows its prefix.
 * - **Not the compact form, anywhere.** `fix/SHA256-digest` is a perfectly good
 *   branch name and nothing structural separates it from `fix/task482-thing`,
 *   so an open compact shape is a blocklist wearing a shape. The configured
 *   list is what catches `fix/pet9003-blocker-edge`, which is the compact case
 *   shape that has actually been observed on this fork.
 * - **Not on a prepositional mention.** "the defect in TASK-482" is not a
 *   reference position, and `UTF-8` is not either. The same reason a bare
 *   `10.0.0.7` is left alone below: reaching for it fires on correct work.
 * - **Not on the diff.** 736 files on `master` carry `PAP-`/`PAPA-` legitimately.
 *   The configured list, which knows those prefixes, is what covers the diff.
 *
 * The one surface that does not require a reference position is the branch
 * name, because a branch name is not prose containing a reference — it is the
 * name, and there is no verb, no `#` and no path in it for the rules to key on.
 * The bare separated shape is measured there rather than assumed: over the 96
 * distinct branch names that have been a pull request head on this fork it
 * flags none. Its one cost is stated rather than hidden — a branch called
 * `fix/UTF-8-normalization` fails, and the remedy is a rename.
 *
 * ## Instance-local addresses: why authored text only
 *
 * CONTRIBUTING.md's section also bans `localhost`, private-IP and tailnet URLs,
 * and that rule *is* checked here — but only in the text an author writes: the
 * PR title, the description, the branch name, the commit subjects. It is
 * deliberately not applied to the diff, and the difference is the whole
 * design.
 *
 * The evidence for the restriction is the measurement this file's identifier
 * half already records: `\b(localhost|127\.0\.0\.1)` matches 664 files on
 * master, and every one of them is the code working. A test asserting a
 * service binds `127.0.0.1` is a test doing its job; the e2e harness reaches
 * its fixtures over loopback by design. Scan the source and the gate is born
 * failing on correct work, and a gate that fails on correct work gets
 * disabled within a day — and a disabled gate reads as "we checked".
 *
 * The same string in a PR *body* is never correct. Nobody needs `127.0.0.1` to
 * understand a change, and a reviewer on github.com cannot use the coordinate
 * anyway. So the shape is split by surface: prose that merely names the
 * loopback interface passes, and a URL that points at it fails.
 *
 * Replayed over the 60 most recent pull requests on this fork, the matcher
 * below flags exactly two — #22 (`http://127.0.0.1:8099/v1` in the body) and
 * #25 (`http://localhost:3101/api/companies/...` in the body) — and no
 * correctly-authored body. Both are the class this rule exists for: an
 * instance coordinate, copy-pasted, permanent.
 *
 * `agent://` is likewise a canonical product feature (structured agent
 * mentions, `packages/shared/src/project-mentions.ts`), so only `agent://`
 * followed by a configured instance prefix is treated as a link to an internal
 * issue — a bare `agent://` is not.
 *
 * ## Failing closed
 *
 * Every way this gate can be unable to answer "does this PR leak an id?"
 * produces a failure, never a pass:
 *
 * - the prefix list resolves to nothing, or holds a malformed entry;
 * - a changed file reports line changes but carries no patch to scan;
 * - a patch hunk is shorter than its own header declares (GitHub truncates
 *   large diffs and the truncation is not flagged anywhere in the payload);
 * - the changed-file list reached GitHub's 3000-file cap.
 *
 * A gate that answers "passed" because it could not look is worse than no gate,
 * because it is evidence.
 */
import { fileURLToPath } from 'node:url';

/** The instance prefix this repository's own board issues carry. */
export const DEFAULT_INTERNAL_REF_PREFIXES = ['PET'];

/**
 * Namespaces the open matcher must not claim, because the product owns them.
 *
 * This is an exemption, not a prefix list, and the difference is the whole
 * reason the open matcher is usable: `DEFAULT_INTERNAL_REF_PREFIXES` is
 * "identifiers I issued", and adding to it makes the gate stricter, whereas
 * every entry here makes it *looser* and therefore has to be earned. `PAP` and
 * `PAPA` are earned by the header's measurement — they are the canonical
 * product's own namespace, the fork inherits it legitimately, and 736 files on
 * `master` carry it.
 *
 * An empty or malformed list is a configuration error rather than a default,
 * because the failure mode is silent in the dangerous direction: drop the
 * entries and every honest mention of `/PAP/issues/PAP-1` in a pull request
 * body starts failing, which is how a gate acquires a reputation for noise.
 */
export const DEFAULT_PRODUCT_OWNED_PREFIXES = ['PAP', 'PAPA'];

/** GitHub's hard ceiling on a pull request's changed-file list. */
export const MAX_PR_FILES = 3000;

/**
 * Paths this gate never scans.
 *
 * The gate and its own test necessarily contain the literals they search for.
 * Self-exclusion is a fixed list rather than a heuristic because the set is
 * closed: adding a file here is a reviewable act, and a heuristic broad enough
 * to avoid maintenance would also be broad enough to hide a real leak.
 */
export const SELF_EXEMPT_PATHS = [
  '.github/scripts/check-pr-internal-refs.mjs',
  '.github/scripts/tests/check-pr-internal-refs.test.mjs',
];

/**
 * Paths exempt from the diff scan because they *are* the rule text and must
 * quote the banned shapes to explain them. A reason is mandatory and enforced
 * below — an allowlist entry that does not carry one is itself a failure, so
 * this list cannot grow into a quiet exemption.
 */
export const ALLOWLIST = [
  {
    path: 'CONTRIBUTING.md',
    reason: 'The rule text itself: it quotes the banned identifier and link shapes to define them.',
  },
  {
    path: '.github/PULL_REQUEST_TEMPLATE.md',
    reason: 'The rule text itself: the PR template repeats the banned shapes in its "do not include" section.',
  },
];

/** Case-insensitive word boundary that also refuses to start inside a word. */
const NOT_IN_WORD = String.raw`(?<![A-Za-z0-9_])`;

/**
 * Resolves and validates the prefix list. Returns `{ prefixes }` or
 * `{ configError }`; the caller turns a config error into a failure.
 */
export function resolvePrefixes(raw) {
  // A string is the env-var shape (`PET,PAP`), an array the programmatic one.
  // Anything else is a caller error and has to surface as a failure rather than
  // as a thrown TypeError, because the gate's job here is to report, not crash.
  const source = raw === undefined || raw === null ? DEFAULT_INTERNAL_REF_PREFIXES : raw;
  const entries = Array.isArray(source) ? source : typeof source === 'string' ? source.split(',') : null;
  if (entries === null) {
    return {
      configError:
        'INTERNAL_REF_PREFIXES must be a comma-separated string or an array of prefixes, ' +
        `got ${typeof source}. Refusing to pass a scan that could not match anything.`,
    };
  }

  const list = entries
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);

  if (list.length === 0) {
    return {
      configError:
        'INTERNAL_REF_PREFIXES is set but resolved to no prefixes. Refusing to pass a scan that could not match anything — ' +
        'unset it to fall back to this instance\'s default, or name at least one valid prefix.',
    };
  }

  const bad = list.filter((entry) => !/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(entry));
  if (bad.length > 0) {
    return {
      configError:
        `INTERNAL_REF_PREFIXES holds ${bad.length === 1 ? 'an entry' : 'entries'} that cannot be an identifier prefix: ` +
        `${bad.map((e) => `"${e}"`).join(', ')}. Expected 2-10 characters, starting with a letter, letters and digits only.`,
    };
  }

  // De-duplicated case-insensitively: a list holding `pet` and `PET` twice
  // would otherwise report the same finding once per spelling.
  const seen = new Set();
  const prefixes = [];
  for (const entry of list) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    prefixes.push(entry);
  }

  return { prefixes };
}

/**
 * Resolves and validates the product-owned exemption list. Same contract as
 * `resolvePrefixes`: a configuration error is returned, never thrown, and the
 * caller turns it into a failure.
 */
export function resolveProductOwnedPrefixes(raw) {
  const source = raw === undefined || raw === null ? DEFAULT_PRODUCT_OWNED_PREFIXES : raw;
  const entries = Array.isArray(source) ? source : typeof source === 'string' ? source.split(',') : null;
  if (entries === null) {
    return {
      configError:
        'PRODUCT_OWNED_REF_PREFIXES must be a comma-separated string or an array of prefixes, ' +
        `got ${typeof source}. Refusing to run a matcher whose exemptions cannot be read.`,
    };
  }

  const list = entries.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  if (list.length === 0) {
    return {
      configError:
        'PRODUCT_OWNED_REF_PREFIXES is set but resolved to no prefixes. That would make every ' +
        'mention of the product\'s own `PAP-`/`PAPA-` namespace a failure, including the canonical ' +
        'route shape. Unset it, or name at least one prefix.',
    };
  }

  const bad = list.filter((entry) => !/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(entry));
  if (bad.length > 0) {
    return {
      configError:
        `PRODUCT_OWNED_REF_PREFIXES holds ${bad.length === 1 ? 'an entry' : 'entries'} that cannot be an ` +
        `identifier prefix: ${bad.map((e) => `"${e}"`).join(', ')}. Expected 2-10 characters, starting with ` +
        'a letter, letters and digits only.',
    };
  }

  const seen = new Set();
  const owned = [];
  for (const entry of list) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    owned.push(key);
  }

  return { owned };
}

/**
 * Builds the matchers for one prefix.
 *
 * Two shapes per prefix, because the identifier is written both ways and a
 * branch-name check that only knows the separated form misses the one shape
 * that actually lands in git: `fix/pet9002-blocker-edge-one-way-door` carries
 * no hyphen after the prefix at all, so `PET-\d+` cannot see it.
 */
function buildMatchers(prefixes) {
  const alternation = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join('|');
  return {
    // `PET-9001`, `#PET-9001`, `/PET-9001`
    separated: new RegExp(`${NOT_IN_WORD}(${alternation})-\\d+\\b`, 'gi'),
    // `pet9002-blocker`, `pet9002_blocker`, `pet9002`. Two digits minimum: with no
    // separator a single trailing digit is far more likely to be a coincidence.
    // The floor used to be measured, not argued — the sweep that removed the
    // real compact-form occurrences found eleven on master, all in temp-dir
    // prefixes, throwaway systemd unit names and a deploy note. It is stated as
    // a judgement now because that measurement is zero. Read the zero narrowly:
    // it is a property of one tree at one moment, not of the rule. Eleven sat
    // on master past the sweep that cleared the separated spelling, and four of
    // them arrived *after* a first cut of this cleanup had already rebased, so
    // the same claim made one commit earlier was false. The separated form also
    // still has one live occurrence this cleanup does not touch — a branch
    // name in .github/workflows/e2e-service-leg.yml, where renaming the ref
    // would break the workflow that names it. "Zero" means this matcher, this
    // spelling, this tree.
    compact: new RegExp(`${NOT_IN_WORD}(${alternation})\\d{2,}\\b`, 'gi'),
    // `/PET/issues/...`, `/PET/agents/...`, `agent://PET`
    link: new RegExp(
      String.raw`(?<![A-Za-z0-9_])(?:/(${alternation})/(?:issues|agents|documents)\b|(?:agent|issue|document)://(${alternation})\b)`,
      'gi',
    ),
  };
}

function findAll(text, pattern) {
  const found = new Set();
  // Fresh lastIndex per call: these module-level-free patterns are rebuilt per
  // call, but `exec` in a loop is still stateful if a caller ever hoists one.
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.add(match[0]);
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return [...found];
}

/**
 * `findAll`, but keyed on the first capture group rather than the whole match.
 *
 * The open-shape rules match more than the identifier — `issues/PAP-224` is a
 * path segment plus an id, and `#TASK-482` is a sigil plus an id — and the
 * exemption check has to see the id alone. Returning `match[0]` would compare
 * `issues/PAP` against a list of prefixes, never match, and report the
 * product's own namespace as a leak.
 */
function findAllCaptured(text, pattern) {
  const found = new Set();
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.add(match[1] ?? match[0]);
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return [...found];
}

/**
 * The open identifier shape, and the three positions a reference goes.
 *
 * `OPEN_SHAPE` is deliberately not case-insensitive and carries no `i` flag, so
 * the verb alternation below spells both cases by hand. Adding `i` here would
 * silently make `[A-Z]` match `[a-z]` and the matcher would start claiming
 * `utf-8` and `sha-256` — see the header's boundaries.
 */
const OPEN_SHAPE = String.raw`[A-Z][A-Z0-9]{1,9}-\d+\b`;

/**
 * The bare separated shape, with no reference-position requirement.
 *
 * Used on exactly one surface — the branch name. A branch name is not prose
 * with a reference in it; it *is* the name, so there is no verb, no `#` and no
 * path for the reference rules to key on, and `fix/TASK-482-unbound-target`
 * would otherwise pass. Measured over the 96 distinct branch names that have
 * been a pull request head on this fork, this shape flags none of them, so the
 * one cost it carries is theoretical: a branch named `fix/UTF-8-normalization`
 * fails, and the remedy is to rename the branch, which costs nothing before the
 * branch is pushed and nothing after.
 *
 * The compact form stays out on every surface. `fix/SHA256-digest` is a
 * perfectly good branch name and nothing structural separates it from
 * `fix/task482-thing`; the configured list already catches the instance's own
 * lowercase prefix, which is the case that has actually been observed.
 */
const OPEN_SHAPE_LOOSE = new RegExp(String.raw`${NOT_IN_WORD}(${OPEN_SHAPE})`, 'g');


/**
 * The gap between a reference verb and the id it refers to.
 *
 * Authors quote the id they have just named, so the reference is usually
 * written `` `TASK-482` `` or `"TASK-482"`, and a matcher that insists on a
 * single space misses the form that actually appears — that gap is what made
 * the first cut of the verb rule read #85 as clean. Held as a plain string
 * because it contains a backtick, which cannot appear unescaped inside the
 * template literal the rules themselves are written in.
 */
const REF_GAP = "[: #`\"'({\\[]*";

const OPEN_REF_RULES = [
  // `/issues/TASK-482`, `POST /api/issues/{TASK-482}/checkout`. The `{$?` is a
  // URL template placeholder, which is how #85 wrote the step the finding is
  // about: a reader copying that curl gets a shell brace, not an issue.
  new RegExp(String.raw`\b(?:issues|agents|documents)/[{]?(?:\$\{)?(${OPEN_SHAPE})`, 'g'),
  // `#TASK-482`. A `#` followed by a space is a Markdown heading and is not
  // matched; `#123` is a public GitHub reference and has no prefix to match.
  new RegExp(String.raw`(?<![A-Za-z0-9_])#(${OPEN_SHAPE})`, 'g'),
  // `Fixes TASK-482`, `ticket TASK-482`, `see TASK-482`.
  new RegExp(
    String.raw`\b(?:[Ff]ix(?:e[sd])?|[Cc]los(?:e[sd])?|[Rr]ef(?:s|erenced)?|[Ss]ee|[Tt]ickets?|[Tt]asks?|[Bb]ugs?)\b${REF_GAP}(${OPEN_SHAPE})`,
    'g',
  ),
];

/**
 * Every `{PREFIX}-{NUMBER}` reference in one string whose prefix this
 * deployment has not accounted for, de-duplicated.
 *
 * `owned` is the resolved product-owned list from `resolveProductOwnedPrefixes`;
 * `alreadyFound` is what the configured-prefix matchers already reported on the
 * same surface, and it is subtracted here so that one id is one finding even
 * when both tiers can see it. The second half of that is not cosmetic: the
 * conventional-commit prefix `fix:` is also a reference verb, so a title
 * reading `fix: PET-9003` is visible to both matchers, and an author who fixed
 * one identifier and got two paragraphs about it learns to skip the gate.
 *
 * `requireReference: false` drops the reference-position condition, and is used
 * on the branch-name surface only. See `OPEN_SHAPE_LOOSE`.
 */
export function findUnknownInternalRefs(
  text,
  owned = DEFAULT_PRODUCT_OWNED_PREFIXES,
  alreadyFound = [],
  { requireReference = true } = {},
) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const exempt = new Set(owned.map((p) => p.toLowerCase()));
  const seen = new Set(alreadyFound.map((h) => String(h).toLowerCase()));
  const found = new Set();
  for (const rule of requireReference ? OPEN_REF_RULES : [OPEN_SHAPE_LOOSE]) {
    for (const hit of findAllCaptured(text, rule)) {
      const prefix = hit.slice(0, hit.lastIndexOf('-'));
      if (exempt.has(prefix.toLowerCase())) continue;
      if (seen.has(hit.toLowerCase())) continue;
      found.add(hit);
    }
  }
  return [...found];
}

/**
 * The instance-local hosts this gate knows how to name.
 *
 * Split by why each entry is here, because the two groups are treated
 * differently below and conflating them is what makes this rule unusable:
 *
 * - loopback and RFC1918 (`127.0.0.0/8`, `::1`, `10/8`, `172.16/12`,
 *   `192.168/16`): the address space a single-node instance lives in. None of
 *   it routes anywhere public, so a body that names it is naming one machine.
 * - `100.64.0.0/10`: the CGNAT block Tailscale hands out. A tailnet node is
 *   routinely addressed by its `100.x` address, so the tailnet rule is not
 *   only about MagicDNS names.
 * - `localhost`: the name, and the one people paste.
 * - `0.0.0.0`: the wildcard bind, which is a *target* in a URL and a *socket
 *   description* in prose. The distinction matters, so it appears in one
 *   matcher and not the other (see `HOST_WITH_PORT`).
 * - `*.ts.net`: MagicDNS. No legitimate appearance in a public PR body.
 */
const INSTANCE_HOST = String.raw`(?:localhost|127\.(?:\d{1,3}\.){2}\d{1,3}|\[::1\]|10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|[A-Za-z0-9-]+(?:-[A-Za-z0-9-]+)*\.ts\.net|0\.0\.0\.0)`;

/** Schemes whose authority component is a host: the http family, the wire
 *  protocols an instance is reached over, and the URL schemes that appear in
 *  a config snippet. `file:` is absent on purpose — a `file://` path is a local
 *  filesystem path, not an instance coordinate. */
const URL_SCHEME = String.raw`(?:https?|wss?|ssh|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|grpc|git\+https?)`;

/**
 * A host in the authority of a URL: `http://localhost:3101/api/...`.
 *
 * The optional `user:pass@` is consumed so that a credentialed DSN
 * (`postgres://agent:hunter2@10.0.0.7:5432/paperclip`) reports the address
 * rather than stopping at the userinfo.
 */
const HOST_IN_URL = new RegExp(
  String.raw`\b${URL_SCHEME}://(?:[^\s/@]+@)?${INSTANCE_HOST}`,
  'gi',
);

/**
 * A bare authority: `localhost:3101`, `192.168.1.20:8080`.
 *
 * `host:port` with no scheme is a URL reference in every reading — it is the
 * authority form, and a reader copies it into a browser. The lookbehind refuses
 * to start inside a word, a path or a dotted name, which also keeps this
 * matcher from re-reporting the `localhost` that `HOST_IN_URL` already
 * reported (that one is preceded by `//`).
 *
 * `0.0.0.0` is the one host excluded here and kept in `HOST_IN_URL`. "The unit
 * binds 0.0.0.0:3100" is a true and load-bearing sentence about a socket, and
 * this repository has a whole class of pull requests that need to say it;
 * "curl http://0.0.0.0:3100" is a client reaching for an instance. A wildcard
 * is a description in one position and a target in the other.
 */
const HOST_WITH_PORT = new RegExp(
  String.raw`(?<![\w./-])(?:localhost|127\.(?:\d{1,3}\.){2}\d{1,3}|\[::1\]|10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|[A-Za-z0-9-]+(?:-[A-Za-z0-9-]+)*\.ts\.net):\d{1,5}\b`,
  'gi',
);

/**
 * A MagicDNS name with no scheme and no port: `box.tail1234.ts.net`.
 *
 * Unqualified, because there is no reading of a tailnet hostname in a public
 * PR body that is not a leak, and requiring a scheme around it would let the
 * bare form through.
 */
const TAILNET_NAME = new RegExp(String.raw`\b[A-Za-z0-9-]+\.ts\.net\b`, 'gi');

/**
 * Every instance-local address reference in one string, de-duplicated.
 *
 * Exported for the tests and for any caller that wants the finding without the
 * surrounding report text. A bare `localhost` in prose is deliberately not a
 * match — see the header's note on why the shape is split by surface.
 */
export function findInstanceHosts(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return [
    ...new Set([...findAll(text, HOST_IN_URL), ...findAll(text, HOST_WITH_PORT), ...findAll(text, TAILNET_NAME)]),
  ];
}

/** True when the line is the added half of a unified-diff body. */
function isAddedLine(line) {
  return line.startsWith('+') && !line.startsWith('+++');
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Decides whether a unified diff was fully delivered.
 *
 * GitHub truncates the patch it returns for a large diff and puts nothing in
 * the payload to say so. The truncation is still detectable, because a hunk
 * header declares exactly how many body lines follow it. A hunk that ends
 * early has been cut. The alternative — trusting that what arrived is what
 * changed — is a gate that reports "no internal references" about code it
 * never read.
 */
export function patchIsComplete(patch) {
  const lines = patch.split('\n');
  let declared = null;

  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      declared = {
        old: header[2] === undefined ? 1 : Number(header[2]),
        next: header[4] === undefined ? 1 : Number(header[4]),
        seenOld: 0,
        seenNext: 0,
      };
      continue;
    }
    if (declared === null) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    // An empty string is not a unified-diff body line. A real empty context
    // line is a single space. The trailing '' that `split` leaves after a
    // final newline is the common case, and counting it as context would pad
    // the last hunk back up to its declared size and hide every truncation.
    if (line.length === 0) continue;
    if (line.startsWith('+')) declared.seenNext += 1;
    else if (line.startsWith('-')) declared.seenOld += 1;
    else declared.seenOld += 1, declared.seenNext += 1;
  }

  if (declared === null) return { complete: true };

  return {
    complete: declared.seenOld >= declared.old && declared.seenNext >= declared.next,
  };
}

/**
 * @param {object} input
 * @param {string} input.prTitle
 * @param {string} input.prBody
 * @param {string} input.prBranch
 * @param {Array<{commit?: {message?: string}}>} [input.commits]
 * @param {Array<object>} [input.files]  entries of `/pulls/{n}/files`
 * @param {string|string[]|undefined} [input.prefixes]
 * @param {string|string[]|undefined} [input.productOwnedPrefixes]
 * @returns {{passed: boolean, failures: string[]}}
 */
export function checkInternalRefs({
  prTitle = '',
  prBody = '',
  prBranch = '',
  commits = [],
  files = [],
  prefixes,
  productOwnedPrefixes,
} = {}) {
  const { prefixes: resolved, configError } = resolvePrefixes(prefixes);
  if (configError) return { passed: false, failures: [configError] };

  const { owned, configError: ownedError } = resolveProductOwnedPrefixes(productOwnedPrefixes);
  if (ownedError) return { passed: false, failures: [ownedError] };

  const { separated, compact, link } = buildMatchers(resolved);
  const prefixLabel = resolved.map((p) => `${p}-<number>`).join(', ');
  const failures = [];

  const report = (surface, location, hits, extra = '') => {
    const listed = [...new Set(hits)].slice(0, 8).map((h) => `\`${h}\``).join(', ');
    failures.push(
      `${surface} carries ${listed}${hits.length > 8 ? ` (and ${hits.length - 8} more)` : ''} — ` +
      `internal issue identifier${hits.length > 1 ? 's' : ''} from this instance's namespace. ` +
      `CONTRIBUTING.md ("No Internal Issue References") bans \`{PREFIX}-{NUMBER}\` that is not a public GitHub issue number, ` +
      `because a reviewer on github.com cannot open it. Restate the context in plain English instead.` +
      (extra ? ` ${extra}` : '')
    );
    if (location) {
      failures.push(`  ↳ found in ${location}`);
    }
  };

  /**
   * The instance-local-address half of the same rule, on the same four
   * authored surfaces and nowhere else.
   *
   * Its own report text, because the fix is not "restate the context in plain
   * English" — a reviewer can read `http://<host>:<port>` perfectly well. The
   * fix is to write the endpoint as a shape instead of an address, and the
   * failure has to say that or the author removes the sentence instead.
   */
  const hostReport = (surface, location, text, extra = '') => {
    const hits = findInstanceHosts(text);
    if (hits.length === 0) return;
    const listed = [...hits].slice(0, 8).map((h) => `\`${h}\``).join(', ');
    failures.push(
      `${surface} carries ${listed}${hits.length > 8 ? ` (and ${hits.length - 8} more)` : ''} — ` +
      'an address that resolves to one machine, not to a repository. ' +
      'CONTRIBUTING.md ("No Internal Issue References") bans `localhost`, private-IP and tailnet URLs ' +
      'pointing at your own instance, because a reviewer on github.com has no route to them. ' +
      'Write the endpoint as a shape — `scheme://<host>:<port>` — and say what it is, not where it happened to run.' +
      (extra ? ` ${extra}` : '')
    );
    if (location) {
      failures.push(`  ↳ found in ${location}`);
    }
  };

  /**
   * The open-shape half of the same rule, on the same four authored surfaces.
   *
   * Its own report text, because this finding is a different mistake from a
   * configured-prefix finding and the fix is different. A `PET-` id is a
   * coordinate from this instance's board. An unconfigured `TASK-482` is the
   * same mistake made by a tool whose namespace nobody here configured, and the
   * only way to write the body correctly is to stop pointing at the ticket
   * altogether — so the failure has to say that, or the author adds a second
   * prefix to the config and the hole moves rather than closes.
   */
  const unknownReport = (surface, location, text, owned, alreadyFound, extra = '', options = {}) => {
    const hits = findUnknownInternalRefs(text, owned, alreadyFound, options);
    if (hits.length === 0) return;
    const listed = [...hits].slice(0, 8).map((h) => `\`${h}\``).join(', ');
    failures.push(
      `${surface} refers to ${listed}${hits.length > 8 ? ` (and ${hits.length - 8} more)` : ''} — ` +
      'an issue identifier in a namespace this repository has no exemption for. ' +
      'CONTRIBUTING.md ("No Internal Issue References") bans `{PREFIX}-{NUMBER}` that is not a public GitHub ' +
      'issue number, because a reviewer on github.com cannot open it. Restate what the issue was in plain ' +
      'English and delete the reference.' +
      (extra ? ` ${extra}` : '')
    );
    if (location) {
      failures.push(`  ↳ found in ${location}`);
    }
  };

  // --- Surface 1: PR title -------------------------------------------------
  const titleHits = [...findAll(prTitle, separated), ...findAll(prTitle, compact), ...findAll(prTitle, link)];
  if (titleHits.length > 0) {
    report('The PR title', null, titleHits,
      'A squash merge takes the PR title as the commit subject, so this becomes permanent history and cannot be cleaned up afterwards without a rewrite.');
  }
  unknownReport('The PR title', null, prTitle, owned, titleHits,
    'A squash merge takes the PR title as the commit subject, so this becomes permanent history and cannot be cleaned up afterwards without a rewrite.');
  hostReport('The PR title', null, prTitle,
    'A squash merge takes the PR title as the commit subject, so an instance address in a title is permanent history.');

  // --- Surface 2: PR body --------------------------------------------------
  const bodyHits = [...findAll(prBody, separated), ...findAll(prBody, compact), ...findAll(prBody, link)];
  if (bodyHits.length > 0) {
    report('The PR description', null, bodyHits,
      'The description should carry the reasoning, not the coordinates of a ticket nobody outside this instance can open.');
  }
  unknownReport('The PR description', null, prBody, owned, bodyHits,
    'A repro step is where these arrive, because the id is the one part of the step a reader cannot reconstruct. Say what the issue was, not what number it had here.');
  hostReport('The PR description', null, prBody,
    'A curl line or a config snippet pasted verbatim is where these arrive: the endpoint is the one thing a reader cannot reconstruct.');

  // --- Surface 3: branch name ---------------------------------------------
  const branchHits = [...findAll(prBranch, separated), ...findAll(prBranch, compact)];
  if (branchHits.length > 0) {
    report(`The branch name \`${prBranch}\``, null, branchHits,
      'CONTRIBUTING.md ("Branch Naming") asks for a name describing the change, and ships the rename snippet for exactly this case.');
  }
  // No reference-position requirement here, and only here: a branch name has
  // no verb, no `#` and no path to key on, so the reference rules would never
  // fire and `fix/TASK-482-unbound-target` would pass.
  unknownReport(`The branch name \`${prBranch}\``, null, prBranch, owned, branchHits,
    'CONTRIBUTING.md ("Branch Naming") asks for a name describing the change, and ships the rename snippet for exactly this case.',
    { requireReference: false });
  hostReport(`The branch name \`${prBranch}\``, null, prBranch,
    'A branch name is published on the PR and outlives the merge.');
  // On this surface the address rule can only ever fire on a bare `.ts.net`
  // name, and that is a property of git rather than of the matchers.
  // `git check-ref-format` rejects a refname containing `:`, `@{`, or `//`, so
  // every shape `HOST_IN_URL` and `HOST_WITH_PORT` exist to catch — an
  // authority, a credentialed DSN, a spelled-out URL — is unrepresentable in a
  // branch name. Relaxing the path lookbehind for this surface therefore buys
  // nothing and reads as though it does. Measured over the 84 branch names that
  // have ever been a head on this fork, the branch surface reported 16
  // findings, and all 16 were identifiers. The address shapes a branch *can*
  // carry are the bare ones, which the header's second exclusion declines on
  // purpose: `fix/10.0.0.7-rebind` describes a change accurately and a hyphen
  // is how a branch name separates its words, so reading `-8099-` as a port
  // would mean matching most names with three digits in them.

  // --- Surface 4: commit subjects ----------------------------------------
  // A squash collapses the branch into the PR title, but a merge or a rebase
  // preserves these subjects, and a reviewer reading `git log` before merging
  // reads them today.
  const commitHits = [];
  const commitLocations = [];
  for (const commit of commits ?? []) {
    const message = commit?.commit?.message;
    if (typeof message !== 'string') continue;
    const firstLine = message.split('\n')[0];
    const hits = [...findAll(firstLine, separated), ...findAll(firstLine, compact)];
    if (hits.length === 0) continue;
    commitHits.push(...hits);
    commitLocations.push(firstLine.trim().slice(0, 80));
  }
  if (commitHits.length > 0) {
    report('A commit subject', commitLocations[0], commitHits,
      'Rewrite the subject (`git rebase -i`, `reword`); a merged subject is permanent history.');
  }
  for (const commit of commits ?? []) {
    const message = commit?.commit?.message;
    if (typeof message !== 'string') continue;
    const firstLine = message.split('\n')[0];
    unknownReport('A commit subject', firstLine.trim().slice(0, 80), firstLine, owned, [],
      'Rewrite the subject (`git rebase -i`, `reword`); a merged subject is permanent history.');
    if (findInstanceHosts(firstLine).length > 0) {
      hostReport('A commit subject', firstLine.trim().slice(0, 80), firstLine,
        'Rewrite the subject (`git rebase -i`, `reword`); a merged subject is permanent history.');
    }
  }

  // --- Surface 5: the diff, and the paths it touches -----------------------
  //
  // The instance-address rule stops here, on purpose. 664 files on master use
  // `localhost` in the e2e and dev surface, and a test that asserts a service
  // binds `127.0.0.1` is the code working. Authored text is where the address
  // is a leak; a diff line is where it is usually the subject matter. Only the
  // identifier half of the rule applies to the diff.

  const allowReasons = new Map(ALLOWLIST.filter((e) => e && e.path && e.reason).map((e) => [e.path, e.reason]));
  const allowless = ALLOWLIST.filter((e) => !e || !e.path || !e.reason);
  if (allowless.length > 0) {
    failures.push(
      `The gate's own ALLOWLIST has ${allowless.length} entry that carries no \`path\`/\`reason\` pair, so it cannot be ` +
      'reviewed. Every exemption must state why the path is exempt. Remove the entry or give it a reason.'
    );
  }

  if (files.length >= MAX_PR_FILES) {
    failures.push(
      `The changed-file list reached GitHub's ${MAX_PR_FILES}-file cap, so the diff could not be fully scanned. ` +
      'This gate reports failure rather than a clean result it did not earn. Split the change.'
    );
  }

  const diffHits = [];
  const diffLocations = [];
  const unscannable = [];

  for (const file of files ?? []) {
    const filename = file?.filename ?? '(unnamed)';
    // A file's own name is part of the change and can carry the id, which is
    // how `pet9002-blocker-edge-one-way-door.test.ts` reached the tree. A rename
    // publishes its new name, so the path is checked even where the *content*
    // is exempt — which is why this sits above the exemption checks.
    const pathHits = [...findAll(filename, separated), ...findAll(filename, compact)];
    if (pathHits.length > 0) {
      diffHits.push(...pathHits);
      diffLocations.push(`the file name \`${filename}\` (status \`${file?.status ?? 'unknown'}\`)`);
    }

    // The gate and its test contain the literals they search for, and the rule
    // text has to quote the banned shapes to define them. Both are exempt from
    // the *content* scan only: an id in a PR title still fails regardless.
    if (allowReasons.has(filename) || SELF_EXEMPT_PATHS.includes(filename)) continue;

    const changes = typeof file?.changes === 'number' ? file.changes : 0;
    const patch = typeof file?.patch === 'string' ? file.patch : null;

    if (patch === null) {
      // No patch with no reported line changes is a binary file or a pure
      // rename: there is no text to scan, which is a true negative.
      if (changes > 0) {
        unscannable.push(`${filename} (${changes} changed lines, no patch in the API response)`);
      }
      continue;
    }

    const completeness = patchIsComplete(patch);
    if (!completeness.complete) {
      unscannable.push(`${filename} (patch truncated by the GitHub API)`);
    }

    for (const line of patch.split('\n')) {
      if (!isAddedLine(line)) continue;
      const hits = [...findAll(line, separated), ...findAll(line, link)];
      if (hits.length === 0) continue;
      diffHits.push(...hits);
      diffLocations.push(`${filename}: ${line.replace(/^\+/, '').trim().slice(0, 80)}`);
    }
  }

  if (diffHits.length > 0) {
    report('The diff', diffLocations[0], diffHits,
      'A code comment lands in the tree permanently and reads as a public reference; say what the defect was, not which ticket it came from.');
  }

  if (unscannable.length > 0) {
    failures.push(
      `The diff could not be completely scanned, so this gate cannot certify it. ` +
      `${unscannable.length} changed file${unscannable.length === 1 ? '' : 's'} arrived without readable patch content: ` +
      `${unscannable.slice(0, 5).map((u) => `\`${u}\``).join(', ')}${unscannable.length > 5 ? ` (and ${unscannable.length - 5} more)` : ''}. ` +
      'Reported as a failure because "no internal references found" is a claim this run cannot make.'
    );
  }

  return { passed: failures.length === 0, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkInternalRefs({
    prTitle: process.env.PR_TITLE ?? '',
    prBody: process.env.PR_BODY ?? '',
    prBranch: process.env.PR_BRANCH ?? '',
    commits: JSON.parse(process.env.PR_COMMITS ?? '[]'),
    files: JSON.parse(process.env.PR_FILES ?? '[]'),
    prefixes: process.env.INTERNAL_REF_PREFIXES,
    productOwnedPrefixes: process.env.PRODUCT_OWNED_REF_PREFIXES,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
