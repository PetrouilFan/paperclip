#!/usr/bin/env bash
# paperclip-notify-probe-proof -- the end-to-end proof that
# scripts/paperclip-notify-probe.sh does what its guard claims, against a real
# user manager. Needs a host; not part of `pnpm test`.
#
#   scripts/paperclip-notify-probe-proof.sh
#
# WHAT IT PROVES, and it is the measurement the guard is built on. A notify
# datagram cannot be aimed at a unit. Every unit of one manager shares ONE notify
# socket, and systemd attributes a datagram to the unit the *sending process* is
# in. So the safety of a probe is entirely a question of which cgroup it runs in,
# and this proves both directions:
#
#   A. From inside the control plane's cgroup, every target is refused and the
#      reason names the unit that would have been edited. Nothing is sent.
#   B. Wrapped in a throwaway `systemd-run --user` unit, the same send is allowed,
#      delivered, and lands on the *throwaway* unit's StatusText.
#   C. The control plane's own StatusText is byte-identical before and after.
#   D. A lifecycle key is refused even from the allowed position, so wrapping the
#      probe buys a throwaway unit and not a licence to stop anything.
#   E. A lifecycle key batched onto the end of an allowed one -- one argument, one
#      newline, the exact form `printf '%s\n' "$@"` turns into a two-message
#      datagram -- is refused too, and the throwaway unit is still running
#      afterwards. This is the leg that proves the refusal against the manager: at the
#      head before the newline refusal this same send returned 0 and the unit went to
#      `deactivating (stop-sigterm)`, so a parser-only test cannot stand in for it.
#
# Nothing here touches the control plane. The only datagrams written in this script
# are STATUS= to a throwaway unit, and the whole of part A writes none at all.
#
# The standalone unit proof for the guardian is
# scripts/paperclip-unit-guardian-freeze-proof.sh; this is the same shape of thing
# for the notify guard.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE="$HERE/paperclip-notify-probe.sh"
SOCK="/run/user/$(id -u)/systemd/notify"
OUT="$(mktemp -d)"
fails=0

cleanup() {
  for u in ${UNITS:-}; do
    systemctl --user stop "$u.service" >/dev/null 2>&1
    systemctl --user reset-failed "$u.service" >/dev/null 2>&1
  done
  rm -rf "$OUT"
}
UNITS=""
trap cleanup EXIT

ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
head_() { printf '\n== %s\n' "$*"; }

if ! systemctl --user show paperclipai.service -p MainPID >/dev/null 2>&1; then
  printf 'no user manager on this host; this proof needs one\n'
  exit 2
fi

CP_BEFORE="$(systemctl --user show paperclipai.service -p StatusText --value)"

# --- A. the refusal half, from where a probe is actually run -------------------
head_ "A. from inside the control plane cgroup every target is refused"
# `info` reports rather than enforces -- it is the command an operator runs *before*
# they decide to send anything -- so the assertion is that it names the position
# as long-lived, not that it exits non-zero. `guard` and `notify` are the two that
# have to refuse, and both are checked below.
"$PROBE" info >"$OUT/info.txt" 2>&1
if grep -q 'sender unit .*LONG-LIVED' "$OUT/info.txt"; then
  ok "info reports the sender's unit as long-lived"
else
  bad "info did not report the sender's position"
fi
sed 's/^/        /' "$OUT/info.txt"

if "$PROBE" guard "$SOCK" >"$OUT/guard.txt" 2>&1; then
  bad "guard allowed a send from inside the control plane cgroup"
else
  ok "guard refused the live notify socket"
fi
sed 's/^/        /' "$OUT/guard.txt"

# The reason has to name the unit, or an operator cannot tell which thing they are
# about to edit.
if grep -q 'paperclipai.service' "$OUT/guard.txt"; then
  ok "the refusal names the unit that would have been edited"
else
  bad "the refusal does not name the unit"
fi

if "$PROBE" notify "$SOCK" "STATUS=must-not-be-sent" >"$OUT/notify.txt" 2>&1; then
  bad "notify succeeded from inside the control plane cgroup"
else
  ok "notify refused, so no datagram was written"
fi

# --- B/D. the allowed half, wrapped in a throwaway unit ------------------------
UNIT="pc-probe-proof-$$"
UNITS="$UNITS $UNIT"
head_ "B. wrapped in a throwaway unit the send is allowed and lands there"
systemd-run --user --no-block --unit="$UNIT" --property=Type=exec --property=NotifyAccess=all \
  /bin/bash -c "'$PROBE' info >'$OUT/inner-info.txt' 2>&1;
                '$PROBE' guard '$SOCK' >'$OUT/inner-guard.txt' 2>&1; echo \$? >'$OUT/inner-guard.rc';
                '$PROBE' notify '$SOCK' 'STATUS=pc-probe-proof-ok' >'$OUT/inner-notify.txt' 2>&1; echo \$? >'$OUT/inner-notify.rc';
                '$PROBE' notify '$SOCK' 'STOPPING=1' >'$OUT/inner-stopping.txt' 2>&1; echo \$? >'$OUT/inner-stopping.rc';
                '$PROBE' notify '$SOCK' \$'STATUS=ok\nSTOPPING=1' >'$OUT/inner-batched.txt' 2>&1; echo \$? >'$OUT/inner-batched.rc';
                sleep 12" >/dev/null 2>&1

# The last send is the batched one, so waiting on its rc means every send in the unit
# has already been attempted.
for _ in $(seq 1 60); do
  [ -f "$OUT/inner-batched.rc" ] && break
  sleep 0.25
done

if grep -q 'throwaway, safe to send from' "$OUT/inner-info.txt" 2>/dev/null; then
  ok "the probe reports itself as inside a throwaway unit"
else
  bad "the probe did not recognise its own throwaway unit"
  sed 's/^/        /' "$OUT/inner-info.txt" 2>/dev/null
fi

if [ "$(cat "$OUT/inner-guard.rc" 2>/dev/null)" = "0" ]; then
  ok "guard allowed the send from inside the throwaway unit"
else
  bad "guard refused a send from inside a throwaway unit"
  sed 's/^/        /' "$OUT/inner-guard.txt" 2>/dev/null
fi

if [ "$(cat "$OUT/inner-notify.rc" 2>/dev/null)" = "0" ]; then
  ok "notify delivered one datagram"
else
  bad "notify failed inside the throwaway unit"
  sed 's/^/        /' "$OUT/inner-notify.txt" 2>/dev/null
fi

sleep 1
GOT="$(systemctl --user show "$UNIT.service" -p StatusText --value)"
if [ "$GOT" = "pc-probe-proof-ok" ]; then
  ok "the datagram landed on the throwaway unit (StatusText=$GOT)"
else
  bad "the throwaway unit's StatusText is '$GOT', expected pc-probe-proof-ok"
fi

if [ "$(cat "$OUT/inner-stopping.rc" 2>/dev/null)" = "1" ] && grep -q 'STOPPING' "$OUT/inner-stopping.txt"; then
  ok "D. STOPPING= refused even from the allowed position"
else
  bad "STOPPING= was not refused from inside the throwaway unit"
  sed 's/^/        /' "$OUT/inner-stopping.txt" 2>/dev/null
fi

if [ "$(cat "$OUT/inner-batched.rc" 2>/dev/null)" = "1" ] && grep -q 'single-line KEY=VALUE' "$OUT/inner-batched.txt"; then
  ok "E. a lifecycle key batched after an allowed one is refused"
else
  bad "a batched lifecycle key was not refused from inside the throwaway unit"
  sed 's/^/        /' "$OUT/inner-batched.txt" 2>/dev/null
fi

# The half of E that a parser-only assertion cannot make. A refused datagram writes
# nothing, so if either refusal above had let a STOPPING through, this unit would have
# been told to stop by now -- it is still in the `sleep` at the bottom of its command.
sleep 1
UNIT_STATE="$(systemctl --user is-active "$UNIT.service")"
if [ "$UNIT_STATE" = "active" ]; then
  ok "E. the throwaway unit is still active, so no batched STOPPING= reached the manager"
else
  bad "the throwaway unit is '$UNIT_STATE'; a batched STOPPING= reached the manager"
fi

# --- C. the control plane is untouched ----------------------------------------
head_ "C. the control plane did not move"
CP_AFTER="$(systemctl --user show paperclipai.service -p StatusText --value)"
if [ "$CP_BEFORE" = "$CP_AFTER" ]; then
  ok "paperclipai.service StatusText unchanged: $CP_AFTER"
else
  bad "paperclipai.service StatusText changed from '$CP_BEFORE' to '$CP_AFTER'"
fi
if [ "$(systemctl --user is-active paperclipai.service)" = "active" ]; then
  ok "paperclipai.service is still active"
else
  bad "paperclipai.service is $(systemctl --user is-active paperclipai.service)"
fi

printf '\n'
if [ "$fails" -eq 0 ]; then
  printf 'paperclip-notify-probe-proof: PASS\n'
  exit 0
fi
printf 'paperclip-notify-probe-proof: %d FAILURE(S)\n' "$fails"
exit 1
