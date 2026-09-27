#!/usr/bin/env bash
# Tests the control leg's cgroup derivation and the aim assertion that consumes
# it, without systemd, without root, and without a cgroup fs.
#
# Run: bash scripts/test-control-cgroup-derivation.sh
#
# lever_aim is extracted from the real script rather than reimplemented, so a
# change to the check under test fails this instead of passing a copy of it.

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/slow-boot-proof.sh"

pass_n=0
fail_n=0
ok()   { pass_n=$((pass_n+1)); printf ' ok   %s\n' "$1"; }
bad()  { fail_n=$((fail_n+1)); printf ' FAIL %s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

# --- the code under test, lifted verbatim ----------------------------------
# lever_aim reports its refusals through the script's info(); stub it, or the
# shell runs /usr/bin/info and the test output turns into a texinfo error.
info() { printf 'info: %s\n' "$*" >&2; }

# 1. the derivation, extracted from the control leg so that reverting the fix in
#    slow-boot-proof.sh fails this file. Bounds are the PROOF_IO_CG assignment
#    and the fi that closes its guard.
DERIVE_BLOCK="$(awk '
  /^PROOF_IO_CG="\$IO_CG"$/ { f = 1 }
  f                  { print }
  f && /^fi$/        { exit }
' "$SCRIPT")"
if [ -z "$DERIVE_BLOCK" ]; then
  echo "could not extract the control-leg derivation from $SCRIPT" >&2
  exit 2
fi

derive_control_io_cg() {
  # Mirrors the control leg's real state on entry: IO_CG still holds the cgroup
  # resolved for the unit under test, and the only new information is whatever
  # `show -p ControlGroup` reports for the control unit.
  local IO_CG="$1" CONTROL_UNIT="$2" REPORTED="$3"
  prop() { printf '%s' "$REPORTED"; }
  eval "$DERIVE_BLOCK"
  printf '%s' "$IO_CG"
}

# 2. lever_aim, extracted from the script so we test the real predicate. The
#    cgroup fs prefix is redirected at the same time: the fixtures are a
#    directory tree, and every lever in the script builds its file as
#    "/sys/fs/cgroup$IO_CG/<controller>.<limit>".
ROOT="$HERE/../.test-cgroup-root"
eval "$(awk '/^lever_aim\(\) \{/,/^\}/' "$SCRIPT" \
  | sed "s#/sys/fs/cgroup\\\$IO_CG#$ROOT\\\$IO_CG#g")"
if ! declare -F lever_aim >/dev/null; then
  echo "could not extract lever_aim from $SCRIPT" >&2
  exit 2
fi

# --- fixtures --------------------------------------------------------------
# A real runner path, from run 36276091075. IO_CG is relative to /sys/fs/cgroup,
# which is why every lever prefixes it.
PROOF_CG='/user.slice/user-1001.slice/user@1001.service/app.slice/paperclipai-pet296.service'
CONTROL='paperclipai-pet296-control.service'
CONTROL_CG='/user.slice/user-1001.slice/user@1001.service/app.slice/paperclipai-pet296-control.service'
rm -rf "$ROOT"
mkdir -p "$ROOT${PROOF_CG}" "$ROOT$(dirname "$CONTROL_CG")"
: > "$ROOT${PROOF_CG}/cpu.max"

echo '== control cgroup derivation =='

# The defect: 'show -p ControlGroup' is empty for a never-started unit.
got="$(derive_control_io_cg "$PROOF_CG" "$CONTROL" '')"
check "empty show falls back to the sibling cgroup" "$got" "$CONTROL_CG"

# The normal case must not be disturbed: a started unit reports its own path.
got="$(derive_control_io_cg "$PROOF_CG" "$CONTROL" "$CONTROL_CG")"
check "a reported path is used as-is" "$got" "$CONTROL_CG"

# Both empty: no parent to derive from, and it must stay empty so lever_aim
# fails loudly rather than aiming at '.'.
got="$(derive_control_io_cg '' "$CONTROL" '')"
check "no proof cgroup and no reported path stays empty" "$got" ''

# The derived path must be the proof's parent with only the leaf swapped, so
# check the parent explicitly rather than trusting the string above.
got_parent="$(dirname "$(derive_control_io_cg "$PROOF_CG" "$CONTROL" '')")"
want_parent="$(dirname "$PROOF_CG")"
check "the derived parent is the proof unit's parent" "$got_parent" "$want_parent"

echo
echo '== lever_aim against the derived path =='

UNIT="$CONTROL"
IO_CG="$(derive_control_io_cg "$PROOF_CG" "$CONTROL" '')"
mkdir -p "$ROOT$IO_CG"; : > "$ROOT$IO_CG/cpu.max"
if lever_aim bandwidth:8; then
  ok "7c passes: the derived cgroup's leaf is the control unit"
else
  bad "7c passes: the derived cgroup's leaf is the control unit"
fi
check "  and it reads back a value" "$LEVER_AIM" "bandwidth="

# The pre-fix state, kept as a regression: a stale IO_CG aimed at the proof unit
# is rejected, so the defect cannot come back silently.
UNIT="$CONTROL"
IO_CG="$PROOF_CG"
if lever_aim bandwidth:8; then
  bad "a stale IO_CG is rejected by lever_aim"
else
  ok "a stale IO_CG is rejected by lever_aim"
fi

# An empty IO_CG is still refused, which is what 7c reports on.
UNIT="$CONTROL"
IO_CG=""
if lever_aim bandwidth:8; then
  bad "an empty IO_CG is rejected by lever_aim"
else
  ok "an empty IO_CG is rejected by lever_aim"
fi

# Host-side levers carry no aim to check, so they must not be refused for an
# empty IO_CG -- otherwise the fallback would break them too.
UNIT="$CONTROL"
IO_CG=""
if lever_aim cpu:8; then
  ok "a host-side lever is unaffected by an empty IO_CG"
else
  bad "a host-side lever is unaffected by an empty IO_CG"
fi

rm -rf "$ROOT"
echo
echo "== $pass_n passed, $fail_n failed =="
[ "$fail_n" -eq 0 ]
