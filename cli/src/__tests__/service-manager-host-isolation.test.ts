import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemdServiceManager, systemdServiceName, type CommandRunner } from "../services/service-manager.js";

// PET-52: the e2e service legs end in `service uninstall`. This file pins what
// that actually does to a host, because the answer decides whether an isolated
// HOME is enough.
//
// Measured on a host with a live paperclipai.service: with HOME and
// XDG_CONFIG_HOME both pointed at an empty temp dir, `systemctl --user cat`,
// `is-active` and `show -p FragmentPath` still resolved the real unit under the
// real $HOME. `systemctl --user <verb> <name>` addresses units the manager has
// already loaded; XDG_CONFIG_HOME only decides where *new* unit files are
// searched. So SystemdServiceManager.uninstall() deletes the unit FILE by path
// (os.homedir()) but stops and disables the unit BY NAME. A HOME override
// therefore cannot, on its own, stop an e2e leg from stopping production.
//
// These tests need no systemd: CommandRunner is injected, so the exact argv
// sequence is observable.

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-isolation-"));
  temporaryDirectories.push(directory);
  return directory;
}

// An onboarded host has an executable shim at the path the unit's ExecStart
// names, and the renderer depends on that: it refuses to write a unit whose
// ExecStart target is missing rather than install a `203/EXEC` crash loop. A
// fixture that names a shim it never created therefore fails in the guard
// before reaching the isolation assertions these tests exist to make.
async function isolatedHomeWithShim(): Promise<{ home: string; shimPath: string }> {
  const home = await temporaryDirectory();
  const shimPath = path.join(home, ".local/bin/paperclipai");
  await fs.mkdir(path.dirname(shimPath), { recursive: true });
  await fs.writeFile(shimPath, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  return { home, shimPath };
}

type Invocation = { command: string; args: string[] };

/** Records every invocation and answers `show` as an active unit would. */
function recordingRunner(invocations: Invocation[], active = true): CommandRunner {
  return async (command, args) => {
    invocations.push({ command, args });
    if (command === "systemctl" && args.includes("show")) {
      return {
        stdout: [
          "LoadState=loaded",
          `ActiveState=${active ? "active" : "inactive"}`,
          "UnitFileState=enabled",
          "MainPID=4242",
        ].join("\n"),
        stderr: "",
      };
    }
    if (command === "loginctl") return { stdout: "yes", stderr: "" };
    return { stdout: "", stderr: "" };
  };
}

function systemctlVerbs(invocations: Invocation[]): string[] {
  return invocations
    .filter((invocation) => invocation.command === "systemctl")
    .map((invocation) => {
      const index = invocation.args.indexOf("--user");
      const verb = invocation.args[index + 1];
      const unit = invocation.args.find((arg) => arg.endsWith(".service"));
      return unit ? `${verb} ${unit}` : verb;
    });
}

describe("PET-52 host isolation", () => {
  it("gives the default instance the production unit name", () => {
    // The premise of the whole hazard: an e2e leg that onboards the default
    // instance installs a unit named exactly like the host's production one.
    expect(systemdServiceName("default")).toBe("paperclipai.service");
  });

  it("a distinct instance yields a unit name the host cannot have", () => {
    expect(systemdServiceName("e2e")).toBe("paperclipai-e2e.service");
    expect(systemdServiceName("e2e")).not.toBe(systemdServiceName("default"));
  });

  it("uninstall under an isolated HOME still stops the production unit BY NAME (the hazard)", async () => {
    const isolatedHome = await temporaryDirectory();
    const invocations: Invocation[] = [];
    const manager = new SystemdServiceManager("default", recordingRunner(invocations), path.join(isolatedHome, ".paperclip"), path.join(isolatedHome, ".local/bin/paperclipai"), isolatedHome);

    await manager.uninstall();

    const verbs = systemctlVerbs(invocations);
    // The file deletion is path-based and stays inside the isolated home...
    await expect(fs.access(path.join(isolatedHome, ".config", "systemd", "user", "paperclipai.service"))).rejects.toThrow();
    // ...but the stop and disable are name-based and reach the host's unit,
    // because a loaded unit is addressed by name regardless of XDG_CONFIG_HOME.
    expect(verbs).toContain("stop paperclipai.service");
    expect(verbs).toContain("disable paperclipai.service");
  });

  it("uninstall of a distinct instance touches the production unit by neither name nor path", async () => {
    const isolatedHome = await temporaryDirectory();
    const invocations: Invocation[] = [];
    const manager = new SystemdServiceManager("e2e", recordingRunner(invocations), path.join(isolatedHome, ".paperclip"), path.join(isolatedHome, ".local/bin/paperclipai"), isolatedHome);

    await manager.uninstall();

    const verbs = systemctlVerbs(invocations);
    expect(verbs).toContain("stop paperclipai-e2e.service");
    expect(verbs).toContain("disable paperclipai-e2e.service");
    // No verb of any kind names the production unit.
    for (const verb of verbs) {
      expect(verb).not.toMatch(/(^| )paperclipai\.service$/);
    }
  });

  it("start/stop/status of a distinct instance never name the production unit", async () => {
    const { home: isolatedHome, shimPath } = await isolatedHomeWithShim();
    const invocations: Invocation[] = [];
    const manager = new SystemdServiceManager("smoke", recordingRunner(invocations), path.join(isolatedHome, ".paperclip"), shimPath, isolatedHome);

    await manager.install({ startNow: true, startOnLogin: true });
    await manager.status();
    await manager.stop();
    await manager.restart();

    for (const verb of systemctlVerbs(invocations)) {
      expect(verb).not.toMatch(/(^| )paperclipai\.service$/);
    }
    expect(systemctlVerbs(invocations)).toContain("start paperclipai-smoke.service");
  });

  it("the unit file a distinct instance writes lands in the isolated home", async () => {
    const { home: isolatedHome, shimPath } = await isolatedHomeWithShim();
    const invocations: Invocation[] = [];
    const manager = new SystemdServiceManager("e2e", recordingRunner(invocations), path.join(isolatedHome, ".paperclip"), shimPath, isolatedHome);

    await manager.install({ startNow: false, startOnLogin: false });

    const written = await fs.readFile(path.join(isolatedHome, ".config", "systemd", "user", "paperclipai-e2e.service"), "utf8");
    expect(written).toContain('ExecStart="');
    expect(written).toContain('run --instance "e2e"');
  });
});
