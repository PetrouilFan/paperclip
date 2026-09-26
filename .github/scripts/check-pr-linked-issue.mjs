#!/usr/bin/env node
/**
 * check-pr-linked-issue.mjs
 * Checks that a PR body either links an existing issue/PR or inlines an
 * issue-template-shaped description. Respects conventional commit prefixes —
 * skips check for docs/chore/build/ci/style/test/revert prefixed PRs.
 *
 * Exports:
 *   checkLinkedIssue(prBody, prTitle, options) → { passed, failures }
 *   hasInlineIssueDescription(prBody) → boolean
 *   scoreInlineDescription(prBody) → { best, union, byTemplate }
 *   TEMPLATE_FIELDS — the field vocabulary, exported so a test can hold the
 *     canonical-label uniqueness invariant that `union` depends on
 */
import { fileURLToPath } from 'node:url';

const ISSUE_PATTERNS = [
  /(?:fixes|closes|resolves|refs)\s+#\d+/i,
  /(?:^|[\s(])https:\/\/github\.com\/paperclipai\/paperclip\/issues\/\d+(?=$|[\s),:;!?]|[.](?![\w-]))/i,
  /(?<!\w)#\d+/,
];

// Prefixes where neither a linked issue nor an inline description is required
const SKIP_ISSUE_PREFIXES = ['docs', 'chore', 'build', 'ci', 'style', 'test', 'revert'];

// Minimum number of template fields the PR body must match to count as an
// inline issue description.
const INLINE_DESCRIPTION_MIN_FIELDS = 3;

// Per-template field labels. Each field is an array of accepted variants; the
// field counts as "present" if any variant appears as a markdown heading
// (`## Label`) or as a bolded/plain label on its own line (`**Label**` /
// `Label:`). Matching is case-insensitive.
//
// Each field carries one of two weights:
//
//   - `required` fields are what the pass threshold is measured against.
//   - `optional` fields are still recognised, so they keep working as field
//     boundaries during the content scan and their presence is reported back to
//     the author, but they never count toward the threshold.
//
// `Paperclip version` is optional for a concrete reason: a version is not
// knowable at PR-authoring time for a change that has not shipped yet. Listing
// it as required meant the gate could only be satisfied by guessing a version or
// writing `master`, so it scored a correct, complete bug report as a failure.
//
// The first variant of every field is its canonical label. Canonical labels are
// unique across all templates, which is what lets `scoreInlineDescription`
// count the fields a body filled without double-counting.
export const TEMPLATE_FIELDS = {
  bug: {
    required: [
      ['What happened', 'What happened?'],
      // "Expected result" is a synonym of the same field, and the wording the
      // repository's own earlier bug templates used. Requiring the exact
      // spelling rejected a complete report over one word.
      ['Expected behavior', 'Expected behaviour', 'Expected result'],
      ['Steps to reproduce', 'Reproduction steps', 'Repro steps'],
      ['Deployment mode'],
    ],
    optional: [
      ['Paperclip version', 'Paperclip version or commit', 'Version or commit', 'Version/commit'],
    ],
  },
  feature: {
    required: [
      ['Problem or motivation', 'Problem', 'Motivation'],
      ['Proposed solution', 'Solution'],
      ['Alternatives considered', 'Alternatives'],
      ['Roadmap alignment', 'Roadmap'],
    ],
    optional: [],
  },
  adapter: {
    required: [
      ['Agent or provider', 'Agent', 'Provider', 'Adapter'],
      ["Why this adapter is useful", "Why it's useful", 'Why useful', 'Use case'],
      ['How the agent is invoked', 'How it is invoked', "How it's invoked", 'Invocation'],
    ],
    optional: [],
  },
  // Labels below match .github/ISSUE_TEMPLATE/enhancement.yml exactly.
  enhancement: {
    required: [
      ['What existing behavior does this improve?', 'What existing behavior does this improve'],
      ['Subsystem affected'],
      ['Current behavior'],
      ['Proposed behavior'],
      ['Reason and benefit'],
      ['Breaking changes'],
    ],
    optional: [],
  },
  // Labels below match .github/ISSUE_TEMPLATE/docs_issue.yml exactly. The
  // template has 4 distinct fields, so it meets the 3-field minimum. A
  // "docs"-prefixed PR skips this check; this set helps a non-"docs"-prefixed
  // PR that describes a documentation issue inline.
  docs: {
    required: [
      ['Issue type'],
      ['Where is the issue?', 'Where is the issue'],
      ["What's wrong?", "What's wrong"],
      ['Suggested fix'],
    ],
    optional: [],
  },
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A generic "label line" is a markdown heading (`## Label`) or a bolded label on
// its own line (`**Label**`). The content scan stops at a label line, because
// that line starts a new field.
const LABEL_LINE = /^\s*(?:#{1,6}\s+\S|(?:\*\*|__)[^*_].*(?:\*\*|__)\s*[:?]?\s*$)/;

// Build the regex that matches one field label on its own line.
function labelLinePattern(label) {
  const esc = escapeRegExp(label);
  // Accept markdown headings or bolded/plain labels on their own line.
  // Examples: "## What happened?", "**Expected behavior**", "Problem:".
  return new RegExp(
    `^\\s*(?:#{1,6}\\s+|\\*\\*\\s*|__\\s*)?${esc}(?:\\s*[:?])?(?:\\s*\\*\\*|\\s*__)?\\s*$`,
    'i'
  );
}

// Every known field label from every template, required and optional alike,
// precompiled. The generic LABEL_LINE regex sees a heading or a bold label as a
// field boundary, but not a plain "Label:" line. A skeleton of stacked plain
// labels needs each label to act as a boundary. Without this list the scan
// reads the next label as content, so it counts an empty field as filled.
const KNOWN_LABEL_PATTERNS = Object.values(TEMPLATE_FIELDS)
  .flatMap(t => [...t.required, ...t.optional])
  .flat()
  .map(labelLinePattern);

// Return true if the line starts a new field. The line is a heading, a bold
// label, or a plain line that equals a known field label.
function isFieldBoundary(line) {
  return LABEL_LINE.test(line) || KNOWN_LABEL_PATTERNS.some(p => p.test(line));
}

// Return true if the line holds real content, not a bare placeholder. The
// default template skeleton puts a lone "-" under each label, so a label with
// only "-", blank lines, or a "[...]" placeholder does not count as filled.
function lineHasContent(line) {
  let text = line.trim();
  if (!text) return false;
  // Drop a leading list marker ("- ", "* ", "1. ") before the check.
  text = text.replace(/^[-*+]\s*/, '').replace(/^\d+[.)]\s*/, '').trim();
  if (!text) return false;
  // Treat a whole-line bracket placeholder ("[describe here]") as empty.
  if (/^\[.*\]$/.test(text)) return false;
  return true;
}

// Return true if a label variant appears on its own line AND at least one
// content line follows it before the next label line.
function isFieldFilled(lines, variants) {
  const patterns = variants.map(labelLinePattern);
  for (let i = 0; i < lines.length; i += 1) {
    if (!patterns.some(p => p.test(lines[i]))) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isFieldBoundary(lines[j])) break; // next field starts here
      if (lineHasContent(lines[j])) return true;
    }
  }
  return false;
}

// Return the required fields of one template the body filled, in declaration
// order. Optional fields are excluded: they are recognised as boundaries during
// the scan but must not let a body clear the threshold on fields the gate does
// not require.
function filledRequiredFields(lines, fieldSet) {
  return fieldSet.filter(variants => isFieldFilled(lines, variants));
}

// Remove HTML comments. The PR template puts its guidance and its example
// issue links ("Fixes: #123") inside comments, so the gate must not read them
// as author content.
function stripHtmlComments(body) {
  return body.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Score a PR body against every issue template.
 *
 * Returns:
 *   best      — the highest score any single template reached
 *   union     — how many distinct required fields the body filled across all
 *               templates, counted by canonical label
 *   byTemplate— per-template required-field counts
 *
 * `union` exists because the threshold used to be all-or-nothing across
 * templates: a body that substantively covers both a bug and a doc change could
 * score 2 on `bug` and 2 on `docs` and fail, because only one template was ever
 * allowed to clear the bar. It still does not weaken the gate — every counted
 * field must be a real, filled template label, so prose-only bodies and
 * unfilled skeletons score 0 either way.
 */
export function scoreInlineDescription(body) {
  if (!body || !body.trim()) return { best: 0, union: 0, byTemplate: {} };

  const lines = stripHtmlComments(body).split(/\r?\n/);
  const byTemplate = {};
  const filledLabels = new Set();
  let best = 0;

  for (const [name, { required }] of Object.entries(TEMPLATE_FIELDS)) {
    const filled = filledRequiredFields(lines, required);
    byTemplate[name] = filled.length;
    if (filled.length > best) best = filled.length;
    // The first variant is the canonical label, unique across templates.
    for (const variants of filled) filledLabels.add(variants[0]);
  }

  return { best, union: filledLabels.size, byTemplate };
}

export function hasInlineIssueDescription(body) {
  const { best, union } = scoreInlineDescription(body);
  return Math.max(best, union) >= INLINE_DESCRIPTION_MIN_FIELDS;
}

function parsePrefix(title) {
  if (!title) return null;
  const match = title.match(/^([a-z]+)(?:\([^)]*\))?:/);
  return match ? match[1].toLowerCase() : null;
}

// Render what the scan actually read, so a failing author can see the gap
// instead of guessing. Keeps only the single line the PR comment renders: the
// gate posts each failure as one `- [ ] ` item.
function describeScore(body) {
  const { union, byTemplate } = scoreInlineDescription(body);
  const seen = Object.entries(byTemplate)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`);
  const filled = seen.length ? seen.join(', ') : 'no template field was filled';
  return (
    `This check read your body and found ${filled}` +
    ` (${union} distinct filled, ${INLINE_DESCRIPTION_MIN_FIELDS} required).`
  );
}

const TEMPLATE_URL =
  'https://github.com/paperclipai/paperclip/tree/master/.github/ISSUE_TEMPLATE';

// Build the "no linked issue" guidance for the repository the PR targets.
//
// A repository with GitHub issues disabled has no issue to reference, so the
// `Fixes #NNN` advice is not a slower route there — it is an unsatisfiable one,
// and `ISSUE_PATTERNS` is a bare regex that never checks the number resolves,
// so following it means publishing a link to a number that does not exist. On
// such a repository the inline description is the only honest route, so it
// leads the message and the issue-link advice is dropped entirely.
function noLinkedIssueMessage(body, { repoHasIssues }) {
  const n = INLINE_DESCRIPTION_MIN_FIELDS;
  const threshold = `at least ${n} filled fields from one template, or ${n}+ spread across templates`;

  if (repoHasIssues === false) {
    return (
      'No inline issue description found, and this repository has GitHub issues ' +
      'disabled, so there is no issue to link. Describe the underlying issue inline ' +
      `in the PR body, following one of our issue templates (${TEMPLATE_URL}): ` +
      `${threshold}. A bug report needs what happened, expected behavior, and ` +
      'steps to reproduce. Do not add a `#NNN` to satisfy this check — on this ' +
      'repository the number would not resolve to anything a reviewer can open. ' +
      'See CONTRIBUTING.md → "Link Issues or Describe Them In-PR". ' +
      describeScore(body)
    );
  }

  return (
    'No linked issue or inline issue description found — either tag an existing issue ' +
    'with `Fixes #NNN` / `Closes #NNN` / `Refs #NNN`, or describe the underlying issue ' +
    `inline in the PR body following one of our issue templates (${TEMPLATE_URL}) — ` +
    `${threshold}. ` +
    'See CONTRIBUTING.md → "Link Issues or Describe Them In-PR". ' +
    describeScore(body)
  );
}

/**
 * @param {string} prBody
 * @param {string} prTitle
 * @param {{ repoHasIssues?: boolean }} [options] `repoHasIssues` is the target
 *   repository's `has_issues` flag (`pulls/{n}.base.repo.has_issues`). It
 *   defaults to `true` so a caller that does not know the repository still gets
 *   the upstream guidance rather than silently losing the issue-link advice.
 */
export function checkLinkedIssue(body, prTitle = '', options = {}) {
  const { repoHasIssues = true } = options;
  const prefix = parsePrefix(prTitle);

  if (prefix && SKIP_ISSUE_PREFIXES.includes(prefix)) {
    return { passed: true, failures: [] };
  }

  if (!body || !body.trim()) {
    return { passed: false, failures: ['PR body is empty — please fill out the PR template'] };
  }

  const linked = ISSUE_PATTERNS.some(p => p.test(stripHtmlComments(body)));
  const inlined = hasInlineIssueDescription(body);
  const passed = linked || inlined;

  return {
    passed,
    failures: passed ? [] : [noLinkedIssueMessage(body, { repoHasIssues })],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const body = process.env.PR_BODY ?? '';
  const title = process.env.PR_TITLE ?? '';
  // Standalone invocation reads the target repository's `has_issues` from
  // REPO_HAS_ISSUES. The workflow does not run this entry point — it runs
  // run-quality-gates.mjs, which passes the flag from the pull payload it has
  // already fetched. Absent here means "unknown", treated as issues-enabled so a
  // direct run keeps the upstream advice.
  const repoHasIssues = process.env.REPO_HAS_ISSUES !== 'false';
  const result = checkLinkedIssue(body, title, { repoHasIssues });
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
