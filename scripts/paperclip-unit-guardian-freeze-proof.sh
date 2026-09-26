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
sed -e 's|^UNIT="paperclipai.service"|UNIT="pet452-heal.service"|' \
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
U1=pet452-freeze.service
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
U2=pet452-heal.service
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
echo
[ "$fail" -eq 0 ] && echo "ALL LEGS PASS" || echo "SOME LEGS FAILED"
exit "$fail"
