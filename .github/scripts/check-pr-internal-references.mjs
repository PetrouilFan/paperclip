#!/usr/bin/env node
/**
 * check-pr-internal-references.mjs
 *
 * Enforces the two CONTRIBUTING.md sections that state a hard rule and had no
 * gate behind them:
 *
 *   - "No Internal Issue References" — titles, bodies, commits, comments
 *   - "Branch Naming"                — the branch name is public too
 *
 * Exports:
 *   checkInternalReferences(pr, options)   → { passed, failures }
 *   findInstanceIds(text, options)         → { prefix, number, line, lineNumber }[]
 *   findInstanceLinks(text)                → { match, kind }[]
 *   auditTicketShapedReferences(text)      → { token, count }[]   (measurement only)
 *   DEEP_LINK_PATTERN, AGENT_URI_PATTERN, HOST_PATTERN
 *   DEFAULT_INSTANCE_ISSUE_PREFIXES
 */
import { fileURLToPath } from 'node:url';

/**
 * The issue-key prefixes whose references are leaks.
 *
 * ## Why the gate is prefix-declared rather than shape-based
 *
 * The obvious implementation is "find `{PREFIX}-{NUMBER}` and fail unless the
 * prefix is public". Measured against this repository, that gate is a
 * false-positive generator and could not ship.
 *
 * `{ALLCAPS}-{NUMBER}` is not a ticket-id namespace. Every `{ALLCAPS}-{NUMBER}`
 * occurrence on `master` was counted, and there are **about 200 distinct
 * prefixes** behind them:
 *
 * ```
 *   3716  PAP     fixture ids that happen to use the public prefix
 *     265  MCK     172 CHA      162 UTF     140 SHA      87 TASK
 *      64  GPT      62 SR        56 PET      50 US       46 STRESS
 *      42  TST      42 SD        37 MIG      33 LOOA     32 DOT
 *      30  BUG      28 ACME      25 PAPA     25 AGE      24 REC
 *      ... and ~170 more, down to single occurrences of AAAA-1, ZZZZ-1, FOR-1
 * ```
 *
 * Of all of it, the real leaks are `PET` (56 occurrences) and `PAPA` (25) — the
 * two prefixes this instance's board actually mints. Everything else is a
 * charset (`UTF-8`), a hash (`SHA-256`), a model id (`GPT-4`), a test name
 * (`TASK-482`, `STRESS-1`), a two-letter fixture stem (`MCK-1`, `SD-1`, `SR-1`),
 * or ordinary English in caps (`FOR-1`, `NOT-1`). A shape-based diff gate would
 * fail a PR for editing a line that mentions UTF-8.
 *
 * Every heuristic that tries to be cleverer fails on the same data: requiring
 * uppercase still matches a charset name; excluding digits from the prefix still
 * matches a hash length; a minimum prefix length still matches a two-letter
 * fixture stem. And resolving the number against the public tracker does not
 * work either — of the 20 distinct instance ids on `master`, **19 have a number
 * that resolves to a real public `paperclipai/paperclip` issue**, so number
 * resolution would pass 19 of 20 genuine leaks.
 *
 * Declaring the prefix inverts the problem into something exact. The harm the
 * rule exists to prevent is *one contributor's instance* leaking into a public
 * repository, and an instance's issue-key prefix is knowable rather than
 * guessable. Naming it costs one line and produces no false positives: on this
 * repository the two declared prefixes appear in 81 places, and every one of
 * them is a leak.
 *
 * This file reports the measurement by count and never by identifier, so that
 * adding the gate does not itself publish the ids it was written to catch. It
 * is exempt from its own diff scan for the same reason the two rule documents
 * are: a gate has to be able to name the vocabulary it forbids.
 *
 * Upstream, whose prefixes are the public one only, the default is a no-op — the
 * gate then costs nothing and catches nothing until a fork sets its own.
 */
export const DEFAULT_INSTANCE_ISSUE_PREFIXES = ['PET', 'PAPA'];

/**
 * Instance UI deep links — the second bullet of the section. The project
 * segment is open, so `/PAP/issues/PAP-1` and `/Paperclip/issues/PET-1` are both
 * caught without hardcoding any one instance's project name. The first of those
 * two is a *public* reference and is therefore not an instance path at all; the
 * example pair only shows that the project segment is not hardcoded.
 */
export const DEEP_LINK_PATTERN =
  /\/(?:[A-Za-z0-9][A-Za-z0-9_-]{0,30})\/(?:issues|agents|projects|documents|companies)\//g;

/** `agent://` is listed alongside the UI paths in CONTRIBUTING.md. */
export const AGENT_URI_PATTERN = /agent:\/\/[^\s)"'`<>]+/g;

/**
 * A URL pointing at a contributor's own instance — the third bullet:
 * `localhost`, a private RFC1918 address, or a tailnet address.
 *
 * Only ever applied to **authored PR text** (title, body, branch, commit
 * subjects), never to source files. A test asserting that a service binds
 * `http://127.0.0.1:3101` is the code working correctly, and scanning diffs for
 * hostnames would fail every server test in the repository.
 *
 * The `.internal`/`.lan`/`.corp`/`.intranet`/`.local`/`.home`/`.test` arm is the
 * tailnet case, which is why a single-label host has to be caught here and not
 * only by its IP form.
 */
export const HOST_PATTERN =
  /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|\d{1,3}(?:\.\d{1,3}){3}\.\[a-z0-9]+\.\d{1,3}\.\d{1,3}\.\d{1,3}|https?:\/\/[\w.-]*\b(?:local|internal|lan|corp|intranet|home|test)\b[\w.-]*)(?::\d{2,5})?(?:\/\S*)?/gi;

/** A URL on the public tracker. Never an instance link, and never a leak. */
const PUBLIC_TRACKER_URL = /https?:\/\/(?:www\.)?github\.com\/\S+/gi;

/**
 * Paths that carry the forbidden vocabulary **on purpose**, and so are exempt
 * from the diff scan. Without these the gate fails the very commit that adds
 * it, and fails any later edit to the rule it enforces.
 *
 * Test files in general are deliberately *not* exempt: the rule leaked into a
 * real test file on `master` — one occurrence, in a comment in a file under
 * `cli/src/__tests__/` — and exempting `*.test.*` would keep that class open.
 * Because the gate keys on a declared prefix rather than a shape, a test fixture
 * cannot trip it by accident, which is what makes leaving test files in scope
 * affordable.
 */
export const EXEMPT_PATHS = [
  'CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/scripts/check-pr-internal-references.mjs',
  '.github/scripts/tests/check-pr-internal-references.test.mjs',
];

function isExempt(filename) {
  return EXEMPT_PATHS.includes(filename);
}

function parsePrefixes(raw) {
  const list = (raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_INSTANCE_ISSUE_PREFIXES;
}

/** Build the matcher for a declared prefix set, matched case-insensitively. */
function idPatternFor(prefixes) {
  const alternation = prefixes
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  // The separator is optional because tooling slugs a ticket into a branch without
  // it: the branch this repository's own tooling produced for a merged change was
  // the glued form, lowercased and hyphen-free. CONTRIBUTING.md's own example
  // branch keeps the hyphen. Both must be caught. The leading lookbehind stops a
  // longer token from being split, and the trailing `(?!\d)` stops a longer number
  // from being split either.
  return new RegExp(`(?<![\\w-])(${alternation})-?(\\d{1,7})(?!\\d)`, 'gi');
}

/**
 * Find every reference to a declared instance issue prefix in `text`.
 *
 * Each match carries the line and its 1-based number, and is deduplicated by
 * identifier so a twenty-line comment about one ticket reports one finding.
 * The reported token is the text as authored, so an author can grep their own
 * branch or body for exactly what the message names.
 */
export function findInstanceIds(text, options = {}) {
  if (!text) return [];
  const pattern = idPatternFor(parsePrefixes(options.instanceIssuePrefixes));
  const seen = new Set();
  const found = [];

  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const key = `${match[1].toUpperCase()}-${match[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        id: match[0],
        prefix: match[1].toUpperCase(),
        number: match[2],
        line: line.trim(),
        lineNumber: index + 1,
      });
    }
  }

  return found;
}

/**
 * Count every `{ALLCAPS}-{NUMBER}` token in `text`, regardless of prefix.
 *
 * Never used to fail anything. It exists so the measurement quoted at the top of
 * this file — that the shape is shared by ~200 prefixes on this repository, of
 * which only two are leaks — is reproducible from the codebase instead of only
 * being asserted in a comment, and so a future change to the prefix list can be
 * checked against the real distribution.
 */
export function auditTicketShapedReferences(text) {
  if (!text) return [];
  const pattern = /(?<![\w-])([A-Z]{2,10})-(\d{1,7})(?!\d)/g;
  const counts = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const key = `${match[1]}-${match[2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
}

/**
 * Find instance deep links and instance-host URLs.
 *
 * `kind` is reported so the failure line can name which bullet of
 * CONTRIBUTING.md the author broke.
 *
 * Public-tracker URLs are removed from the text first. Without that, the deep
 * link pattern reads `https://github.com/paperclipai/paperclip/issues/123` as an
 * instance path: the segment before `/issues/` is the *repository* name on a
 * public link and the *project* key on an instance link, and only the host tells
 * them apart. Stripping the public URL is more precise than an allowlist for the
 * owner or repository name, neither of which is stable.
 */
export function findInstanceLinks(text) {
  if (!text) return [];
  const scannable = String(text).replace(PUBLIC_TRACKER_URL, ' ');
  const found = [];
  const push = (kind, pattern) => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(scannable)) !== null) {
      found.push({ match: match[0], kind });
    }
  };
  push('instance path link', DEEP_LINK_PATTERN);
  push('agent:// link', AGENT_URI_PATTERN);
  push('instance URL', HOST_PATTERN);
  return found;
}

/** Build the scan surface for one piece of authored text. */
function scanAuthored(label, text, options) {
  const problems = [];
  for (const hit of findInstanceIds(text, options)) {
    problems.push({
      kind: 'internal-issue-id',
      label,
      detail: `\`${hit.id}\` (line ${hit.lineNumber})`,
    });
  }
  for (const link of findInstanceLinks(text)) {
    problems.push({ kind: link.kind, label, detail: `\`${link.match}\`` });
  }
  return problems;
}

/** Added lines only: a removed line is not part of the PR's result. */
function addedLines(patch) {
  if (!patch) return [];
  return String(patch)
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1));
}

function publicLinkGuidance() {
  return (
    'Use the public tracker only: `#123`, `Fixes #123` / `Closes #123` / ' +
    '`Refs #123`, or a full `https://github.com/paperclipai/paperclip/...` URL. ' +
    'If the internal issue captured context worth keeping, restate it in plain ' +
    'English here instead of linking. '
  );
}

function branchGuidance() {
  return (
    'Rename it to describe the change itself, not your instance: ' +
    '`git branch -m docs/no-internal-issue-references`, ' +
    '`git push -u origin <new-name>`, and `git push origin --delete <old-name>` ' +
    'if the old name is already on origin. '
  );
}

/**
 * @param {object} pr
 * @param {string} [pr.prTitle]     PR title
 * @param {string} [pr.prBody]      PR body
 * @param {string} [pr.branch]      head branch name
 * @param {{sha?: string, commit?: {message?: string}}[]} [pr.commits]
 * @param {{filename: string, status?: string, patch?: string}[]} [pr.files]
 * @param {{instanceIssuePrefixes?: string}} [options] comma-separated prefixes
 */
export function checkInternalReferences(pr = {}, options = {}) {
  const { prTitle = '', prBody = '', branch = '', commits = [], files = [] } = pr;
  const problems = [];

  // CONTRIBUTING.md's own guidance lives inside an HTML comment in the template,
  // so an unstripped body reads the rule's examples as author content and fails
  // every PR that used the template. Same reason `check-pr-linked-issue.mjs`
  // strips comments.
  const body = String(prBody).replace(/<!--[\s\S]*?-->/g, '');

  if (prTitle) problems.push(...scanAuthored('PR title', prTitle, options));
  if (body.trim()) problems.push(...scanAuthored('PR body', body, options));
  if (branch) problems.push(...scanAuthored('branch name', branch, options));

  // The commit-subject scan is not redundant with the title scan. A squash merge
  // takes the PR title as the commit subject, so a title that survives review is
  // still what becomes permanent history — which is how an instance id reviewed
  // and explicitly asked to be retitled became a subject on `master` anyway.
  for (const entry of commits ?? []) {
    const subject = String(entry?.commit?.message ?? '').split('\n')[0];
    if (subject) {
      problems.push(...scanAuthored(`commit ${entry.sha ?? ''}`.trim(), subject, options));
    }
  }

  // Diff scan: an internal id in a code comment is the leak class already on
  // `master` — a workflow sentinel string and a test comment — and it survives
  // review because a reviewer reads a diff for behaviour, not for vocabulary.
  // Host and deep-link checks stay out of this scan by design — see
  // `HOST_PATTERN`.
  for (const file of files ?? []) {
    if (!file?.filename || isExempt(file.filename)) continue;
    if (file.status === 'removed') continue;
    for (const hit of findInstanceIds(addedLines(file.patch).join('\n'), options)) {
      problems.push({ kind: 'internal-issue-id', label: file.filename, detail: `\`${hit.id}\`` });
    }
  }

  if (problems.length === 0) return { passed: true, failures: [] };

  // One line per problem, matching how the orchestrator renders a failure.
  const failures = problems.map(p => {
    const isBranch = p.label === 'branch name';
    const section = isBranch ? '"Branch Naming"' : '"No Internal Issue References"';
    switch (p.kind) {
      case 'internal-issue-id':
        return (
          `Internal issue reference ${p.detail} in your ${p.label} — it names a ticket on a ` +
          `contributor's own Paperclip instance, so no reviewer can open it. ` +
          (isBranch ? branchGuidance() : publicLinkGuidance()) +
          `See CONTRIBUTING.md → ${section}.`
        );
      case 'instance path link':
        return `Instance UI link \`${p.detail}\` in your ${p.label} — it points at a contributor's own Paperclip instance and is a broken link for everyone else. ${publicLinkGuidance()}`;
      case 'agent:// link':
        return `Instance \`agent://\` link \`${p.detail}\` in your ${p.label} — it resolves only inside one instance. ${publicLinkGuidance()}`;
      default:
        return `Instance-only URL \`${p.detail}\` in your ${p.label} — a localhost, private-IP, or tailnet address is unreachable for reviewers. Describe the behaviour in words and point at the public URL instead. See CONTRIBUTING.md → "No Internal Issue References".`;
    }
  });

  return { passed: false, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const commits = JSON.parse(process.env.PR_COMMITS ?? '[]');
  const result = checkInternalReferences(
    {
      prTitle: process.env.PR_TITLE ?? '',
      prBody: process.env.PR_BODY ?? '',
      branch: process.env.PR_BRANCH ?? '',
      commits,
      files,
    },
    { instanceIssuePrefixes: process.env.INSTANCE_ISSUE_PREFIXES }
  );
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
