/**
 * The notify deadline on a process with nothing else left to run.
 *
 * An unreferenced timer is skipped whenever the event loop would otherwise be
 * empty, and that is the state a stopping process is in once its last handle
 * is gone — the HTTP listener closed, the database pool ended, the teardown
 * left. A `unref`'d deadline therefore stops being a deadline at exactly the
 * moment it starts to matter, which is the failure this fixture exists to make
 * observable.
 *
 * It cannot be observed in-process. Vitest keeps the event loop alive with its
 * own handles, so an in-suite `unref`'d timer still fires and the test passes
 * anyway — a false pass of the same shape as a "slow dependency" test. So this
 * runs as its own process with *no* other pending work, where an unref'd
 * deadline is genuinely skipped.
 *
 * What an unref'd deadline looks like from out here is the trap worth naming.
 * This file's own `await` is a top-level await, so node reports it: the process
 * exits **13** with `Detected unsettled top-level await`, and the resolution
 * line is never printed. In the real `shutdown()` the same await sits inside a
 * `void`-ed function with no top-level await to complain about, and there the
 * same unref'd timer produces the far worse version — exit **0**, silently, with
 * the notify unresolved. So the assertion here cannot be "the process exited
 * cleanly"; it is that the resolved value was *printed*, which only happens if
 * the deadline actually fired.
 *
 * `resolveBinary` is the seam, not `run`, and the distinction is the point.
 * `execFile`'s own `timeout` bounds the child, but only once `run()` has been
 * reached; `resolveBinary` is an `fs.access` chain over `PATH` above it, and a
 * stalled mount makes the kernel hold that await. On a process with an empty
 * loop it is the only thing left, and it has no second bound.
 *
 * Usage: node --import tsx notify-empty-loop.mjs [timeoutMs]
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { createSystemdNotifier } = await import(
  pathToFileURL(path.join(here, "../../services/systemd-notify.ts")).href
);

const timeoutMs = Number(process.argv[2] ?? "300");

const notify = createSystemdNotifier({
  notifySocket: () => "/run/user/1000/systemd/notify",
  // The stall: a `PATH` lookup that never comes back.
  resolveBinary: () => new Promise(() => undefined),
  timeoutMs,
});

const result = await notify(["--stopping", "--status=Stopping after SIGTERM"]);

// Printed only on the resolving path. An unref'd deadline takes the process out
// at 0 with this line absent, which is what the caller sees as a silent hang.
console.log(JSON.stringify({ notifyResolved: true, result, timeoutMs }));
