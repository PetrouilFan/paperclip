---
title: Shadowed Service Units
summary: Reading what the systemd unit actually runs, so a patched install cannot be mistaken for a shadowed one
---

Operational runbook for a control plane whose **service unit** no longer describes
the process it is running: a different `ExecStart` than the operator believes, an
`Environment=` block that no longer agrees with the instance configuration, or a
restart that skipped the preflight run-set recording entirely. Written after
measuring all three on the `default` dev plane on 2026-09-26, where the unit file,
the loaded unit, the installed `dist` and the running process had drifted apart
while every version string stayed intact.

One of three ways a plane stops matching its source. The other two are documented:

- [shadowed-server-install.md](./shadowed-server-install.md) — the `node_modules`
  / `dist` contents were edited in place. This document is the *unit file* side of
  that family: which binary, which environment, which database.
- [dev-plane-restart-hygiene.md](./dev-plane-restart-hygiene.md) — restart bursts
  and lost in-flight runs.

The distinction matters because they are diagnosed differently. A shadowed `dist` is
caught by diffing installed files against a published tarball. A shadowed **unit**
passes that diff perfectly — the files are fine — while the service runs something
else entirely.

A third thing in this document can be shadowed the same way, and it is the one
that repairs the other two: the installed **guardian** the 60s timer runs
(`~/.local/bin/paperclip-unit-guardian.sh`). It was a 4-line `exit 0` on
2026-09-27, under a timer that was `active` at a correct cadence, with 1418 clean
runs logged. See Check 4.

## Why the existing check cannot see this

`paperclipai doctor` has a `Service definition` check, and it is the right check
for the job it does. It compares one thing to one thing:

```
fs.readFile(manager.definitionPath) === await manager.desiredDefinition()
```

That is a **byte-exact comparison of a single file** against what the renderer
would write today. It is a good gate against the failure it was written for — a
re-render that dropped operator `Environment=` lines or pointed `ExecStart` at a
missing binary. It is not a statement about what is running, and four things sit
outside it:

1. **Drop-ins.** A drop-in in `paperclipai.service.d/` is applied *on top of* the
   main file and wins on every key it sets. The comparison never reads the drop-in
   directory, so `ExecStart`, `Environment`, `StartLimit*`, `TimeoutStartSec` and
   `KillMode` can all be set somewhere the check does not look.
2. **`daemon-reload` staleness.** The check reads the file. systemd executes what
   it *loaded*. Edit the file, skip the reload, and the check describes a unit that
   is not the one running. (`NeedDaemonReload=yes` is the property that reports
   this; the check never asks for it.)
3. **Symlink resolution.** The check verifies the `ExecStart` target is an existing
   executable file. A symlink satisfies that. Re-pointing the symlink changes what
   runs and changes nothing in the unit.
4. **The running process.** Nothing compares `ExecStart` against the argv of the
   live `MainPID`, so a unit that has been correct on paper for weeks while a
   different binary answered is not detectable from the unit at all.

A green `Service definition` therefore means *the file on disk is what the renderer
would write*. It does not mean the service is running that file. On the plane
measured below, doctor reported drift while the plane was healthy — and the
remedy it offers writes the main file only, while a drop-in is what actually sets
`ExecStart` there. See *The repair hint is not always a repair*.

## The four-way agreement

There are four views of one unit. A unit is trustworthy when all four agree, and
**shadowed the moment any pair disagrees**:

| | view | read with |
|---|---|---|
| (a) | what the renderer wants | `paperclipai doctor` → `Service definition` |
| (b) | what the unit file says | `grep` on `~/.config/systemd/user/<unit>` |
| (c) | what systemd has loaded, drop-ins merged | `systemctl --user show` |
| (d) | what is actually running | `ps` / `/proc/<MainPID>` |

Start from (c) and (d). An operator reading (b) is reading a file that may not be
the one in force, which is the whole failure mode.

Save the block below as `unit-snapshot.sh` and run it with no arguments for the
`default` instance. Every later snippet in this document assumes the same two
variables it sets:

```sh
unit=paperclipai.service        # paperclipai-<id>.service for a non-default instance
inst=default                    # the instance id, which is not always the unit name
```

```bash
#!/usr/bin/env bash
# The four views of one unit. Any disagreement is a shadow.
#   usage: unit-snapshot.sh [unit] [instance-id]
set -uo pipefail
unit="${1:-paperclipai.service}"
inst="${2:-default}"

echo "=== (b) what the unit FILE says ==="
grep -nE '^(ExecStart|Environment|WorkingDirectory)=' \
  "$HOME/.config/systemd/user/$unit" 2>&1

echo
echo "=== (c) what systemd has LOADED (drop-ins merged) ==="
systemctl --user show "$unit" \
  -p ExecStart -p Environment -p WorkingDirectory \
  -p FragmentPath -p DropInPaths -p NeedDaemonReload

echo
echo "=== (d) what is actually RUNNING ==="
pid="$(systemctl --user show "$unit" -p MainPID --value 2>/dev/null || true)"
case "${pid:-0}" in
  ''|0|*[!0-9]*) echo "no MainPID: the unit is not running" ;;
  *)
    ps -o pid,lstart,args -p "$pid"
    printf 'argv:    '; tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null; echo
    # For a Node service this is the *interpreter*, not the script. Do not read
    # it as the target and conclude the unit points at /usr/bin/node.
    printf 'exe:     '; readlink -f "/proc/$pid/exe" 2>/dev/null
    printf 'cwd:     '; readlink -f "/proc/$pid/cwd" 2>/dev/null
    ;;
esac

echo
echo "=== (a) what the renderer wants ==="
# The 'Service definition' line of doctor is the (a)-vs-(b) comparison.
paperclipai doctor 2>&1 | grep -A2 'Service definition' || echo "doctor unavailable"

echo
echo "=== preflight evidence for this instance ==="
root="$HOME/.paperclip/instances/$inst"
if [ -f "$root/hot-restart-intent.json" ]; then
  printf 'intent: '
  python3 - "$root/hot-restart-intent.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"requestedAt={d.get('requestedAt')} drainRequired={d.get('drainRequired')} "
      f"preflightRuns={len(d.get('preflightActiveRunIds') or [])}")
PY
else
  echo "intent:  ABSENT — the last restart recorded no preflight run set"
fi
if [ -f "$root/hot-restart-report.json" ]; then
  printf 'report: '
  python3 - "$root/hot-restart-report.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"requestedAt={d.get('requestedAt')} drainRequired={d.get('drainRequired')} "
      f"adopted={len(d.get('adoptedRunIds') or [])} "
      f"finalizedWhileDown={len(d.get('finalizedWhileDownRunIds') or [])} "
      f"lost={len(d.get('lostRunIds') or [])}")
PY
else
  echo "report:  ABSENT"
fi
printf 'process started: %s   (compare against requestedAt above)\n' \
  "$(systemctl --user show "$unit" -p ExecMainStartTimestamp --value)"
```

## Check 1 — the `ExecStart` that actually wins

The loaded value is the only one that runs. Two things routinely make it differ
from the file:

**A drop-in resets it.** A bare `ExecStart=` in a drop-in clears the list, and the
next `ExecStart=` in that drop-in becomes the command. This is the sanctioned way
to re-point a unit without editing the generated file, and it is invisible to
`grep` on the main unit and to doctor's byte comparison.

```bash
unit=paperclipai.service
# Who sets ExecStart, and in what order systemd applies it:
systemctl --user cat "$unit" | grep -n '^ExecStart='
# Which files contribute, in precedence order:
systemctl --user show "$unit" -p DropInPaths --value | tr ' ' '\n'
```

If the last `ExecStart=` in that listing is not the one in the main file, the main
file is decoration. A drop-in that re-specifies `ExecStart` also has to carry the
whole argument list itself; if it drifts from the renderer's
`run --instance "<id>"`, the unit is now running a *different instance id* under
the *default* unit's name, which is the failure that leaves a second plane's runs
filed against the wrong unit.

**The target is a symlink.** `ExecStart` names a path; the kernel runs what it
resolves to.

```bash
target="$(systemctl --user show "$unit" -p ExecStart --value \
  | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
printf 'ExecStart names : %s\n' "$target"
printf 'actually runs   : %s\n' "$(readlink -f "$target")"
```

If those two lines differ in any more than a version-stamp directory, the unit is
pointing at a link whose target can be swapped by a package install without the
unit changing. This is the unit-side twin of a shadowed `dist`: a `npm i -g`
replaces the link, the unit file is untouched, doctor's comparison is unaffected,
and the process is a different build.

That is when to switch to [shadowed-server-install.md](./shadowed-server-install.md)
— the resolved path is where the contents check applies.

## Check 2 — the `Environment=` block in force

The renderer owns exactly three keys: `PAPERCLIP_SERVICE_MANAGED`,
`PAPERCLIP_INSTANCE_ID`, `PAPERCLIP_HOME`. Every other `Environment=` line is
operator configuration that a rewrite must carry forward, and the current renderer
does carry it. The ways it still goes wrong:

```bash
# The merged, effective set — not what any one file says. A quoted value may
# itself contain spaces (PAPERCLIP_OPENCODE_PROVIDERS is JSON), so read the key
# names rather than splitting the value on whitespace.
systemctl --user show "$unit" -p Environment --value \
  | sed 's/^/ /' \
  | grep -oE '["[:space:]][A-Za-z_][A-Za-z0-9_]*=' | tr -d '" =' | sort -u
```

- **A bare `Environment=` reset.** `Environment=` with no assignment is a reset
  directive: it clears everything assembled so far. Carried *after* the renderer's
  own keys it also clears `PAPERCLIP_SERVICE_MANAGED`, and the process stops being
  a managed service. Carried before them it silently cancels the operator's own
  resets. Find them across the unit and its drop-ins with:

  ```bash
  grep -rnE '^Environment=[[:space:]]*$' \
    "$HOME/.config/systemd/user/$unit" "$HOME/.config/systemd/user/$unit.d/"
  ```
- **A port that disagrees with the config.** The server reads `PORT` from its own
  environment. `config.json` and every CLI probe read the configured port. When a
  drop-in pins `PORT` to something else, the control plane is healthy on the pinned
  port while every shell-side probe against the configured port fails. On the plane
  measured below this presented as `Service health: fetch failed` from `doctor`
  against a server answering `/api/health` with `status: ok`. The instinct is to
  restart a healthy plane; the actual fault is two files naming different ports.

  ```bash
  # What the unit will use, versus what the config says:
  systemctl --user show "$unit" -p Environment --value \
    | tr ' ' '\n' | grep -E '^PORT=' || echo "PORT not pinned in the unit"
  python3 -c 'import json,sys;print("config server.port =",json.load(open(sys.argv[1]))["server"]["port"])' \
    "$HOME/.paperclip/instances/$inst/config.json"
  ```

- **`KillMode`.** The renderer emits `KillMode=process` so a stop signals the server
  and not the embedded PostgreSQL and detached local-agent runs sharing the cgroup.
  With systemd's default `control-group`, a stop or a `TimeoutStartSec` overrun
  takes all of them at once, which is the opposite of the ordering the server's
  shutdown assumes. It is a one-key difference with the widest blast radius in the
  unit, and on the plane measured below it was set nowhere:

  ```bash
  # The effective value, which is the one that matters:
  systemctl --user show "$unit" -p KillMode --value
  # Where it is set, if anywhere. Absence means systemd's default is in force.
  systemctl --user cat "$unit" | grep -n '^KillMode=' \
    || echo "KillMode unset anywhere: control-group is in effect"
  ```

## Check 3 — did the preflight run set actually get recorded

`paperclipai service restart` is a hot restart, not a stop and a start. Before it
touches systemd it snapshots the set of running heartbeat run ids into
`$PAPERCLIP_HOME/instances/<id>/hot-restart-intent.json` as
`preflightActiveRunIds`; the replacement server diffs that against its shutdown
snapshot and writes `hot-restart-report.json` with `adoptedRunIds`,
`finalizedWhileDownRunIds` and `lostRunIds`. If the preflight set was never
recorded, a missing snapshot cannot look like a zero-loss restart — but only for a
restart that *did* record one. **A restart performed any other way produces no
report at all, and no report is not a clean report.**

```bash
inst=default
root="$HOME/.paperclip/instances/$inst"
systemctl --user show paperclipai.service -p ExecMainStartTimestamp --value
ls -l "$root"/hot-restart-intent.json "$root"/hot-restart-report.json 2>&1
```

Read the two together:

- **The unit is newer than the newest report.** `ExecMainStartTimestamp` after the
  `requestedAt` in `hot-restart-report.json` means the unit has started at least
  once with no preflight recorded. On the plane measured below the report was ~41
  hours older than the running process and `NRestarts=2`. Every restart in that
  window reported the runs it lost as `process_lost`, which reads exactly like
  restart-burst damage and sends triage to
  [dev-plane-restart-hygiene.md](./dev-plane-restart-hygiene.md) — the wrong
  document.
- **The report is vacuous.** `adoptedRunIds: []`, `finalizedWhileDownRunIds: []`,
  `lostRunIds: []`, `runs: []` with `drainRequired: false` is not evidence of
  continuity; it is evidence that nothing was in flight, or that the preflight
  read the wrong database. A guard the report cannot distinguish those two is not
  a guard.
- **The preflight can read the wrong database, and it will not fail.** The preflight
  set is resolved from the *instance's own configuration and env file*; the
  operator's shell `DATABASE_URL` is deliberately ignored, because a shell export
  names whatever database that shell last pointed at. The server resolves its
  database from *its own process environment*, which is the unit's `Environment=`
  lines plus the user manager's. The two therefore agree only when both name the
  same database. A `DATABASE_URL` present in the unit but absent from the
  instance's `.env` — or present in both with different values — makes the server
  and the preflight query read **different databases**: the query succeeds,
  returns the wrong set (usually empty), and the guard that refuses to write an
  intent with an unknown preflight set never fires, because nothing errored.

  ```bash
  inst="${inst:-default}"
  echo "-- the unit's effective value (what the server will read):"
  systemctl --user show "$unit" -p Environment --value \
    | grep -oE 'DATABASE_URL=[^ ]*' || echo "   DATABASE_URL not set in the unit"
  echo "-- the instance's own value (what the preflight query reads):"
  grep -E '^DATABASE_URL=' "$HOME/.paperclip/instances/$inst/.env" \
    || echo "   DATABASE_URL not set in the instance env file"
  ```

  Only one of those two lines printing a value is the divergence. When neither
  prints one, the instance is on its configured database and this mechanism is not
  in play — do not reach for it to explain an empty preflight set.

  An empty `preflightActiveRunIds` on a busy instance is the signature either way.
  Distinguish it from a genuinely idle instance with `drainRequired`: a `--wait`
  drain writes `preflightActiveRunIds: []` *on purpose*. Empty plus
  `drainRequired: true` is the drain; empty plus `drainRequired: false` on a plane
  you believe was busy is a database mismatch until proven otherwise.

  ```bash
  inst="${inst:-default}"; root="$HOME/.paperclip/instances/$inst"
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print("drainRequired:",d["drainRequired"],"preflight runs:",len(d["preflightActiveRunIds"]))' \
    "$root/hot-restart-intent.json" 2>/dev/null || echo "no intent: the last restart recorded no preflight"
  ```

Two ways a healthy-looking restart goes wrong here, both observed:

- Restarting the unit with plain `systemctl --user restart` skips the preflight by
  construction. `Restart=always` does not cover an explicit stop, so the unit also
  stays down until someone starts it by hand.
- A `RefuseManualStop=yes` drop-in makes `systemctl --user stop` and
  `systemctl --user restart` fail with exit 4 — which also makes
  `paperclipai service restart` fail, after it has written the intent. The intent
  is rolled back only when the supervisor still reports the pid it names, so on a
  correctly refused restart nothing is left behind and no report is written. A
  guard against manual stops and a requirement for a recorded preflight are in
  direct tension; whichever one is in force, the outcome to look for is an absent
  report, not a clean one.

## Check 4 — is the thing that repairs all of this the one you committed

Checks 1–3 read the unit. This one reads the **guardian**: the 60-second timer
that restores a deleted unit file or drop-in from the golden copy, re-enables the
unit, starts it, and resumes a `SIGSTOP`ped main PID. Every check above is
answered by the guardian being correct, and the guardian's own body is not checked
by anything — it cannot check itself, because the body is the thing that gets
replaced.

```bash
# the installed guardian vs the committed one, and the golden copy set vs what is in force
pnpm check:guardian-install-drift          # or: node scripts/check-guardian-install-drift.mjs
node scripts/check-guardian-install-drift.mjs --json
```

### What it caught, and why every other signal was green

On 2026-09-27 the installed copy at `~/.local/bin/paperclip-unit-guardian.sh` was
reduced to a 4-line `exit 0` stub — 177 bytes, executable, owned by the
installing user. It ran under a timer that was `active` at a correct 60s cadence,
and the journal held 1418 runs, all exiting 0, with zero repairs and zero alerts.

None of those readings was wrong. They are facts about the timer, the unit file,
the drop-ins, the wants symlink and the exit status, and every one of them is
still true of a script whose entire body is `exit 0`. So the check asserts
**content**, and specifically:

- not presence — the stub was present, and executable;
- not size — a legitimate one-character fix is a size change too;
- not mtime or ownership — all of those were unremarkable.

The check also asserts the marker set **in the source at HEAD**, the same
two-part shape as `shadowed-server-install.md`'s sentinels. Without that half, a
guardian gutted in the repository as well as on the host would make the two copies
agree and the board go permanently green.

### Three states, three remedies

| state | meaning | remedy |
|---|---|---|
| `absent` | the install is gone, so nothing runs the heal at all | reinstall from the committed copy |
| `stubbed` | present and executable, and missing the guard steps — the `exit 0` case | reinstall from the committed copy |
| `altered` | implements every guard and still disagrees with HEAD | **decide which side is authoritative** |

`altered` is deliberately not a tamper verdict. Measured the same day, the two
copies also differed by **one character** on the step 6b threshold with the
*installed* copy correct and the committed one carrying a dead detector — an
unpushed host fix. A content comparison catches both directions for one reason:
either way the two files disagree. Which one is authoritative is a decision the
check refuses to make for you, and `stubbed` is decided on markers while
`altered` is decided on bytes precisely so the two are not confused.

### Exit codes, and why 2 exists

`0` nothing diverged, `1` something did, `2` the check could not be evaluated —
no repo, an unreadable source tree, an unreadable install, or a marker that is no
longer in the source at HEAD. Every unevaluated path returns 2 and never 1, so a
broken check cannot be read as a finding. The last case matters most: a marker
missing from HEAD means the manifest has drifted or the guard has been deleted
from the repo, and in either situation the honest output is "I cannot say", not a
green line.

### The golden copy set gets the same treatment

Step 2b of the guardian alerts on a drop-in that is in force with **no golden
copy**. A drop-in present in both places with **altered content** is invisible to
it, and invisible to the guardian, whose header says it never rewrites a file that
already exists. That is how the `RefuseManualStop` golden/live divergence stayed
hidden: the guard under repair and the copy it would restore are two different
files, and nothing compared them. When it diverges, a delete-and-restore cycle
silently changes the unit — the check names that as the reason to act.

## What "patched" looks like versus "shadowed"

The test is traceability, and it is the same test the sibling document applies to
`dist`:

**Patched** — the running process resolves to something you can name:

- a **git checkout** at a specific commit, with a clean tree, so the running code
  is `git rev-parse HEAD` plus an empty `git status --porcelain`;
- a **global npm install** at a published version, where the resolved path's
  contents match the published tarball for the version reported
  (`shadowed-server-install.md` has the diff);
- a **tarball built from a named commit** and installed as a unit, with that commit
  recorded in the instance's notes.

**Shadowed** — the running process resolves to something you cannot name:

- the resolved path is inside a `node_modules` tree with no recorded origin;
- the unit's `ExecStart` is set by a drop-in nobody remembers adding;
- the `Environment=` set contains keys no file on disk explains;
- the binary's mtime is later than every file that would have produced it, and
  nothing in a commit log accounts for the difference;
- a scar sits next to the unit — a `.bak`, a `.pre-*`, a
  `<unit>.<something>-<ts>` copy. Same forensic marker as a patched `dist`, and it
  means the unit was edited in place by a tool that left the original behind.

A unit file that has been hand-edited in place is shadowed even when every
directive in it is correct, because the next re-render overwrites the edit without
telling anyone. That is the difference between the two states: a patched install
is *traceable to a commit*, and a shadowed one is not.

## Repair order

Work outside in, cheapest and most-likely-wrong first, and re-read the four views
after every step:

1. `systemctl --user cat <unit>` and list `DropInPaths`. Reconcile (b) with (c).
   Every disagreement here is a drop-in, by definition.
2. Resolve the `ExecStart` target with `readlink -f` and identify the install. If it
   is not traceable, stop: you are now in `shadowed-server-install.md`, and the
   unit is not the problem.
3. Diff the effective `Environment=` set against the three managed keys and the
   operator's intent. Restore dropped `PATH` or provider keys from the file that
   still has them.
4. Confirm `KillMode=process` is in force unless you have a specific reason it is
   not.
5. Reconcile the preflight evidence: does the newest report cover the current
   process? If not, the last restart was unrecorded, and the runs it lost are
   already filed as `process_lost`.
6. Only then re-render, and **back the unit up first**:
   `cp -a ~/.config/systemd/user/<unit> ~/.config/systemd/user/<unit>.bak-<ts>`,
   then `systemctl --user daemon-reload` and re-read `systemctl --user show`.

### The repair hint is not always a repair

`doctor` answers a drifted definition with *"Run `paperclipai service install` to
regenerate the service definition."* Take that as a proposal, not an instruction,
because of what the re-render does and does not touch:

- It writes the **main file only**. Every drop-in still applies on top. If a drop-in
  sets `ExecStart`, `StartLimit*` or `KillMode`, the check can go green while the
  loaded configuration is unchanged. Verify with `systemctl --user show` after the
  reload, not with `doctor`.
- It changes behaviour on a unit a human may have tuned. On the plane measured
  below, the file carried `StartLimitIntervalSec=60` / `StartLimitBurst=5`; the
  renderer emits `900` / `12`. Applying the hint silently retunes the start-limit
  budget of a live control plane.
- It can flip `KillMode` from `control-group` to `process` under a drop-in whose
  comments were written reasoning about the other value. Read the drop-in prose
  before you change the key it discusses.

`doc/INSTALLING.md`'s *Recover A Broken Service Unit* covers the case where the
unit is already parked at `start-limit-hit`. This document covers the case where
the unit is running and the question is *what*.

## What was measured on `default`

Instance `default`, unit `paperclipai.service`, measured 2026-09-26. Every number
below is reproducible with the commands above.

**The unit file is not the rendered unit.** 603 bytes, hand-written:
`StartLimitIntervalSec=60`, `StartLimitBurst=5`, `RestartSec=5`, and **no
`KillMode`**. The renderer emits `KillMode=process`, `StartLimitIntervalSec=900`,
`StartLimitBurst=12`, `RestartSteps=5`, `RestartMaxDelaySec=60`. Ten drop-ins
supply the rest.

**`KillMode` is set nowhere** — not in the file, not in any of the ten drop-ins.
The effective value is systemd's default `control-group`, so a stop or a
`TimeoutStartSec` overrun signals the embedded PostgreSQL and every detached
local-agent run in the cgroup at once. One drop-in's own comments document the
consequence and note that it "matters once `KillMode=process` reaches this host" —
i.e. the drop-in was written for a unit configuration this host does not have.

**The loaded `ExecStart` comes from a drop-in, not the file.**
`paperclipai.service.d/20-runtime-env.conf` carries a bare `ExecStart=` reset
followed by a full re-specification. The main file's own `ExecStart=` line is
never what runs, and `grep '^ExecStart='` on the main file is misleading in
exactly the way this document is about.

**`doctor` reports drift and the plane is healthy.** `Service definition: Missing
or drifted definition` and `Service health: fetch failed`, against a server
answering `/api/health` with `status: ok` on the port it is actually bound to. The
health failure is the `PORT` divergence: a drop-in pins `PORT` to the address the
fleet uses while `config.json` names another, so every shell-side probe against the
configured port fails. The drift failure is the missing `KillMode` and the
retuned start-limit budget.

**The preflight did not run for the current process.** `MainPID` 349672, started
2026-09-26 21:04:32; `ExecMainStartTimestamp` 2026-09-26 21:04:33; `NRestarts=2`;
`hot-restart-intent.json` absent; the newest `hot-restart-report.json` has
`requestedAt` 2026-09-25T00:31:40Z — about 41 hours earlier. That report is also
vacuous: `drainRequired: false` with `adoptedRunIds`, `finalizedWhileDownRunIds`,
`lostRunIds` and `runs` all empty, and `previousServerVersion: null`. The runs
lost in that window are filed as `process_lost`.

The cause here is the absent preflight, not the database mismatch: neither the
unit's effective environment nor the instance's `.env` sets `DATABASE_URL`, and
the instance is on its embedded Postgres, so both sides resolve the same database.
The check above is how to tell those two apart on a host where it is ambiguous.

**The `ExecStart` target is a symlink, and the install behind it is the one the
sibling document describes.** `ExecStart` names the CLI shim; `readlink -f` resolves
it to `.../lib/node_modules/paperclipai/dist/index.js`, inside an install tree whose
mtime is 2026-09-25 00:57 — the timestamp of the in-place `dist` patches in
`shadowed-server-install.md`. The unit-level and `dist`-level shadowing are the
same install, reached by different checks. `/proc/<pid>/exe` is `/usr/bin/node`,
which is the interpreter and says nothing about the target.

## Rules of thumb

1. **A green `Service definition` is a statement about one file.** It is not a
   statement about the process. Read `systemctl --user show` and
   `/proc/<MainPID>` before believing anything about what is running.
2. **`systemctl --user cat <unit>`, not `grep` on the unit.** Drop-ins win on every
   key they set, and a bare `ExecStart=` or `Environment=` in a drop-in resets the
   list the main file built. Ten drop-ins is a normal, healthy, completely
   ungreppable configuration.
3. **Resolve the `ExecStart` target before trusting it.** An existing executable
   file is all the installer checks; a symlink satisfies that and a package install
   can re-point it with the unit untouched.
4. **A missing `hot-restart-report.json` is not a clean restart.** It is a restart
   whose run set was never recorded. Correlate the report's `requestedAt` against
   `ExecMainStartTimestamp` before quoting `lostRunIds` as a continuity result.
5. **An empty `preflightActiveRunIds` with `drainRequired: false` on a busy
   instance means the preflight read the wrong database**, not that nothing was
   running. The fail-closed guard cannot catch this, because nothing errored.
6. **Check `KillMode` first when the plane goes down on a stop or a slow boot.**
   One key, defaulting to the value that takes the database out with the server.
7. **Back the unit up before any re-render, and re-read `systemctl --user show`
   after the reload.** The re-render fixes the file and leaves every drop-in
   standing.
8. **An `active` guardian timer is not evidence that the guardian is installed.**
   Run `pnpm check:guardian-install-drift` before trusting a healthy plane, for the
   same reason a green `Service definition` is not evidence about the process: it
   asserts content, because on 2026-09-27 a 177-byte `exit 0` stub satisfied every
   other signal there was.
