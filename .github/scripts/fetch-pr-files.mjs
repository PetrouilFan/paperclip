#!/usr/bin/env node
/**
 * fetch-pr-files.mjs
 * Fetches the full changed-file list for a PR across GitHub pagination.
 *
 * Also exports fetchWholeFileContents, the second reader the internal-reference
 * gate uses when GitHub declines to deliver a patch for a file.
 */
import { MAX_SCANNED_FILE_BYTES } from './check-pr-internal-refs.mjs';

/**
 * The ceiling on how many whole-file reads one pull request may cost.
 *
 * Real pull requests need zero or one. The bound exists so the pathological
 * case — a pull request whose every changed file is unreadable by patch, which
 * is what a 3000-file diff of generated output looks like — cannot turn one
 * gate run into 3000 sequential API calls inside a 15s-per-call timeout.
 *
 * It fails closed in the direction that matters: the files past the bound simply
 * have no content handed to the gate, so they land in `unscannable` and the gate
 * reports it cannot certify them. Truncating the read list can only cost
 * coverage, never manufacture it.
 */
export const MAX_WHOLE_FILE_FETCHES = 10;

export async function fetchAllPullRequestFiles(ghFetchFn, repo, prNumber, token) {
  const files = [];

  for (let page = 1; ; page += 1) {
    const batch = await ghFetchFn(
      `/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      token
    );
    files.push(...batch);

    if (batch.length < 100) {
      return files;
    }
  }
}

/**
 * Read the published content of files whose patch did not arrive.
 *
 * The `ref` is the pull request's head commit and not a branch name on purpose:
 * a branch name resolves to whatever the branch points at *now*, so a re-read
 * after a push could hand the gate content from a commit the pull request never
 * had. A commit cannot move, so the read is about the change under review or
 * about nothing.
 *
 * Each path segment is encoded individually and the slashes are kept, because
 * `encodeURIComponent` on the whole path would escape them and GitHub would
 * answer 404 for a path that exists.
 *
 * A file that cannot be read is simply absent from the result. That is the
 * contract the gate is built around: absent means "this file is not covered",
 * and the gate turns that into its own unscannable failure rather than into a
 * pass. Throwing instead would take down every gate in the run, including the
 * ones that do not read files at all, over a supplementary read.
 */
export async function fetchWholeFileContents(ghFetchFn, repo, filenames, ref, token) {
  const contents = {};
  if (typeof ref !== 'string' || ref === '') return contents;

  for (const filename of filenames.slice(0, MAX_WHOLE_FILE_FETCHES)) {
    const encoded = filename.split('/').map(encodeURIComponent).join('/');
    const path = `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
    try {
      const body = await ghFetchFn(path, token, {
        raw: true,
        headers: { Accept: 'application/vnd.github.raw' },
      });
      // The cap is enforced here as well as in the gate, so an oversized file
      // costs one request instead of a 4 MB transfer on every run.
      if (typeof body !== 'string') continue;
      if (Buffer.byteLength(body, 'utf8') > MAX_SCANNED_FILE_BYTES) continue;
      contents[filename] = body;
    } catch {
      // Absent by design; see the doc comment.
    }
  }

  return contents;
}
