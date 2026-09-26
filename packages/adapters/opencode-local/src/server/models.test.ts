import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
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

  it("still rejects from the original catalog when refresh fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
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
      .mockRejectedValueOnce(new Error("refresh unavailable"));

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).rejects.toThrow("Available models: openrouter/example/stale-model");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'refresh failed for "openrouter/deepseek/deepseek-v4-flash-0731"',
      ),
    );
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
