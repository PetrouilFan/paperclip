import { afterEach, describe, expect, it } from "vitest";
import { runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  // The environment these keys arrive in is a real service unit's, not a
  // synthetic one: Type=notify puts NOTIFY_SOCKET in the control plane's own
  // environment, and every local agent run inherits it from there.
  it("does not hand a run child the unit's systemd IPC handles", () => {
    const inherited = sanitizeInheritedPaperclipEnv({
      NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
      LISTEN_PID: "3256022",
      LISTEN_FDS: "3",
      LISTEN_FDNAMES: "paperclip-api",
      PATH: "/usr/bin",
      HOME: "/home/alice",
    });

    expect(inherited).not.toHaveProperty("NOTIFY_SOCKET");
    expect(inherited).not.toHaveProperty("LISTEN_PID");
    expect(inherited).not.toHaveProperty("LISTEN_FDS");
    expect(inherited).not.toHaveProperty("LISTEN_FDNAMES");
    // Non-vacuity: the scrub is four keys, not "empty the environment". The
    // rest of the run's environment has to survive it untouched.
    expect(inherited).toEqual({ PATH: "/usr/bin", HOME: "/home/alice" });
  });

  it("keeps the three PAPERCLIP_ pass-throughs the run needs", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_LISTEN_HOST: "127.0.0.1",
      PAPERCLIP_LISTEN_PORT: "3100",
      PAPERCLIP_API_KEY: "server-process-key",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_LISTEN_HOST: "127.0.0.1",
      PAPERCLIP_LISTEN_PORT: "3100",
    });
  });
});

// The chokepoint tests below spawn a real child, because the boundary they
// cover is the merge, not either scrub in isolation: `opts.env` is spread over
// the sanitized inherited base inside `runChildProcess`, so a scrub-only test
// would pass against code that leaks.
describe("runChildProcess identity boundary", () => {
  const originalApiKey = process.env.PAPERCLIP_API_KEY;
  const originalWakePayload = process.env.PAPERCLIP_WAKE_PAYLOAD_JSON;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
    else process.env.PAPERCLIP_API_KEY = originalApiKey;
    if (originalWakePayload === undefined) delete process.env.PAPERCLIP_WAKE_PAYLOAD_JSON;
    else process.env.PAPERCLIP_WAKE_PAYLOAD_JSON = originalWakePayload;
  });

  // Prints the value of each named key, or "<absent>". One key per line so a
  // failure names the key instead of dumping the child's whole environment.
  const probe = (keys: string[]) =>
    [
      "const keys = " + JSON.stringify(keys) + ";",
      "for (const key of keys) {",
      "  process.stdout.write(key + '=' + (process.env[key] ?? '<absent>') + '\\n');",
      "}",
    ].join("\n");

  async function childEnvFor(
    env: Record<string, string>,
    keys: string[],
  ): Promise<Record<string, string>> {
    let stdout = "";
    const result = await runChildProcess("identity-boundary-probe", process.execPath, ["-e", probe(keys)], {
      cwd: process.cwd(),
      env,
      timeoutSec: 20,
      graceSec: 2,
      onLog: async (stream, chunk) => {
        if (stream === "stdout") stdout += chunk;
      },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    return Object.fromEntries(
      stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
  }

  // The load-bearing direction. `execute.ts` mints the run's own token, sets it
  // on `opts.env.PAPERCLIP_API_KEY`, and nothing re-injects it inside
  // `runChildProcess` — the child has no other route to a credential. Any scrub
  // applied to the adapter half deletes this and leaves every run unable to
  // reach the control plane, so this test is the guard on the fix that is
  // actually correct: the leak is closed at the two call sites that pass
  // `process.env`, not by stripping the adapter half.
  it("hands a child the run's own token, which is the credential every run needs", async () => {
    process.env.PAPERCLIP_API_KEY = "server-process-key";

    const seen = await childEnvFor(
      { PAPERCLIP_API_KEY: "harness-minted-run-token" },
      ["PAPERCLIP_API_KEY"],
    );

    expect(seen.PAPERCLIP_API_KEY).toBe("harness-minted-run-token");
  });

  // The leak itself, as observed at the chokepoint. With `process.env` carrying
  // the control plane's company-scoped key, a child that does not name a token
  // of its own gets none. Before the call-site fix the discovery probes named
  // the server's key, because they spread `process.env` into `opts.env` and the
  // spread ran after the inherited scrub.
  it("does not hand a child the server's API key when opts.env does not name a token", async () => {
    process.env.PAPERCLIP_API_KEY = "server-process-key";
    process.env.PAPERCLIP_WAKE_PAYLOAD_JSON = '{"stale":true}';

    const seen = await childEnvFor({}, ["PAPERCLIP_API_KEY", "PAPERCLIP_WAKE_PAYLOAD_JSON"]);

    expect(seen.PAPERCLIP_API_KEY).toBe("<absent>");
    expect(seen.PAPERCLIP_WAKE_PAYLOAD_JSON).toBe("<absent>");
  });

  // Non-vacuity: the inherited scrub drops two keys, not the environment. PATH
  // and HOME must survive, or the discovery probes cannot find `pi`/`opencode`
  // on PATH and the fix would have broken discovery instead of securing it.
  it("still passes PATH and the adapter's own keys through", async () => {
    process.env.PAPERCLIP_API_KEY = "server-process-key";

    const seen = await childEnvFor(
      { PAPERCLIP_TEST_MARKER: "from-adapter", HOME: "/home/alice" },
      ["PAPERCLIP_API_KEY", "PAPERCLIP_TEST_MARKER", "HOME", "PATH"],
    );

    expect(seen.PAPERCLIP_API_KEY).toBe("<absent>");
    expect(seen.PAPERCLIP_TEST_MARKER).toBe("from-adapter");
    expect(seen.HOME).toBe("/home/alice");
    expect(seen.PATH).not.toBe("<absent>");
  });

  // The three pass-throughs are what a run needs to reach the control plane, and
  // the inherited scrub deliberately keeps them. They arrive from the inherited
  // base, which is why dropping the `process.env` spread at the discovery
  // call sites costs a run nothing.
  it("keeps the run's own Paperclip pass-throughs", async () => {
    process.env.PAPERCLIP_API_KEY = "server-process-key";

    const seen = await childEnvFor(
      {
        PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
        PAPERCLIP_LISTEN_HOST: "127.0.0.1",
        PAPERCLIP_LISTEN_PORT: "3100",
      },
      [
        "PAPERCLIP_API_KEY",
        "PAPERCLIP_RUNTIME_API_URL",
        "PAPERCLIP_LISTEN_HOST",
        "PAPERCLIP_LISTEN_PORT",
      ],
    );

    expect(seen.PAPERCLIP_API_KEY).toBe("<absent>");
    expect(seen.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3100");
    expect(seen.PAPERCLIP_LISTEN_HOST).toBe("127.0.0.1");
    expect(seen.PAPERCLIP_LISTEN_PORT).toBe("3100");
  });
});
