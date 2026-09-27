import { describe, expect, it } from "vitest";
import { sanitizeInheritedPaperclipEnv } from "./server-utils.js";

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
