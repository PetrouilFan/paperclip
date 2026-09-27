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
 * The ceiling on one notify, and why the ceiling is the whole point of the
 * `timeout` option below.
 *
 * `systemd-notify` is a single `sendmsg` to a unix datagram socket; it was
 * measured at 4 ms on this host. Anything that has not answered in
 * `SYSTEMD_NOTIFY_TIMEOUT_MS` is not slow, it is wedged — a hung child, a
 * `PATH` lookup on a stalled mount, a fork that cannot be reaped. A notify is
 * also the *first* thing `shutdown()` awaits, before the scheduler latch and
 * before every drain, so an unbounded wait here is an unbounded wait on the
 * whole shutdown: the unit is already stopping, `TimeoutStopSec` is already
 * counting, and the process sits there until systemd SIGKILLs the cgroup. That
 * is the production signature of the 2026-09-27 control-plane stops,
 * reproduced on a throwaway unit with no external actor and automated in
 * `server/src/__tests__/notify-stop-hang-probe.test.ts`.
 *
 * So the wait is bounded twice over: `execFile`'s own `timeout` (which signals
 * the child, unlike a bare race that leaks it) and the `Promise.race` in
 * `notify()` (which also covers binary resolution and a child that ignores
 * `SIGTERM`). A dropped datagram costs a stale `STOPPING=1`/`READY=1`; a
 * dropped `process.exit(0)` costs the unit a `TimeoutStopSec` of darkness and
 * every in-flight run in the cgroup. The trade is not close.
 */
export const SYSTEMD_NOTIFY_TIMEOUT_MS = 2_000;

/**
 * Run the notifier and report whether systemd took the datagram.
 *
 * The exit code is not the acceptance signal — `systemd-notify` exits 0 for a
 * datagram a `NotifyAccess=main` unit discards, which is how a bad setting reads
 * as a green probe. The boolean is the best answer this process can get, and it
 * is why the setting is not the setting.
 *
 * A timeout resolves `false` on the callback, exactly as a spawn failure does.
 * The caller cannot tell "systemd refused it" from "the notifier never
 * answered", and does not need to: both mean the unit did not take the
 * datagram, and neither is a reason to keep the shutdown waiting.
 */
export async function runSystemdNotifyBinary(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = SYSTEMD_NOTIFY_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    execFile(binary, args, { windowsHide: true, env, timeout: timeoutMs }, (error) => resolve(!error));
  });
}

export type SystemdNotifierDeps = {
  /** The notify socket address, or undefined when this process has none. */
  notifySocket: () => string | undefined;
  /** The notifier binary, resolved once per process. */
  resolveBinary: () => Promise<string>;
  run: typeof runSystemdNotifyBinary;
  /**
   * The ceiling on the whole notify, binary resolution included. Defaults to
   * `SYSTEMD_NOTIFY_TIMEOUT_MS`.
   */
  timeoutMs?: number;
};

/**
 * Race `work` against a deadline, and make the deadline stick.
 *
 * The timer is deliberately not `unref`'d, for the same reason the three
 * deadlines in `server/src/shutdown.ts` are not: an unreferenced timer is
 * skipped entirely whenever the event loop would otherwise be empty, which is
 * exactly the state a process is in once its last handle is gone. A deadline
 * that can be skipped is not a deadline.
 *
 * That is not a theoretical concern here, and it is the reason this deadline
 * exists at all. `execFile`'s own `timeout` only bounds the *child*, and only
 * once `run()` has been reached. The `resolveBinary()` await above it is an
 * `fs.access` chain over `PATH` — the one wedging mechanism this module's own
 * docs name — and on a process that has already closed its listener it is the
 * only thing left. `unref`'d, that promise never settles and the loop empties.
 * In `shutdown()`'s real shape — an `await` inside a `void`-ed function — node
 * exits **0** with the notify unresolved: a clean exit code and a unit that
 * looks like it stopped, while `TimeoutStopSec` is still counting.
 *
 * The cost of holding the reference is at most `timeoutMs` of process lifetime
 * on a path that is already failing. That is not a close trade against an
 * unbounded wait.
 */
const withNotifyTimeout = async <T>(timeoutMs: number, onTimeout: () => T, work: Promise<T>) => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const timeoutMs = overrides.timeoutMs ?? SYSTEMD_NOTIFY_TIMEOUT_MS;

  return async function notify(args: string[]): Promise<boolean> {
    return await withNotifyTimeout(timeoutMs, () => false, (async () => {
      const notifySocket = (overrides.notifySocket ?? (() => process.env.NOTIFY_SOCKET))()?.trim();
      if (!notifySocket) return false;
      const binary = await resolveBinary();
      const run = overrides.run ?? runSystemdNotifyBinary;
      return await run(
        binary,
        args,
        buildSystemdNotifyEnv(notifySocket, { needsPathLookup: binary === SYSTEMD_NOTIFY_BARE_NAME }),
        timeoutMs,
      );
    })());
  };
}

export const systemdNotify = createSystemdNotifier();
