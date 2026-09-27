import { afterEach, describe, expect, it } from "vitest";

import { runChildProcess, stripSystemdIpcEnv } from "./server-utils.js";

// A systemd Type=notify user unit, as the control plane actually runs under.
// systemd exports the unit's notify socket address to the unit as
// NOTIFY_SOCKET, and the unit's own environment is what the server process
// holds, so anything the server spawns from process.env inherits it. These are
// installed on this process for the duration of each test so the assertion is
// about a real environment rather than a synthetic one.
const UNIT_SYSTEMD_IPC_ENV = {
  NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
  LISTEN_PID: "50317",
  LISTEN_FDS: "3",
  LISTEN_FDNAMES: "paperclip-api",
} as const;

const SYSTEMD_IPC_KEYS = Object.keys(UNIT_SYSTEMD_IPC_ENV);

const restoredEnv: Record<string, string | undefined> = {};

function installUnitSystemdIpcEnv() {
  for (const [key, value] of Object.entries(UNIT_SYSTEMD_IPC_ENV)) {
    restoredEnv[key] = process.env[key];
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of Object.entries(restoredEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete restoredEnv[key];
  }
});

/**
 * Spawn a real child and read back the environment it was actually handed.
 *
 * This is the negative control the static dataflow trace cannot give: the child
 * reports its own `process.env`, so the assertion is about the bytes that
 * reached `execve`, not about the shape of the object we intended to pass.
 */
async function spawnAndReadChildEnv(env: Record<string, string>) {
  let stdout = "";
  await runChildProcess("systemd-ipc-scrub-run", process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify(process.env))",
  ], {
    cwd: process.cwd(),
    env,
    timeoutSec: 30,
    graceSec: 5,
    onLog: async (stream, chunk) => {
      if (stream === "stdout") stdout += chunk;
    },
  });
  return JSON.parse(stdout) as Record<string, string | undefined>;
}

describe("stripSystemdIpcEnv", () => {
  it("drops exactly the four systemd IPC handles", () => {
    expect(
      stripSystemdIpcEnv({
        ...UNIT_SYSTEMD_IPC_ENV,
        PATH: "/usr/bin",
        HOME: "/home/alice",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/alice" });
  });

  // Non-vacuity for the negative control below: a scrub that emptied the
  // environment would also make every "key is absent" assertion pass, and would
  // be a worse bug than the leak it fixes.
  it("leaves every other key alone", () => {
    const env = { PATH: "/usr/bin", NOTIFY_SOCKET_X: "keep", LISTEN: "keep" };
    expect(stripSystemdIpcEnv(env)).toEqual(env);
  });
});

describe("a run child never receives the unit's systemd IPC handles", () => {
  // The inherited base. `sanitizeInheritedPaperclipEnv` already covers this,
  // and #147 landed it; it is here so a regression at the chokepoint cannot be
  // masked by the inherited path still working.
  it("when the child env is only the inherited base", async () => {
    installUnitSystemdIpcEnv();
    const childEnv = await spawnAndReadChildEnv({ PAPERCLIP_SCRUB_PROBE: "inherited" });

    for (const key of SYSTEMD_IPC_KEYS) {
      expect(childEnv).not.toHaveProperty(key);
    }
    expect(childEnv.PAPERCLIP_SCRUB_PROBE).toBe("inherited");
  });

  // The vector that made this a leak. Every remaining leaking call site built
  // its `env` argument by spreading process.env, and runChildProcess spreads
  // that argument *after* the sanitized inherited base — so the inherited
  // scrub could not see it. Each shape below is one of those real sites,
  // reproduced by name so this test fails if a site's pattern is reintroduced
  // elsewhere without anyone re-measuring it.
  it.each([
    ["opencode-local engine probe", { ...process.env, PAPERCLIP_SCRUB_PROBE: "probe" }],
    ["opencode-local models discovery", { ...process.env, CODEX_HOME: "/home/alice/.codex" }],
    ["pi-local models discovery", { ...process.env, PI_HOME: "/home/alice/.pi" }],
  ])("when the child env is process.env-derived, as at %s", async (_site, env) => {
    installUnitSystemdIpcEnv();
    const childEnv = await spawnAndReadChildEnv(env as Record<string, string>);

    for (const key of SYSTEMD_IPC_KEYS) {
      expect(childEnv).not.toHaveProperty(key);
    }
  });

  // Non-vacuity for the process.env-derived case: a process.env-derived `env`
  // must still carry the rest of the server's context through to the child. If
  // this failed, the scrub would be achieving its result by discarding the
  // environment rather than by removing four keys.
  it("while still forwarding the rest of a process.env-derived environment", async () => {
    installUnitSystemdIpcEnv();
    process.env.PAPERCLIP_SCRUB_MARKER = "forwarded";
    try {
      const childEnv = await spawnAndReadChildEnv({
        ...process.env,
        CODEX_HOME: "/home/alice/.codex",
      } as Record<string, string>);

      expect(childEnv.PAPERCLIP_SCRUB_MARKER).toBe("forwarded");
      expect(childEnv.CODEX_HOME).toBe("/home/alice/.codex");
    } finally {
      delete process.env.PAPERCLIP_SCRUB_MARKER;
    }
  });

  // The behaviour change, stated as a test so it is a decision on the record
  // rather than a side effect. Scrubbing the *merged* environment means an
  // agent-configured NOTIFY_SOCKET is scrubbed too, so the guarantee is "no run
  // child ever holds a notify socket" rather than "no run child inherits one".
  //
  // This is the stronger invariant, and it is the one the incident needs: the
  // inherited-base-only scrub is defeated by a single operator setting
  // NOTIFY_SOCKET to the unit's socket in an agent's environment, which is
  // exactly the capability being removed.
  //
  // Nothing in this repository produces these keys into a child's environment,
  // and no agent in this instance configures them, so the change removes an
  // attack surface rather than a capability. An agent that genuinely needs to
  // hand a notify socket to its own subprocess is a case this does not support
  // today, and did not support safely before either.
  it("and an agent-configured notify socket is scrubbed as well", async () => {
    installUnitSystemdIpcEnv();
    const childEnv = await spawnAndReadChildEnv({
      PAPERCLIP_SCRUB_PROBE: "configured",
      NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
      LISTEN_PID: "1",
      LISTEN_FDS: "3",
      LISTEN_FDNAMES: "paperclip-api",
    });

    for (const key of SYSTEMD_IPC_KEYS) {
      expect(childEnv).not.toHaveProperty(key);
    }
    // The rest of the configured environment is still the agent's.
    expect(childEnv.PAPERCLIP_SCRUB_PROBE).toBe("configured");
  });
});
