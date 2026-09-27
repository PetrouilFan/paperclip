#!/usr/bin/env bash
# paperclip-unit-guardian -- keeps the paperclipai systemd unit definition present,
# enabled and running.
#
# WHY: on 2026-09-26 14:24:16 the unit file
#   ~/.config/systemd/user/paperclipai.service
# was deleted a second time. systemd had no fragment and no wants symlink, so the
# unit was garbage-collected, a stop job ran, the drain wedged, TimeoutStopSec=300
# expired and every postgres backend was SIGKILLed with the cgroup. The whole
# control plane went down. The file was restored by hand at 14:29.
#
# The manual restore is not a fix; it is a rerun. This closes the loop so a repeat
# costs at most one timer interval instead of the board.
#
# WHAT IT DOES (every 60s, idempotent, no-ops when healthy):
#   1. unit file missing            -> restore from golden copy
#   2. any drop-in missing          -> restore from golden copy
#   3. unit not enabled             -> systemctl --user enable
#   4. unit not active              -> systemctl --user start
#   5. daemon-reload only if it actually restored something
#   6. main PID job-control stopped  -> SIGCONT that PID
#
# WHAT IT DELIBERATELY NEVER DOES:
#   * never `stop`, `restart`, or a terminating signal -- only `start`, plus the
#     single non-terminating SIGCONT in step 6. It cannot be the thing that takes
#     the board down. SIGCONT is the only signal in the table that cannot
#     terminate a process, which is why resuming a frozen board is strictly
#     safer than the `start` this script already issues.
#   * never rewrites a unit file that already exists. If the file is present but
#     differs from the golden copy, that is logged and left alone: a human or a
#     deliberate deploy may have changed it, and clobbering that would be worse
#     than the drift.
#   * never touches the running process when the unit is healthy.
#   * never sends SIGCONT to anything but the main PID. See step 6 for why the
#     cgroup-wide version of that sweep is unsafe here.
#
# OPERATOR ESCAPE HATCH: create the pause file and the guardian does nothing.
#   touch ~/.local/state/paperclip-unit-guardian/PAUSE
# Remove it to resume. To remove the guardian entirely:
#   systemctl --user disable --now paperclip-unit-guardian.timer
#   rm ~/.config/systemd/user/paperclip-unit-guardian.{service,timer}
#   rm ~/.local/bin/paperclip-unit-guardian.sh

set -uo pipefail

UNIT="paperclipai.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT"
DROPIN_DIR="$UNIT_DIR/$UNIT.d"
GOLDEN="$HOME/.local/state/paperclip-unit-guardian/golden"
PAUSE="$HOME/.local/state/paperclip-unit-guardian/PAUSE"
LOG="$HOME/.local/state/paperclip-unit-guardian/guardian.log"
# Consecutive ticks on which the main PID was found stopped. Survives between
# ticks so a freeze that SIGCONT does not clear escalates instead of repeating
# silently. 0 is written back on any healthy observation.
FREEZE_COUNT="$HOME/.local/state/paperclip-unit-guardian/freeze-count"
# Last set of in-force drop-ins that had no golden copy, so step 2b alerts on a
# change instead of every tick.
UNPROTECTED_SEEN="$HOME/.local/state/paperclip-unit-guardian/unprotected-dropins"

# Keep the log from growing without bound; it only gets appended on repair.
[ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ] && : > "$LOG"

log() { printf '%s GUARDIAN %s\n' "$(date -Is)" "$*" >> "$LOG"; }

[ -e "$PAUSE" ] && exit 0

# Reload the manager as soon as anything is put back, and before enable/start.
# systemd garbage-collects a unit whose fragment vanished, so until the manager
# has re-read the restored file the unit is still cached as not-found and
# `start` would fail. Getting this order wrong makes the guardian a no-op in
# precisely the case it exists for: file gone AND service down.
reloaded=0
reload_now() { [ "$reloaded" -eq 1 ] || { systemctl --user daemon-reload >/dev/null 2>&1; reloaded=1; }; }

# 1. unit definition present?
if [ ! -f "$UNIT_PATH" ]; then
  if [ -f "$GOLDEN/$UNIT" ]; then
    cp -p "$GOLDEN/$UNIT" "$UNIT_PATH"
    log "RESTORED unit definition $UNIT_PATH from golden (was absent)"
    reload_now
  else
    log "ALERT unit definition $UNIT_PATH is absent and no golden copy exists at $GOLDEN/$UNIT"
  fi
fi

# 2. drop-ins present? These carry the PORT pin, the start timeout, the memory
#    ceiling, run-scratch root, the restart backoff, the opencode v1 pin and the
#    RefuseManualStop guard. Losing any silently degrades the service, so restore
#    whatever is missing -- but only what $GOLDEN has a copy of, which is why 2b
#    checks that set rather than assuming it covers everything in force.
mkdir -p "$DROPIN_DIR"
for g in "$GOLDEN"/dropins/*.conf; do
  [ -e "$g" ] || continue
  name="$(basename "$g")"
  if [ ! -f "$DROPIN_DIR/$name" ]; then
    cp -p "$g" "$DROPIN_DIR/$name"
    log "RESTORED drop-in $DROPIN_DIR/$name from golden (was absent)"
    reload_now
  fi
done

# 2b. Does every drop-in that is actually in force have a golden copy to restore
#     from? Found by hand on 2026-09-27: 75-restart-backoff.conf was in
#     force with no counterpart in $GOLDEN/dropins, so the loop above would have
#     walked straight past it -- the exact silent degradation step 2 exists to
#     prevent, and invisible because a missing golden copy is indistinguishable
#     from a drop-in that was never meant to be there. The guardian cannot fix that
#     on its own (it has nothing to restore from), so it says so instead, once per
#     distinct set rather than every 60s.
#     The fix when this fires: cp -p <live drop-in> $GOLDEN/dropins/
if [ -d "$DROPIN_DIR" ]; then
  unprotected="$(cd "$DROPIN_DIR" && ls -1 ./*.conf 2>/dev/null | sed 's|^\./||' | while read -r n; do
    [ -f "$GOLDEN/dropins/$n" ] || printf '%s ' "$n"
  done)"
  if [ -n "$unprotected" ]; then
    if [ "$(cat "$UNPROTECTED_SEEN" 2>/dev/null)" != "$unprotected" ]; then
      printf '%s' "$unprotected" > "$UNPROTECTED_SEEN" 2>/dev/null
      log "ALERT drop-in(s) in force with no golden copy, so this script cannot restore them if they are deleted: $unprotected -- fix: cp -p $DROPIN_DIR/<name> $GOLDEN/dropins/<name>"
    fi
  elif [ -f "$UNPROTECTED_SEEN" ]; then
    rm -f "$UNPROTECTED_SEEN"
  fi
fi

# 3. enabled? Without the wants symlink the unit does not survive logout or reboot.
#    The 14:24 restore put the file back but left the unit disabled, so the next
#    login would have taken the board down with nothing left to investigate.
if [ -f "$UNIT_PATH" ] && [ "$(systemctl --user is-enabled "$UNIT" 2>/dev/null)" != "enabled" ]; then
  if systemctl --user enable "$UNIT" >/dev/null 2>&1; then
    log "REENABLED $UNIT (default.target.wants symlink was missing)"
  else
    log "ALERT could not enable $UNIT"
  fi
fi

# 4. running? `start` only -- never stop/restart/kill.
if [ -f "$UNIT_PATH" ] && [ "$(systemctl --user is-active "$UNIT" 2>/dev/null)" != "active" ]; then
  if systemctl --user start "$UNIT" >/dev/null 2>&1; then
    log "STARTED $UNIT (it was not active)"
  else
    log "ALERT $UNIT was not active and start failed; see: systemctl --user status $UNIT"
  fi
fi

# 5. re-read the manager once more if drop-ins landed after the last reload, so a
#    guard drop-in restored in this same pass is live immediately rather than on
#    the next tick.
reload_now

# 6. frozen? Added 2026-09-27 after the incident recorded below.
#
#    On 2026-09-27 00:50:01 every process in this cgroup received SIGSTOP in the
#    same second -- 138 of them, main process and all ten embedded postgres
#    backends included -- and not one SIGCONT followed in the entire retained
#    journal. Steps 1-5 all passed throughout: the unit file was present, the
#    drop-ins were present, the symlink was present, and systemd reported the unit
#    `active`, because a stopped process is still a running one as far as
#    `is-active` is concerned. The board answered nothing for 13 minutes while
#    looking completely healthy to this script. The next stop request then could
#    not drain, because a stopped process cannot act on SIGTERM, so it hit
#    TimeoutStopSec=300 exactly and systemd SIGKILLed the backends.
#
#    So: check the main PID's process state. `T` is the marker ps reports for a
#    process stopped by a job-control signal, and SIGCONT is how it comes back.
#
#    WHY ONLY THE MAIN PID, AND NOT THE WHOLE CGROUP. The obvious stronger
#    version of this is `systemctl --user kill --kill-whom=all --signal=CONT` on
#    the unit, which resumes everything at once and is one line. It is also
#    wrong here, and measurably so: this repo's own test suite pins live PIDs
#    against reuse with SIGSTOP/SIGCONT
#    (packages/paperclip-runner/src/drivers/acpx/installation-integrity.test.ts),
#    and those child processes live in this cgroup whenever the test runs inside
#    a detached agent run. A cgroup-wide CONT would resume test-owned children
#    mid-assertion and turn a passing run into a flaky one. The main PID is the
#    one process whose stopped state is unambiguously fatal and never somebody
#    else's deliberate test fixture, so that is the one this script signals.
#
#    Residual gap, stated rather than papered over: a freeze that spares the main
#    PID (postgres backends only) is still invisible to the heal, because telling
#    that apart from a test-owned child needs process attribution the guardian
#    does not have. Step 6b counts it and shouts instead of guessing.
main_pid() { systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null; }

# Echo the PID if it is job-control stopped, else fail. Two samples, because this
# is the only place the script acts on a live process rather than on a file, and
# one `ps` can catch a process mid-transition -- or catch a PID that has just been
# recycled by an unrelated process.
pid_is_stopped() {
  local mp s1 s2
  mp="$1"
  [ -n "$mp" ] && [ "$mp" -gt 0 ] 2>/dev/null || return 1
  s1="$(ps -o stat= -p "$mp" 2>/dev/null)" || return 1
  # Uppercase T only. Lowercase t means stopped by a tracer under ptrace, where
  # the tracer owns the process and a SIGCONT from here would be wrong.
  case "$s1" in *T*) ;; *) return 1 ;; esac
  sleep 0.3
  s2="$(ps -o stat= -p "$mp" 2>/dev/null)" || return 1
  case "$s2" in *T*) printf '%s' "$mp" ;; *) return 1 ;; esac
}

MP="$(main_pid)"

if [ -n "$MP" ] && [ "$MP" != "0" ] && FROZEN="$(pid_is_stopped "$MP")" && [ -n "$FROZEN" ]; then
  n=$(( $(cat "$FREEZE_COUNT" 2>/dev/null || echo 0) + 1 ))
  printf '%s' "$n" > "$FREEZE_COUNT" 2>/dev/null
  log "FROZEN main PID $FROZEN is SIGSTOPped (STAT $(ps -o stat= -p "$FROZEN" 2>/dev/null)) while $UNIT reports $(systemctl --user is-active "$UNIT" 2>/dev/null); sending SIGCONT to the main PID (consecutive detection #$n)"
  if kill -CONT "$FROZEN" 2>/dev/null; then
    sleep 0.3
    s3="$(ps -o stat= -p "$FROZEN" 2>/dev/null)"
    case "$s3" in
      *T*) log "ALERT sent SIGCONT to main PID $FROZEN but it is still '$s3'; something is re-freezing it" ;;
      *)   log "RESUMED main PID $FROZEN with SIGCONT; it is now '${s3:-gone}'" ;;
    esac
  else
    log "ALERT main PID $FROZEN is stopped and SIGCONT to the PID failed"
  fi
  if [ "$n" -ge 3 ]; then
    log "ALERT $FROZEN has been found stopped on $n consecutive guardian ticks. SIGCONT is not holding, so the freeze is being reapplied; RefuseManualStop=yes does NOT block 'systemctl --user kill' (measured: rc=0), so look for a kill --kill-whom=all --signal=STOP against this unit."
  fi
else
  [ -f "$FREEZE_COUNT" ] && printf '0' > "$FREEZE_COUNT" 2>/dev/null

  # 6b. A freeze that spared the main PID. Count stopped processes in the unit
  # cgroup and shout above a floor, but do not signal: the processes we would be
  # resuming may be a test's own SIGSTOP fixtures (see the note above), and a
  # false resume inside a running test is worse than a logged alert. Detection
  # only, deliberately.
  CG="$(systemctl --user show "$UNIT" -p ControlGroup --value 2>/dev/null)"
  if [ -n "$CG" ] && [ -r "/sys/fs/cgroup$CG/cgroup.procs" ]; then
    stopped_total=0
    total=0
    while read -r cpid; do
      [ -n "$cpid" ] || continue
      total=$(( total + 1 ))
      case "$(ps -o stat= -p "$cpid" 2>/dev/null)" in *T*) stopped_total=$(( stopped_total + 1 )) ;; esac
    done < "/sys/fs/cgroup$CG/cgroup.procs"
    # Require both an absolute floor and a majority, so a lone test-owned child
    # never trips this.
    if [ "$total" -ge 8 ] && [ "$stopped_total" -ge 4 ] && [ "$stopped_total" -gt $(( total / 2 )) ]; then
      log "ALERT $stopped_total of $total processes in $CG are stopped while the main PID is not. This is the known residual gap: the guardian will not sweep the cgroup with SIGCONT because this repo's tests SIGSTOP their own children here, so this needs a human: systemctl --user kill --kill-whom=all --signal=SIGCONT $UNIT"
    fi
  fi
fi

exit 0
