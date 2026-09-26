import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkLinkedIssue,
  hasInlineIssueDescription,
  scoreInlineDescription,
  TEMPLATE_FIELDS,
} from '../check-pr-linked-issue.mjs';

// Existing tests with title parameter added (defaults to no prefix, so still required)

test('passes with bare #NNN reference', () => {
  assert.equal(checkLinkedIssue('This fixes the bug in #123', 'fix: something').passed, true);
});

test('passes with "Fixes #NNN"', () => {
  assert.equal(checkLinkedIssue('Fixes #456\n\nSome description', 'fix: something').passed, true);
});

test('passes with "Closes #NNN" (case-insensitive)', () => {
  assert.equal(checkLinkedIssue('closes #789', 'fix: something').passed, true);
});

test('passes with "Resolves #NNN"', () => {
  assert.equal(checkLinkedIssue('Resolves #101', 'fix: something').passed, true);
});

test('passes with "Refs #NNN"', () => {
  assert.equal(checkLinkedIssue('Refs #202', 'fix: something').passed, true);
});

test('passes with "refs #NNN" (case-insensitive)', () => {
  assert.equal(checkLinkedIssue('refs #303', 'fix: something').passed, true);
});

test('passes with full github.com URL', () => {
  assert.equal(
    checkLinkedIssue('See https://github.com/paperclipai/paperclip/issues/202', 'fix: bug').passed,
    true
  );
});

test('passes with a full github.com URL followed by punctuation', () => {
  assert.equal(
    checkLinkedIssue('See (https://github.com/paperclipai/paperclip/issues/202).', 'fix: bug').passed,
    true
  );
});

test('fails with empty body when no skip prefix', () => {
  const result = checkLinkedIssue('', 'fix: bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

test('fails with no issue reference when no skip prefix', () => {
  const result = checkLinkedIssue('Added a cool feature, no issue linked', 'feat: something');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('Fixes #NNN'));
});

test('fails with cross-repo issue reference', () => {
  const result = checkLinkedIssue('See https://github.com/other/repo/issues/123', 'fix: bug');
  assert.equal(result.passed, false);
});

test('fails when the Paperclip issue URL is embedded inside another host', () => {
  const result = checkLinkedIssue(
    'See https://evil.example/https://github.com/paperclipai/paperclip/issues/123',
    'fix: bug'
  );
  assert.equal(result.passed, false);
});

test('fails when the Paperclip issue URL continues into another host', () => {
  const result = checkLinkedIssue(
    'See https://github.com/paperclipai/paperclip/issues/123.evil.example',
    'fix: bug'
  );
  assert.equal(result.passed, false);
});

test('fails when #NNN is part of a word (no space before)', () => {
  const result = checkLinkedIssue('This is version#123 not an issue link', 'fix: bug');
  assert.equal(result.passed, false);
});

// Prefix-aware skip behavior

test('skips check for docs: prefix', () => {
  assert.equal(checkLinkedIssue('', 'docs: update README').passed, true);
});

test('skips check for chore: prefix', () => {
  assert.equal(checkLinkedIssue('', 'chore: bump deps').passed, true);
});

test('skips check for build: prefix', () => {
  assert.equal(checkLinkedIssue('', 'build: update Dockerfile').passed, true);
});

test('skips check for ci: prefix', () => {
  assert.equal(checkLinkedIssue('', 'ci: add workflow').passed, true);
});

test('skips check for test: prefix', () => {
  assert.equal(checkLinkedIssue('', 'test: add coverage').passed, true);
});

test('skips check with scoped prefix like docs(api):', () => {
  assert.equal(checkLinkedIssue('', 'docs(api): document endpoint').passed, true);
});

test('requires issue for feat: prefix', () => {
  assert.equal(checkLinkedIssue('Some description without issue', 'feat: new thing').passed, false);
});

test('requires issue for refactor: prefix', () => {
  assert.equal(checkLinkedIssue('Some refactor', 'refactor: rewrite thing').passed, false);
});

test('requires issue when no prefix (encourages prefix usage)', () => {
  assert.equal(checkLinkedIssue('No prefix here', 'Add some feature').passed, false);
});

// Inline issue description (path 2)

const BUG_INLINE_BODY = `
## What happened?

Login button does nothing when clicked.

## Expected behavior

Clicking the login button should authenticate the user.

## Steps to reproduce

1. Open the app
2. Click login
3. Nothing happens
`;

const FEATURE_INLINE_BODY = `
## Problem or motivation

We don't have a way to bulk-tag issues.

## Proposed solution

Add a bulk-tag action to the issues list.

## Alternatives considered

Tagging individually — too slow.
`;

const ADAPTER_INLINE_BODY = `
## Agent or provider

Gemini CLI

## Why this adapter is useful

Lots of users want Gemini as an alternative model option.

## How the agent is invoked

Via the \`gemini\` CLI binary with stdin/stdout JSON.
`;

test('passes with inline bug description (3 template fields, feat: prefix)', () => {
  assert.equal(checkLinkedIssue(BUG_INLINE_BODY, 'feat: fix login button').passed, true);
});

test('passes with inline feature description (3 template fields)', () => {
  assert.equal(checkLinkedIssue(FEATURE_INLINE_BODY, 'feat: bulk tag').passed, true);
});

test('passes with inline adapter description (3 template fields)', () => {
  assert.equal(checkLinkedIssue(ADAPTER_INLINE_BODY, 'feat: gemini adapter').passed, true);
});

test('fails with only two bug template fields (below threshold)', () => {
  const body = `
## What happened?

Something broke.

## Expected behavior

It should work.
`;
  assert.equal(checkLinkedIssue(body, 'feat: fix').passed, false);
});

test('fails with a single stray template-like heading', () => {
  const body = `
This is mostly a free-form description but one heading happens to match.

## Expected behavior

Everything works.
`;
  assert.equal(checkLinkedIssue(body, 'feat: fix').passed, false);
});

test('hasInlineIssueDescription returns true for ≥3 bug fields', () => {
  assert.equal(hasInlineIssueDescription(BUG_INLINE_BODY), true);
});

test('hasInlineIssueDescription returns false for empty body', () => {
  assert.equal(hasInlineIssueDescription(''), false);
});

test('hasInlineIssueDescription accepts bolded labels with colons', () => {
  const body = `
**Problem:**
We need this.

**Proposed solution:**
Build it.

**Alternatives considered:**
None.
`;
  assert.equal(hasInlineIssueDescription(body), true);
});

// Prose-only description (no template labels) must fail. A good paragraph of
// prose matches zero labels, so the gate rejects it.
test('fails with a prose-only description that has no template labels', () => {
  const body = `
This pull request rewrites the retry loop so the worker gives up after five
attempts instead of looping forever. The previous loop could hang a job when
the upstream service was down. I also added a log line for each retry so an
operator can see the backoff in the run output.
`;
  const result = checkLinkedIssue(body, 'feat: bounded retry');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

// An author who copies the feature template labels into the PR body must pass.
// The labels use the bold-label-on-its-own-line form the gate accepts.
const FEATURE_BOLD_LABEL_BODY = `
**Problem or motivation:**
- The gate rejects a good prose description.

**Proposed solution:**
- Copy the feature template labels into the PR body.

**Alternatives considered:**
- Lower the field threshold — rejected, it weakens the gate.
`;

test('passes with the feature template labels (bold labels)', () => {
  assert.equal(checkLinkedIssue(FEATURE_BOLD_LABEL_BODY, 'feat: inline feature description').passed, true);
});

// Enhancement template set (matches .github/ISSUE_TEMPLATE/enhancement.yml).
const ENHANCEMENT_INLINE_BODY = `
## What existing behavior does this improve?

The board task list sort order.

## Current behavior

The list sorts by creation time only.

## Proposed behavior

The list sorts by priority, then creation time.

## Reason and benefit

Users miss high-priority tasks that were created early.
`;

test('passes with inline enhancement description (4 template fields)', () => {
  assert.equal(checkLinkedIssue(ENHANCEMENT_INLINE_BODY, 'feat: sort by priority').passed, true);
});

test('hasInlineIssueDescription returns true for ≥3 enhancement fields', () => {
  assert.equal(hasInlineIssueDescription(ENHANCEMENT_INLINE_BODY), true);
});

// Empty default skeleton must fail. A label with only the bare "-" placeholder
// under it is not filled, so it must not count toward the field minimum.
const EMPTY_SKELETON_BODY = `
**What happened?**
-

**Expected behavior:**
-

**Steps to reproduce:**
-
`;

test('fails with an empty template skeleton (labels but no content)', () => {
  const result = checkLinkedIssue(EMPTY_SKELETON_BODY, 'feat: something');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

test('hasInlineIssueDescription returns false for an empty skeleton', () => {
  assert.equal(hasInlineIssueDescription(EMPTY_SKELETON_BODY), false);
});

// A filled bug skeleton in the bold-label form must pass, even with list-marker
// content. This proves the fix does not reject real author content.
const FILLED_BUG_SKELETON_BODY = `
**What happened?**
- The login button does nothing.

**Expected behavior:**
- The login button authenticates the user.

**Steps to reproduce:**
- Open the app, then click login.
`;

test('passes with a filled bug skeleton (three filled fields)', () => {
  assert.equal(checkLinkedIssue(FILLED_BUG_SKELETON_BODY, 'feat: fix login').passed, true);
});

// Stacked plain labels with no content must fail. Each label sits on its own
// line with the next label directly under it. The scan must treat the next
// label as a field boundary, not as content, so every field stays empty.
const STACKED_FEATURE_LABELS = `
Problem or motivation:
Proposed solution:
Alternatives considered:
Roadmap alignment:
`;

const STACKED_BUG_LABELS = `
What happened?:
Expected behavior:
Steps to reproduce:
Paperclip version:
`;

const STACKED_ENHANCEMENT_LABELS = `
What existing behavior does this improve?
Subsystem affected
Current behavior
Proposed behavior
Reason and benefit
`;

const STACKED_DOCS_LABELS = `
Issue type
Where is the issue?
What's wrong?
Suggested fix
`;

test('fails with stacked plain feature labels and no content', () => {
  assert.equal(checkLinkedIssue(STACKED_FEATURE_LABELS, 'feat: x').passed, false);
});

test('fails with stacked plain bug labels and no content', () => {
  assert.equal(checkLinkedIssue(STACKED_BUG_LABELS, 'feat: x').passed, false);
});

test('fails with stacked plain enhancement labels and no content', () => {
  assert.equal(checkLinkedIssue(STACKED_ENHANCEMENT_LABELS, 'feat: x').passed, false);
});

test('fails with stacked plain docs labels and no content', () => {
  assert.equal(checkLinkedIssue(STACKED_DOCS_LABELS, 'feat: x').passed, false);
});

// A plain-label skeleton with real content under each label must still pass.
// The boundary fix must not reject a field that has genuine content.
const FILLED_PLAIN_FEATURE_LABELS = `
Problem or motivation:
- The gate rejects a good prose description.
Proposed solution:
- Copy the feature template labels into the PR body.
Alternatives considered:
- Lower the field threshold — rejected, it weakens the gate.
`;

test('passes with plain feature labels and real content under each', () => {
  assert.equal(checkLinkedIssue(FILLED_PLAIN_FEATURE_LABELS, 'feat: inline feature').passed, true);
});

// The real .github/PULL_REQUEST_TEMPLATE.md, submitted unchanged, must fail the
// gate. Its skeleton labels have no content and its example issue links live in
// HTML comments, so neither the inline path nor the linked path may pass it.
const PR_TEMPLATE_PATH = fileURLToPath(
  new URL('../../PULL_REQUEST_TEMPLATE.md', import.meta.url)
);

test('fails with the unfilled default PR template body', () => {
  const body = readFileSync(PR_TEMPLATE_PATH, 'utf8');
  const result = checkLinkedIssue(body, 'feat: unfilled template');
  assert.equal(result.passed, false);
});

// An issue link that appears only inside an HTML comment must not satisfy the
// linked-issue check. The template ships such an example ("Fixes: #123").
test('fails when the only issue link is inside an HTML comment', () => {
  const body = '<!-- Example: Fixes: #123 -->\n\nSome prose with no real link.';
  assert.equal(checkLinkedIssue(body, 'feat: commented link').passed, false);
});

// --- "Expected result" is the same field as "Expected behavior" -------------
//
// PR #29 described its bug completely and scored 2 of 5 because the body said
// `**Expected result**`. The template and CONTRIBUTING.md never warn about the
// spelling, and it is the word the repository's own earlier bug templates used,
// so the gate rejected a correct report over vocabulary.

const EXPECTED_RESULT_BODY = `
**What happened**

resolveInstallStorePaths returned six paths under \`paperclipHome\` and one under
\`homeDir\`. \`shimPath\` was the odd one out.

**Expected result**

One variable names the shim location for every reader and the writer.

**Steps to reproduce**

1. Install normally.
2. Point \`PAPERCLIP_HOME\` at a directory that was never installed into.
3. Run \`paperclipai doctor\`.
`;

test('passes a complete bug report that says "Expected result"', () => {
  assert.equal(checkLinkedIssue(EXPECTED_RESULT_BODY, 'fix(cli): resolve the shim').passed, true);
});

test('"Expected result" counts toward the bug score the same as "Expected behavior"', () => {
  const asBehavior = EXPECTED_RESULT_BODY.replace('Expected result', 'Expected behavior');
  assert.equal(hasInlineIssueDescription(EXPECTED_RESULT_BODY), hasInlineIssueDescription(asBehavior));
  assert.equal(scoreInlineDescription(EXPECTED_RESULT_BODY).byTemplate.bug, 3);
});

test('"Expected result" is still recognised when it is the only expected-behavior label', () => {
  const body = '## Expected result\n\nIt should work.\n';
  assert.equal(scoreInlineDescription(body).byTemplate.bug, 1);
});

// --- "Paperclip version" is optional ---------------------------------------
//
// A version is not knowable at PR-authoring time for a change that has not
// shipped. Requiring it meant the three fields the template exists to collect —
// what happened, expected behavior, steps to reproduce — could not clear the
// threshold on their own, which is exactly the body PR #29 wrote.

test('a complete bug report without a version passes', () => {
  const body = `
**What happened**
- The login button does nothing.

**Expected behavior**
- The login button authenticates the user.

**Steps to reproduce**
- Open the app, then click login.
`;
  assert.equal(checkLinkedIssue(body, 'fix: login').passed, true);
});

test('a complete bug report with a version still passes', () => {
  const body = EXPECTED_RESULT_BODY + '\n**Paperclip version**\n\n`master` at `429d14927`.\n';
  assert.equal(checkLinkedIssue(body, 'fix: login').passed, true);
});

// A version is not the thing the gate is measuring, so a body that fills only
// the version cannot reach the threshold on the strength of it.
test('"Paperclip version" alone does not count toward the threshold', () => {
  const body = `
**Paperclip version**
- \`master\` at \`429d14927\`.

**What happened**
-
`;
  assert.equal(checkLinkedIssue(body, 'fix: login').passed, false);
});

test('"Paperclip version" is still recognised as a field boundary', () => {
  // It must keep ending the content scan, or a stacked skeleton would read the
  // version as the content of the field above it.
  const body = 'What happened\nPaperclip version\nExpected behavior\n';
  assert.equal(scoreInlineDescription(body).byTemplate.bug, 0);
});

// --- A description may span templates --------------------------------------
//
// The threshold used to require one single template to clear 3 fields, so a
// body that substantively covered both a bug and a doc change scored 2 and 2
// and failed with nothing to fix.

const MIXED_BUG_AND_DOCS_BODY = `
**What happened**

The install guide documents a shim path the installer no longer writes.

**Expected behavior**

The guide and the installer agree on one path.

**Where is the issue?**

\`doc/INSTALLING.md\`, the "Shim" section.

**What's wrong?**

It still says \`~/.local/bin/paperclipai\` is written directly.
`;

test('a bug-plus-docs description passes even though neither template reaches 3', () => {
  const score = scoreInlineDescription(MIXED_BUG_AND_DOCS_BODY);
  assert.equal(score.byTemplate.bug, 2);
  assert.equal(score.byTemplate.docs, 2);
  assert.equal(score.union, 4);
  assert.equal(checkLinkedIssue(MIXED_BUG_AND_DOCS_BODY, 'fix(docs): correct the shim path').passed, true);
});

test('the union does not let a body pass on two thin slivers', () => {
  // One bug field and one docs field is 2 filled fields, still below 3.
  const body = `
**What happened**

The guide is wrong.

**What's wrong?**

It documents a path the installer does not write.
`;
  const score = scoreInlineDescription(body);
  assert.equal(score.union, 2);
  assert.equal(checkLinkedIssue(body, 'fix(docs): correct the shim path').passed, false);
});

test('the union still requires filled fields, not bare labels', () => {
  // Three filled fields spread across two templates, none of them real content.
  const body = `
What happened
-
Expected behavior
-
What's wrong
-
`;
  assert.equal(scoreInlineDescription(body).union, 0);
  assert.equal(checkLinkedIssue(body, 'fix: x').passed, false);
});

test('canonical field labels are unique across templates', () => {
  // `union` counts distinct canonical labels, so a label shared by two
  // templates would be counted once — which is the intent, but only if the
  // overlap is deliberate rather than accidental.
  const canonical = new Map();
  for (const [name, template] of Object.entries(TEMPLATE_FIELDS)) {
    for (const variants of template.required) {
      const existing = canonical.get(variants[0]);
      assert.equal(
        existing,
        undefined,
        `canonical label "${variants[0]}" appears in both ${existing} and ${name}`
      );
      canonical.set(variants[0], name);
    }
  }
});

// --- Repository-aware failure message ---------------------------------------
//
// A repository with GitHub issues disabled has no issue to reference. The
// message used to lead with `Fixes #NNN` anyway, and ISSUE_PATTERNS never
// checks that the number resolves, so the advice could only be satisfied by
// publishing a link to a number that does not exist.

const NO_LINK_BODY = 'Added a cool feature, no issue linked';

test('with issues enabled the message still offers Fixes #NNN', () => {
  const { failures } = checkLinkedIssue(NO_LINK_BODY, 'feat: something', { repoHasIssues: true });
  assert.ok(failures[0].includes('Fixes #NNN'));
});

test('with issues disabled the message drops the issue-link advice', () => {
  const { failures } = checkLinkedIssue(NO_LINK_BODY, 'feat: something', { repoHasIssues: false });
  assert.ok(!failures[0].includes('Fixes #NNN'), failures[0]);
  assert.ok(!failures[0].includes('Refs #NNN'), failures[0]);
  assert.ok(!failures[0].includes('Closes #NNN'), failures[0]);
});

test('with issues disabled the message leads with the inline route', () => {
  const { failures } = checkLinkedIssue(NO_LINK_BODY, 'feat: something', { repoHasIssues: false });
  assert.ok(failures[0].includes('has GitHub issues disabled'), failures[0]);
  assert.ok(failures[0].includes('inline'), failures[0]);
  // The message must not steer an author into a fabricated link.
  assert.ok(failures[0].includes('Do not add a `#NNN`'), failures[0]);
});

test('the message names the three fields a bug report needs', () => {
  const { failures } = checkLinkedIssue(NO_LINK_BODY, 'feat: something', { repoHasIssues: false });
  assert.ok(failures[0].includes('what happened'), failures[0]);
  assert.ok(failures[0].includes('expected behavior'), failures[0]);
  assert.ok(failures[0].includes('steps to reproduce'), failures[0]);
});

test('the message reports what the scan actually read', () => {
  const body = `
**What happened**

The login button does nothing.
`;
  const { failures } = checkLinkedIssue(body, 'fix: login', { repoHasIssues: false });
  assert.ok(failures[0].includes('bug 1'), failures[0]);
  assert.ok(failures[0].includes('1 distinct filled, 3 required'), failures[0]);
});

test('the message reports "no template field was filled" for a prose body', () => {
  const { failures } = checkLinkedIssue(NO_LINK_BODY, 'feat: something', { repoHasIssues: false });
  assert.ok(failures[0].includes('no template field was filled'), failures[0]);
});

test('the message stays a single line, because the gate renders one checkbox per failure', () => {
  const { failures } = checkLinkedIssue(NO_LINK_BODY, 'feat: something', { repoHasIssues: false });
  assert.equal(failures.length, 1);
  assert.ok(!failures[0].includes('\n'), failures[0]);
});

test('an unknown repository keeps the issue-link advice', () => {
  // `repoHasIssues` defaults to true, so a caller that does not know the
  // repository never silently loses the documented route.
  const { failures } = checkLinkedIssue(NO_LINK_BODY, 'feat: something');
  assert.ok(failures[0].includes('Fixes #NNN'), failures[0]);
  assert.ok(!failures[0].includes('has GitHub issues disabled'), failures[0]);
});

test('the issues-disabled message does not change the verdict', () => {
  // The message is advice, not policy: a body that satisfies either route still
  // passes, whatever the repository's issue setting is.
  assert.equal(checkLinkedIssue(NO_LINK_BODY, 'feat: x', { repoHasIssues: false }).passed, false);
  assert.equal(checkLinkedIssue('Fixes #1', 'feat: x', { repoHasIssues: false }).passed, true);
  assert.equal(
    checkLinkedIssue(BUG_INLINE_BODY, 'feat: x', { repoHasIssues: false }).passed,
    true
  );
});

test('a skip prefix short-circuits before the message is built', () => {
  const { failures, passed } = checkLinkedIssue('', 'docs: update README', { repoHasIssues: false });
  assert.equal(passed, true);
  assert.deepEqual(failures, []);
});

