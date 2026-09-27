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
#   F. The two attacks that switched the FIRST version of this guard off, replayed
#      against the current one from inside the live cgroup. Both were measured to
#      produce an ALLOWED verdict at that head, and both are cheap: a `mkdir` of the
#      unit's entry in systemd's transient runtime directory, and two environment
#      variables naming files the caller wrote a moment earlier. The guard must still
#      refuse, and the control plane's StatusText must still be unchanged.
#
# Nothing here touches the control plane. The only datagrams written in this script
# are STATUS= to a throwaway unit, and the whole of parts A and F write none at all.
#
# The standalone unit proof for the guardian is
# scripts/paperclip-unit-guardian-freeze-proof.sh; this is the same shape of thing
# for the notify guard.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE="$HERE/paperclip-notify-probe.sh"
SOCK="/run/user/$(id -u)/systemd/notify"
# The unit the probe must never send from, and this harness must never write to.
# It is a constant here for the same reason it is one in the probe: read from the
# environment it would be a value a caller could point somewhere harmless, and part F
# of this script is specifically about callers doing that.
CONTROL_UNIT_NAME="paperclipai.service"
OUT="$(mktemp -d)"
fails=0

cleanup() {
  for u in ${UNITS:-}; do
    systemctl --user stop "$u.service" >/dev/null 2>&1
    systemctl --user reset-failed "$u.service" >/dev/null 2>&1
  done
  rmdir "/run/user/$(id -u)/systemd/transient/$CONTROL_UNIT_NAME" >/dev/null 2>&1
  rm -rf "$OUT"
}
UNITS=""
trap cleanup EXIT

ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
head_() { printf '\n== %s\n' "$*"; }

if ! systemctl --user show "$CONTROL_UNIT_NAME" -p MainPID >/dev/null 2>&1; then
  printf 'no user manager on this host; this proof needs one\n'
  exit 2
fi

CP_BEFORE="$(systemctl --user show "$CONTROL_UNIT_NAME" -p StatusText --value)"

# --- A. the refusal half, from where a probe is actually run -------------------
head_ "A. from inside the control plane cgroup every target is refused"
# `info` is asked for its verdict rather than its exit status, because `info` reports
# and does not enforce -- it is the command an operator runs *before* they decide to
# send anything. The assertion is that its verdict is the same REFUSED the enforcing
# commands return, which is the property that `info` goes through the guard rather than
# beside it. `guard` and `notify` are the two that have to refuse on exit status.
"$PROBE" info "$SOCK" >"$OUT/info.txt" 2>&1
if grep -q 'verdict             REFUSED' "$OUT/info.txt"; then
  ok "info reports the live notify socket as REFUSED"
else
  bad "info did not report a refusal for the live notify socket"
fi
sed 's/^/        /' "$OUT/info.txt"

if grep -q 'sender unit .*paperclipai\.service' "$OUT/info.txt"; then
  ok "info names the unit the sender is inside"
else
  bad "info did not report the sender's unit"
fi

if "$PROBE" guard "$SOCK" >"$OUT/guard.txt" 2>&1; then
  bad "guard allowed a send from inside the control plane cgroup"
else
  ok "guard refused the live notify socket"
fi
sed 's/^/        /' "$OUT/guard.txt"

# The reason has to name the unit, or an operator cannot tell which thing they are
# about to edit.
if grep -q 'paperclipai\.service' "$OUT/guard.txt"; then
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
  /bin/bash -c "'$PROBE' info '$SOCK' >'$OUT/inner-info.txt' 2>&1;
                '$PROBE' guard '$SOCK' >'$OUT/inner-guard.txt' 2>&1; echo \$? >'$OUT/inner-guard.rc';
                '$PROBE' notify '$SOCK' 'STATUS=pc-probe-proof-ok' >'$OUT/inner-notify.txt' 2>&1; echo \$? >'$OUT/inner-notify.rc';
                '$PROBE' notify '$SOCK' 'STOPPING=1' >'$OUT/inner-stopping.txt' 2>&1; echo \$? >'$OUT/inner-stopping.rc';
                '$PROBE' notify '$SOCK' \$'STATUS=ok\nSTOPPING=1' >'$OUT/inner-batched.txt' 2>&1; echo \$? >'$OUT/inner-batched.rc';
                '$PROBE' notify '$SOCK' 'MAINPID=1' >'$OUT/inner-mainpid.txt' 2>&1; echo \$? >'$OUT/inner-mainpid.rc';
                sleep 12" >/dev/null 2>&1

# The last send is the MAINPID one, so waiting on its rc means every send in the unit
# has already been attempted.
for _ in $(seq 1 60); do
  [ -f "$OUT/inner-mainpid.rc" ] && break
  sleep 0.25
done

if grep -q 'ownership           transient' "$OUT/inner-info.txt" 2>/dev/null; then
  ok "the probe reports itself as inside a throwaway unit"
else
  bad "the probe did not recognise its own throwaway unit"
  sed 's/^/        /' "$OUT/inner-info.txt" 2>/dev/null
fi

if grep -q 'verdict             ALLOWED' "$OUT/inner-info.txt" 2>/dev/null; then
  ok "info's verdict inside the throwaway unit is the same one guard acts on"
else
  bad "info's verdict inside the throwaway unit is not ALLOWED"
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

# MAINPID= is the field the first version of the key check did not name, and it is
# the one that matters: it re-points the unit's recorded main process, which is the
# process a stop signals under KillMode=process (PET-621's gap). Measured at that head
# against a throwaway unit, MainPID went 226683 -> 226685 after one probe. The
# allowlist refuses it on its own account, not because the cgroup guard happened to be
# in the way.
if [ "$(cat "$OUT/inner-mainpid.rc" 2>/dev/null)" = "1" ] && grep -q 'MAINPID= is not a field' "$OUT/inner-mainpid.txt"; then
  ok "MAINPID= is refused from the allowed position, on its own account"
else
  bad "MAINPID= was not refused from inside the throwaway unit"
  sed 's/^/        /' "$OUT/inner-mainpid.txt" 2>/dev/null
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

# --- F. the two attacks that switched the first version of this guard off --------
head_ "F. the first version's two bypasses, replayed against this one"
# Both of these returned an ALLOWED verdict at the head before this change, from
# inside this very cgroup, and both are the kind of thing that reads as a design
# property in the file it lives in. Replayed verbatim:
#
#   * S1. One `mkdir` of the live unit's entry in systemd's transient runtime
#     directory. That directory is `drwxr-xr-x` and owned by the caller, so a bare
#     existence test is a thing the caller can arrange. The guard used to print
#     "paperclipai.service (throwaway, safe to send from)" when it was in place.
#   * B1. Two environment variables naming files the caller wrote a moment earlier,
#     which the enforcing path used to read the cgroup from and the transient root
#     from. They are named here even though the current head has no such variable, so
#     that reintroducing one under any name is visible in this transcript.
TRANSIENT_DIR="/run/user/$(id -u)/systemd/transient/$CONTROL_UNIT_NAME"
FORGED_CGROUP="$OUT/forged-cgroup"
printf '0::/user.slice/user-1000.slice/user@1000.service/app.slice/pc-probe-forged.service\n' >"$FORGED_CGROUP"
FORGED_OWNED=0
if mkdir -p "$TRANSIENT_DIR" 2>/dev/null; then
  FORGED_OWNED=1
  ok "forged $TRANSIENT_DIR (the directory the first version tested for existence)"
else
  bad "could not create $TRANSIENT_DIR, so the S1 half of this leg did not run"
fi

FORGE_ENV=(
  "SELF_CGROUP_FILE=$FORGED_CGROUP"
  "TRANSIENT_ROOT=$(dirname "$TRANSIENT_DIR")"
  "PAPERCLIP_PROBE_SELF_CGROUP_FILE=$FORGED_CGROUP"
  "PAPERCLIP_PROBE_TRANSIENT_ROOT=$(dirname "$TRANSIENT_DIR")"
  "PAPERCLIP_PROBE_CONTROL_UNIT=pc-probe-forged.service"
)
if env "${FORGE_ENV[@]}" "$PROBE" guard "$SOCK" >"$OUT/forged-guard.txt" 2>&1; then
  bad "guard ALLOWED a send from inside the control plane cgroup with both bypasses in place"
else
  ok "guard still refuses with the forged directory and every legacy fixture variable set"
fi
sed 's/^/        /' "$OUT/forged-guard.txt"

if env "${FORGE_ENV[@]}" "$PROBE" notify "$SOCK" "STATUS=must-not-land" >"$OUT/forged-notify.txt" 2>&1; then
  bad "notify delivered a datagram with both bypasses in place"
else
  ok "notify still refuses with both bypasses in place, so no datagram was written"
fi

# The refusal must not be a different refusal: a guard that merely broke would pass
# the two checks above while no longer naming the unit, which is the part an operator
# acts on.
if grep -q 'paperclipai\.service' "$OUT/forged-guard.txt"; then
  ok "the refusal under attack still names the unit that would have been edited"
else
  bad "the refusal under attack does not name the unit"
fi

if [ "$FORGED_OWNED" = "1" ]; then
  rmdir "$TRANSIENT_DIR" 2>/dev/null || true
  if [ -d "$TRANSIENT_DIR" ]; then
    bad "left $TRANSIENT_DIR behind"
  else
    ok "removed the forged directory"
  fi
fi

# --- C. the control plane is untouched ----------------------------------------
# This runs last on purpose. CP_BEFORE is read before part A, so the comparison
# covers every datagram in the script -- including the two that part F tried to make
# land and could not. There is no separate "did F change anything" check because this
# line is that check.
head_ "C. the control plane did not move"
CP_AFTER="$(systemctl --user show "$CONTROL_UNIT_NAME" -p StatusText --value)"
if [ "$CP_BEFORE" = "$CP_AFTER" ]; then
  ok "$CONTROL_UNIT_NAME StatusText unchanged: $CP_AFTER"
else
  bad "$CONTROL_UNIT_NAME StatusText changed from '$CP_BEFORE' to '$CP_AFTER'"
fi
if [ "$(systemctl --user is-active "$CONTROL_UNIT_NAME")" = "active" ]; then
  ok "$CONTROL_UNIT_NAME is still active"
else
  bad "$CONTROL_UNIT_NAME is $(systemctl --user is-active "$CONTROL_UNIT_NAME")"
fi

printf '\n'
if [ "$fails" -eq 0 ]; then
  printf 'paperclip-notify-probe-proof: PASS\n'
  exit 0
fi
printf 'paperclip-notify-probe-proof: %d FAILURE(S)\n' "$fails"
exit 1
