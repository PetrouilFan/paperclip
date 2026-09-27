#!/usr/bin/env bash
# The lifecycle-verb decision record, as a measurement.
#
# PET-470 asks a policy question -- "which lifecycle verbs does a human keep on
# the production unit?" -- and this script is the evidence behind whichever way
# that is answered. It measures, it does not assert: every rc and every effect
# below is read back off a throwaway unit that carries the same guard shape as
# the production unit.
#
# The live paperclipai.service is never started, stopped, masked, suspended or
# signalled here. Every leg runs against a uniquely named `pet470-*.service`.
#
# NOTE ON ISOLATION: a running systemd --user manager caches its unit search path
# from the environment it was started with, so faking HOME/XDG_CONFIG_HOME in this
# shell does NOT hide or reveal units to it. The isolation lever that actually
# works is the unit NAME: a name the host cannot have cannot be reached by any
# verb, and `systemctl --user kill` accepts no pattern here that would match both
# it and the production unit.
set -u
SCRATCH="${PAPERCLIP_RUN_SCRATCH_DIR:?}"
GUARDIAN="${GUARDIAN:-$(cd "$(dirname "$0")" && pwd)/paperclip-unit-guardian.sh}"
PROBE_STATE="$SCRATCH/lifecycle-verb-state"
D="$HOME/.config/systemd/user"
mkdir -p "$PROBE_STATE" "$D"
rm -f "$PROBE_STATE"/guardian.log "$PROBE_STATE"/freeze-count

fail=0
ok()  { printf '  PASS  %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }
note() { printf '  ----  %s\n' "$*"; }
stat_of() { [ -n "${1:-}" ] && [ "${1:-0}" -gt 0 ] 2>/dev/null && ps -o stat= -p "$1" 2>/dev/null; }

# The guardian under test: the repo copy by default, so a proof run cannot pass
# against a stale installed script. Override with GUARDIAN=... to test a
# deployment. Only the unit name and the state directory are redirected.
sed -e 's|^UNIT="paperclipai.service"|UNIT="pet470-heal.service"|' \
    -e "s|\$HOME/.local/state/paperclip-unit-guardian|$PROBE_STATE|g" \
    "$GUARDIAN" > "$SCRATCH/guardian-verb-probe.sh"
chmod +x "$SCRATCH/guardian-verb-probe.sh"
norm() { sed -e 's|^UNIT=.*|U|' -e "s|\$HOME/.local/state/paperclip-unit-guardian|S|g" -e "s|$PROBE_STATE|S|g" "$1"; }
cmp -s <(norm "$SCRATCH/guardian-verb-probe.sh") <(norm "$GUARDIAN") \
  || { echo "  FATAL: probe script drifted from the guardian under test"; diff <(norm "$SCRATCH/guardian-verb-probe.sh") <(norm "$GUARDIAN"); exit 1; }

# A guarded unit shaped like the production one: RefuseManualStop=yes from a
# 90-no-manual-stop.conf drop-in, Restart=always, KillMode=control-group (the
# live unit's KillMode, measured -- it is NOT process).
#
# The assert at the end is load-bearing, not defensive noise. `systemctl start`
# on an already-active unit is a no-op that returns 0, so a probe unit leaked
# by an earlier interrupted run keeps serving its OLD cgroup: the leg then
# measures the corpse of a previous run's fixture and reports a clean pass for
# the wrong reason. That is exactly what happened here until it was measured.
write_guarded() {
  local U="$1" trap_body="$2" min_procs="${3:-1}"
  local MP CG n
  mkdir -p "$D/$U.d"
  cat > "$D/$U" <<UNIT
[Unit]
Description=PET-470 lifecycle verb matrix probe
[Service]
Type=simple
ExecStart=/usr/bin/bash -c "$trap_body"
Restart=always
TimeoutStopSec=10
KillMode=control-group
[Install]
WantedBy=default.target
UNIT
  cat > "$D/$U.d/90-no-manual-stop.conf" <<'UNIT'
[Unit]
RefuseManualStop=yes
UNIT
  # Seed a golden copy of the drop-in. Without it the guardian's step 2b logs
  # "drop-in in force with no golden copy" and the log stops being about the
  # thing this script is measuring. The deployed guardian has these.
  mkdir -p "$PROBE_STATE/golden/dropins"
  cp -p "$D/$U.d/90-no-manual-stop.conf" "$PROBE_STATE/golden/dropins/90-no-manual-stop.conf"
  systemctl --user daemon-reload
  systemctl --user enable "$U" >/dev/null 2>&1
  systemctl --user start "$U" >/dev/null 2>&1
  sleep 0.5
  MP=$(systemctl --user show "$U" -p MainPID --value 2>/dev/null)
  CG=$(systemctl --user show "$U" -p ControlGroup --value 2>/dev/null)
  n=0; [ -n "$CG" ] && n=$(cat "/sys/fs/cgroup$CG/cgroup.procs" 2>/dev/null | wc -l)
  if [ -z "$MP" ] || [ "$MP" = "0" ] || [ "$n" -lt "$min_procs" ] 2>/dev/null; then
    bad "$U did not come up as written (MainPID='$MP', $n processes in the cgroup, wanted >= $min_procs); a stale unit from an earlier run is serving this leg"
    return 1
  fi
  return 0
}

# Reclaim any pet470-* probe unit left by an earlier run before measuring
# anything. Only this script's own uniquely-named units are touched; the
# production unit is never in that namespace.
#
# It has to enumerate units the MANAGER knows about, not files on disk. A probe
# unit whose file was deleted while it was running stays loaded and running, and
# `systemctl start` on it is a no-op returning 0 -- so the next leg silently
# measures the previous run's fixture. A disk glob misses exactly those.
preflight() {
  local u MP found=0
  for u in $(systemctl --user list-units --all --plain --no-legend 'pet470-*' 2>/dev/null | awk '{print $1}') \
           $(systemctl --user list-unit-files --plain --no-legend 'pet470-*' 2>/dev/null | awk '{print $1}'); do
    [ -n "$u" ] || continue
    found=1
    printf '  ----  reclaiming a leaked probe unit from an earlier run: %s (%s)\n' \
      "$u" "$(systemctl --user is-active "$u" 2>/dev/null)"
    MP=$(systemctl --user show "$u" -p MainPID --value 2>/dev/null)
    systemctl --user kill --kill-whom=all --signal=SIGCONT "$u" 2>/dev/null
    [ -n "$MP" ] && [ "$MP" != "0" ] && kill -KILL "$MP" 2>/dev/null
    # `stop` before the rm: a leaked probe unit carries Restart=always, so once
    # its file is gone it sits in auto-restart-queued forever, and those never
    # leave the manager's unit list on their own. The guard does not apply to a
    # not-found unit, so this stop is not the rc=4 the production unit gives.
    systemctl --user stop "$u" >/dev/null 2>&1
    systemctl --user unmask "$u" 2>/dev/null
    systemctl --user disable "$u" 2>/dev/null
    systemctl --user reset-failed "$u" 2>/dev/null
    rm -f "$D/$u" "$D/$u.d/90-no-manual-stop.conf"
    rmdir "$D/$u.d" 2>/dev/null
  done
  # A loaded-but-filetless unit keeps its cgroup; the reload drops the definition.
  [ "$found" = "1" ] && systemctl --user daemon-reload
  # Prove it, rather than assume it. What actually poisons a later leg is a stale
  # unit that is RUNNING, because `start` will not replace it. A not-found entry
  # with no process is inert garbage: `start` on it does start the new fixture.
  local running
  running=$(systemctl --user list-units --all --plain --no-legend 'pet470-*' 2>/dev/null \
             | awk '$4 == "active" || $4 == "activating" || $4 == "reloading" {print $1}' | tr '\n' ' ')
  if [ -n "${running// /}" ]; then
    bad "preflight left a probe unit running: $running -- a later leg would measure a stale unit"
    return 1
  fi
  return 0
}

cleanup_unit() {
  local U="$1"
  # `stop` is refused by the guard, so recovery is SIGCONT plus rm, never stop.
  systemctl --user kill --kill-whom=all --signal=SIGCONT "$U" 2>/dev/null
  systemctl --user unmask "$U" 2>/dev/null
  systemctl --user disable "$U" 2>/dev/null
  # The drop-in file has to go before its directory can: rmdir on a directory
  # that still holds 90-no-manual-stop.conf fails, which silently leaves the
  # next run's unit guarded by a drop-in nobody wrote this time.
  rm -f "$D/$U" "$D/$U.d/90-no-manual-stop.conf"
  rmdir "$D/$U.d" 2>/dev/null
  systemctl --user daemon-reload
  # A leaked probe unit is a unit that outlives its run, which is exactly the
  # class of thing this script exists to catch. Fail loudly instead.
  [ -e "$D/$U" ] || [ -d "$D/$U.d" ] && { bad "cleanup left $U behind"; return 1; }
  return 0
}

preflight || exit 1

# ============================================================================
# Leg 1. The whole verb surface, not the five rows the issue happened to list.
# A decision that only covers the rows someone already measured is not a
# decision. rc=4 is the refusal; rc=0 is "it did it".
# ============================================================================
echo "== leg 1: the full lifecycle verb surface against a guarded unit =="
U1=pet470-matrix.service
write_guarded "$U1" 'echo ready; while true; do sleep 0.2; done' || exit 1
[ "$(systemctl --user is-active "$U1" 2>/dev/null)" = "active" ] \
  && ok "probe unit is active before the matrix" || { bad "probe unit did not start"; exit 1; }

verb() {  # verb <label> <expected-rc | '-'> <cmd...>
  # "-" means "record the rc, assert nothing" -- used for verbs whose rc is
  # version-dependent and where the rc itself is the finding. Asserting a guess
  # would make this script fail on a correct measurement.
  local label="$1" exp="$2"; shift 2
  local out rc row
  out=$("$@" 2>&1); rc=$?
  local v; v=$(printf '%s' "$out" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-88)
  row=$(printf '  rc=%-2s  %-34s %s' "$rc" "$label" "${v:-(no output)}")
  printf '%s\n' "$row"
  printf '%s\n' "$row" >> "$PROBE_STATE/verb-matrix"
  case "$exp" in
    "-") return 0 ;;
    "$rc") return 0 ;;
    *) bad "$label: expected rc=$exp, got rc=$rc (${v:-(no output)})"; return 1 ;;
  esac
}

# Several rows below need a live main PID to act on, and the matrix kills its
# own unit as it goes. Waiting for one keeps each row a measurement of the verb
# rather than of the previous row's corpse.
ensure_main() {
  local u="$1" mp
  for _ in $(seq 1 100); do
    mp=$(systemctl --user show "$u" -p MainPID --value 2>/dev/null)
    if [ -n "$mp" ] && [ "$mp" != "0" ]; then printf '%s' "$mp"; return 0; fi
    sleep 0.2
  done
  return 1
}

: > "$PROBE_STATE/verb-matrix"
verb "start (already active)"        - systemctl --user start    "$U1"
verb "stop"                         4 systemctl --user stop     "$U1"
verb "restart"                      4 systemctl --user restart  "$U1"
verb "try-restart"                  - systemctl --user try-restart "$U1"
verb "reload (no ExecReload)"       - systemctl --user reload   "$U1"
verb "reload-or-restart"            - systemctl --user reload-or-restart "$U1"
verb "try-reload-or-restart"        - systemctl --user try-reload-or-restart "$U1"
# suspend/hibernate do not address a unit: on a user manager they are logind
# verbs and reject a unit argument outright. That is the finding, so it is
# recorded rather than asserted. NOT run without a unit -- that would suspend
# the whole session.
verb "suspend <unit> (not a unit verb)" - systemctl --user suspend "$U1"
verb "hibernate <unit> (not a unit verb)" - systemctl --user hibernate "$U1"
verb "reset-failed"                 - systemctl --user reset-failed "$U1"
# CPUQuota is runtime-settable; Restart is not (systemd 261, measured), so
# asking for it would have measured the wrong thing.
verb "set-property CPUQuota"        - systemctl --user set-property "$U1" CPUQuota=50%
verb "kill (default SIGTERM)"       - systemctl --user kill     "$U1"
ensure_main "$U1" >/dev/null
verb "kill --kill-whom=all SIGSTOP" - systemctl --user kill --kill-whom=all --signal=SIGSTOP "$U1"
ensure_main "$U1" >/dev/null
verb "kill --kill-whom=all SIGCONT" - systemctl --user kill --kill-whom=all --signal=SIGCONT "$U1"
ensure_main "$U1" >/dev/null
verb "kill --kill-whom=main SIGSTOP" - systemctl --user kill --kill-whom=main --signal=SIGSTOP "$U1"
ensure_main "$U1" >/dev/null
verb "kill --kill-whom=all SIGKILL" - systemctl --user kill --kill-whom=all --signal=SIGKILL "$U1"

# The unit must still be there after the destructive verbs, or the matrix is
# measuring a unit that already died and every later row is noise.
sleep 0.5
[ "$(systemctl --user is-active "$U1" 2>/dev/null)" = "active" ] \
  && ok "the unit is still active after the whole matrix; no row was a fluke" \
  || bad "unit is $(systemctl --user is-active "$U1" 2>/dev/null) after the matrix"

# disable/mask are the two verbs the drop-in's KNOWN LIMITS section already
# admits to, and they are the ones that outlive the run, so they get their own
# leg rather than a row in a table.
verb "disable"                      - systemctl --user disable  "$U1"
if systemctl --user is-enabled "$U1" 2>/dev/null | grep -q disabled; then
  ok "disable really did remove the wants symlink (rc=0 is not a no-op here)"
else
  bad "disable returned 0 but the unit reports $(systemctl --user is-enabled "$U1" 2>/dev/null)"
fi
verb "enable"                       - systemctl --user enable   "$U1"
# mask refuses for an incidental reason, not because of the guard: the unit file
# is in the search path, so /dev/null cannot take its place. Measured both ways,
# because "mask was refused" and "mask only failed because a file was in the
# way" are different answers and only one of them is a real guard.
verb "mask (file still present)"    - systemctl --user mask     "$U1"
mv "$D/$U1" "$SCRATCH/$U1.saved"
verb "mask (file moved aside)"      - systemctl --user mask     "$U1"
if systemctl --user is-enabled "$U1" 2>/dev/null | grep -q masked; then
  ok "mask works once the unit file is out of the way, so the guard does not refuse it at all"
else
  bad "mask did not take effect: $(systemctl --user is-enabled "$U1" 2>/dev/null)"
fi
verb "unmask"                       - systemctl --user unmask   "$U1"
mv "$SCRATCH/$U1.saved" "$D/$U1"
cleanup_unit "$U1"

# ============================================================================
# Leg 2. The SIGTERM variant the issue calls "a direct kill rather than a
# freeze". The claim is that nothing prevents it. Measured: nothing prevents it,
# but Restart=always plus the guardian do recover it, and how fast is the number
# that decides between "constrain kill" and "detect kill".
# ============================================================================
echo
echo "== leg 2: what a direct kill actually costs (the SIGTERM/SIGKILL variant) =="
U2=pet470-directkill.service
write_guarded "$U2" 'echo ready; while true; do sleep 0.2; done' || exit 1
MP_BEFORE=$(systemctl --user show "$U2" -p MainPID --value)
for SIG in TERM KILL; do
  T0=$(date +%s)
  systemctl --user kill --kill-whom=all --signal=SIG$SIG "$U2" 2>/dev/null
  # Wait for a new main PID, i.e. Restart=actually did the work. A separate
  # flag, not the elapsed seconds: a sub-second recovery would read as a
  # failure if 0 doubled for "did not recover".
  RECOVERED=no; ELAPSED=0
  for _ in $(seq 1 100); do
    MP_NOW=$(systemctl --user show "$U2" -p MainPID --value 2>/dev/null)
    if [ -n "$MP_NOW" ] && [ "$MP_NOW" != "0" ] && [ "$MP_NOW" != "$MP_BEFORE" ] \
       && [ "$(systemctl --user is-active "$U2" 2>/dev/null)" = "active" ]; then
      RECOVERED=yes; ELAPSED=$(( $(date +%s) - T0 )); break
    fi
    sleep 0.2
  done
  if [ "$RECOVERED" = "yes" ]; then
    ok "SIG$SIG --kill-whom=all: Restart=always brought the unit back with a new main PID in ${ELAPSED}s (no human, no guardian tick needed)"
  else
    bad "SIG$SIG --kill-whom=all: unit did not come back on its own; is-active=$(systemctl --user is-active "$U2" 2>/dev/null) MainPID=$(systemctl --user show "$U2" -p MainPID --value 2>/dev/null)"
  fi
  MP_BEFORE=$(systemctl --user show "$U2" -p MainPID --value 2>/dev/null)
done
cleanup_unit "$U2"

# ============================================================================
# Leg 3. The freeze class, for contrast with leg 2. A SIGSTOPped process is
# still a running one as far as is-active is concerned, so this is the variant
# with no automatic recovery at all -- and the only variant the board sat
# through for 13 minutes.
# ============================================================================
echo
echo "== leg 3: what a freeze costs, for contrast (the SIGSTOP variant) =="
U3=pet470-freeze.service
write_guarded "$U3" 'echo ready; while true; do sleep 0.2; done' || exit 1
MP3=$(systemctl --user show "$U3" -p MainPID --value)
systemctl --user kill --kill-whom=all --signal=SIGSTOP "$U3" 2>/dev/null
sleep 0.3
S3=$(stat_of "$MP3")
case "$S3" in *T*) ok "whole cgroup frozen; main PID $MP3 STAT='$S3'" ;; *) bad "expected T, got '$S3'" ;; esac
note "is-active while frozen: $(systemctl --user is-active "$U3" 2>/dev/null) -- this is the check that reported nothing for 13 minutes"
# A restart is refused by the guard, so the only in-band resume is a signal.
systemctl --user restart "$U3" 2>/dev/null; note "restart rc=$? (refused by the guard, so it is not a resume path)"
sleep 12
N3=$(journalctl --user -u "$U3" --since '-30s' --no-pager 2>/dev/null | grep -c 'timed out. Killing.')
[ "${N3:-0}" -ge 1 ] && ok "the stop request could not drain and ran out TimeoutStopSec (${N3} 'timed out. Killing.')" \
  || note "no timeout line in this leg's journal (the drain may not have wedged here)"
# The one-line human resume, the thing a policy must not take away.
systemctl --user kill --kill-whom=all --signal=SIGCONT "$U3" 2>/dev/null
sleep 0.5
S3B=$(stat_of "$MP3")
case "$S3B" in *T*) bad "SIGCONT did not resume it; STAT='$S3B'" ;; *) ok "kill --signal=SIGCONT resumed it in one line; STAT='${S3B:-gone}'" ;; esac
cleanup_unit "$U3"

# ============================================================================
# Leg 4. The one place a human verb is genuinely required. A freeze that spares
# the main PID is logged by the guardian but NOT swept: the guardian will not
# SIGCONT this repo's own test children. This is the measured justification for
# keeping a kill verb open, and it is the strongest single fact in the matrix.
# ============================================================================
echo
echo "== leg 4: the residual gap -- the guardian detects but will not sweep it =="
U4=pet470-heal.service
# The probe guardian above is a sed copy of the real one with UNIT renamed to
# pet470-heal.service, so this leg's unit MUST carry that name or the guardian
# measures a unit that does not exist. That is not a hypothetical: naming it
# anything else made this leg report the guardian's "unit is absent" ALERT
# instead of the residual gap it exists to measure.
#
# 6b needs a wide cgroup: it only fires at >= 8 processes with more than half
# of them stopped. A probe with a couple of children sits under that threshold
# and the leg measures nothing, which is how this leg first reported a clean
# pass for the wrong reason.
write_guarded "$U4" 'for i in $(seq 1 9); do (while true; do sleep 30; done) & done; echo ready; while true; do sleep 0.2; done' 8 || exit 1
MP4=$(systemctl --user show "$U4" -p MainPID --value)
# Freeze the children, spare the main PID: the shape 6b exists for.
CG4=$(systemctl --user show "$U4" -p ControlGroup --value 2>/dev/null)
CGP4="/sys/fs/cgroup${CG4}/cgroup.procs"
[ -r "$CGP4" ] || note "cannot read $CGP4 (unified cgroup layout?); leg 4 is inconclusive"
if [ -r "$CGP4" ]; then
  for CP in $(cat "$CGP4"); do
    [ "$CP" = "$MP4" ] && continue
    kill -STOP "$CP" 2>/dev/null
  done
fi
sleep 0.3
: > "$PROBE_STATE/guardian.log"
"$SCRATCH/guardian-verb-probe.sh" >/dev/null 2>&1
sleep 0.2
S4=$(stat_of "$MP4")
case "$S4" in *T*) bad "main PID is stopped; the guardian should have resumed it" ;; *) ok "main PID $MP4 left running by the guardian (STAT='${S4:-gone}')" ;; esac
if grep -q 'are stopped while the main PID is not' "$PROBE_STATE/guardian.log"; then
  ok "the guardian detected the freeze and said a human must finish it: $(grep -o 'systemctl --user kill[^.]*' "$PROBE_STATE/guardian.log" | head -1)"
else
  bad "the guardian did not report the residual gap; log was: $(head -4 "$PROBE_STATE/guardian.log" 2>/dev/null | tr '\n' ' ')"
fi
# And it must NOT have swept it: that restraint is the whole reason a human
# verb has to stay open.
if grep -qE "sending SIGCONT to main PID|RESUMED main PID" "$PROBE_STATE/guardian.log"; then
  bad "the guardian swept the cgroup; 6b's documented restraint did not hold"
else
  ok "the guardian did NOT sweep the cgroup -- its own documented restraint, and the reason a human verb has to stay open"
fi
# The human finishes it, in one line, with a verb the guard does not refuse.
systemctl --user kill --kill-whom=all --signal=SIGCONT "$U4" 2>/dev/null
sleep 0.4
STILL_STOPPED=0
CG=$(systemctl --user show "$U4" -p ControlGroup --value 2>/dev/null)
for CP in $(cat "/sys/fs/cgroup$CG/cgroup.procs" 2>/dev/null); do
  case "$(stat_of "$CP")" in *T*) STILL_STOPPED=$((STILL_STOPPED + 1)) ;; esac
done
[ "$STILL_STOPPED" -eq 0 ] && ok "the one-line SIGCONT sweep finished the job; 0 processes left stopped" \
  || bad "$STILL_STOPPED processes still stopped after the SIGCONT sweep"
cleanup_unit "$U4"

# ============================================================================
# Leg 5. Whether the D-Bus policy knob (option 2) can express "a human, but not
# an agent". Two independent reasons it cannot, both measured here rather than
# argued: a shared uid, and a second non-D-Bus route to the same method.
# ============================================================================
echo
echo "== leg 5: can a D-Bus deny on KillUnit separate the human from the agent? =="
LIVE_UID=$(ps -o uid= -p "$(systemctl --user show paperclipai.service -p MainPID --value 2>/dev/null)" 2>/dev/null | tr -d ' ')
note "paperclipai.service runs as uid ${LIVE_UID:-?}; this agent is uid $(id -u)"
[ -n "$LIVE_UID" ] && [ "$LIVE_UID" = "$(id -u)" ] \
  && ok "the human operator and the agent are the SAME uid on this host, so a D-Bus rule that denies KillUnit denies the operator too -- it cannot name one and not the other" \
  || note "uids differ ($LIVE_UID vs $(id -u)); a D-Bus rule could in principle tell them apart"

U5=pet470-busprobe.service
write_guarded "$U5" 'echo ready; while true; do sleep 0.2; done' || exit 1
MP5=$(systemctl --user show "$U5" -p MainPID --value)
# 5a. The method is reachable over the user bus, so a user-bus policy is at
#     least in the right place to be tried.
if busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 \
     org.freedesktop.systemd1.Manager KillUnit ssi "$U5" all 19 >/dev/null 2>&1; then
  ok "KillUnit is reachable over the user bus (busctl call returned 0)"
else
  bad "KillUnit over the user bus failed: $(busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager KillUnit ssi "$U5" all 19 2>&1 | head -1)"
fi
systemctl --user kill --kill-whom=all --signal=SIGCONT "$U5" 2>/dev/null
sleep 0.3
# 5b. The same method is reachable over systemd's private socket, which is NOT
#     D-Bus, so no D-Bus policy file governs it. This is the load-bearing leg.
PSOCK="/run/user/$(id -u)/systemd/private"
if [ -S "$PSOCK" ]; then
  if SYSTEMD_BUS_ADDRESS="unix:path=$PSOCK" systemctl --user show "$U5" -p MainPID --value >/dev/null 2>&1; then
    ok "systemctl --user also talks to the manager over $PSOCK"
    if SYSTEMD_BUS_ADDRESS="unix:path=$PSOCK" systemctl --user kill --kill-whom=all --signal=SIGSTOP "$U5" >/dev/null 2>&1; then
      S5=$(stat_of "$MP5")
      case "$S5" in *T*) ok "and kill --kill-whom=all SIGSTOP goes through THAT route too -- a D-Bus deny cannot reach it" ;;
                    *) bad "the private-socket kill returned 0 but main PID STAT='${S5:-gone}'" ;; esac
      note "a D-Bus policy cannot govern this socket: $(busctl --address="unix:path=$PSOCK" call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager ListUnits 2>&1 | head -1) (it is systemd's private protocol, not D-Bus)"
    else
      bad "the private-socket kill was refused"
    fi
    systemctl --user kill --kill-whom=all --signal=SIGCONT "$U5" 2>/dev/null
  else
    note "could not reach the manager over $PSOCK on this host"
  fi
else
  note "no private socket at $PSOCK on this host"
fi
cleanup_unit "$U5"

echo
echo "== the measured matrix, as a table =="
cat "$PROBE_STATE/verb-matrix"
echo
[ "$fail" -eq 0 ] && echo "ALL LEGS PASS" || echo "SOME LEGS FAILED"
exit "$fail"
