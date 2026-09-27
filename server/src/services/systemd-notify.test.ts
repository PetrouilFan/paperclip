import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";
import dgram from "node:dgram";
import { describe, expect, it } from "vitest";

import {
  buildSystemdNotifyEnv,
  createSystemdNotifier,
  resolveSystemdNotifyBinary,
  runSystemdNotifyBinary,
  SYSTEMD_NOTIFY_BINARY_CANDIDATES,
  type SystemdNotifierDeps,
} from "./systemd-notify.js";

/**
 * `server/src/index.ts` sends `READY=1` through this module, and the datagram
 * has to come from somewhere: the control plane is a `Type=notify` unit. These
 * tests pin the two properties that file cannot afford to lose.
 *
 * 1. The notifier is spawned as an absolute path with a minimal environment, so
 *    the only child of this process that can address the unit's notify socket
 *    is the notifier itself, holding nothing else.
 * 2. That child is not `MainPID`, which is why the unit keeps `NotifyAccess=all`
 *    and why nobody should "fix" it to `main` on the strength of a comment. The
 *    last two tests are the measurement behind that: node cannot send an
 *    `AF_UNIX` datagram, so the notifier cannot be this process.
 */

async function fakeNotifier(dir: string, name = "systemd-notify"): Promise<string> {
  const binary = path.join(dir, name);
  await writeFile(binary, "#!/bin/sh\nenv > \"$1\"\n", "utf8");
  await chmod(binary, 0o755);
  return binary;
}

function captureRun() {
  const calls: { binary: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: SystemdNotifierDeps["run"] = async (binary, args, env) => {
    calls.push({ binary, args, env });
    return true;
  };
  return { calls, run };
}

describe("systemdNotify", () => {
  it("spawns the notifier by absolute path, never through PATH", async () => {
    // The server's PATH is not a boundary this process controls, and a hijacked
    // notifier is a process that can send STOPPING=1 to the unit running it.
    const { calls, run } = captureRun();
    const notify = createSystemdNotifier({
      notifySocket: () => "/run/user/1000/systemd/notify",
      resolveBinary: async () => "/usr/bin/systemd-notify",
      run,
    });

    await notify(["--ready", "--status=Listening on 127.0.0.1:3101"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.binary).toBe("/usr/bin/systemd-notify");
    expect(path.isAbsolute(calls[0]?.binary ?? "")).toBe(true);
    expect(calls[0]?.args).toEqual(["--ready", "--status=Listening on 127.0.0.1:3101"]);
  });

  it("hands the notifier child the notify socket and nothing else", async () => {
    // A notifier needs one variable. This process is also holding the unit's
    // socket-activated descriptors, its own API key and its run keys; none of
    // them are the notifier's business, and a child that can be aimed at the
    // socket is the wrong place to leave them.
    const { calls, run } = captureRun();
    const notify = createSystemdNotifier({
      notifySocket: () => "/run/user/1000/systemd/notify",
      resolveBinary: async () => "/usr/bin/systemd-notify",
      run,
    });

    await notify(["--stopping"]);

    expect(calls[0]?.env).toEqual({ NOTIFY_SOCKET: "/run/user/1000/systemd/notify" });
    expect(Object.keys(calls[0]?.env ?? {})).toEqual(["NOTIFY_SOCKET"]);
  });

  it("sends nothing and spawns nothing without a notify socket", async () => {
    // A dev server, a test run and every non-systemd host take this path. It has
    // to stay free of a spawn, because a spawn here is a child holding an
    // address it should not have.
    const { calls, run } = captureRun();
    for (const notifySocket of [undefined, "", "   "]) {
      const notify = createSystemdNotifier({ notifySocket: () => notifySocket, run });
      expect(await notify(["--ready"])).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("buildSystemdNotifyEnv", () => {
  it("is the notify socket alone, plus PATH only for a name-resolved binary", () => {
    expect(
      buildSystemdNotifyEnv("/run/user/1000/systemd/notify", { needsPathLookup: false }),
    ).toEqual({ NOTIFY_SOCKET: "/run/user/1000/systemd/notify" });
    const withPath = buildSystemdNotifyEnv("/run/user/1000/systemd/notify", {
      needsPathLookup: true,
    });
    expect(withPath.PATH).toBe(process.env.PATH);
    expect(Object.keys(withPath)).toEqual(["NOTIFY_SOCKET", "PATH"]);
  });
});

describe("resolveSystemdNotifyBinary", () => {
  it("returns the first candidate that is an executable file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "systemd-notify-"));
    const present = await fakeNotifier(dir);
    // A non-executable file earlier in the list must be skipped, not returned.
    const notExecutable = path.join(dir, "systemd-notify-noexec");
    await writeFile(notExecutable, "", "utf8");

    expect(await resolveSystemdNotifyBinary([notExecutable, present])).toBe(present);
  });

  it("falls back to the bare name when no candidate exists", async () => {
    // A host that installs the notifier somewhere this list does not name would
    // otherwise lose READY=1 and sit out TimeoutStartSec. It keeps the old
    // behaviour, and keeps PATH for the lookup, rather than going dark.
    const dir = await mkdtemp(path.join(tmpdir(), "systemd-notify-"));
    expect(await resolveSystemdNotifyBinary([path.join(dir, "absent")])).toBe("systemd-notify");
  });

  it("names only absolute paths, so no candidate can come from a writable directory", () => {
    for (const candidate of SYSTEMD_NOTIFY_BINARY_CANDIDATES) {
      expect(path.isAbsolute(candidate)).toBe(true);
    }
    expect(SYSTEMD_NOTIFY_BINARY_CANDIDATES).not.toContain("systemd-notify");
  });
});

describe("the notifier child's own environment, on real bytes", () => {
  it("is what the child actually sees, not what the caller intended", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "systemd-notify-"));
    const binary = await fakeNotifier(dir);
    const envFile = path.join(dir, "child.env");

    // The fake notifier prints its own environment, so the assertion is on what
    // reached `execve`.
    const sent = await runSystemdNotifyBinary(binary, [envFile], {
      NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
    });
    expect(sent).toBe(true);

    // `/bin/sh` adds PWD, SHLVL and `_` to its own environment, so the assertion
    // is on everything this process handed over rather than on the whole listing.
    const observed = (await readFile(envFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .filter((line) => !["PWD", "SHLVL", "_"].includes(line.split("=")[0] ?? ""));
    expect(observed).toEqual(["NOTIFY_SOCKET=/run/user/1000/systemd/notify"]);
  });
});

describe("why NotifyAccess=main is not reachable from this process", () => {
  it("node's datagram module refuses a unix socket outright", () => {
    // dgram is UDP-only, so there is no in-process sender to write the
    // datagram with.
    expect(() => dgram.createSocket({ type: "unix_dgram" as "udp4" })).toThrowError(
      /Bad socket type|ERR_SOCKET_BAD_TYPE/,
    );
  });

  it("node's net module accepts type unix_dgram and still opens a stream socket", async () => {
    // This is the trap worth pinning. The option is accepted, the socket is
    // created, and it is not a datagram socket: it connects to a SOCK_STREAM
    // listener. A reviewer skimming for "does node support unix_dgram" sees
    // yes. Against a real datagram listener the same call fails EPROTOTYPE.
    // A unix socket path is capped near 108 bytes by the kernel, and a scratch
    // directory can be longer than that, so keep this one short.
    const socketPath = path.join(
      tmpdir().length + 12 < 100 ? tmpdir() : "/tmp",
      `pc-unix-dgram-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
    );
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: socketPath }, resolve);
    });

    try {
      const connected = await new Promise<boolean>((resolve) => {
        // The cast is the point: `type` is not a valid `unix_dgram` value in the
        // type definitions either, and node accepts it at runtime anyway.
        const options = {
          path: socketPath,
          type: "unix_dgram",
        } as unknown as net.NetConnectOpts;
        const client = net.createConnection(options);
        client.once("connect", () => {
          client.destroy();
          resolve(true);
        });
        client.once("error", () => resolve(false));
      });
      expect(connected).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
