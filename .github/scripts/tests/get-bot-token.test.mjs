import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInstallationId, ghFetch } from '../get-bot-token.mjs';

test('resolveInstallationId: uses the repo installation endpoint when repo context is available', async () => {
  const seenPaths = [];
  const installationId = await resolveInstallationId(async (path) => {
    seenPaths.push(path);
    return { id: 42 };
  }, 'jwt', 'paperclipai/paperclip', 'paperclipai');

  assert.equal(installationId, 42);
  assert.deepEqual(seenPaths, ['/repos/paperclipai/paperclip/installation']);
});

test('resolveInstallationId: falls back to the matching owner installation', async () => {
  const installationId = await resolveInstallationId(async () => ([
    { id: 1, account: { login: 'someone-else' } },
    { id: 7, account: { login: 'PaperclipAI' } },
  ]), 'jwt', undefined, 'paperclipai');

  assert.equal(installationId, 7);
});

test('resolveInstallationId: rejects ambiguous installations without repo or owner context', async () => {
  await assert.rejects(
    resolveInstallationId(async () => ([
      { id: 1, account: { login: 'org-one' } },
      { id: 2, account: { login: 'org-two' } },
    ]), 'jwt'),
    /Multiple commitperclip installations found/
  );
});

/**
 * The `raw` option, and only that option.
 *
 * `ghFetch` parses every response body as JSON, and the one media type whose
 * body is not a JSON document is `application/vnd.github.raw`, which returns a
 * file's bytes. Without this the internal-reference gate's whole-file reader has
 * nowhere to get a 1.3 MB migration snapshot from, and the gate goes on refusing
 * to certify every schema change. These tests pin both halves: raw hands back the
 * bytes untouched, and everything else keeps the parse it always did.
 */
const withStubbedFetch = async (body, init, run) => {
  const original = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      text: async () => body,
    };
  };
  try {
    return await run(() => captured);
  } finally {
    globalThis.fetch = original;
  }
};

test('ghFetch raw: returns the body untouched, and asks for the raw media type', async () => {
  // A 1.3 MB snapshot is a JSON *document*, so a JSON.parse over the raw body
  // would sometimes succeed on a prefix and hand the gate something that is not
  // the file. The point of `raw` is that it does not parse.
  // Deliberately truncated: a prefix of a valid snapshot. A JSON.parse over it
  // would succeed and hand the gate a document that is not the file.
  const body = '{ "tables": { "public"."users"';
  await withStubbedFetch(body, {}, async (captured) => {
    const result = await ghFetch('/repos/o/r/contents/a.json', 'token', {
      raw: true,
      headers: { Accept: 'application/vnd.github.raw' },
    });
    assert.equal(result, body);
    // The caller's Accept overrides the default; the spread order in ghFetch is
    // what makes that true, so it is asserted rather than assumed.
    assert.equal(captured().options.headers.Accept, 'application/vnd.github.raw');
    assert.equal(captured().options.headers.Authorization, 'Bearer token');
  });
});

test('ghFetch: the default is unchanged — a JSON body is parsed', async () => {
  await withStubbedFetch('{"id":7}', {}, async () => {
    assert.deepEqual(await ghFetch('/repos/o/r/pulls/1', 'token'), { id: 7 });
  });
});

test('ghFetch: `raw` is not forwarded to fetch as a request option', async () => {
  // A stray `raw` in the init object is a body the API does not understand, so
  // its absence from the wire is part of the option being correct.
  await withStubbedFetch('{}', {}, async (captured) => {
    await ghFetch('/repos/o/r/pulls/1', 'token', { raw: true });
    assert.equal('raw' in captured().options, false);
  });
});

test('ghFetch: a JSON body that is not JSON still throws without raw', async () => {
  await withStubbedFetch('not json at all', {}, async () => {
    await assert.rejects(ghFetch('/repos/o/r/pulls/1', 'token'), SyntaxError);
  });
});

test('ghFetch: an error response throws with its status, raw or not', async () => {
  await withStubbedFetch('{"message":"Not Found"}', { ok: false, status: 404 }, async () => {
    await assert.rejects(
      ghFetch('/repos/o/r/contents/a.json', 'token', { raw: true }),
      /GitHub API GET .* → 404/
    );
  });
});
