# service-stop-attribution

A durable per-stop ledger for a systemd **user** unit, and a sender-side trace of
`systemd-notify` so a stop that the journal cannot explain can still be
attributed.

Built for a host investigation into the control-plane stops of 2026-09-27, on
which two of five stops of the live unit had no attributable cause.

## The problem

On a `Type=notify` unit, a stop has at least two causes that look identical from
outside: an operator asked the manager to stop the unit, or a process inside the
unit sent `STOPPING=1`. The journal records the _consequence_ of both
(`Result=timeout`, a `stop-sigterm` timeout, a SIGKILL sweep) and records the
_request_ only in the first case, as a `Stopping <description>...` job line.

Measured signatures on systemd 261, throwaway `systemd-run --user` units with
`Type=notify`, `NotifyAccess=all`, `TimeoutStopSec=3`:

| trigger                                               | `JOB_TYPE=stop` | `Stopping …` line | `Service must stop after STOPPING=1` | `Result`  |
| ----------------------------------------------------- | --------------- | ----------------- | ------------------------------------ | --------- |
| `systemctl --user stop`                               | yes             | yes               | no                                   | `success` |
| a process sends `STOPPING=1`                          | no              | **no**            | only if a later `READY=1` is refused | `timeout` |
| main process killed by a signal, then a stop job runs | no              | no                | no                                   | `signal`  |

The third column of the middle row is the trap. systemd logs
`Service must stop after STOPPING=1 notification, refusing attempted transition
to READY=1.` **only** when a `STOPPING=1` is followed by a `READY=1` attempt. A
`STOPPING=1` that is never contradicted logs nothing at all, so the absence of
that line is not evidence that no `STOPPING=1` arrived. This tool calls that
state `silent` and reports it as its own class rather than guessing.

## What it produces

`report` prints one line per stop in the journal window:

```
when                     trigger  result   victims  refusals  sender                note
-----------------------  -------  -------  -------  --------  --------------------  ----
2026-09-27 01:07:04.290  silent   signal   9        0         -
2026-09-27 09:33:38.573  notify   timeout  100      2         -
2026-09-27 10:07:44.482  notify   timeout  57       3         -
2026-09-27 11:06:13.521  silent   timeout  79       0         -
2026-09-27 11:54:19.404  job      -        0        0         -       the unit started again before a terminal line
2026-09-27 12:14:57.561  notify   timeout  47       6         -

6 stop(s); 1 job, 3 notify-confirmed, 2 silent (no stop job, no STOPPING=1 evidence).
```

Three classes, and no fourth: `job`, `notify` (confirmed by a refusal line), and
`silent`. `victims` is the SIGKILL sweep size, which is the blast radius.

`record` appends anything new to an append-only JSONL ledger, keyed on
`unit:invocationId` so re-reading an overlapping journal window never duplicates
a record. `watch` is `record` on a timer, for a unit service.

## The requesting PID: a measured negative

The investigation that asked for this tool wanted stop events "recorded with the
requesting PID". On a systemd user bus that PID is not observable from outside.
Three independent measurements, all on throwaway units:

1. **The journal at info level.** A `Stopping …` job line names the unit, not
   the requester.
2. **The journal with the user manager at debug.** `LogLevel` is a writable
   property on `org.freedesktop.systemd1.Manager`, so it can be raised at runtime
   with `busctl --user set-property … LogLevel s debug` and lowered again, with
   no restart. The manager then logs
   `Got message type=method_call … member=StopUnit` and prints **`sender=n/a`**.
   The calling connection is not recorded. (There is no `SetLogLevel` _method_ on
   this interface in systemd 261; the property is the only handle.)
3. **Bus monitoring**, new-style and with `eavesdrop=true`. Only signals are
   delivered on the systemd user bus — `JobNew`, `JobRemoved`, `UnitNew`,
   `PropertiesChanged`. No method call is ever visible, so there is no sender to
   resolve even in principle.

So a `job` stop is attributable to "an explicit request reached the user
manager" and to nothing finer, and a `notify` stop is attributable only from the
sender's own side. That is the whole reason this tool pairs a ledger with a
sender-side trace instead of trying to reconstruct the requester.

## The sender-side trace

`install` writes a launcher named `systemd-notify` into a directory of your
choosing. Put that directory first on the `PATH` of anything that might send a
notification and every invocation is recorded before it is forwarded to the real
binary unchanged:

```console
$ node bin/service-stop-attribution.mjs install --shim-dir /path/to/bin
shim installed: /path/to/bin/systemd-notify
real binary:   /usr/bin/systemd-notify
trace file:    …/notify-senders.jsonl
self-check:    ok (resolves to the real binary)
```

One JSON line per invocation:

```json
{
  "traceVersion": 1,
  "atMs": 1790502008590,
  "pid": 117278,
  "ppid": 117043,
  "argv": ["--stopping"],
  "cwd": "/home/petrouil",
  "fields": { "STOPPING": "1" },
  "notifySocket": "/run/user/1000/systemd/notify",
  "run": {
    "runId": "run-shim-demo",
    "agentId": "talos",
    "taskId": "TASK-0000"
  },
  "cgroup": "0::/user.slice/…/notify-shim-demo.service",
  "sendsStopping": true
}
```

The run identity comes from the `PAPERCLIP_*` variables the harness already puts
in a run's environment, so nothing new had to be plumbed to get it. A PATH shim
rather than a patch of the two in-repo `systemdNotify` call sites, because the
sender of the 10:02 outage was an agent's shell running `systemd-notify` as a
command — a shim sees every sender, including the ones code review would not.

**A `silent` stop with a traced `STOPPING=1` in its window is a positively
attributed notify stop.** That is the combination this exists to produce, and it
is exactly what the 11:06 stop of 2026-09-27 lacks today.

### Notes on the shim

- The launcher `export`s its two variables. Without `export` they are shell
  variables, the exec'd Node process does not see them, and the shim refuses to
  run — which fails the unit's `READY=1` rather than the send. `install` runs a
  self-check (`systemd-notify --print-real` with the shim first on `PATH`) and
  refuses to report success unless it resolves to the real binary.
- The shim exits 127 if `PAPERCLIP_NOTIFY_REAL_BINARY` is unset. Swallowing a
  notification would be a worse failure than a loud one.
- Its exit status is the real binary's.
- A failed trace write is reported on stderr and does not stop the send. The
  trace is diagnostic; it must not become an outage of its own.

### When the shim is needed

The shim is still needed. One half of the run-IPC fix is deployed and the other
half is not.

What is on the default branch: a run child inherits no `NOTIFY_SOCKET` and no
`LISTEN_*` value. That is the environment half, and it is what stops a run from
holding the address by inheritance.

What is not on the default branch: the unit is still `NotifyAccess=all`.
`cli/src/services/service-manager.ts` renders that value into the unit, and
`cli/src/__tests__/service-manager.test.ts` asserts it. So the unit still accepts
a notification datagram from any process in the cgroup, and the shim still has
something to detect.

The two halves are separate changes, and the unit-side one has a precondition
that is not met yet. The server sends its readiness datagram by running the
`systemd-notify` binary as a child process: `server/src/index.ts` calls
`systemdNotify(["--ready", ...])`, and `server/src/services/systemd-notify.ts`
implements that with `execFile`. `NotifyAccess=main` accepts a datagram only from
the unit's main process, so a child would be refused. The unit is
`Type=notify`, so a refused `READY=1` means the unit never reaches `active` and
sits out `TimeoutStartSec=600` before it is killed and restarted.

Narrowing `NotifyAccess` therefore needs the notifier to send from the main
process first. Until that happens, `NotifyAccess=all` is load-bearing and must
not be changed on its own.

### The notifier cannot be the main process, in node

The precondition above is not merely unmet, it is unreachable from a node
server. Writing the datagram in-process needs an `AF_UNIX` `SOCK_DGRAM` send,
and node has none. Measured on this host, node v26.9.0:

| attempt                                                       | result                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `dgram.createSocket({ type: "unix_dgram" })`                   | throws `ERR_SOCKET_BAD_TYPE`, "Valid types are: udp4, udp6"        |
| `net.createConnection({ path, type: "unix_dgram" })`           | connects to a `SOCK_STREAM` listener; `EPROTOTYPE` at a datagram one |

The second row is the one to be careful with. The `type` option is accepted, no
warning is printed, and a socket is created — it is simply not a datagram
socket. `server/src/services/systemd-notify.test.ts` pins both rows, so the next
reader does not have to rediscover this from a `node -e` session.

There is exactly one shape that would make `NotifyAccess=main` correct:

```ini
ExecStart=/usr/bin/systemd-notify --ready --exec <server argv…>
```

`--exec` sends the datagram and then becomes the server in the same pid, so the
sender is the pid systemd records as `MainPID`. It costs the meaning of
`READY=1`: the datagram would go out before the server process exists, while
`READY=1` today means the server is listening and migrations have run — and the
embedded postmaster lives in the same cgroup, so "ready" currently means the
database is up too (`doc/DEVELOPING.md`). That is a worse unit than a wider
`NotifyAccess`, and it is a deployment change besides.

What contains a run child is therefore the environment half, not the unit half:
`scrubSystemdIpcEnv` at the spawn chokepoint in
`packages/adapter-utils/src/server-utils.ts` strips `NOTIFY_SOCKET` and the
`LISTEN_*` triple from the merged child environment, so no run process holds the
address to send from. Keep the shim, keep `NotifyAccess=all`, and spend the
remaining effort on the scrub.

One child on the notify path is left, and it is now pinned down: the server
still spawns the notifier, so `server/src/services/systemd-notify.ts` resolves it
to an absolute path instead of through `PATH` and hands it `NOTIFY_SOCKET` and
nothing else. The server's `PATH` is not a boundary the server controls, and a
hijacked notifier is a process that can send `STOPPING=1`.

## Safety

Nothing in this tool sends a notification, stops a unit, or writes to the unit.
It reads the journal, appends to two files, and forwards.

Every process it spawns has `NOTIFY_SOCKET` and the `LISTEN_*` triple removed
before it runs (`lib/journal.mjs` → `probeEnv`). That is not hygiene for its own
sake: the control plane on this host is a `Type=notify` unit with
`NotifyAccess=all`, so a probe process that inherits `NOTIFY_SOCKET` and runs
`systemd-notify --stopping` takes down the control plane and every in-flight run.
The 10:02 outage on 2026-09-27 was caused by exactly that, in a diagnostic
harness. When running the tool by hand, scrub your own shell too:

```console
$ env -u NOTIFY_SOCKET node bin/service-stop-attribution.mjs report
```

## Commands

| command     | effect                                             |
| ----------- | -------------------------------------------------- |
| `report`    | print one line per stop in the journal window      |
| `record`    | append new stops to the ledger                     |
| `watch`     | `record` on a timer                                |
| `install`   | write the shim, self-check it, print the PATH line |
| `uninstall` | remove the shim directory                          |

Options: `--unit` (default `paperclipai.service`), `--since` (default `1 day
ago`), `--ledger`, `--trace`, `--shim-dir`, `--json`.

## Journal matching, and why it looks wrong

Records are read with `journalctl --user USER_UNIT=<unit> _COMM=systemd`. For a
user unit the manager stamps its own records with `_SYSTEMD_UNIT=user@<uid>.service`
and puts the real unit in `USER_UNIT`, so matching on `_SYSTEMD_UNIT=<unit>`
silently returns nothing — which reads as "no stops today" rather than as an
error.

## Tests

```console
$ node --test tools/service-stop-attribution/test/classify.test.mjs
```

Fixtures are the real shapes of the 2026-09-27 events: the 11:54 explicit stop,
the 09:33 notify stop, the 11:06 stop with neither signature, the 01:07
signal-driven one, and the 12:00 start that separates them.
