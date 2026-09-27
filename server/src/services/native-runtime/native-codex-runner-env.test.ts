import { describe, expect, it } from "vitest";

import { buildNativeRunnerProcessEnv } from "./native-codex-runner.js";

// A systemd Type=notify user unit, as the control plane actually runs under.
// systemd exports the unit's notify socket address to the unit as
// NOTIFY_SOCKET, and the unit's own environment is what the server process
// holds, so anything the server spawns from process.env inherits it.
const NOTIFY_UNIT_HOST_ENV: NodeJS.ProcessEnv = {
  NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
  LISTEN_PID: "50317",
  LISTEN_FDS: "3",
  LISTEN_FDNAMES: "paperclip-api",
  PAPERCLIP_API_KEY: "server-process-key",
  PATH: "/usr/bin",
  HOME: "/home/alice",
};

describe("buildNativeRunnerProcessEnv", () => {
  it("does not hand the runner child the unit's systemd IPC handles", () => {
    const env = buildNativeRunnerProcessEnv(
      { environment: { CODEX_HOME: "/home/alice/.codex" }, bootstrapTicket: "ticket-1" },
      NOTIFY_UNIT_HOST_ENV,
    );

    expect(env).not.toHaveProperty("NOTIFY_SOCKET");
    expect(env).not.toHaveProperty("LISTEN_PID");
    expect(env).not.toHaveProperty("LISTEN_FDS");
    expect(env).not.toHaveProperty("LISTEN_FDNAMES");
  });

  // Non-vacuity. The point is the four systemd keys are gone, not that the
  // environment was emptied: the runner still needs a PATH, a HOME and its
  // own provider home, and a scrub that dropped those would be a worse bug
  // than the leak it fixes.
  it("keeps the host context and the agent's own environment", () => {
    expect(buildNativeRunnerProcessEnv(
      { environment: { CODEX_HOME: "/home/alice/.codex" }, bootstrapTicket: "ticket-1" },
      NOTIFY_UNIT_HOST_ENV,
    )).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/alice",
      CODEX_HOME: "/home/alice/.codex",
      PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: "ticket-1",
    });
  });

  // The server's own credentials are not the runner's credentials. The runner
  // authenticates with its bootstrap ticket, so a leaked PAPERCLIP_API_KEY
  // would be a privilege the run was never issued.
  it("does not leak the server process's API key to the runner", () => {
    expect(buildNativeRunnerProcessEnv(
      { environment: {}, bootstrapTicket: "ticket-1" },
      NOTIFY_UNIT_HOST_ENV,
    )).not.toHaveProperty("PAPERCLIP_API_KEY");
  });

  // An agent-configured value is allowed to name a key the scrub removes. The
  // agent's configuration is an explicit grant, so it must still win, exactly
  // as it does on the runChildProcess path.
  it("still lets the agent's configured environment win over the scrub", () => {
    const env = buildNativeRunnerProcessEnv(
      {
        environment: { NOTIFY_SOCKET: "/tmp/agent-owned.sock", PAPERCLIP_LISTEN_PORT: "3999" },
        bootstrapTicket: "ticket-1",
      },
      NOTIFY_UNIT_HOST_ENV,
    );

    expect(env.NOTIFY_SOCKET).toBe("/tmp/agent-owned.sock");
    expect(env.PAPERCLIP_LISTEN_PORT).toBe("3999");
  });

  it("always sets the bootstrap ticket the runner authenticates with", () => {
    expect(buildNativeRunnerProcessEnv(
      { environment: { PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: "stale" }, bootstrapTicket: "ticket-1" },
      NOTIFY_UNIT_HOST_ENV,
    ).PAPERCLIP_RUNNER_BOOTSTRAP_TICKET).toBe("ticket-1");
  });
});
