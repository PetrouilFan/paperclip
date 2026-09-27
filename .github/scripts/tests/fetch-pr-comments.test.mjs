import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPullRequestComments } from '../fetch-pr-comments.mjs';

/**
 * The three endpoints GitHub splits "a comment" across, and the two shapes a
 * response arrives in. A fetcher that took only the thread would return a clean
 * list on a pull request whose review body carried a leak, and there is no way
 * to tell that apart from a pull request nobody reviewed — which is why the
 * review endpoint is a separate assertion here rather than a detail.
 */
function stub(pages) {
  const seen = [];
  const fn = async (path, token) => {
    seen.push({ path, token });
    for (const [matcher, batches] of Object.entries(pages)) {
      if (path.startsWith(matcher)) return batches[seen.filter((s) => s.path.startsWith(matcher)).length - 1] ?? [];
    }
    return [];
  };
  return { fn, seen };
}

test('all three comment endpoints are read and flattened into one list', async () => {
  const { fn, seen } = stub({
    '/repos/o/r/issues/7/comments': [[{ body: 'a thread comment', user: { login: 'a' } }]],
    '/repos/o/r/pulls/7/comments': [[{ body: 'an inline comment', user: { login: 'b' } }]],
    '/repos/o/r/pulls/7/reviews': [[{ body: 'a review body', user: { login: 'c' } }]],
  });

  const comments = await fetchAllPullRequestComments(fn, 'o/r', 7, 'tok');

  assert.deepEqual(
    comments.map((c) => c.body),
    ['a thread comment', 'an inline comment', 'a review body'],
  );
  // The tag is the only reason the list can name which endpoint a finding came
  // from; a reader who cannot tell a review body from a thread comment cannot
  // act on the finding.
  assert.deepEqual(comments.map((c) => c.kind), ['issue comment', 'inline review comment', 'review body']);
  assert.deepEqual([...new Set(seen.map((s) => s.token))], ['tok']);
});

test('a review with no body is not a comment', async () => {
  // `/pulls/{n}/reviews` returns a row per review event, and an approval or a
  // dismissal carries no text. Returning those would put 3-4 empty entries in
  // front of the gate on every reviewed pull request.
  const { fn } = stub({
    '/repos/o/r/pulls/7/reviews': [[
      { body: '', user: { login: 'a' } },
      { body: '   ', user: { login: 'a' } },
      { body: null, user: { login: 'a' } },
      { body: 'real text', user: { login: 'a' } },
    ]],
  });
  const comments = await fetchAllPullRequestComments(fn, 'o/r', 7, 'tok');
  assert.deepEqual(comments.map((c) => c.body), ['real text']);
});

test('an empty pull request is an empty list, not a failure', async () => {
  // Two of the 100 pull requests in the measured population have no comments at
  // all, and `passed: true` off an empty list is the correct answer for those
  // two. It is only wrong when the list is empty *because the fetch failed*, and
  // that distinction is the caller's — which is why this function rejects
  // rather than swallowing.
  const { fn } = stub({});
  assert.deepEqual(await fetchAllPullRequestComments(fn, 'o/r', 7, 'tok'), []);
});

test('a failing endpoint rejects, and the rejection is not an empty list', async () => {
  // The whole reason the caller can distinguish "nobody commented" from "the
  // API was down" and hand the gate a failure instead of a clean scan.
  const fn = async (path) => {
    if (path.startsWith('/repos/o/r/pulls/7/comments')) throw new Error('503 Service Unavailable');
    return [];
  };
  await assert.rejects(() => fetchAllPullRequestComments(fn, 'o/r', 7, 'tok'), /503/);
});

test('pagination continues past a full page', async () => {
  // A 100-long page is not the end of the list, and stopping there would be a
  // silent truncation — the failure mode the whole surface fails closed on.
  const first = Array.from({ length: 100 }, (_, i) => ({ body: `c${i}`, user: { login: 'a' } }));
  const second = [{ body: 'c100', user: { login: 'a' } }];
  let issueCalls = 0;
  const fn = async (path) => {
    if (path.startsWith('/repos/o/r/issues/7/comments')) {
      issueCalls += 1;
      return issueCalls === 1 ? first : second;
    }
    return [];
  };
  const comments = await fetchAllPullRequestComments(fn, 'o/r', 7, 'tok');
  assert.equal(comments.length, 101);
  assert.equal(comments.at(-1).body, 'c100');
  assert.equal(issueCalls, 2);
});
