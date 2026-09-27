# Which lifecycle verbs a human keeps on `paperclipai.service`

Status: **proposed**, awaiting the board's decision. Author: Hephaestus, for PET-470.
Evidence: `scripts/paperclip-lifecycle-verb-matrix.sh`, measured 2026-09-27 on
systemd 261.3-1-arch. The live unit was never started, stopped or signalled; every
measurement ran against a throwaway `pet470-*.service` carrying the same guard
shape.

This document exists because the drop-in's own `KNOWN LIMITS` section left the
`kill` question open on 2026-09-26, and leaving it open meant the next person to
edit `90-no-manual-stop.conf` would decide it by accident.

## The short answer

Keep every verb that is currently permitted. Refuse nothing that is not already
refused. What changes is that the escape hatch is now **named, measured, and
attributable** rather than merely available, and one detection path that was
believed to work does not.

The two options that would have constrained `kill` are both rejected on measured
grounds, not on taste — see [Why not the D-Bus policy](#why-not-the-d-bus-policy)
and [Why not now, KillMode](#why-not-now-killmode).

## The measured verb surface

The guard's reach is wider than the issue assumed: `RefuseManualStop=yes` refuses
**five** verbs, not two. All five are job-based, which is exactly why it cannot
reach `kill`, `disable`, `mask` or `set-property` — those never enter the job queue.

| verb | rc | what it did |
|---|---|---|
| `start` (already active) | 0 | no-op |
| `stop` | **4** | refused |
| `restart` | **4** | refused |
| `try-restart` | **4** | refused |
| `reload-or-restart` | **4** | refused |
| `try-reload-or-restart` | **4** | refused |
| `reload` | 3 | `Job type reload is not applicable` — this unit has no `ExecReload` |
| `suspend` / `hibernate` | 1 | `Too many arguments` — not unit verbs on a user manager; they address logind |
| `reset-failed` | 0 | harmless |
| `set-property CPUQuota=50%` | 0 | runtime property change |
| `kill` (default SIGTERM) | 0 | delivered |
| `kill --kill-whom=all --signal=SIGSTOP` | 0 | delivered — whole cgroup |
| `kill --kill-whom=all --signal=SIGCONT` | 0 | delivered |
| `kill --kill-whom=main --signal=SIGSTOP` | 0 | delivered — main process only |
| `kill --kill-whom=all --signal=SIGKILL` | 0 | delivered — whole cgroup |
| `disable` | 0 | removed the `default.target.wants` symlink |
| `enable` | 0 | restored it |
| `mask` (unit file present) | 1 | `File already exists` — incidental, not the guard |
| `mask` (unit file moved aside) | **0** | masked |
| `unmask` | 0 | unmasked |

`mask` is worth a line of its own because its `rc=1` reads like a refusal and is
not one: it fails only because a unit file occupies the path `/dev/null` would
take. Move the file aside and masking works. The same is true of the production
unit.

## What a human is allowed to do, by hand

**Always permitted, and expected.** These are the operator's escape hatch.

- `systemctl --user kill --kill-whom=all --signal=SIGCONT paperclipai.service`
  — the one-line recovery for a frozen cgroup. Verified: a stopped main PID goes
  back to `Ss`. This is strictly safer than the `start` the guardian already
  issues, because it resumes rather than replaces.
- `systemctl --user kill --kill-whom=main --signal=SIGCONT|SIGSTOP <unit>` — the
  surgical form. It cannot reach the postgres backends by construction.
- `start`, `enable`, `reset-failed`, `status`, `show`, `daemon-reload` — routine.

**Permitted, deliberate, and now attributable.** Not blocked, but every use is a
known event and should be announced in the issue thread when used:

- `kill --kill-whom=all --signal=SIGTERM|SIGKILL` — see the measurement below for
  why this is the *least* dangerous of the kill variants.
- `disable` then `enable` — removes the wants symlink; without it the unit does
  not survive logout or reboot. The guardian re-enables on its next tick and says
  so in its log.
- `set-property` — a runtime property change with no restart.
- `mask` — permitted in principle, refused in practice while the unit file exists.

**Not available, and not an oversight.** `stop`, `restart`, `try-restart`,
`reload-or-restart`, `try-reload-or-restart` are refused (`rc=4`). `reload` is a
no-op error because the unit has no `ExecReload`; if a reload is ever genuinely
needed, the missing piece is an `ExecReload`, not a permission.

## The measurement that decides it

The issue lists as a cost of leaving `kill` alone that "nothing prevents the
SIGTERM variant, which is a direct kill rather than a freeze". Measured, that is
backwards:

| variant | recovery | measured time |
|---|---|---|
| `kill --kill-whom=all --signal=SIGTERM` | `Restart=always` brings it back with a new main PID | **0–1s**, no human, no guardian tick |
| `kill --kill-whom=all --signal=SIGKILL` | same | **0–1s** |
| `kill --kill-whom=all --signal=SIGSTOP` | **none** | `is-active` still reports `active`; `restart` is refused `rc=4` |

A process killed outright is a *restart*, and `Restart=always` handles it in about
a second. A frozen process is not a restart at all: it never exits, so nothing
that watches for exit fires, and `is-active` — the one check the board had for
thirteen minutes — reports `active` throughout. The variant that costs an outage
is precisely the variant `Restart=` cannot touch, and it is also the one the
guardian can now detect.

So the ranking the issue proposed inverts once measured: the SIGTERM variant needs
no policy response, and the freeze needs detection (shipped) plus a recovery verb
(a human, below).

## Why the kill verb has to stay: the residual gap

The guardian will `SIGCONT` a frozen **main PID** on its own. It deliberately will
**not** sweep a cgroup whose main PID is running, because the processes it would
resume may be this repo's own `SIGSTOP` test fixtures, and a false resume
mid-assertion is worse than an alert. Measured, in that case it:

1. counts the stopped processes (19 of 20, main PID running),
2. logs the one-line recovery, and
3. does not signal.

The human then runs the `SIGCONT` sweep. Measured: 0 processes left stopped. This
is the one measured case where a kill verb is load-bearing, and it is why the
verb stays.

## Why not the D-Bus policy

Option 2 proposed denying `org.freedesktop.systemd1.Manager.KillUnit` to the
owning user. It cannot be made to express "a human, but not an agent" on this
host, for two independent measured reasons. Either alone is disqualifying.

**The human and the agent are the same uid.** `paperclipai.service` runs as uid
1000; this agent runs as uid 1000. A D-Bus policy can only match on uid, label or
SELinux context, so a rule that denies the agent denies the operator identically.
There is no attribute on this host that distinguishes them, because there is no
distinction to find.

**There is a second route to the same method that D-Bus policy cannot reach.**
`KillUnit` is reachable over the user bus at `/run/user/1000/bus`, where a
`session.conf` deny would apply. It is *also* reachable over
`/run/user/1000/systemd/private`, which is systemd's own private protocol rather
than D-Bus — `busctl` against it returns `Invalid request descriptor` precisely
because it is not a D-Bus endpoint. Measured: `kill --kill-whom=all
--signal=SIGSTOP` goes through that socket and freezes the cgroup. No D-Bus policy
file governs it. A correctly-written deny would be a speed bump that the same uid
steps around with one environment variable.

## Why not now, `KillMode`

Option 3 is the structurally right answer and is not being rejected on merit. The
live unit's `KillMode` is `control-group` — measured, not `process` — which is
precisely why a `--kill-whom=all` reaches all ten postgres backends. Moving the
database to its own unit with `KillMode=process` would mean a whole-cgroup sweep
cannot reach it at all, and would shrink the blast radius of the 00:50:01 event
whether or not anyone used `kill`.

It is not this issue's change. It is a real architecture change, it overlaps the
unit-isolation work tracked elsewhere (PET-277), and it does not answer the
question asked here, which is about the operator escape hatch. The decision below
is compatible with doing it later and does not pre-empt it.

## One correction to the premise

The issue states that "the detection and resume are shipped and deployed". That is
true of the main-PID path and **was false of the residual-gap path**.

Step 6b's condition was missing a closing bracket:

```sh
if [ "$total" -ge 8 ] && [ "$stopped_total" -ge 4 ] && [ "$stopped_total" -gt $(( total / 2 )); then
```

`bash -n` accepts it, because an unterminated `[` is a runtime error rather than a
parse error. The branch was never taken on any host, ever, so the residual-gap
alert had never once been printed. It shipped that way in `ef372182b`.

It survived review because the guardian's tests are source-text assertions, and
step 6b's dead condition still contained the literal string `stopped_total` — so
`assert.match(script, /stopped_total/)` passed. A test that only asks whether the
code mentions a variable cannot tell live code from dead code.

This matters to the decision rather than being a footnote beside it: option 2's
stated cost was that a D-Bus deny "needs a documented recovery path or it becomes
the next outage". Until this fix landed, the recovery path that would have had to
be preserved did not work. Fixed in this change, with a test that fails against
the old code, and with an end-to-end leg in the freeze proof that fails against it
too.

## Attribution

The freeze is **not** attributed. `journalctl` records the effect, not the D-Bus
caller, and no agent was shown to have sent it. A process-tree capture at the
instant of a freeze remains the only reliable attribution and does not exist yet.
Nothing in this document should be read as a finding about who sent the signal.

## If this is accepted

1. Replace the `KNOWN LIMITS` section of
   `~/.config/systemd/user/paperclipai.service.d/90-no-manual-stop.conf` with a
   pointer to this document, so the next editor inherits the decision instead of
   re-deriving it. The drop-in is not in this repository, so that edit is a
   separate, explicit host change.
2. Leave the guard as it is. No unit file changes.
3. Ship the 6b fix (already in this change) so the alert named above actually
   fires.
4. PET-277 remains the structural answer, unblocked by this decision.

## Reproducing

```sh
scripts/paperclip-lifecycle-verb-matrix.sh   # the verb surface, the freeze cost, the D-Bus route
scripts/paperclip-unit-guardian-freeze-proof.sh  # the freeze wedge end to end, incl. 6b
node --test scripts/paperclip-unit-guardian.test.mjs  # no systemd needed
```

Both shell scripts refuse to run without `PAPERCLIP_RUN_SCRATCH_DIR` set, use only
uniquely named `pet470-*.service` / `pet452-*.service` units, and reclaim any probe
unit leaked by an earlier run before measuring. A leaked unit matters: `start` on
a running unit is a no-op returning 0, so a probe left behind silently keeps
serving the *previous* run's fixture and the next leg measures the wrong thing.
That happened here twice and is why `preflight` exists and why each leg asserts the
cgroup it got.
