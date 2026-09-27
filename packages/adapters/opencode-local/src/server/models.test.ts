import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import * as runtimeConfig from "./runtime-config.js";
import {
  discoverOpenCodeModels,
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

const configHomeCleanup = new Set<string>();

// The availability gate falls back to the ambient XDG config when the run env
// does not carry one, so these tests pin XDG_CONFIG_HOME to a scratch dir rather
// than reading whatever the developer's or CI host happens to have configured.
async function makeEmptyXdgConfigHome(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-opencode-models-test-"),
  );
  configHomeCleanup.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    [...configHomeCleanup].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      configHomeCleanup.delete(dir);
    }),
  );
});

// Verbatim stderr from `opencode models --refresh` on opencode v2.0.14:
// a bare banner on one line, the actionable detail indented on the next.
const UNSUPPORTED_REFRESH_STDERR =
  "\nERROR\n  Unrecognized flag: --refresh in command opencode models\n";

/**
 * The availability gate reads locally declared OpenCode providers before it
 * treats a catalog as authoritative, and that read touches the real filesystem.
 * These cases run under `vi.useFakeTimers()`, which does not drive real I/O, so
 * an unmocked read never settles and the test times out instead of asserting.
 *
 * Pinning it to "nothing is declared" is the honest precondition for both cases:
 * each one exists to pin the *refresh* path, and a local declaration would
 * short-circuit that path before the refresh is ever reached.
 */
function stubNoLocalDeclarations() {
  return vi
    .spyOn(runtimeConfig, "readLocallyDeclaredOpenCodeModels")
    .mockResolvedValue({ models: new Set<string>(), sources: [] });
}

function childResult(over: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
    ...over,
  };
}

/**
 * Stubs `opencode models` by argv so a test does not have to care how many
 * times discovery retries: `--refresh` answers every refresh attempt with
 * `refresh`, and plain `models` enumerations are served from `plain()`.
 */
function stubModelsCli(opts: {
  refresh: { exitCode?: number | null; stdout?: string; stderr?: string };
  plain: () => { exitCode?: number | null; stdout?: string; stderr?: string };
}) {
  return vi
    .spyOn(serverUtils, "runChildProcess")
    .mockImplementation(async (_id, _command, args) => {
      const isRefresh = Array.isArray(args) && args.includes("--refresh");
      return childResult(isRefresh ? opts.refresh : opts.plain());
    });
}

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    resetOpenCodeModelsCacheForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  // The leak, asserted on the object the call site actually hands the
  // chokepoint. `discoverOpenCodeModels` used to spread `process.env` into
  // `opts.env`, and `runChildProcess` spreads `opts.env` over the sanitized
  // inherited base — so the spread restored the control plane's own
  // `PAPERCLIP_API_KEY` to a child that `sanitizeInheritedPaperclipEnv` had just
  // removed it from. The server's key is company-scoped, carries
  // `responsible_user_id`, and does not expire with a run the way a run-scoped
  // token does.
  it("does not put the control plane's API key in the discovery child env", async () => {
    const originalApiKey = process.env.PAPERCLIP_API_KEY;
    const originalWakePayload = process.env.PAPERCLIP_WAKE_PAYLOAD_JSON;
    process.env.PAPERCLIP_API_KEY = "server-process-key";
    process.env.PAPERCLIP_WAKE_PAYLOAD_JSON = '{"companyId":"stale"}';
    try {
      const spy = stubModelsCli({
        refresh: { exitCode: 1, stderr: "unrecognized flag" },
        plain: () => childResult({ stdout: "openai/gpt-5.2-codex\n" }),
      });

      await discoverOpenCodeModels({ env: { PAPERCLIP_TEST_MARKER: "from-caller" } });

      const opts = spy.mock.calls[0]?.[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
      expect(opts.env.PAPERCLIP_WAKE_PAYLOAD_JSON).toBeUndefined();
      // Non-vacuity: two keys are dropped, not the environment. The caller's
      // own keys and the discovery-specific ones must survive — a fix that
      // emptied `opts.env` would pass the two assertions above while breaking
      // discovery. PATH and HOME are added by `ensurePathInEnv`.
      expect(opts.env.PAPERCLIP_TEST_MARKER).toBe("from-caller");
      expect(opts.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
      expect(opts.env.PATH).toBeTruthy();
      expect(opts.env.HOME).toBeTruthy();
    } finally {
      if (originalApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = originalApiKey;
      if (originalWakePayload === undefined) delete process.env.PAPERCLIP_WAKE_PAYLOAD_JSON;
      else process.env.PAPERCLIP_WAKE_PAYLOAD_JSON = originalWakePayload;
    }
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe(
      "openai/gpt-5.2-codex",
    );
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("proceeds with the configured model when discovery cannot run (probe is best-effort, never fatal)", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).resolves.toEqual([{ id: "openai/gpt-5", label: "openai/gpt-5" }]);
  });

  it("skips the availability check when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).resolves.toEqual([
      {
        id: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        label: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
      },
    ]);
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/gateway/some-model",
      }),
    ).resolves.toEqual([
      {
        id: "anthropic/gateway/some-model",
        label: "anthropic/gateway/some-model",
      },
    ]);
  });

  it("still enforces provider/model format when OPENCODE_ALLOW_ALL_MODELS is set", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "not-a-valid-id",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("retries a transient `opencode models` failure with backoff before succeeding", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "queued behind another opencode run",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: null,
        signal: null,
        timedOut: true,
        stdout: "",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ollama/qwen2.5-coder:7b\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    const promise = discoverOpenCodeModels();
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual([
      { id: "ollama/qwen2.5-coder:7b", label: "ollama/qwen2.5-coder:7b" },
    ]);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("refreshes a stale non-empty catalog before rejecting the configured model", async () => {
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Models cache refreshed\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout:
          "openrouter/example/current-model\nopenrouter/deepseek/deepseek-v4-flash-0731\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).resolves.toContainEqual({
      id: "openrouter/deepseek/deepseek-v4-flash-0731",
      label: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0]?.[2]).toEqual(["models"]);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(spy.mock.calls[2]?.[2]).toEqual(["models"]);
  });

  it("still rejects when a refreshed non-empty catalog omits the configured model", async () => {
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Models cache refreshed\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/current-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).rejects.toThrow(
      "Configured OpenCode model is unavailable: openrouter/deepseek/deepseek-v4-flash-0731",
    );
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(spy.mock.calls[2]?.[2]).toEqual(["models"]);
  });

  it("still rejects from the original catalog when post-refresh enumeration returns no models", async () => {
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Models cache refreshed\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).rejects.toThrow("Available models: openrouter/example/stale-model");
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(spy.mock.calls[2]?.[2]).toEqual(["models"]);
  });

  it("still re-enumerates after a failed refresh and accepts a model the re-read finds", async () => {
    stubNoLocalDeclarations();
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let plainCalls = 0;
    const spy = stubModelsCli({
      // This is the opencode v2 shape verbatim: a bare `ERROR` banner with the
      // actionable detail on the next line, and exit 1. A non-zero exit is
      // retried, so this answers every refresh attempt.
      refresh: { exitCode: 1, stderr: UNSUPPORTED_REFRESH_STDERR },
      plain: () => {
        plainCalls += 1;
        return {
          stdout:
            plainCalls === 1
              ? "openrouter/example/stale-model\n"
              : "openrouter/example/stale-model\nopenrouter/deepseek/deepseek-v4-flash-0731\n",
        };
      },
    });

    const promise = ensureOpenCodeModelConfiguredAndAvailable({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toContainEqual({
      id: "openrouter/deepseek/deepseek-v4-flash-0731",
      label: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    // The failed refresh must not skip the re-enumeration: that second plain
    // read is the only chance to observe the model, and it used to be lost.
    expect(plainCalls).toBe(2);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(spy.mock.calls.at(-1)?.[2]).toEqual(["models"]);
    // ...and the unsupported-flag reason must survive the generic `ERROR`
    // banner, otherwise the log reads "refresh ... failed: ERROR".
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Unrecognized flag: --refresh"),
    );
  });

  it("proceeds with the configured model when the catalog is stale and the CLI cannot refresh it", async () => {
    stubNoLocalDeclarations();
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let plainCalls = 0;
    const spy = stubModelsCli({
      refresh: { exitCode: 1, stderr: UNSUPPORTED_REFRESH_STDERR },
      plain: () => {
        plainCalls += 1;
        return { stdout: "openrouter/example/stale-model\n" };
      },
    });

    // Without a refresh we have no fresh evidence that the model is gone, so
    // the pre-flight must fail open. Rejecting would take every run for every
    // agent down for as long as the cache stays stale.
    const promise = ensureOpenCodeModelConfiguredAndAvailable({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual([
      {
        id: "openrouter/deepseek/deepseek-v4-flash-0731",
        label: "openrouter/deepseek/deepseek-v4-flash-0731",
      },
    ]);
    expect(plainCalls).toBe(2);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("does not support `opencode models --refresh`"),
    );
    expect(spy).toHaveBeenCalled();
  });

  it("still rejects when a refresh that works leaves the model absent", async () => {
    // Guards the fix from over-reaching: when the CLI CAN refresh and the model
    // is genuinely gone, the strict rejection must survive.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/current-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).rejects.toThrow(
      "Configured OpenCode model is unavailable: openrouter/deepseek/deepseek-v4-flash-0731",
    );
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
  });

  it("surfaces the last error once retries are exhausted", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "queued behind another opencode run",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    const promise = discoverOpenCodeModels();
    const assertion = expect(promise).rejects.toThrow(
      "`opencode models` failed: queued behind another opencode run",
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(spy).toHaveBeenCalledTimes(3);
  });

  // Regression: `opencode models` reports the catalog held by the background
  // OpenCode service, which is a different process reading a different config
  // from the one the run uses. When that catalog omits a locally declared custom
  // provider while still listing built-ins, the old code treated the non-empty
  // catalog as authoritative and failed every agent configured on that provider.
  it("accepts a model declared by a locally configured provider that the catalog omits", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout:
        "deepseek/deepseek-flash\ndeepseek/deepseek-v4-pro\nnvidia/meta/llama-3.1-8b-instruct\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    const configHome = await makeEmptyXdgConfigHome();

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "local-zenfree/default",
        env: {
          XDG_CONFIG_HOME: configHome,
          PAPERCLIP_OPENCODE_PROVIDERS: JSON.stringify({
            "local-zenfree": {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: "http://localhost:8099/v1", apiKey: "" },
              models: { default: { name: "Default (MiMo)" } },
            },
          }),
        },
      }),
    ).resolves.toEqual([
      { id: "deepseek/deepseek-flash", label: "deepseek/deepseek-flash" },
      { id: "deepseek/deepseek-v4-pro", label: "deepseek/deepseek-v4-pro" },
      {
        id: "nvidia/meta/llama-3.1-8b-instruct",
        label: "nvidia/meta/llama-3.1-8b-instruct",
      },
    ]);
    // The `--refresh` remedy cannot succeed on OpenCode v2, so a declared model
    // must not pay for it: exactly one discovery call, no refresh.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[2]).toEqual(["models"]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'declared by a locally configured OpenCode provider',
      ),
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("local-zenfree/default"),
    );
  });

  it("accepts a model declared in the OpenCode config the run itself uses", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "deepseek/deepseek-flash\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    const configHome = await makeEmptyXdgConfigHome();
    await fs.mkdir(path.join(configHome, "opencode"), { recursive: true });
    await fs.writeFile(
      path.join(configHome, "opencode", "opencode.json"),
      JSON.stringify({
        provider: {
          "local-zenfree": {
            options: { baseURL: "http://localhost:8099/v1" },
            models: { "space-bunny-free": { name: "Space Bunny Free" } },
          },
        },
      }),
      "utf8",
    );

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "local-zenfree/space-bunny-free",
        env: { XDG_CONFIG_HOME: configHome },
      }),
    ).resolves.toEqual([
      { id: "deepseek/deepseek-flash", label: "deepseek/deepseek-flash" },
    ]);
  });

  it("still rejects a model no local config declares", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "deepseek/deepseek-flash\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    const configHome = await makeEmptyXdgConfigHome();

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "local-zenfree/declared-elsewhere",
        env: { XDG_CONFIG_HOME: configHome },
      }),
    ).rejects.toThrow("Configured OpenCode model is unavailable");
  });
});
