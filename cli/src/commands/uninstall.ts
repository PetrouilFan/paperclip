import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import {
  assertManagedInstallStore,
  removeManagedPathBlock,
  removeManagedShim,
  resolveInstallStorePaths,
  withInstallStoreLock,
} from "../install-store.js";
import { resolvePaperclipInstanceId } from "../config/home.js";
import { detectServiceManager, launchdServiceName, systemdServiceName } from "../services/service-manager.js";

type UninstallDependencies = {
  detectServiceManager: typeof detectServiceManager;
  platform: NodeJS.Platform;
  userHomeDir: string;
  /**
   * Carry on past the service manager's ownership and drop-in refusals.
   *
   * Default off, and deliberately not persisted: a refusal here means the unit
   * about to be deleted may not be the one this CLI installed, or that overrides
   * the CLI never wrote would be orphaned. Both are silent afterwards, so the
   * default has to be the slow answer.
   */
  force?: boolean;
};

function otherServiceDefinitions(platform: NodeJS.Platform, userHomeDir: string, instanceId: string): string[] {
  const directory = platform === "linux"
    ? path.join(userHomeDir, ".config", "systemd", "user")
    : platform === "darwin"
      ? path.join(userHomeDir, "Library", "LaunchAgents")
      : null;
  if (!directory || !fs.existsSync(directory)) return [];
  const currentName = platform === "linux"
    ? systemdServiceName(instanceId)
    : `${launchdServiceName(instanceId)}.plist`;
  const pattern = platform === "linux"
    ? /^paperclipai(?:-.+)?\.service$/
    : /^ing\.paperclip\.paperclipai(?:\..+)?\.plist$/;
  return fs.readdirSync(directory)
    .filter((name) => name !== currentName && pattern.test(name))
    .map((name) => path.join(directory, name));
}

export async function uninstallCommand(
  dependencies: Partial<UninstallDependencies> = {},
): Promise<void> {
  const instanceId = resolvePaperclipInstanceId();
  const detect = dependencies.detectServiceManager ?? detectServiceManager;
  const platform = dependencies.platform ?? process.platform;
  const userHomeDir = dependencies.userHomeDir ?? os.homedir();
  const detection = await detect({ instanceId, platform });
  const otherDefinitions = otherServiceDefinitions(platform, userHomeDir, instanceId);
  if (otherDefinitions.length > 0) {
    throw new Error(`Cannot remove the shared managed CLI while other instance services are installed: ${otherDefinitions.join(", ")}. Uninstall those services first.`);
  }
  if (!detection.supported && platform === "linux") {
    const definitionPath = path.join(
      userHomeDir,
      ".config",
      "systemd",
      "user",
      systemdServiceName(instanceId),
    );
    if (fs.existsSync(definitionPath)) {
      throw new Error(
        `Cannot verify or remove the background service: ${detection.reason}. Retry when the service manager is available.`,
      );
    }
  }
  if (detection.supported) {
    const status = await detection.manager.status();
    // A refusal from the service manager aborts the whole command, before the
    // shim and the install store are touched. Half-removing a CLI while the
    // service it manages is still registered leaves the unit enabled against a
    // command that no longer exists.
    if (status.installed || status.active) await detection.manager.uninstall({ force: dependencies.force === true });
  }

  const paths = resolveInstallStorePaths();
  const hadStore = fs.existsSync(paths.cliRoot);
  if (hadStore) assertManagedInstallStore(paths);
  const shimRemoved = await withInstallStoreLock(async () => {
    if (hadStore) assertManagedInstallStore(paths);
    const removed = removeManagedShim(paths);

    const home = process.env.HOME;
    for (const rcFile of home ? [path.join(home, ".bashrc"), path.join(home, ".zshrc")] : []) {
      removeManagedPathBlock(rcFile);
    }
    fs.rmSync(paths.cliRoot, { recursive: true, force: true });
    return removed;
  }, paths, { initialize: !hadStore });

  if (!shimRemoved) {
    console.log(pc.yellow(`Left ${paths.shimPath} unchanged because it is not a Paperclip-managed shim.`));
  }
  console.log(pc.green("Removed the managed Paperclip CLI install."));
  console.log(pc.dim(`User data was left untouched under ${paths.paperclipHome}.`));
}
