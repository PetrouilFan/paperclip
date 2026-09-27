#!/usr/bin/env bash
# Proof for the frozen-cgroup failure class. Every leg runs against a uniquely
# named throwaway unit.
# The live paperclipai.service is never started, stopped or signalled here.
#
# NOTE ON ISOLATION: a running systemd --user manager caches its unit search path
# from the environment it was started with, so faking HOME/XDG_CONFIG_HOME in this
# shell does NOT hide or reveal units to it (measured here: a unit written under a
# faked XDG_CONFIG_HOME comes back "not found", the same trap pinned in
# scripts/e2e-install-lifecycle-isolation.test.mjs). The isolation lever that
# actually works is the unit NAME: a name the host cannot have cannot be reached
# by any verb, and `systemctl --user kill` accepts no pattern here that would
# match both it and the production unit.
set -u
SCRATCH="${PAPERCLIP_RUN_SCRATCH_DIR:?}"
# The guardian under test: the repo copy by default, so a proof run cannot pass
# against a stale installed script. Override with GUARDIAN=... to test a
# deployment.
GUARDIAN="${GUARDIAN:-$(cd "$(dirname "$0")" && pwd)/paperclip-unit-guardian.sh}"
PROBE_STATE="$SCRATCH/guardian-state"
mkdir -p "$PROBE_STATE"
rm -f "$PROBE_STATE"/guardian.log "$PROBE_STATE"/freeze-count

# The healing logic under test, byte-identical to what is installed, with only the
# unit name and the state directory redirected.
sed -e 's|^UNIT="paperclipai.service"|UNIT="guardian-heal-probe.service"|' \
    -e "s|\$HOME/.local/state/paperclip-unit-guardian|$PROBE_STATE|g" \
    "$GUARDIAN" > "$SCRATCH/guardian-probe.sh"
chmod +x "$SCRATCH/guardian-probe.sh"
norm() { sed -e 's|^UNIT=.*|U|' -e "s|\$HOME/.local/state/paperclip-unit-guardian|S|g" -e "s|$PROBE_STATE|S|g" "$1"; }
cmp -s <(norm "$SCRATCH/guardian-probe.sh") <(norm "$GUARDIAN") \
  && echo "  (probe script differs from the guardian under test only in UNIT and state dir)" \
  || { echo "  FATAL: probe script drifted from the guardian under test"; diff <(norm "$SCRATCH/guardian-probe.sh") <(norm "$GUARDIAN"); exit 1; }

fail=0
ok()  { printf '  PASS  %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }
stat_of() { [ -n "${1:-}" ] && [ "${1:-0}" -gt 0 ] 2>/dev/null && ps -o stat= -p "$1" 2>/dev/null; }
D="$HOME/.config/systemd/user"

# --- Leg 1: the incident class itself, on a throwaway unit. A frozen cgroup
#     cannot drain, so a stop request runs out TimeoutStopSec and systemd
#     SIGKILLs the cgroup. That is the 00:50:01 -> 01:07:04 chain, reproduced.
echo "== leg 1: freeze wedge on a throwaway unit (the failure class) =="
U1=guardian-freeze-probe.service
cat > "$D/$U1" <<'UNIT'
[Unit]
Description=frozen-cgroup wedge probe
[Service]
Type=simple
# The trap is the load-bearing part. A SIGSTOPped process still dies on a
# delivered SIGTERM's default action -- measured -- so the freeze only wedges a
# stop when the main process HANDLES SIGTERM, which is what TimeoutStopSec and a
# drain are for, and what the node server does. Without the trap this leg does
# not reproduce, and the 00:50:01 -> 01:07:04 chain looks inexplicable.
ExecStart=/usr/bin/bash -c "trap \"echo draining; sleep 60\" TERM; echo ready; while true; do sleep 0.2; done"
Restart=always
TimeoutStopSec=10
KillMode=control-group
UNIT
systemctl --user daemon-reload
systemctl --user start "$U1" >/dev/null
sleep 0.3
systemctl --user kill --kill-whom=all --signal=SIGSTOP "$U1"
sleep 0.3
MP1=$(systemctl --user show "$U1" -p MainPID --value)
S1=$(stat_of "$MP1")
case "$S1" in *T*) ok "whole cgroup frozen; main PID $MP1 STAT='$S1'" ;; *) bad "expected T, got '$S1'" ;; esac
echo "  (while frozen, is-active reports: $(systemctl --user is-active "$U1") -- this is the check that missed it)"
systemctl --user stop "$U1" >/dev/null 2>&1
# TimeoutStopSec=10 above, so wait past it or the escalation cannot have happened yet.
sleep 13
N1=$(journalctl --user -u "$U1" --since '-30s' --no-pager 2>/dev/null | grep -c 'timed out. Killing.')
[ "${N1:-0}" -ge 1 ] \
  && ok "the stop could not drain and systemd escalated after TimeoutStopSec ($N1 'timed out. Killing.'); a healthy stop never logs this" \
  || bad "expected the stop to wedge, saw $N1 timeout lines"
J1=$(journalctl --user -u "$U1" --since '-40s' --no-pager 2>/dev/null)
grep -q "status=9/KILL" <<<"$J1" \
  && ok "escalation SIGKILLed the cgroup: 'Main process exited, code=killed, status=9/KILL' -- the live log's line" \
  || bad "no 9/KILL line in: $(grep -c 'Killing process' <<<"$J1") Killing lines"
systemctl --user kill --kill-whom=all --signal=SIGCONT "$U1" 2>/dev/null
sleep 1.5
systemctl --user stop "$U1" 2>/dev/null
systemctl --user kill --kill-whom=all --signal=SIGCONT "$U1" 2>/dev/null
rm -f "$D/$U1"; systemctl --user daemon-reload

# --- Leg 2: the guardian's step 6 resumes a frozen main PID.
echo "== leg 2: guardian step 6 resumes a frozen main PID =="
U2=guardian-heal-probe.service
cat > "$D/$U2" <<'UNIT'
[Unit]
Description=guardian heal probe
[Service]
Type=simple
ExecStart=/usr/bin/sleep 300
Restart=always
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable "$U2" >/dev/null 2>&1
systemctl --user start "$U2" >/dev/null
sleep 0.3
MP2=$(systemctl --user show "$U2" -p MainPID --value)
systemctl --user kill --kill-whom=all --signal=SIGSTOP "$U2"
sleep 0.3
BEFORE=$(stat_of "$MP2")
case "$BEFORE" in *T*) ok "frozen before heal; main PID $MP2 STAT='$BEFORE'" ;; *) bad "expected T before heal, got '$BEFORE'" ;; esac
"$SCRATCH/guardian-probe.sh" >/dev/null 2>&1
sleep 0.3
AFTER=$(stat_of "$MP2")
case "$AFTER" in *T*) bad "still frozen after heal, STAT='$AFTER'" ;; *) ok "heal resumed it; STAT='$AFTER'" ;; esac
grep -q "FROZEN main PID $MP2" "$PROBE_STATE/guardian.log" \
  && ok "logged the freeze, naming PID $MP2" || bad "no FROZEN log line: $(cat "$PROBE_STATE/guardian.log" 2>/dev/null)"
grep -q "RESUMED main PID $MP2" "$PROBE_STATE/guardian.log" \
  && ok "logged the resume" || bad "no RESUMED log line"
[ "$(cat "$PROBE_STATE/freeze-count" 2>/dev/null)" = "1" ] \
  && ok "freeze-count incremented to 1" || bad "freeze-count is $(cat "$PROBE_STATE/freeze-count" 2>/dev/null)"

# --- Leg 3: negative control. A healthy unit must be left strictly alone.
echo "== leg 3: negative control - healthy unit is untouched =="
: > "$PROBE_STATE/guardian.log"
"$SCRATCH/guardian-probe.sh" >/dev/null 2>&1
sleep 0.2
STILL=$(stat_of "$MP2")
case "$STILL" in *T*) bad "signalled something on a healthy run" ;; *) ok "no signal sent to a healthy main PID; STAT='$STILL'" ;; esac
[ -s "$PROBE_STATE/guardian.log" ] \
  && bad "logged on a healthy run: $(cat "$PROBE_STATE/guardian.log")" \
  || ok "silent on a healthy run"
[ "$(cat "$PROBE_STATE/freeze-count" 2>/dev/null)" = "0" ] \
  && ok "freeze-count reset to 0" || bad "freeze-count not reset"

# --- Leg 4: a freeze that SIGCONT does not hold must escalate, not repeat quietly.
echo "== leg 4: repeat freeze escalates to ALERT =="
for i in 1 2 3; do
  systemctl --user kill --kill-whom=all --signal=SIGSTOP "$U2" 2>/dev/null
  "$SCRATCH/guardian-probe.sh" >/dev/null 2>&1
done
grep -q 'consecutive guardian ticks' "$PROBE_STATE/guardian.log" \
  && ok "escalated to ALERT by the 3rd consecutive detection" \
  || bad "no escalation line: $(cat "$PROBE_STATE/guardian.log")"
grep -q "RefuseManualStop=yes does NOT block" "$PROBE_STATE/guardian.log" \
  && ok "the ALERT names the bypass that makes this possible" || bad "escalation does not name the cause"

systemctl --user kill --kill-whom=all --signal=SIGCONT "$U2" 2>/dev/null
sleep 0.5
rm -f "$D/$U2"; rmdir "$D/$U2.d" 2>/dev/null; systemctl --user daemon-reload

# --- Leg 5: step 6b must actually fire. It did not, for its whole life.
#     Found by PET-470 on 2026-09-27: the third test in the 6b condition was
#     missing its closing bracket, so the `if` was a syntax error on every run,
#     the branch was never taken, and the residual-gap ALERT had never once been
#     printed. `bash -n` does not catch it -- a missing `]` inside a command
#     substitution is a runtime error, not a parse error -- and nothing asserted
#     the branch, so it shipped broken in ef372182b. A detector nobody has ever
#     seen fire is not a detector.
echo "== leg 5: step 6b fires on a freeze that spared the main PID =="
U5=pet452-heal.service
# 6b needs >= 8 processes in the cgroup with more than half of them stopped, so
# the probe forks children rather than running a single process.
cat > "$D/$U5" <<'UNIT'
[Unit]
Description=guardian 6b residual-gap probe
[Service]
Type=simple
ExecStart=/usr/bin/bash -c "for i in $(seq 1 9); do (while true; do sleep 30; done) & done; echo ready; while true; do sleep 0.2; done"
Restart=always
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable "$U5" >/dev/null 2>&1
# Leg 2 left a pet452-heal.service running, and `start` on a running unit is a
# no-op -- so without this the probe below would keep serving leg 2's
# single-process fixture and 6b could never reach its 8-process floor.
systemctl --user kill --kill-whom=all --signal=SIGCONT "$U5" 2>/dev/null
systemctl --user stop "$U5" 2>/dev/null
systemctl --user start "$U5" >/dev/null
sleep 0.5
MP5=$(systemctl --user show "$U5" -p MainPID --value)
CG5=$(systemctl --user show "$U5" -p ControlGroup --value)
TOTAL5=$(cat "/sys/fs/cgroup$CG5/cgroup.procs" 2>/dev/null | wc -l)
[ "$TOTAL5" -ge 8 ] || bad "the 6b probe needs >= 8 processes to be meaningful, got $TOTAL5"
# Stop every process but the main PID: the exact shape 6b exists to catch.
for cpid in $(cat "/sys/fs/cgroup$CG5/cgroup.procs" 2>/dev/null); do
  [ "$cpid" = "$MP5" ] && continue
  kill -STOP "$cpid" 2>/dev/null
done
sleep 0.3
case "$(stat_of "$MP5")" in *T*) bad "the main PID should still be running for this leg" ;; esac
: > "$PROBE_STATE/guardian.log"
"$SCRATCH/guardian-probe.sh" >/dev/null 2>&1
sleep 0.2
grep -q 'are stopped while the main PID is not' "$PROBE_STATE/guardian.log" \
  && ok "6b counted the freeze and told a human to finish it by hand" \
  || bad "6b did NOT fire; this is the exact regression leg 5 exists to catch. log: $(cat "$PROBE_STATE/guardian.log")"
grep -q 'systemctl --user kill --kill-whom=all --signal=SIGCONT' "$PROBE_STATE/guardian.log" \
  && ok "the ALERT names the one-line recovery command" \
  || bad "the 6b ALERT does not name a recovery command"
# And the restraint must hold: 6b counts, it does not signal.
grep -qE 'sending SIGCONT to main PID|RESUMED main PID' "$PROBE_STATE/guardian.log" \
  && bad "6b swept the cgroup; its documented detection-only restraint did not hold" \
  || ok "6b did not signal, as documented"
systemctl --user kill --kill-whom=all --signal=SIGCONT "$U5" 2>/dev/null
sleep 0.5
rm -f "$D/$U5"; rmdir "$D/$U5.d" 2>/dev/null; systemctl --user daemon-reload
echo
[ "$fail" -eq 0 ] && echo "ALL LEGS PASS" || echo "SOME LEGS FAILED"
exit "$fail"
