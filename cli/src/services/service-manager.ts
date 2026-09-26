import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolvePaperclipHomeDir, resolvePaperclipInstanceId } from "../config/home.js";

const execFileAsync = promisify(execFile);

export type ServicePlatform = "systemd" | "launchd";
export type ServiceStatus = {
  platform: ServicePlatform;
  serviceName: string;
  installed: boolean;
  active: boolean;
  enabled: boolean;
  pid: number | null;
  detail?: string;
  linger?: boolean | null;
};
export type ServiceInstallOptions = { startNow: boolean; startOnLogin: boolean };

/**
 * `uninstall()` is gated on positive proof that the definition it is about to
 * remove belongs to this instance. `force` is the operator's explicit override
 * for the two refusals that gate can raise — an unrecognised definition, and a
 * drop-in directory the CLI did not create. It is deliberately per-call and
 * never a persisted setting: an override that survives in a config file is an
 * override nobody re-reads before the next uninstall.
 */
export type ServiceUninstallOptions = { force?: boolean };

export interface ServiceManager {
  readonly platform: ServicePlatform;
  readonly instanceId: string;
  readonly serviceName: string;
  readonly definitionPath: string;
  /**
   * The systemd drop-in directory that systemd would load alongside
   * `definitionPath`, or `null` where the platform has no such mechanism.
   *
   * It is exposed on the manager, not recomputed by callers, so the doctor's
   * orphan check and `uninstall()` cannot drift onto different paths.
   */
  readonly dropInDirectory: string | null;
  renderDefinition(): string;
  /**
   * The exact bytes this manager would write to `definitionPath`: the
   * canonical rendering, re-pointed at a usable executable and carrying the
   * operator-supplied settings the renderer does not own. Writing anything
   * else silently deletes operator configuration, so install/start/restart
   * and the doctor's drift check all go through this.
   */
  desiredDefinition(): Promise<string>;
  install(options: ServiceInstallOptions): Promise<{ changed: boolean }>;
  uninstall(options?: ServiceUninstallOptions): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  logs(follow: boolean, lines: number): Promise<void>;
  installedExecutablePath(): Promise<string | null>;
  enableLinger?(): Promise<void>;
}

export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[], options?: { inherit?: boolean }) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = async (command, args, options) => {
  if (options?.inherit) {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(command, args, { windowsHide: true }, (error) => error ? reject(error) : resolve());
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    });
    return { stdout: "", stderr: "" };
  }
  const result = await execFileAsync(command, args, { encoding: "utf8", windowsHide: true });
  return { stdout: result.stdout, stderr: result.stderr };
};

function escapeSystemd(value: string): string {
  if (/\r|\n/.test(value)) {
    throw new Error("Systemd service values must not contain line breaks");
  }
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", () => "$$")
    .replaceAll("%", "%%");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveServiceShimPath(homeDir = os.homedir()): string {
  return process.env.PAPERCLIP_SHIM_PATH?.trim() || path.join(homeDir, ".local", "bin", "paperclipai");
}

// The installed definition, not the current environment, is the truth
// about what the service executes: PAPERCLIP_SHIM_PATH may have changed
// or been unset since the definition was written. A backslash escape is
// part of a systemd word, so `\ ` is a space inside the path and not the
// end of it: an unescaped `\` that systemd would honour cannot be read as
// a literal one, or the path is misreported and the repair is refused.
function unescapeSystemd(value: string): string {
  return value.replace(/\\\\|\\"|\\ |\$\$|%%/g, (m) =>
    m === "\\\\"
      ? "\\"
      : m === '\\"'
        ? '"'
        : m === "\\ "
          ? " "
          : m === "$$"
            ? "$"
            : "%",
  );
}

function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : name === "gt" ? ">" : name === "quot" ? '"' : "'",
  );
}

export function extractExecutableFromSystemdUnit(content: string): string | null {
  // systemd accepts both `ExecStart="/path/with space"` and `ExecStart=/path`.
  // Only the first word counts in the bare form; a unit written by hand or by
  // another packager is usually unquoted, and missing it makes the installed
  // target look absent, which turns a safe rewrite into a refusal.
  const quoted = content.match(/^ExecStart="((?:\\.|[^"\\])*)"/m);
  if (quoted) return unescapeSystemd(quoted[1]);
  // The same escape-aware word shape systemd parses: a backslash escapes the
  // next character, so `ExecStart=/tmp/My\ Apps/bin/paperclipai` is one word.
  // `\S+` stops at the escaped space and reports `/tmp/My\`, which makes a
  // runnable installed target look missing and turns a safe rewrite into a
  // refusal.
  const bare = content.match(/^ExecStart=((?:\\.|[^\s\\])+)/m);
  return bare ? unescapeSystemd(bare[1]) : null;
}

export function extractExecutableFromLaunchdPlist(content: string): string | null {
  const match = content.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
  return match ? unescapeXml(match[1]) : null;
}

// The service definition executes this path directly: existence is not
// enough — a directory or a non-executable file would satisfy fs.access's
// default mode and still crash the supervisor at spawn.
export async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return false;
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the executable a service definition may point at.
 *
 * `PAPERCLIP_SHIM_PATH` and the `~/.local/bin` default describe the current
 * environment, not the machine's history: an instance installed under a
 * different prefix (npm-global, a managed git store) keeps working through
 * every environment change. Rewriting the definition around a path that does
 * not exist produces `status=203/EXEC` and a `start-limit-hit` crash loop, so
 * the preferred candidate wins only when it is a usable executable and the
 * installed target is the fallback. When neither is usable the caller must
 * refuse to write rather than install a corpse.
 */
export async function resolveExecutableShimPath(input: {
  preferredPath: string;
  installedPath?: string | null;
  definitionPath?: string;
}): Promise<string> {
  if (await isExecutableFile(input.preferredPath)) return input.preferredPath;
  const installedPath = input.installedPath?.trim() || null;
  if (installedPath && await isExecutableFile(installedPath)) return installedPath;
  throw new Error(
    `Refusing to write ${input.definitionPath ?? "the service definition"}: `
    + `its ExecStart target ${input.preferredPath} does not exist or is not executable`
    + (installedPath && installedPath !== input.preferredPath
      ? `, and the installed target ${installedPath} is unusable too`
      : "")
    + ". Restore the executable (run `paperclipai install` to rebuild the managed shim) and retry.",
  );
}

export function systemdServiceName(instanceId: string): string {
  return instanceId === "default" ? "paperclipai.service" : `paperclipai-${instanceId}.service`;
}

export function launchdServiceName(instanceId: string): string {
  return instanceId === "default" ? "ing.paperclip.paperclipai" : `ing.paperclip.paperclipai.${instanceId}`;
}

/**
 * The identity a definition must carry before `uninstall()` will remove it, and
 * what the file on disk actually says.
 */
export type DefinitionOwnership = { owned: boolean; detail: string };

/**
 * Read one `Environment="KEY=VALUE"` out of a systemd unit.
 *
 * Both spellings are accepted because the quoted form is what the renderer emits
 * and the bare form is what a unit written by hand or by another packager
 * carries. Escaping is undone by {@link unescapeSystemd}, so a `$` or `%` in a
 * path compares equal to itself rather than to its escaped twin — comparing
 * escaped text is how an identity check starts rejecting the very unit it wrote.
 */
export function systemdEnvironmentValue(contents: string, key: string): string | null {
  const quoted = contents.match(new RegExp(`^Environment="${escapeRegExp(key)}=((?:\\\\.|[^"\\\\])*)"`, "m"));
  if (quoted) return unescapeSystemd(quoted[1]);
  const bare = contents.match(new RegExp(`^Environment=${escapeRegExp(key)}=((?:\\\\.|\\S)+)`, "m"));
  return bare ? unescapeSystemd(bare[1]) : null;
}

/** The launchd counterpart of {@link systemdEnvironmentValue}. */
export function launchdEnvironmentValue(contents: string, key: string): string | null {
  const match = contents.match(new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<string>([^<]*)</string>`));
  return match ? unescapeXml(match[1]) : null;
}

/**
 * Whether a definition on disk is this manager's own unit, judged on the
 * deployment identity the unit records rather than on its path.
 *
 * `definitionPath` is built from `os.homedir()` and the unit name from the
 * instance id, so on the `default` instance both land on the live control-plane
 * unit for every agent, sandbox, and e2e leg that shares the operator's
 * account. `uninstall()` used to remove whatever sat there — `force: true`, no
 * ownership check — which made "the file at that path" and "my file" the same
 * claim, and turned a mis-scoped invocation into the deletion of the service
 * every other agent on the control plane is running under.
 *
 * The discriminator has to be the **home**, not the name. A test, an agent, and
 * the control plane all instantiate the `default` instance, so all three render
 * the same `Description=`, the same unit name, and the same path; a marker built
 * from the name cannot tell them apart. `PAPERCLIP_HOME` is the root the running
 * process reads its state from, so a unit whose `PAPERCLIP_HOME` is not this
 * manager's is a different deployment that happens to share one path — which is
 * exactly the case the name cannot see. `PAPERCLIP_INSTANCE_ID` is checked too so
 * a same-home, different-instance unit is also refused.
 *
 * A definition that records neither is refused as well. There is no way to tell
 * a foreign unit from a Paperclip unit of an unrecognised vintage, and guessing
 * wrong in the permissive direction is the failure this whole predicate exists
 * to prevent.
 */
export function describeSystemdOwnership(
  contents: string,
  identity: { instanceId: string; homeDir: string },
): DefinitionOwnership {
  return describeOwnership(
    {
      instanceId: systemdEnvironmentValue(contents, "PAPERCLIP_INSTANCE_ID"),
      homeDir: systemdEnvironmentValue(contents, "PAPERCLIP_HOME"),
    },
    identity,
  );
}

/** See {@link describeSystemdOwnership}; the launchd side carries the same identity. */
export function describeLaunchdOwnership(
  contents: string,
  identity: { instanceId: string; homeDir: string },
): DefinitionOwnership {
  return describeOwnership(
    {
      instanceId: launchdEnvironmentValue(contents, "PAPERCLIP_INSTANCE_ID"),
      homeDir: launchdEnvironmentValue(contents, "PAPERCLIP_HOME"),
    },
    identity,
  );
}

function describeOwnership(
  found: { instanceId: string | null; homeDir: string | null },
  expected: { instanceId: string; homeDir: string },
): DefinitionOwnership {
  const rendered = `instance ${JSON.stringify(expected.instanceId)}, home ${JSON.stringify(expected.homeDir)}`;
  if (found.instanceId === null && found.homeDir === null) {
    return { owned: false, detail: "it records no PAPERCLIP_INSTANCE_ID or PAPERCLIP_HOME, so it is not a Paperclip-managed definition" };
  }
  if (found.instanceId !== expected.instanceId) {
    return {
      owned: false,
      detail: `it is instance ${JSON.stringify(found.instanceId)}, not ${rendered}`,
    };
  }
  if (found.homeDir !== expected.homeDir) {
    return {
      owned: false,
      detail: `it runs against home ${JSON.stringify(found.homeDir)}, not ${rendered} — a different deployment that resolves to the same path`,
    };
  }
  return { owned: true, detail: rendered };
}

/**
 * List the drop-ins systemd would load for a unit, or `[]` when there is no such
 * directory.
 *
 * Only regular files and symlinks count. A stray subdirectory is not a drop-in
 * and must not be reported as configuration `uninstall()` refused over, or the
 * refusal stops being a statement about the operator's configuration.
 */
export async function listDropInFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderSystemdUnit(input: { instanceId: string; shimPath: string; homeDir: string }): string {
  return `[Unit]
Description=Paperclip AI (${escapeSystemd(input.instanceId)})
After=network.target
# A fast-failing start must not be able to exhaust the burst.
#
# The mechanism is the exponential restart backoff in [Service] below, not this
# interval. StartLimitIntervalSec is only the width of the sliding window that
# StartLimitBurst counts starts in; it does not delay or space the attempts
# themselves. Widening it from 60 to 300 while the attempts still land 5s apart
# leaves the burst draining at the same ~25s. Measured on systemd 261.3 at this
# host, two transient user units differing only in the interval, both with
# Restart=always/RestartSec=5/StartLimitBurst=5/ExecStart=/bin/false: identical
# attempt timestamps to the millisecond from attempt 2, both reaching
# start-limit-hit at T+25s, and neither retrying again once the burst is
# charged (observed for 400s, past both windows). systemd does not reschedule a
# retry when the interval expires.
#
# This host is the proof that the interval alone is not the mechanism, and it
# is worth keeping in mind before "fixing" this again. The deployed unit carries
# a hand-written 70-start-timeout.conf pinning StartLimitIntervalSec=1h, and it
# still does not help: measured on this host with interval 1h, burst 5 and no
# backoff, the five attempts land 5.1s apart and reach start-limit-hit at T+26s
# with ActiveState=failed. A wider window around attempts that are already
# packed together is a wider window around the same failure.
#
# So the interval and the burst are set to match the backoff, not to look wide.
# With RestartMaxDelaySec=60 the steady-state spacing between attempts is 60s,
# so a 900s window holds ~15 starts and a burst of 12 is reachable: a fault
# that outlives the retry budget still parks the unit, and a fault that clears
# inside it is retried into recovery. Measured on systemd 261.3 at this host,
# transient user units carrying exactly these directives and ExecStart=/bin/false:
#   - a fault clearing on the 4th attempt recovers, ActiveState=active, T+27s;
#   - a permanently failing start charges all 12 and parks at T+448s (7.5 min),
#     against T+26s for the policy this replaces.
# Getting this pairing wrong is the failure mode worth naming: interval 300 with
# the original burst of 5 reaches start-limit-hit at T+49s, because 5
# backoff-spaced starts fit inside 300s too. The backoff lengthens the budget;
# only the burst decides where the budget ends.
#
# StartLimitAction stays systemd's default (none), so a genuinely permanent
# failure parks the unit for a human rather than rebooting the host.
StartLimitIntervalSec=900
StartLimitBurst=12

[Service]
Type=notify
NotifyAccess=all
ExecStart="${escapeSystemd(input.shimPath)}" run --instance "${escapeSystemd(input.instanceId)}"
Environment="PAPERCLIP_SERVICE_MANAGED=1"
Environment="PAPERCLIP_INSTANCE_ID=${escapeSystemd(input.instanceId)}"
Environment="PAPERCLIP_HOME=${escapeSystemd(input.homeDir)}"
WorkingDirectory=%h
Restart=always
RestartSec=5
# Exponential backoff, the part that actually keeps a fast-failing start from
# draining StartLimitBurst. systemd grows the delay before each restart from
# RestartSec up to RestartMaxDelaySec, so the starts it counts are spread across
# minutes instead of packed into the first half-minute. RestartSec is the floor
# for the first retry, RestartMaxDelaySec the ceiling every later retry sits at.
#
# The growth curve is systemd's own and is deliberately not reimplemented or
# predicted here. Measured on systemd 261.3 at this host with these values, the
# delay before each successive restart was 5.2s, 8.5s, 13.8s, 22.3s, 36.8s, then
# 60.3s for every attempt after that — growth of about 1.62x per restart, not
# the RestartSteps-fold step the name suggests. The only two facts anything
# should rely on are the documented ones: the delay starts at RestartSec, and it
# never exceeds RestartMaxDelaySec.
#
# RestartSteps and RestartMaxDelaySec need systemd v250+. On anything older they
# are ignored and the unit falls back to a flat RestartSec=5, which is the
# behaviour before this change rather than a new failure mode.
RestartSteps=5
RestartMaxDelaySec=60
# Type=notify cannot send READY=1 until the embedded postmaster is accepting
# connections and migrations have run, because the postmaster lives inside this
# unit's cgroup and the server owns its shutdown. systemd's 90s default therefore
# SIGTERMs the whole cgroup mid-boot on a loaded host, killing the database and
# every detached local-agent run it had just started. 10 minutes is well above
# a measured boot on this host; boot duration is not the control plane's to
# police, so the budget is generous rather than tuned.
TimeoutStartSec=600
TimeoutStopSec=300
# Only the server itself is signalled: the default KillMode=control-group
# would SIGTERM detached local-agent runs and embedded PostgreSQL in the same
# cgroup concurrently with the coordinated shutdown, which defeats hot-restart
# run adoption and puts the database out from under the snapshot.
KillMode=process

[Install]
WantedBy=default.target
`;
}

// Only these Environment keys belong to the renderer. Everything else in the
// installed definition (PATH, PAPERCLIP_OPENCODE_PROVIDERS, operator
// credentials) is operator configuration that a rewrite must carry forward
// instead of silently deleting.
const MANAGED_ENVIRONMENT_KEYS = new Set([
  "PAPERCLIP_SERVICE_MANAGED",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_HOME",
]);

type EnvironmentAssignment = { key: string; raw: string };

function parseEnvironmentAssignments(line: string): EnvironmentAssignment[] {
  const body = line.match(/^\s*Environment\s*=\s*(.*)$/)?.[1];
  if (body === undefined) return [];
  const assignments: EnvironmentAssignment[] = [];
  // The bare branch keeps `KEY=/opt/My\ Apps/bin` whole: systemd unescapes
  // backslashes in unquoted values, so splitting on whitespace would write a
  // truncated PATH back into the unit.
  const segment = /"((?:\\.|[^"\\])*)"|'([^']*)'|((?:\\.|[^\s"'])+)/g;
  let match: RegExpExecArray | null;
  while ((match = segment.exec(body)) !== null) {
    const content = match[1] ?? match[2] ?? match[3] ?? "";
    const separator = content.indexOf("=");
    if (separator < 1) continue;
    assignments.push({ key: content.slice(0, separator), raw: match[0] });
  }
  return assignments;
}

function environmentLinesOfServiceSection(definition: string): string[] {
  const lines: string[] = [];
  let inServiceSection = false;
  for (const line of definition.split("\n")) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inServiceSection = section[1] === "Service";
      continue;
    }
    if (inServiceSection && /^\s*Environment\s*=/.test(line)) lines.push(line.trim());
  }
  return lines;
}

/**
 * Carry the operator's own `Environment=` settings from the installed
 * definition into the rendered one. The renderer owns only its three
 * PAPERCLIP_* keys; dropping the rest rewrites a working unit into one that
 * no longer resolves executables or reaches the configured providers.
 */
export function preserveEnvironmentLines(installedDefinition: string | null, renderedDefinition: string): string {
  if (!installedDefinition) return renderedDefinition;
  const renderedLines = renderedDefinition.split("\n");
  const seen = new Set(renderedLines.map((line) => line.trim()));
  // `Environment=` is a reset directive, not an assignment: systemd clears the
  // environment assembled so far. It has no KEY=VALUE to re-render, so the line
  // itself has to survive the rewrite or the operator's reset is silently
  // cancelled. It also only keeps its meaning *before* the renderer's own keys
  // — carried after them, it clears PAPERCLIP_SERVICE_MANAGED,
  // PAPERCLIP_INSTANCE_ID and PAPERCLIP_HOME and the service stops being a
  // managed one. The two groups are therefore placed either side of the
  // rendered block, each keeping the operator's relative order.
  const resets: string[] = [];
  const carried: string[] = [];
  for (const line of environmentLinesOfServiceSection(installedDefinition)) {
    const assignments = parseEnvironmentAssignments(line);
    const kept = assignments.filter((assignment) => !MANAGED_ENVIRONMENT_KEYS.has(assignment.key));
    if (assignments.length === 0) {
      if (seen.has(line)) continue;
      seen.add(line);
      resets.push(line);
      continue;
    }
    if (kept.length === 0) continue;
    const rendered = `Environment=${kept.map((assignment) => assignment.raw).join(" ")}`;
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    carried.push(rendered);
  }
  if (resets.length === 0 && carried.length === 0) return renderedDefinition;

  // First and last `Environment=` of the rendered [Service] section; the
  // renderer's own managed block is what they bracket.
  let firstAnchor = -1;
  let lastAnchor = -1;
  let inServiceSection = false;
  for (let index = 0; index < renderedLines.length; index += 1) {
    const section = renderedLines[index].match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inServiceSection = section[1] === "Service";
      continue;
    }
    if (inServiceSection && /^\s*Environment\s*=/.test(renderedLines[index])) {
      if (firstAnchor < 0) firstAnchor = index;
      lastAnchor = index;
    }
  }
  if (firstAnchor < 0) {
    // No rendered environment block to bracket; the [Service] header is the
    // earliest legal place for either group.
    for (let index = 0; index < renderedLines.length; index += 1) {
      if (/^\s*\[Service\]\s*$/.test(renderedLines[index])) {
        firstAnchor = index;
        lastAnchor = index;
        break;
      }
    }
  }
  if (firstAnchor < 0) return renderedDefinition;
  const head = firstAnchor === lastAnchor ? renderedLines.slice(0, firstAnchor + 1) : renderedLines.slice(0, firstAnchor);
  const managedBlock = firstAnchor === lastAnchor ? [] : renderedLines.slice(firstAnchor, lastAnchor + 1);
  const tail = renderedLines.slice(lastAnchor + 1);
  return [...head, ...resets, ...managedBlock, ...carried, ...tail].join("\n");
}

type LaunchdEnvironmentEntry = { key: string; value: string };

function extractLaunchdEnvironmentVariables(plist: string): LaunchdEnvironmentEntry[] {
  const block = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!block) return [];
  const entries: LaunchdEnvironmentEntry[] = [];
  const pair = /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  let match: RegExpExecArray | null;
  while ((match = pair.exec(block[1])) !== null) {
    entries.push({ key: unescapeXml(match[1]), value: unescapeXml(match[2]) });
  }
  return entries;
}

/**
 * Carry the operator's own `EnvironmentVariables` from the installed launch
 * agent into the rendered one. The renderer owns only its three PAPERCLIP_*
 * keys; without this a hand-edited agent loses PATH and credentials on every
 * install or restart, which is exactly the contract the systemd path honours.
 */
export function preserveLaunchdEnvironmentVariables(installedPlist: string | null, renderedPlist: string): string {
  if (!installedPlist) return renderedPlist;
  const renderedKeys = new Set(extractLaunchdEnvironmentVariables(renderedPlist).map((entry) => entry.key));
  const additions = extractLaunchdEnvironmentVariables(installedPlist)
    .filter((entry) => !MANAGED_ENVIRONMENT_KEYS.has(entry.key) && !renderedKeys.has(entry.key));
  if (additions.length === 0) return renderedPlist;
  const serialized = additions.map((entry) => `    <key>${escapeXml(entry.key)}</key><string>${escapeXml(entry.value)}</string>`).join("\n");
  const replaced = renderedPlist.replace(
    /(<key>EnvironmentVariables<\/key>\s*<dict>[\s\S]*?)(\s*)(<\/dict>)/,
    (_match, body: string, indent: string, close: string) => `${body}\n${serialized}${indent}${close}`,
  );
  return replaced === renderedPlist ? renderedPlist : replaced;
}

export function renderLaunchdPlist(input: { instanceId: string; shimPath: string; homeDir: string; stdoutPath: string; stderrPath: string }): string {
  const label = launchdServiceName(input.instanceId);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(input.shimPath)}</string><string>run</string><string>--instance</string><string>${escapeXml(input.instanceId)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PAPERCLIP_SERVICE_MANAGED</key><string>1</string>
    <key>PAPERCLIP_INSTANCE_ID</key><string>${escapeXml(input.instanceId)}</string>
    <key>PAPERCLIP_HOME</key><string>${escapeXml(input.homeDir)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>300</integer>
  <key>StandardOutPath</key><string>${escapeXml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(input.stderrPath)}</string>
</dict>
</plist>
`;
}

async function writeIfChanged(filePath: string, contents: string): Promise<boolean> {
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directoryPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(`Refusing to write service definition through unsafe directory ${directoryPath}.`);
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && directoryStat.uid !== currentUid) throw new Error(`Refusing to write service definition in directory not owned by the current user: ${directoryPath}.`);
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error(`Refusing to replace unsafe service definition ${filePath}.`);
    if (currentUid !== undefined && stat.uid !== currentUid) throw new Error(`Refusing to replace service definition not owned by the current user: ${filePath}.`);
    if (await fs.readFile(filePath, "utf8") === contents) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(directoryPath, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  return true;
}

export class SystemdServiceManager implements ServiceManager {
  readonly platform = "systemd" as const;
  readonly serviceName: string;
  readonly definitionPath: string;
  readonly dropInDirectory: string;

  constructor(readonly instanceId: string, private readonly runner: CommandRunner = defaultCommandRunner, private readonly homeDir = resolvePaperclipHomeDir(), private readonly shimPath = resolveServiceShimPath(), userHomeDir = os.homedir()) {
    this.serviceName = systemdServiceName(instanceId);
    this.definitionPath = path.join(userHomeDir, ".config", "systemd", "user", this.serviceName);
    this.dropInDirectory = path.join(userHomeDir, ".config", "systemd", "user", `${this.serviceName}.d`);
  }

  renderDefinition(): string {
    return renderSystemdUnit({ instanceId: this.instanceId, shimPath: this.shimPath, homeDir: this.homeDir });
  }

  async installedExecutablePath(): Promise<string | null> {
    try {
      return extractExecutableFromSystemdUnit(await fs.readFile(this.definitionPath, "utf8"));
    } catch {
      return null;
    }
  }

  private async installedDefinition(): Promise<string | null> {
    try {
      return await fs.readFile(this.definitionPath, "utf8");
    } catch {
      return null;
    }
  }

  async desiredDefinition(): Promise<string> {
    const rendered = this.renderDefinition();
    const renderedTarget = extractExecutableFromSystemdUnit(rendered);
    // Preferred candidate first, then the target the installed unit already
    // uses; if neither is a runnable executable this throws instead of
    // writing a unit systemd cannot exec (status=203/EXEC → start-limit-hit).
    const target = await resolveExecutableShimPath({
      preferredPath: renderedTarget ?? this.shimPath,
      installedPath: await this.installedExecutablePath(),
      definitionPath: this.definitionPath,
    });
    const withTarget = target === renderedTarget
      ? rendered
      : rendered.replace(/^ExecStart="(?:\\.|[^"\\])*"/m, `ExecStart="${escapeSystemd(target)}"`);
    return preserveEnvironmentLines(await this.installedDefinition(), withTarget);
  }

  private async ensureCurrent(): Promise<boolean> {
    const changed = await writeIfChanged(this.definitionPath, await this.desiredDefinition());
    if (changed) await this.runner("systemctl", ["--user", "daemon-reload"]);
    return changed;
  }

  async install(options: ServiceInstallOptions): Promise<{ changed: boolean }> {
    const changed = await this.ensureCurrent();
    if (options.startOnLogin) await this.runner("systemctl", ["--user", "enable", this.serviceName]);
    else await this.runner("systemctl", ["--user", "disable", this.serviceName]).catch(() => undefined);
    if (options.startNow) await this.start();
    return { changed };
  }

  async uninstall(options: ServiceUninstallOptions = {}): Promise<void> {
    // Both refusals are raised ahead of every destructive step, so a refusal
    // leaves the host byte-identical: no stop, no disable, no daemon-reload.
    // That ordering is the whole point — a gate that runs after `stop()` has
    // already taken the service down, which is the outage the gate exists to
    // prevent.
    await this.assertUninstallable(options.force === true);
    const status = await this.status();
    if (status.active) await this.stopOrRefuseToRemove();
    // A failed `disable` is recorded, not swallowed: swallowed, the unit stays
    // enabled and comes back on the next login, so an uninstall that reported
    // success had in fact scheduled the service to return.
    let disableFailure: unknown;
    try {
      await this.runner("systemctl", ["--user", "disable", this.serviceName]);
    } catch (error) {
      disableFailure = error;
    }
    await fs.rm(this.definitionPath, { force: true });
    await this.runner("systemctl", ["--user", "daemon-reload"]);
    // `reset-failed` only clears a start-limit counter for a unit that no longer
    // exists, so its failure is genuinely inert and stays unlogged.
    await this.runner("systemctl", ["--user", "reset-failed", this.serviceName]).catch(() => undefined);
    if (disableFailure) {
      throw new Error(
        `Removed ${this.definitionPath}, but could not disable ${this.serviceName}: ${describeError(disableFailure)}. `
        + `The unit is no longer defined, but it may still be enabled and will be started again on the next login. `
        + `Run \`systemctl --user disable ${this.serviceName}\` (or \`systemctl --user reset-failed ${this.serviceName}\` if the unit is already gone) to clear it.`,
        { cause: disableFailure },
      );
    }
  }

  /**
   * Refuse, before anything is touched, when the definition is not this
   * instance's unit or when a drop-in directory is present.
   *
   * The drop-in case is the one that is quiet when it goes wrong. `uninstall()`
   * removes the unit *file*; the directory systemd loads its overrides from is
   * a separate path and survives. systemd stops reading it the moment the parent
   * unit is gone, so the drop-ins are not deleted and not reported — they are
   * orphaned, and the next `paperclipai service install` writes a bare unit that
   * silently lost every one of them. The failure then surfaces much later, as an
   * outage whose two error signatures point at unrelated causes. The CLI never
   * writes to that directory, so it can never be "the one uninstall created":
   * refusing is the only honest option, and the message names the files.
   */
  private async assertUninstallable(force: boolean): Promise<void> {
    let contents: string | null = null;
    try {
      contents = await fs.readFile(this.definitionPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const ownership = contents === null
      ? { owned: true, detail: "no definition is installed" }
      : describeSystemdOwnership(contents, { instanceId: this.instanceId, homeDir: this.homeDir });
    if (!ownership.owned && !force) {
      throw new Error(
        `Refusing to remove ${this.definitionPath}: ${ownership.detail}. `
        + `This manager is the one for ${this.serviceName} at ${JSON.stringify(this.homeDir)}, and removing a unit file that is not its own `
        + `deletes whatever is installed at that path — including a loaded unit, whose fragment the systemd user manager garbage-collects, stopping the service `
        + `and every agent running under it. Inspect the file, or re-run with --force if you really mean to remove it.`,
      );
    }

    const dropIns = await listDropInFiles(this.dropInDirectory);
    if (dropIns.length > 0 && !force) {
      throw new Error(
        `Refusing to remove ${this.definitionPath}: ${this.dropInDirectory} holds ${dropIns.length} drop-in file${dropIns.length === 1 ? "" : "s"} (${dropIns.join(", ")}). `
        + `Uninstalling removes the unit file only, and systemd stops loading that directory the moment the parent unit is gone — `
        + `so the drop-ins would be orphaned rather than removed, \`doctor\` would report nothing, and the next \`paperclipai service install\` would write a bare unit that has quietly lost all of them. `
        + `Move or delete ${this.dropInDirectory} yourself, or re-run with --force to leave it behind on purpose.`,
      );
    }
  }

  /**
   * Stopping a unit is not allowed to fail quietly into a removal.
   *
   * `RefuseManualStop=` makes `systemctl --user stop` exit non-zero while the
   * unit keeps running, and the old code let that error abort the uninstall by
   * accident. That accident is the only reason a mis-scoped uninstall has not
   * taken a control plane down: a drop-in written to stop outage-driven manual
   * restarts happens to block the deletion of the unit the board runs on, and
   * removing *that* drop-in — which its own header tells operators to do to
   * restore normal service operation — would arm the deletion. A protection
   * that depends on an unrelated setting is not a protection, so the refusal is
   * now the stated behaviour and it names the blocker.
   */
  private async stopOrRefuseToRemove(): Promise<void> {
    try {
      await this.stop();
    } catch (error) {
      throw new Error(
        `Refusing to remove ${this.definitionPath}: ${this.serviceName} is running and could not be stopped (${describeError(error)}). `
        + `Removing the fragment of a running unit makes the systemd user manager garbage-collect it, which stops the service and takes down every agent on this control plane. `
        + `Stop it by hand (\`systemctl --user stop ${this.serviceName}\`; a RefuseManualStop= drop-in will block that) and retry, or re-run with --force.`,
        { cause: error },
      );
    }
  }

  async start(): Promise<void> { await this.ensureCurrent(); await this.runner("systemctl", ["--user", "start", this.serviceName]); }
  async stop(): Promise<void> { await this.runner("systemctl", ["--user", "stop", this.serviceName]); }
  async restart(): Promise<void> { await this.ensureCurrent(); await this.runner("systemctl", ["--user", "restart", this.serviceName]); }

  async status(): Promise<ServiceStatus> {
    let output: string;
    try {
      output = (await this.runner("systemctl", ["--user", "show", this.serviceName, "--property=LoadState,ActiveState,UnitFileState,MainPID"])).stdout;
    } catch {
      return { platform: this.platform, serviceName: this.serviceName, installed: false, active: false, enabled: false, pid: null, linger: await this.lingerStatus() };
    }
    const values = Object.fromEntries(output.trim().split(/\r?\n/).map((line) => line.split(/=(.*)/s).slice(0, 2)));
    const pid = Number(values.MainPID);
    return { platform: this.platform, serviceName: this.serviceName, installed: values.LoadState === "loaded", active: values.ActiveState === "active", enabled: values.UnitFileState === "enabled", pid: Number.isInteger(pid) && pid > 0 ? pid : null, detail: values.ActiveState, linger: await this.lingerStatus() };
  }

  private async lingerStatus(): Promise<boolean | null> {
    try {
      const result = await this.runner("loginctl", ["show-user", String(process.getuid?.() ?? os.userInfo().username), "--property=Linger", "--value"]);
      return result.stdout.trim() === "yes";
    } catch { return null; }
  }

  async enableLinger(): Promise<void> { await this.runner("loginctl", ["enable-linger", os.userInfo().username]); }
  async logs(follow: boolean, lines: number): Promise<void> { await this.runner("journalctl", ["--user", "--unit", this.serviceName, "--lines", String(lines), ...(follow ? ["--follow"] : [])], { inherit: true }); }
}

export class LaunchdServiceManager implements ServiceManager {
  readonly platform = "launchd" as const;
  readonly serviceName: string;
  readonly definitionPath: string;
  /** launchd has no drop-in directory; a plist is one file or it is nothing. */
  readonly dropInDirectory: null = null;
  private readonly domain = `gui/${process.getuid?.() ?? 0}`;
  private readonly stdoutPath: string;
  private readonly stderrPath: string;

  constructor(readonly instanceId: string, private readonly runner: CommandRunner = defaultCommandRunner, private readonly homeDir = resolvePaperclipHomeDir(), private readonly shimPath = resolveServiceShimPath(), userHomeDir = os.homedir()) {
    this.serviceName = launchdServiceName(instanceId);
    this.definitionPath = path.join(userHomeDir, "Library", "LaunchAgents", `${this.serviceName}.plist`);
    const logDir = path.join(homeDir, "instances", instanceId, "logs");
    this.stdoutPath = path.join(logDir, "service.log");
    this.stderrPath = path.join(logDir, "service.err.log");
  }

  renderDefinition(): string { return renderLaunchdPlist({ instanceId: this.instanceId, shimPath: this.shimPath, homeDir: this.homeDir, stdoutPath: this.stdoutPath, stderrPath: this.stderrPath }); }

  async installedExecutablePath(): Promise<string | null> {
    try {
      return extractExecutableFromLaunchdPlist(await fs.readFile(this.definitionPath, "utf8"));
    } catch {
      return null;
    }
  }

  async desiredDefinition(): Promise<string> {
    const rendered = this.renderDefinition();
    const renderedTarget = extractExecutableFromLaunchdPlist(rendered);
    // Same contract as the systemd manager: preferred shim, else the target
    // the installed plist already uses, else refuse to write (launchd would
    // otherwise respawn a missing binary forever).
    const target = await resolveExecutableShimPath({
      preferredPath: renderedTarget ?? this.shimPath,
      installedPath: await this.installedExecutablePath(),
      definitionPath: this.definitionPath,
    });
    const installed = await this.installedDefinition();
    const withTarget = target === renderedTarget
      ? rendered
      : rendered.replace(
        /(<string>)([^<]*)(<\/string><string>run<\/string>)/,
        (_match, prefix, _current, suffix: string) => `${prefix}${escapeXml(target)}${suffix}`,
      );
    return preserveLaunchdEnvironmentVariables(installed, withTarget);
  }

  private async installedDefinition(): Promise<string | null> {
    try {
      return await fs.readFile(this.definitionPath, "utf8");
    } catch {
      return null;
    }
  }

  async install(options: ServiceInstallOptions): Promise<{ changed: boolean }> {
    await fs.mkdir(path.dirname(this.stdoutPath), { recursive: true });
    const changed = await writeIfChanged(this.definitionPath, await this.desiredDefinition());
    if (changed) await this.runner("launchctl", ["bootout", `${this.domain}/${this.serviceName}`]).catch(() => undefined);
    await this.runner("launchctl", [options.startOnLogin ? "enable" : "disable", `${this.domain}/${this.serviceName}`]);
    if (options.startOnLogin || options.startNow) {
      await this.runner("launchctl", ["bootstrap", this.domain, this.definitionPath]).catch(async () => this.runner("launchctl", ["kickstart", "-k", `${this.domain}/${this.serviceName}`]));
    }
    if (!options.startNow) await this.stop().catch(() => undefined);
    return { changed };
  }

  async uninstall(options: ServiceUninstallOptions = {}): Promise<void> {
    // Same gate and the same ordering as the systemd side: prove ownership
    // before booting the agent out, so a refusal does not stop a LaunchAgent it
    // has no claim to. A booted-out agent is an outage the operator did not ask
    // for and cannot undo from the same command.
    let contents: string | null = null;
    try {
      contents = await fs.readFile(this.definitionPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (contents !== null) {
      const ownership = describeLaunchdOwnership(contents, { instanceId: this.instanceId, homeDir: this.homeDir });
      if (!ownership.owned && options.force !== true) {
        throw new Error(
          `Refusing to remove ${this.definitionPath}: ${ownership.detail}. `
          + `This manager is the one for ${this.serviceName} at ${JSON.stringify(this.homeDir)}, and removing a plist that is not its own `
          + `deletes whatever is installed at that path — including the plist a running LaunchAgent was bootstrapped from. `
          + `Inspect the file, or re-run with --force if you really mean to remove it.`,
        );
      }
    }
    await this.runner("launchctl", ["bootout", `${this.domain}/${this.serviceName}`]).catch(() => undefined);
    let disableFailure: unknown;
    try {
      await this.runner("launchctl", ["disable", `${this.domain}/${this.serviceName}`]);
    } catch (error) {
      disableFailure = error;
    }
    await fs.rm(this.definitionPath, { force: true });
    if (disableFailure) {
      throw new Error(
        `Removed ${this.definitionPath}, but could not disable ${this.serviceName}: ${describeError(disableFailure)}. `
        + `The agent is no longer defined, but it may still be enabled and will be loaded again on the next login. `
        + `Run \`launchctl disable ${this.domain}/${this.serviceName}\` to clear it.`,
        { cause: disableFailure },
      );
    }
  }
  async start(): Promise<void> { await this.install({ startNow: true, startOnLogin: await this.isEnabled() }); }
  async stop(): Promise<void> { await this.runner("launchctl", ["bootout", `${this.domain}/${this.serviceName}`]); }
  async restart(): Promise<void> { await writeIfChanged(this.definitionPath, await this.desiredDefinition()); await this.runner("launchctl", ["kickstart", "-k", `${this.domain}/${this.serviceName}`]); }

  async status(): Promise<ServiceStatus> {
    try {
      const result = await this.runner("launchctl", ["print", `${this.domain}/${this.serviceName}`]);
      const pidMatch = result.stdout.match(/\bpid\s*=\s*(\d+)/);
      const pid = pidMatch ? Number(pidMatch[1]) : null;
      return { platform: this.platform, serviceName: this.serviceName, installed: true, active: Boolean(pid), enabled: await this.isEnabled(), pid, detail: pid ? "running" : "loaded" };
    } catch {
      let installed = true;
      try { await fs.access(this.definitionPath); } catch { installed = false; }
      return { platform: this.platform, serviceName: this.serviceName, installed, active: false, enabled: installed && await this.isEnabled(), pid: null };
    }
  }

  private async isEnabled(): Promise<boolean> {
    try {
      const result = await this.runner("launchctl", ["print-disabled", this.domain]);
      return !new RegExp(`"${escapeRegExp(this.serviceName)}"\\s*=>\\s*true`).test(result.stdout);
    } catch { return true; }
  }

  async logs(follow: boolean, lines: number): Promise<void> { await this.runner("tail", ["-n", String(lines), ...(follow ? ["-F"] : []), this.stdoutPath, this.stderrPath], { inherit: true }); }
}

export type ServiceManagerDetection = { supported: true; manager: ServiceManager } | { supported: false; reason: string };

export async function detectServiceManager(input: { instanceId?: string; platform?: NodeJS.Platform; runner?: CommandRunner } = {}): Promise<ServiceManagerDetection> {
  const instanceId = resolvePaperclipInstanceId(input.instanceId);
  const platform = input.platform ?? process.platform;
  const runner = input.runner ?? defaultCommandRunner;
  if (platform === "darwin") return { supported: true, manager: new LaunchdServiceManager(instanceId, runner) };
  if (platform !== "linux") return { supported: false, reason: `Service management is not supported on ${platform}. Use paperclipai run instead.` };
  try {
    await runner("systemctl", ["--user", "show-environment"]);
    return { supported: true, manager: new SystemdServiceManager(instanceId, runner) };
  } catch {
    return { supported: false, reason: "No usable systemd user manager was detected (common in containers and WSL1). Use paperclipai run instead." };
  }
}

export async function assertForegroundRunAllowed(instanceId: string, force = false, detector: typeof detectServiceManager = detectServiceManager): Promise<void> {
  if (force || process.env.PAPERCLIP_SERVICE_MANAGED === "1") return;
  const detection = await detector({ instanceId });
  if (!detection.supported) return;
  const status = await detection.manager.status();
  if (status.active) throw new Error(`Paperclip instance '${instanceId}' is already running as ${status.serviceName}. Use 'paperclipai service status --instance ${instanceId}' or pass --force to bypass this safety check.`);
}
