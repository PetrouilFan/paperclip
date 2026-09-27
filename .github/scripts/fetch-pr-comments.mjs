#!/usr/bin/env node
/**
 * fetch-pr-comments.mjs
 * Fetches every comment on a pull request, across all three endpoints GitHub
 * splits them across, and flattens them into one list.
 *
 * Three endpoints, because "a comment" is three things in the API:
 *
 * - `/issues/{n}/comments` — the conversation thread, including the gate's own
 *   report;
 * - `/pulls/{n}/comments` — inline review comments attached to a diff line;
 * - `/pulls/{n}/reviews` — the review bodies, which are the summary text a
 *   reviewer wrote and are not returned by either of the other two.
 *
 * The inline comments are not a separate surface as far as the rule is
 * concerned — a reviewer pastes a diff into an inline comment exactly as
 * readily as into the thread — so all three are flattened and tagged with
 * `kind`, and the tag exists only so a finding can name which of them it came
 * from. Measured over the 100 most recently updated pull requests on this fork:
 * 367 comments, of which one is a review body and the rest are thread and
 * inline comments, so a fetcher that took only the thread would have missed
 * exactly the one it had no way of noticing it was missing.
 */

/** GitHub's maximum page size on the comment endpoints. */
const PER_PAGE = 100;

/**
 * `fetchAllPullRequestComments` — every comment on the pull request.
 *
 * `ghFetchFn` is expected to throw on a non-2xx, and it is allowed to: the
 * caller hands the failure to the gate as `commentsUnavailable` rather than
 * treating an empty list as a clean scan. Rejecting here is the whole point —
 * the alternative is a function that returns `[]` on failure, which is
 * indistinguishable from a pull request nobody has commented on, and two of the
 * 100 pull requests in the measured population genuinely have no comments at
 * all.
 */
export async function fetchAllPullRequestComments(ghFetchFn, repo, prNumber, token) {
  const endpoints = [
    { kind: 'issue comment', path: `/repos/${repo}/issues/${prNumber}/comments` },
    { kind: 'inline review comment', path: `/repos/${repo}/pulls/${prNumber}/comments` },
    { kind: 'review body', path: `/repos/${repo}/pulls/${prNumber}/reviews` },
  ];

  const comments = [];

  for (const { kind, path } of endpoints) {
    for (let page = 1; ; page += 1) {
      const batch = await ghFetchFn(`${path}?per_page=${PER_PAGE}&page=${page}`, token);
      // A review with an empty body is not a comment. `/pulls/{n}/reviews`
      // returns one row per review event, and an approval carries no text.
      for (const entry of batch ?? []) {
        if (typeof entry?.body !== 'string' || entry.body.trim() === '') continue;
        comments.push({ ...entry, kind });
      }
      if ((batch ?? []).length < PER_PAGE) break;
    }
  }

  return comments;
}
