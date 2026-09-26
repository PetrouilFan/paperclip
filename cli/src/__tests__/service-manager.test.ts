import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertForegroundRunAllowed,
  detectServiceManager,
  extractExecutableFromSystemdUnit,
  LaunchdServiceManager,
  preserveEnvironmentLines,
  preserveLaunchdEnvironmentVariables,
  renderLaunchdPlist,
  renderSystemdUnit,
  SystemdServiceManager,
  type CommandRunner,
  type ServiceManager,
} from "../services/service-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  delete process.env.PAPERCLIP_SERVICE_MANAGED;
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeExecutable(executablePath: string): Promise<string> {
  await fs.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  return executablePath;
}

describe("service definition generation", () => {
  it("generates a stable systemd notify unit without secrets", () => {
    const unit = renderSystemdUnit({ instanceId: "team-a", shimPath: "/home/alice/.local/bin/paperclipai", homeDir: "/home/alice/.paperclip" });
    expect(unit).toContain("Type=notify");
    expect(unit).toContain("NotifyAccess=all");
    expect(unit).toContain('ExecStart="/home/alice/.local/bin/paperclipai" run --instance "team-a"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("TimeoutStopSec=300");
    expect(unit).not.toContain("API_KEY");
  });

  it("signals only the server process so adoption and the embedded database survive a stop", () => {
    const unit = renderSystemdUnit({ instanceId: "team-a", shimPath: "/home/alice/.local/bin/paperclipai", homeDir: "/home/alice/.paperclip" });
    // KillMode=control-group (systemd's default) would SIGTERM every process in
    // the cgroup — local agent runs and embedded PostgreSQL — concurrently with
    // the coordinated shutdown, defeating hot-restart run adoption.
    expect(unit).toContain("KillMode=process");
    expect(unit).not.toMatch(/^KillMode=control-group$/m);
  });

  it("escapes systemd variable and specifier expansion in configured values", () => {
    const unit = renderSystemdUnit({
      instanceId: "team-$USER-%i",
      shimPath: "/home/$USER/%i/paperclipai",
      homeDir: "/home/$USER/%i/.paperclip",
    });

    expect(unit).toContain('ExecStart="/home/$$USER/%%i/paperclipai" run --instance "team-$$USER-%%i"');
    expect(unit).toContain('Environment="PAPERCLIP_HOME=/home/$$USER/%%i/.paperclip"');
  });

  it.each([
    ["instanceId", { instanceId: "team-a\nExecStartPre=/tmp/attack", shimPath: "/home/alice/.local/bin/paperclipai", homeDir: "/home/alice/.paperclip" }],
    ["shimPath", { instanceId: "team-a", shimPath: "/home/alice/bin/paperclipai\r\nExecStartPre=/tmp/attack", homeDir: "/home/alice/.paperclip" }],
    ["homeDir", { instanceId: "team-a", shimPath: "/home/alice/.local/bin/paperclipai", homeDir: "/home/alice/.paperclip\nEnvironment=ATTACK=1" }],
  ])("rejects line breaks in the systemd %s", (_field, input) => {
    expect(() => renderSystemdUnit(input)).toThrow("Systemd service values must not contain line breaks");
  });

  it("generates a launchd agent with keepalive and instance logs", () => {
    const plist = renderLaunchdPlist({ instanceId: "team-a", shimPath: "/Users/alice/.local/bin/paperclipai", homeDir: "/Users/alice/.paperclip", stdoutPath: "/Users/alice/.paperclip/instances/team-a/logs/service.log", stderrPath: "/Users/alice/.paperclip/instances/team-a/logs/service.err.log" });
    expect(plist).toContain("ing.paperclip.paperclipai.team-a");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("service.err.log");
  });
});

describe("systemd drift regeneration", () => {
  it("rewrites a drifted unit and reloads the user manager", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const shimPath = path.join(userHome, ".local/bin/paperclipai");
    const manager = new SystemdServiceManager("default", runner, path.join(userHome, ".paperclip"), shimPath, userHome);
    await writeExecutable(shimPath);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    await fs.writeFile(manager.definitionPath, "stale\n", "utf8");

    const result = await manager.install({ startNow: false, startOnLogin: false });

    expect(result.changed).toBe(true);
    expect(await fs.readFile(manager.definitionPath, "utf8")).toBe(manager.renderDefinition());
    expect(calls).toContain("systemctl --user daemon-reload");
  });

  it("keeps an installed executable ExecStart when the environment resolves a missing shim", async () => {
    const userHome = await temporaryDirectory();
    const host = await temporaryDirectory();
    const installedShim = path.join(host, ".npm-global", "bin", "paperclipai");
    await fs.mkdir(path.dirname(installedShim), { recursive: true });
    await fs.writeFile(installedShim, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });

    const missingShim = path.join(host, ".local", "bin", "paperclipai");
    const homeDir = path.join(userHome, ".paperclip");
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const manager = new SystemdServiceManager("default", runner, homeDir, missingShim, userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    // Hand-patched unit: the real CLI lives outside the default shim path, and
    // an unrelated field has drifted so a rewrite really has to happen.
    const installedUnit = renderSystemdUnit({ instanceId: "default", shimPath: installedShim, homeDir }).replace("RestartSec=5", "RestartSec=99");
    await fs.writeFile(manager.definitionPath, installedUnit, "utf8");

    await manager.restart();

    const written = await fs.readFile(manager.definitionPath, "utf8");
    expect(await manager.installedExecutablePath()).toBe(installedShim);
    expect(written).toContain(`ExecStart="${installedShim}" run --instance "default"`);
    expect(written).toContain("RestartSec=5");
    expect(calls).toContain("systemctl --user daemon-reload");
  });

  it("adopts the resolved shim once it is executable", async () => {
    const userHome = await temporaryDirectory();
    const host = await temporaryDirectory();
    const resolvedShim = path.join(host, ".local", "bin", "paperclipai");
    await fs.mkdir(path.dirname(resolvedShim), { recursive: true });
    await fs.writeFile(resolvedShim, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
    const staleShim = path.join(host, ".npm-global", "bin", "paperclipai");
    const homeDir = path.join(userHome, ".paperclip");

    const manager = new SystemdServiceManager("default", async () => ({ stdout: "", stderr: "" }), homeDir, resolvedShim, userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    await fs.writeFile(manager.definitionPath, renderSystemdUnit({ instanceId: "default", shimPath: staleShim, homeDir }), "utf8");

    await manager.install({ startNow: false, startOnLogin: false });

    expect(await manager.installedExecutablePath()).toBe(resolvedShim);
  });

  it("preserves operator Environment= settings across a rewrite without duplicating managed keys", async () => {
    const userHome = await temporaryDirectory();
    const shimPath = path.join(userHome, ".local/bin/paperclipai");
    await writeExecutable(shimPath);
    const homeDir = path.join(userHome, ".paperclip");
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const manager = new SystemdServiceManager("default", runner, homeDir, shimPath, userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    // Operator hand-patched unit: custom PATH, provider routing, and a stale
    // managed key sharing a line with an operator setting.
    const installedUnit = renderSystemdUnit({ instanceId: "default", shimPath, homeDir })
      .replace("RestartSec=5", "RestartSec=99")
      .replace(
        "WorkingDirectory=%h",
        [
          'Environment="PATH=/opt/custom/bin:/usr/bin"',
          'Environment="PAPERCLIP_OPENCODE_PROVIDERS=openai anthropic"',
          'Environment="PAPERCLIP_HOME=/stale/home" "OPERATOR_TOKEN=abc"',
          "WorkingDirectory=%h",
        ].join("\n"),
      );
    await fs.writeFile(manager.definitionPath, installedUnit, "utf8");

    await manager.restart();

    const written = await fs.readFile(manager.definitionPath, "utf8");
    expect(written).toContain('Environment="PATH=/opt/custom/bin:/usr/bin"');
    expect(written).toContain('Environment="PAPERCLIP_OPENCODE_PROVIDERS=openai anthropic"');
    expect(written).toContain('Environment="OPERATOR_TOKEN=abc"');
    expect(written.match(/Environment="PAPERCLIP_HOME=/g)).toHaveLength(1);
    expect(written.match(/Environment="PAPERCLIP_SERVICE_MANAGED=/g)).toHaveLength(1);
    expect(written.match(/Environment="PATH=/g)).toHaveLength(1);
    expect(written).toContain("RestartSec=5");
    expect(calls).toContain("systemctl --user daemon-reload");
    // The preserved settings must be stable: a second render is a no-op.
    expect(await manager.desiredDefinition()).toBe(written);
  });

  it("refuses to rewrite a unit when neither the resolved nor the installed target is executable", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const shimPath = path.join(userHome, ".local/bin/paperclipai");
    const homeDir = path.join(userHome, ".paperclip");
    const manager = new SystemdServiceManager("default", runner, homeDir, shimPath, userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    // Installed unit points at a second path that is missing too.
    await fs.writeFile(
      manager.definitionPath,
      renderSystemdUnit({ instanceId: "default", shimPath: path.join(userHome, "gone", "paperclipai"), homeDir }),
      "utf8",
    );

    await expect(manager.restart()).rejects.toThrow(/Refusing to write/);

    const written = await fs.readFile(manager.definitionPath, "utf8");
    expect(written).toContain("gone/paperclipai");
    expect(calls).toEqual([]);
  });

  it("keeps the unit installed when stopping an active service fails", async () => {
    const userHome = await temporaryDirectory();
    const runner: CommandRunner = async (command, args) => {
      if (args.includes("--property=LoadState,ActiveState,UnitFileState,MainPID")) return { stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=42\n", stderr: "" };
      if (command === "systemctl" && args.includes("stop")) throw new Error("stop failed");
      return { stdout: "", stderr: "" };
    };
    const manager = new SystemdServiceManager("default", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    await fs.writeFile(manager.definitionPath, manager.renderDefinition(), "utf8");

    await expect(manager.uninstall()).rejects.toThrow("stop failed");
    await expect(fs.access(manager.definitionPath)).resolves.toBeUndefined();
  });
});

describe("service adapter dispatch", () => {
  it("selects launchd on macOS", async () => {
    const detection = await detectServiceManager({ platform: "darwin", instanceId: "default" });
    expect(detection.supported).toBe(true);
    if (detection.supported) expect(detection.manager).toBeInstanceOf(LaunchdServiceManager);
  });

  it("selects systemd only when the user manager is reachable", async () => {
    const runner: CommandRunner = async () => ({ stdout: "", stderr: "" });
    const detection = await detectServiceManager({ platform: "linux", instanceId: "default", runner });
    expect(detection.supported).toBe(true);
    if (detection.supported) expect(detection.manager).toBeInstanceOf(SystemdServiceManager);
  });

  it("returns a foreground-run skip on unsupported hosts", async () => {
    const runner: CommandRunner = async () => { throw new Error("no bus"); };
    const detection = await detectServiceManager({ platform: "linux", instanceId: "default", runner });
    expect(detection).toEqual({ supported: false, reason: expect.stringContaining("paperclipai run") });
  });
});

describe("launchd lifecycle", () => {
  it("starts without changing the saved login preference", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "print-disabled") return { stdout: `\"ing.paperclip.paperclipai.team-a\" => true`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);
    await writeExecutable(path.join(userHome, ".local/bin/paperclipai"));

    await manager.start();

    expect(calls).toContain(`launchctl disable gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
    expect(calls).not.toContain(`launchctl enable gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
  });

  it("preserves disabled state when the service name contains regex metacharacters", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const serviceName = "ing.paperclip.paperclipai.team[qa]+";
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "print-disabled") return { stdout: `"${serviceName}" => true`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team[qa]+", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);
    await writeExecutable(path.join(userHome, ".local/bin/paperclipai"));

    await manager.start();

    expect(calls).toContain(`launchctl disable gui/${process.getuid?.() ?? 0}/${serviceName}`);
    expect(calls).not.toContain(`launchctl enable gui/${process.getuid?.() ?? 0}/${serviceName}`);
  });

  it("disables login startup and unloads the keepalive job when stopped", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);
    await writeExecutable(path.join(userHome, ".local/bin/paperclipai"));

    await manager.install({ startNow: false, startOnLogin: false });
    await manager.stop();

    expect(calls).toContain(`launchctl disable gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
    expect(calls).toContain(`launchctl bootout gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
    expect(calls.some((call) => call.includes("launchctl kill"))).toBe(false);
  });

  it("keeps an installed executable launch agent when the resolved shim is missing", async () => {
    const userHome = await temporaryDirectory();
    const host = await temporaryDirectory();
    const installedShim = path.join(host, "npm-global", "bin", "paperclipai");
    await fs.mkdir(path.dirname(installedShim), { recursive: true });
    await fs.writeFile(installedShim, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
    const missingShim = path.join(host, ".local", "bin", "paperclipai");
    const homeDir = path.join(userHome, ".paperclip");

    const manager = new LaunchdServiceManager("default", async () => ({ stdout: "", stderr: "" }), homeDir, missingShim, userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    const installedAgent = renderLaunchdPlist({
      instanceId: "default",
      shimPath: installedShim,
      homeDir,
      stdoutPath: path.join(homeDir, "instances", "default", "logs", "service.log"),
      stderrPath: path.join(homeDir, "instances", "default", "logs", "service.err.log"),
    }).replace("<integer>5</integer>", "<integer>9</integer>");
    await fs.writeFile(manager.definitionPath, installedAgent, "utf8");

    await manager.install({ startNow: false, startOnLogin: false });

    const written = await fs.readFile(manager.definitionPath, "utf8");
    expect(await manager.installedExecutablePath()).toBe(installedShim);
    expect(written).toContain(`<string>${installedShim}</string><string>run</string>`);
    expect(written).toContain("<integer>5</integer>");
  });

  it("refuses to write a launch agent when no runnable target exists", async () => {
    const userHome = await temporaryDirectory();
    const missingShim = path.join(userHome, ".local", "bin", "paperclipai");
    const homeDir = path.join(userHome, ".paperclip");
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("default", runner, homeDir, missingShim, userHome);

    await expect(manager.install({ startNow: false, startOnLogin: false })).rejects.toThrow(/Refusing to write/);

    expect(calls).toEqual([]);
    await expect(fs.access(manager.definitionPath)).rejects.toThrow();
  });

  it("disables login startup when uninstalled", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchdServiceManager("team-a", runner, path.join(userHome, ".paperclip"), path.join(userHome, ".local/bin/paperclipai"), userHome);

    await manager.uninstall();

    expect(calls).toContain(`launchctl disable gui/${process.getuid?.() ?? 0}/ing.paperclip.paperclipai.team-a`);
  });
});

describe("single-writer guard", () => {
  const activeManager = { status: async () => ({ active: true, serviceName: "paperclipai.service" }) } as unknown as ServiceManager;
  const detector = async () => ({ supported: true as const, manager: activeManager });

  it("refuses a second foreground writer", async () => {
    await expect(assertForegroundRunAllowed("default", false, detector)).rejects.toThrow("already running");
  });

  it("allows an explicit force override", async () => {
    await expect(assertForegroundRunAllowed("default", true, detector)).resolves.toBeUndefined();
  });

  it("allows the supervisor-owned process", async () => {
    process.env.PAPERCLIP_SERVICE_MANAGED = "1";
    await expect(assertForegroundRunAllowed("default", false, detector)).resolves.toBeUndefined();
  });

  it("refuses to replace a symlinked service definition", async () => {
    const userHome = await temporaryDirectory();
    const shimPath = path.join(userHome, ".local/bin/paperclipai");
    const manager = new SystemdServiceManager("default", async () => ({ stdout: "", stderr: "" }), path.join(userHome, ".paperclip"), shimPath, userHome);
    await writeExecutable(shimPath);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    const target = path.join(userHome, "target.service"); await fs.writeFile(target, "preserve\n"); await fs.symlink(target, manager.definitionPath);
    await expect(manager.install({ startNow: false, startOnLogin: false })).rejects.toThrow("unsafe service definition");
    expect(await fs.readFile(target, "utf8")).toBe("preserve\n");
  });

});

describe("installed unit parsing", () => {
  it("reads quoted and unquoted ExecStart targets", () => {
    expect(
      extractExecutableFromSystemdUnit('[Service]\nExecStart="/opt/mine/paperclipai" run --instance "default"\n'),
    ).toBe("/opt/mine/paperclipai");
    expect(
      extractExecutableFromSystemdUnit('[Service]\nExecStart=/home/alice/.npm-global/bin/paperclipai run --instance "alice"\n'),
    ).toBe("/home/alice/.npm-global/bin/paperclipai");
    expect(extractExecutableFromSystemdUnit("[Service]\nExecStart=\n")).toBe(null);
    expect(extractExecutableFromSystemdUnit("[Unit]\nAfter=network.target\n")).toBe(null);
  });

  it("keeps an unquoted installed target when the preferred shim is missing", async () => {
    const userHome = await temporaryDirectory();
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const installedTarget = await writeExecutable(path.join(userHome, ".npm-global/bin/paperclipai"));
    const manager = new SystemdServiceManager(
      "default",
      runner,
      path.join(userHome, ".paperclip"),
      path.join(userHome, ".local/bin/paperclipai"),
      userHome,
    );
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    await fs.writeFile(manager.definitionPath, `[Service]\nExecStart=${installedTarget} run --instance "default"\n`, "utf8");

    await manager.restart();

    const written = await fs.readFile(manager.definitionPath, "utf8");
    expect(written).toContain(`ExecStart="${installedTarget}"`);
    expect(calls).toContain("systemctl --user daemon-reload");
  });

  it("reads a bare ExecStart target whose path contains an escaped space", () => {
    // systemd reads `\ ` as a space inside the word. Reading only up to the
    // backslash reports `/tmp/My\`, which is not a runnable target, so the
    // repair is refused for a unit that works.
    expect(
      extractExecutableFromSystemdUnit(
        "[Service]\nExecStart=/tmp/My\\ Apps/bin/paperclipai run --instance default\n",
      ),
    ).toBe("/tmp/My Apps/bin/paperclipai");
    // An escaped backslash is a literal backslash, and the space after it does
    // end the word -- the same way systemd splits it.
    expect(extractExecutableFromSystemdUnit("[Service]\nExecStart=/opt/od\\\\ d/paperclipai run\n")).toBe(
      "/opt/od\\",
    );
  });

  it("keeps an installed target with an escaped space when the preferred shim is missing", async () => {
    const userHome = await temporaryDirectory();
    const spacedDir = path.join(userHome, "My Apps", "bin");
    await fs.mkdir(spacedDir, { recursive: true });
    const calls: string[] = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { stdout: "", stderr: "" };
    };
    const installedTarget = path.join(spacedDir, "paperclipai");
    await writeExecutable(installedTarget);
    const manager = new SystemdServiceManager(
      "default",
      runner,
      path.join(userHome, ".paperclip"),
      path.join(userHome, ".local/bin/paperclipai"),
      userHome,
    );
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    // Hand-written, unquoted, with the space escaped the way systemd wants it.
    await fs.writeFile(
      manager.definitionPath,
      `[Service]\nExecStart=${installedTarget.replace(/ /g, "\\ ")} run --instance "default"\n`,
      "utf8",
    );

    await manager.restart();

    const written = await fs.readFile(manager.definitionPath, "utf8");
    expect(written).toContain(`ExecStart="${installedTarget}"`);
    expect(calls).toContain("systemctl --user daemon-reload");
  });

  it("keeps an operator Environment value that contains an escaped space", () => {
    const rendered = renderSystemdUnit({ instanceId: "default", shimPath: "/s/paperclipai", homeDir: "/h" });
    const installed = rendered.replace(
      "WorkingDirectory=%h",
      "Environment=PATH=/opt/My\\ Apps/bin:/usr/bin\nWorkingDirectory=%h",
    );

    const written = preserveEnvironmentLines(installed, rendered);

    expect(written).toContain("Environment=PATH=/opt/My\\ Apps/bin:/usr/bin");
    // Re-rendering an already-preserved unit must not drift.
    expect(preserveEnvironmentLines(installed, written)).toBe(written);
  });

  it("keeps an Environment reset directive that carries no assignment", () => {
    const rendered = renderSystemdUnit({ instanceId: "default", shimPath: "/s/paperclipai", homeDir: "/h" });
    const installed = rendered.replace("WorkingDirectory=%h", "Environment=\nWorkingDirectory=%h");

    const written = preserveEnvironmentLines(installed, rendered);

    expect(written).toMatch(/^Environment=$/m);
    expect(preserveEnvironmentLines(installed, written)).toBe(written);
  });

  it("places an Environment reset above the renderer's managed keys", () => {
    const rendered = renderSystemdUnit({ instanceId: "default", shimPath: "/s/paperclipai", homeDir: "/h" });
    const installed = rendered.replace("WorkingDirectory=%h", "Environment=\nWorkingDirectory=%h");

    const lines = preserveEnvironmentLines(installed, rendered).split("\n");

    // `Environment=` clears everything set so far. Carried below the renderer's
    // own keys it would clear PAPERCLIP_SERVICE_MANAGED, PAPERCLIP_INSTANCE_ID
    // and PAPERCLIP_HOME, and the service would stop being a managed one.
    const resetAt = lines.findIndex((line) => line.trim() === "Environment=");
    const managedAt = lines.findIndex((line) => line.startsWith('Environment="PAPERCLIP_SERVICE_MANAGED'));
    expect(resetAt).toBeGreaterThanOrEqual(0);
    expect(managedAt).toBeGreaterThanOrEqual(0);
    expect(resetAt).toBeLessThan(managedAt);
    // And the managed keys survive intact and contiguous after it.
    expect(lines.filter((line) => line.startsWith('Environment="PAPERCLIP_')).length).toBe(3);
    expect(preserveEnvironmentLines(installed, lines.join("\n"))).toBe(lines.join("\n"));
  });

  it("puts the operator's reset above the managed keys and their assignments below", () => {
    const rendered = renderSystemdUnit({ instanceId: "default", shimPath: "/s/paperclipai", homeDir: "/h" });
    const installed = rendered
      .replace("WorkingDirectory=%h", "Environment=\nWorkingDirectory=%h")
      .replace("WorkingDirectory=%h", "Environment=PATH=/opt/bin:/usr/bin\nEnvironment=FOO=bar\nWorkingDirectory=%h");

    const lines = preserveEnvironmentLines(installed, rendered).split("\n");

    const resetAt = lines.findIndex((line) => line.trim() === "Environment=");
    const managedAt = lines.findIndex((line) => line.startsWith('Environment="PAPERCLIP_SERVICE_MANAGED'));
    const carriedAt = lines.findIndex((line) => line.startsWith("Environment=PATH="));
    expect(resetAt).toBeGreaterThanOrEqual(0);
    expect(resetAt).toBeLessThan(managedAt);
    expect(carriedAt).toBeGreaterThan(managedAt);
    // The operator's own relative order is kept on both sides.
    expect(lines.indexOf("Environment=PATH=/opt/bin:/usr/bin")).toBeLessThan(lines.indexOf("Environment=FOO=bar"));
  });
});

describe("installed launch agent parsing", () => {
  const launchdInput = {
    instanceId: "default",
    shimPath: "/s/paperclipai",
    homeDir: "/h",
    stdoutPath: "/h/instances/default/logs/service.log",
    stderrPath: "/h/instances/default/logs/service.err.log",
  };

  it("carries operator EnvironmentVariables through a rewrite", () => {
    const rendered = renderLaunchdPlist(launchdInput);
    const installed = rendered.replace(
      "<key>PAPERCLIP_SERVICE_MANAGED</key><string>1</string>",
      "<key>PATH</key><string>/opt/My Apps/bin</string><key>PAPERCLIP_SERVICE_MANAGED</key><string>1</string>",
    );

    const written = preserveLaunchdEnvironmentVariables(installed, rendered);

    expect(written).toContain("<key>PATH</key><string>/opt/My Apps/bin</string>");
    expect(written.match(/<key>PATH<\/key>/g)).toHaveLength(1);
    // Re-rendering an already-preserved agent must not drift or duplicate.
    expect(preserveLaunchdEnvironmentVariables(installed, written)).toBe(written);
  });

  it("does not let an operator entry override a renderer-owned key", () => {
    const rendered = renderLaunchdPlist(launchdInput);
    const installed = rendered.replace(
      "<key>PAPERCLIP_HOME</key><string>/h</string>",
      "<key>OPERATOR_TOKEN</key><string>abc</string><key>PAPERCLIP_HOME</key><string>/stale/home</string>",
    );

    const written = preserveLaunchdEnvironmentVariables(installed, rendered);

    expect(written).toContain("<key>OPERATOR_TOKEN</key><string>abc</string>");
    expect(written).not.toContain("/stale/home");
    expect(written.match(/<key>PAPERCLIP_HOME<\/key>/g)).toHaveLength(1);
  });

  it("preserves the installed agent's operator entries through install", async () => {
    const userHome = await temporaryDirectory();
    const shimPath = await writeExecutable(path.join(userHome, ".local/bin/paperclipai"));
    const homeDir = path.join(userHome, ".paperclip");
    const manager = new LaunchdServiceManager("default", async () => ({ stdout: "", stderr: "" }), homeDir, shimPath, userHome);
    await fs.mkdir(path.dirname(manager.definitionPath), { recursive: true });
    await fs.writeFile(
      manager.definitionPath,
      renderLaunchdPlist(launchdInput).replace(
        "<key>PAPERCLIP_SERVICE_MANAGED</key><string>1</string>",
        "<key>PAPERCLIP_OPENCODE_PROVIDERS</key><string>openai anthropic</string><key>PAPERCLIP_SERVICE_MANAGED</key><string>1</string>",
      ),
      "utf8",
    );

    await manager.install({ startNow: false, startOnLogin: false });

    const written = await fs.readFile(manager.definitionPath, "utf8");
    expect(written).toContain("<key>PAPERCLIP_OPENCODE_PROVIDERS</key><string>openai anthropic</string>");
    expect(await manager.desiredDefinition()).toBe(written);
  });
});
