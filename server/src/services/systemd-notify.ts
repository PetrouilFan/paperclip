import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

/**
 * The systemd notifier, and why it is a child process.
 *
 * The control plane runs as a `Type=notify` user unit. systemd puts the unit's
 * notify socket address into this process's own environment as `NOTIFY_SOCKET`,
 * and `READY=1` is what completes the start protocol, so the datagram has to be
 * sent from somewhere.
 *
 * It cannot be sent from here. Node has no way to write an `AF_UNIX`
 * `SOCK_DGRAM` datagram, measured on this host against node v26.9.0:
 *
 * - `dgram.createSocket({ type: "unix_dgram" })` throws `ERR_SOCKET_BAD_TYPE`
 *   ("Valid types are: udp4, udp6"). `dgram` is UDP-only.
 * - `net.createConnection({ path, type: "unix_dgram" })` looks like the answer
 *   and is not: the `type` is accepted, the socket is created, and it is still a
 *   `SOCK_STREAM` socket. Pointed at a real datagram listener (`socat -u
 *   UNIX-RECV:…`) it fails `connect EPROTOTYPE`, and pointed at a stream
 *   listener it connects, which is the proof. `server/src/services/
 *   systemd-notify.test.ts` pins both halves.
 *
 * So the datagram goes out through the `systemd-notify` binary, and that makes
 * the sender a child of this process rather than this process. Two consequences
 * are load-bearing and both are easy to get wrong:
 *
 * 1. `NotifyAccess=main` is unreachable from here. systemd accepts a datagram
 *    under `main` only from the pid it records as `MainPID`, and the notifier is
 *    not that pid, so a `main` unit refuses `READY=1`, never reaches `active`, and
 *    sits out `TimeoutStartSec` before it is killed and restarted. The unit
 *    therefore stays `NotifyAccess=all`
 *    (`cli/src/services/service-manager.ts`), and that value must not be
 *    "tightened" without changing the notifier first.
 *
 *    The one shape that would make `main` correct is
 *    `ExecStart=/usr/bin/systemd-notify --ready --exec <server>`, because
 *    `--exec` sends the datagram and then becomes the server in the same pid.
 *    It is not used here: the datagram would then be sent *before* the server
 *    exists, and `READY=1` currently means "the server is listening and
 *    migrations have run" (`doc/DEVELOPING.md`, on `Type=notify` and the
 *    embedded postmaster). Trading that for a narrower `NotifyAccess` is a
 *    regression, not a fix.
 *
 * 2. A child on the notify path is a child an attacker can aim. The binary is
 *    resolved here to an absolute path rather than through `PATH`, because the
 *    server's `PATH` is not a boundary this process controls, and a hijacked
 *    notifier is a process that can send `STOPPING=1`. The child is also handed
 *    the notify socket and nothing else, so it holds no `PAPERCLIP_*` key, no
 *    `LISTEN_*` descriptor and nothing else this process was given.
 *
 * What actually contains a run child is the scrub at the spawn chokepoint
 * (`scrubSystemdIpcEnv` in `packages/adapter-utils/src/server-utils.ts`), not
 * this file. See `tools/service-stop-attribution/README.md` for the measurement
 * behind both halves.
 */

/**
 * Where the notifier lives on a systemd host, in the order systemd's own
 * packaging installs it. Absolute paths only: a `PATH` lookup here would put a
 * writable directory back on the path by which this unit is told to stop.
 */
export const SYSTEMD_NOTIFY_BINARY_CANDIDATES = [
  "/usr/bin/systemd-notify",
  "/bin/systemd-notify",
  "/usr/lib/systemd/systemd-notify",
  "/usr/libexec/systemd-notify",
] as const;

/** The bare name, used only when no fixed candidate exists on this host. */
const SYSTEMD_NOTIFY_BARE_NAME = "systemd-notify";

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    if (!(await fs.stat(candidate)).isFile()) return false;
    await fs.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the notifier to an absolute path.
 *
 * The bare name is the last resort rather than an error: a host that installs
 * the notifier somewhere this list does not name would otherwise lose its
 * `READY=1` datagram and the unit would sit out `TimeoutStartSec`. A host like
 * that is a host where the fixed list did not apply, and it gets the old
 * behaviour with a comment saying so.
 */
export async function resolveSystemdNotifyBinary(
  candidates: readonly string[] = SYSTEMD_NOTIFY_BINARY_CANDIDATES,
): Promise<string> {
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return SYSTEMD_NOTIFY_BARE_NAME;
}

/**
 * The notifier child's entire environment: the one variable it needs to find
 * the socket, and `PATH` only when the binary was resolved by name.
 */
export function buildSystemdNotifyEnv(
  notifySocket: string,
  options: { needsPathLookup: boolean },
): NodeJS.ProcessEnv {
  if (options.needsPathLookup) return { NOTIFY_SOCKET: notifySocket, PATH: process.env.PATH };
  return { NOTIFY_SOCKET: notifySocket };
}

/**
 * Run the notifier and report whether systemd took the datagram.
 *
 * The exit code is not the acceptance signal — `systemd-notify` exits 0 for a
 * datagram a `NotifyAccess=main` unit discards, which is how a bad setting reads
 * as a green probe. The boolean is the best answer this process can get, and it
 * is why the setting is not the setting.
 */
export async function runSystemdNotifyBinary(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    execFile(binary, args, { windowsHide: true, env }, (error) => resolve(!error));
  });
}

export type SystemdNotifierDeps = {
  /** The notify socket address, or undefined when this process has none. */
  notifySocket: () => string | undefined;
  /** The notifier binary, resolved once per process. */
  resolveBinary: () => Promise<string>;
  run: typeof runSystemdNotifyBinary;
};

/**
 * Build a notifier. The default instance reads `process.env` and spawns the
 * real binary; the seams exist so the wiring can be asserted without spawning
 * anything, which is the only way to test the shape of a call that must not
 * happen on a live unit.
 */
export function createSystemdNotifier(overrides: Partial<SystemdNotifierDeps> = {}) {
  let resolvedBinary: Promise<string> | null = null;
  const resolveBinary =
    overrides.resolveBinary ??
    (() => (resolvedBinary ??= resolveSystemdNotifyBinary()));

  return async function notify(args: string[]): Promise<boolean> {
    const notifySocket = (overrides.notifySocket ?? (() => process.env.NOTIFY_SOCKET))()?.trim();
    if (!notifySocket) return false;
    const binary = await resolveBinary();
    const run = overrides.run ?? runSystemdNotifyBinary;
    return await run(
      binary,
      args,
      buildSystemdNotifyEnv(notifySocket, { needsPathLookup: binary === SYSTEMD_NOTIFY_BARE_NAME }),
    );
  };
}

export const systemdNotify = createSystemdNotifier();
