import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPullRequestFiles, fetchWholeFileContents, MAX_WHOLE_FILE_FETCHES } from '../fetch-pr-files.mjs';
import { MAX_SCANNED_FILE_BYTES } from '../check-pr-internal-refs.mjs';

test('fetchAllPullRequestFiles: returns a single short page', async () => {
  const seenPaths = [];
  const files = await fetchAllPullRequestFiles(async (path) => {
    seenPaths.push(path);
    return [{ filename: 'src/only.ts' }];
  }, 'paperclipai/paperclip', 6469, 'token');

  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/pulls/6469/files?per_page=100&page=1',
  ]);
  assert.equal(files.length, 1);
});

test('fetchAllPullRequestFiles: keeps fetching when a page is full', async () => {
  const seenPaths = [];
  const files = await fetchAllPullRequestFiles(async (path) => {
    seenPaths.push(path);
    const page = Number(new URL(`https://github.com${path}`).searchParams.get('page'));
    if (page === 1) {
      return Array.from({ length: 100 }, (_, index) => ({
        filename: `src/file-${index + 1}.ts`,
      }));
    }
    return [{ filename: 'src/file-101.ts' }];
  }, 'paperclipai/paperclip', 6469, 'token');

  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/pulls/6469/files?per_page=100&page=1',
    '/repos/paperclipai/paperclip/pulls/6469/files?per_page=100&page=2',
  ]);
  assert.equal(files.length, 101);
  assert.equal(files.at(-1)?.filename, 'src/file-101.ts');
});

// ---------------------------------------------------------------------------
// The second reader.
//
// The whole point of this fetch is to keep one unreadable file from being
// reported as "this gate cannot certify this diff", so the tests below are about
// what it does when GitHub misbehaves. Every one of them asserts that the
// failure shows up as a *missing entry* rather than as a thrown error: the
// caller is the gate orchestrator, and a throw here would take down gates that
// do not read files at all.
// ---------------------------------------------------------------------------

test('fetchWholeFileContents: reads the file at the given ref, not a branch', async () => {
  const seen = [];
  const contents = await fetchWholeFileContents(async (path, token, options) => {
    seen.push({ path, token, options });
    return '{\n  "tables": {}\n}';
  }, 'paperclipai/paperclip', ['packages/db/src/migrations/meta/0286_snapshot.json'], 'abc123def', 'token');

  assert.deepEqual(Object.keys(contents), ['packages/db/src/migrations/meta/0286_snapshot.json']);
  assert.match(contents['packages/db/src/migrations/meta/0286_snapshot.json'], /"tables"/);
  // The ref is a commit, so a re-read after a push cannot see content the pull
  // request never had. A branch name would resolve to whatever is there now.
  assert.match(seen[0].path, /\?ref=abc123def$/);
  // The raw media type is the whole reason `ghFetch` grew a `raw` option: the
  // body here is a file, not a JSON document describing a file.
  assert.equal(seen[0].options.raw, true);
  assert.equal(seen[0].options.headers.Accept, 'application/vnd.github.raw');
  assert.equal(seen[0].token, 'token');
});

test('fetchWholeFileContents: keeps the slashes and escapes each segment', async () => {
  const seen = [];
  await fetchWholeFileContents(async (path) => {
    seen.push(path);
    return 'x';
  }, 'paperclipai/paperclip', ['packages/db/src/migrations/meta/0286_snapshot.json'], 'abc123', 'token');

  // `encodeURIComponent` over the whole path would escape the slashes and
  // GitHub would answer 404 for a path that exists.
  assert.equal(
    seen[0],
    '/repos/paperclipai/paperclip/contents/packages/db/src/migrations/meta/0286_snapshot.json?ref=abc123'
  );
});

test('fetchWholeFileContents: a file that cannot be read is absent, not thrown', async () => {
  const contents = await fetchWholeFileContents(async (path) => {
    if (path.includes('missing')) throw new Error('GitHub API GET → 404');
    return 'body';
  }, 'paperclipai/paperclip', ['present.txt', 'missing.json'], 'abc123', 'token');

  // Absent means "the gate cannot read this file", which the gate turns into its
  // own unscannable failure. Throwing would instead fail the whole run.
  assert.deepEqual(Object.keys(contents), ['present.txt']);
});

test('fetchWholeFileContents: no ref means no reads at all', async () => {
  let calls = 0;
  for (const ref of [undefined, null, '', 42]) {
    const contents = await fetchWholeFileContents(async () => {
      calls += 1;
      return 'body';
    }, 'paperclipai/paperclip', ['a.txt'], ref, 'token');
    assert.deepEqual(contents, {}, `expected no reads for ref=${JSON.stringify(ref)}`);
  }
  assert.equal(calls, 0);
});

test('fetchWholeFileContents: an oversized file is skipped, not transferred into the gate', async () => {
  const contents = await fetchWholeFileContents(async () => 'x'.repeat(MAX_SCANNED_FILE_BYTES + 1),
    'paperclipai/paperclip', ['huge.txt'], 'abc123', 'token');
  assert.deepEqual(contents, {});

  // And the boundary is inclusive: exactly at the cap is readable.
  const atCap = await fetchWholeFileContents(async () => 'x'.repeat(MAX_SCANNED_FILE_BYTES),
    'paperclipai/paperclip', ['huge.txt'], 'abc123', 'token');
  assert.equal(Object.keys(atCap).length, 1);
});

test('fetchWholeFileContents: bounds the request count so one PR cannot spend the run budget', async () => {
  const requested = [];
  const names = Array.from({ length: MAX_WHOLE_FILE_FETCHES + 5 }, (_, i) => `generated/f${i}.json`);
  const contents = await fetchWholeFileContents(async (path) => {
    requested.push(path);
    return 'body';
  }, 'paperclipai/paperclip', names, 'abc123', 'token');

  assert.equal(requested.length, MAX_WHOLE_FILE_FETCHES);
  assert.equal(Object.keys(contents).length, MAX_WHOLE_FILE_FETCHES);
  // Truncating the read list can only cost coverage. The files past the bound
  // are absent, so the gate reports them unscannable — the verdict it gave
  // before this fetch existed.
  assert.equal(contents[names.at(-1)], undefined);
});

test('fetchWholeFileContents: a non-string body is skipped rather than stored', async () => {
  const contents = await fetchWholeFileContents(async () => ({ content: 'base64' }),
    'paperclipai/paperclip', ['a.json'], 'abc123', 'token');
  assert.deepEqual(contents, {});
});
