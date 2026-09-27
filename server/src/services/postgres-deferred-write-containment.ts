/**
 * Containment for the one uncaught exception that `postgres@3.4.9` throws from
 * a bare timer callback, which kills the process with
 * `code=exited, status=1/FAILURE` one second into a systemd stop.
 *
 * ## The bug this contains
 *
 * The driver buffers a query frame and, when no callback is attached and the
 * frame is under 1024 bytes, defers the socket write to a `setImmediate`
 * (`connection.js` `write` -> `nextWrite`). `nextWrite` reads the closure
 * variable `socket` with no null check:
 *
 * ```js
 * function nextWrite(fn) {
 *   const x = socket.write(chunk, fn)   // `socket` may already be null
 * ```
 *
 * A connection close sets `socket = null` and, separately, raises
 * `CONNECTION_CLOSED` for whatever was in flight. Because the throw lands in a
 * `setImmediate` callback it is outside every promise chain in the program, so
 * a `.catch()` at the call site cannot reach it -- by the time the flush runs,
 * the call site's `CONNECTION_CLOSED` rejection has already been handled and
 * logged. Node treats the `TypeError` as an uncaught exception and exits `1`.
 *
 * ## Why this cannot be fixed at the call site
 *
 * Adding error handling around the call that triggers the write does not help,
 * and reporting it as fixed is worse than leaving it: the rejection the call
 * site sees is a *different* error, raised earlier, from a different place. The
 * failure is deferred to a macrotask that no promise chain covers. The same
 * window is reachable from any connection teardown -- a server-side close, an
 * idle-timeout close, `pool.end()` -- not only from shutdown. Shutdown is just
 * when the window is widest, because connections are closing en masse.
 *
 * ## Why containment, and only during shutdown
 *
 * Two things make a targeted `uncaughtException` handler the honest fix here
 * rather than a patch to the driver.
 *
 * First, the driver fix already exists in this repository and cannot reach
 * production. `patches/postgres@3.4.9.patch` is registered in
 * `package.json#pnpm.patchedDependencies` and `pnpm-workspace.yaml`, and it
 * hardens `closed()` and `terminate()`. But the published `paperclipai` package
 * declares `postgres` as a plain npm dependency and keeps it external to the
 * CLI bundle, so the registry serves an unpatched `postgres@3.4.9`. A pnpm
 * patch is applied by pnpm from a workspace's own `node_modules`; it is not
 * carried inside another package's tarball. Verified against the deployed
 * instance: `paperclipai/node_modules/postgres/src/connection.js` is
 * line-for-line upstream.
 *
 * Second, this handler is gated on shutdown state. Outside a drain the handler
 * re-creates Node's default fatal behaviour, so registering it changes nothing
 * about how a real bug is reported. Inside a drain, continuing is safe for this
 * one signature specifically: the exception is a dropped frame for a connection
 * that is already closed, whose in-flight queries were already rejected through
 * the normal `CONNECTION_CLOSED` path. There is no half-written state to
 * recover. The alternative is the outcome we are avoiding -- a non-zero exit
 * mid-teardown that the supervisor records as a crash.
 *
 * The handler matches on a stack frame inside the driver's `nextWrite`, not on
 * the message alone, so a Paperclip bug that happens to read `.write` of `null`
 * somewhere else still fails the process.
 */

/**
 * V8 changed the wording of the null-property read between Node releases.
 * Both forms appear in the wild, so accept either and keep them pinned by
 * `server/src/__tests__/postgres-deferred-write-containment.test.ts`.
 */
const NULL_PROPERTY_READ_PATTERNS = [
  /Cannot read properties? of null \(reading 'write'\)/,
  /Cannot read property 'write' of null/,
];

/**
 * A frame from the driver's deferred flush. V8 renders that frame as
 * `at Immediate.nextWrite [as _onImmediate] (<...>/postgres/cjs/src/connection.js:255:23)`,
 * so the function name precedes the path. Requiring the driver's file *and*
 * the function name on the same line keeps this from catching an unrelated
 * null-socket read that happens to reuse the same message.
 */
const DRIVER_CONNECTION_FILE = /[/\\]postgres[/\\](?:cjs[/\\])?src[/\\]connection\.js:\d+:\d+/;

export function isPostgresNulledSocketDeferredWrite(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;

  const message = typeof err.message === "string" ? err.message : "";
  if (!NULL_PROPERTY_READ_PATTERNS.some((pattern) => pattern.test(message))) return false;

  const stack = typeof err.stack === "string" ? err.stack : "";
  return stack
    .split("\n")
    .some((line) => DRIVER_CONNECTION_FILE.test(line) && /\bnextWrite\b/.test(line));
}

export type NulledSocketWriteContainmentLog = {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export type NulledSocketWriteContainment = {
  /**
   * How many times this handler has contained the signature. Exposed for the
   * regression test and for the shutdown log line that reports it.
   */
  contained(): number;
  /** Remove the process listener. Returns whether a listener was removed. */
  uninstall(): boolean;
};

/**
 * Arm the containment. `isShuttingDown` is read on every uncaught exception, so
 * the handler follows shutdown state instead of latching at install time.
 *
 * `exitOnUncaught` is injectable only so the regression test can observe the
 * fatal path without ending the test runner's process.
 */
export function installNulledSocketWriteContainment(input: {
  isShuttingDown: () => boolean;
  log: NulledSocketWriteContainmentLog;
  exitOnUncaught?: (code: number) => void;
}): NulledSocketWriteContainment {
  const exitOnUncaught = input.exitOnUncaught ?? ((code: number) => process.exit(code));
  let contained = 0;

  const onUncaughtException = (err: unknown) => {
    if (input.isShuttingDown() && isPostgresNulledSocketDeferredWrite(err)) {
      contained += 1;
      input.log.warn(
        { err, contained },
        "contained a postgres deferred write to a closed socket during shutdown; " +
          "the connection is already closed and its in-flight queries already rejected",
      );
      return;
    }

    // Outside a drain, and for every other error, reproduce Node's default
    // behaviour: a registered listener suppresses the built-in fatal path, so
    // this handler owns it. Log first so the cause survives the exit.
    input.log.error({ err }, "uncaught exception is outside the shutdown containment window");
    exitOnUncaught(1);
  };

  process.on("uncaughtException", onUncaughtException);

  let removed = false;
  return {
    contained: () => contained,
    uninstall: () => {
      if (removed) return false;
      removed = true;
      process.removeListener("uncaughtException", onUncaughtException);
      return true;
    },
  };
}
