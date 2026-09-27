#!/usr/bin/env bash
# paperclip-notify-probe -- the sanctioned way for a script in this repo to write a
# systemd notification datagram, and the shared guard every probe should call
# before it touches systemd IPC at all.
#
# WHY THIS EXISTS. Every agent run on this host inherits NOTIFY_SOCKET from the
# control plane, and every agent run also sits *inside* the control plane unit's
# cgroup. The combination is a capability, measured from inside a live run on
# 2026-09-27 without sending anything harmful:
#
#   $ env | grep -c '^NOTIFY_SOCKET='
#   1
#   $ cat /proc/self/cgroup
#   0::/user.slice/user-1000.slice/user@1000.service/app.slice/paperclipai.service
#   $ systemctl --user show paperclipai.service -p NotifyAccess
#   NotifyAccess=all
#
#   # a STATUS= datagram written from that run process:
#   $ systemctl --user show paperclipai.service -p StatusText
#   StatusText=<the exact marker this run had just sent>
#
# The marker is elided because its value is not the point: what the line
# shows is that the text we sent is the text the unit now reports, from a
# process that had no business sending it.
#
# STATUS= is the cheapest datagram there is and it already lands. STOPPING=1 is
# the same socket, the same cgroup and the same access check, so "I only sent the
# harmless one" is not a defence -- it is the same bug with less damage.
#
# WHAT MEASUREMENT CHANGED, and it is the whole design. The obvious guard is
# "refuse to write to a socket the probe does not own", which needs a per-unit
# socket to exist. It does not. Measured on this host, 2026-09-27:
#
#   # a throwaway unit started with systemd-run --user, and its own child's env:
#   $ tr '\0' '\n' < /proc/$(systemctl --user show pc-probe-x.service -p MainPID --value)/environ \
#       | grep NOTIFY_SOCKET
#   NOTIFY_SOCKET=/run/user/1000/systemd/notify
#
#   # ...which is byte-for-byte the control plane's own NOTIFY_SOCKET. Every unit
#   # of one manager shares ONE notify socket. So a path cannot name an owner, and
#   # "send STATUS= to unit X" is a category error rather than a risky operation.
#
# Attribution follows the *sender*, and that is the good news. Two more probes on
# the same day, same socket, from inside two different throwaway units:
#
#   sender pc-probe-own-A  ->  pc-probe-own-A.service  StatusText=i-am-the-sender
#   sender pc-probe-own-A  ->  pc-probe-other-B.service StatusText=(empty)
#   sender inside a run    ->  paperclipai.service     StatusText=<overwritten>
#
# A datagram cannot be aimed. It is always applied to the unit the sending process
# is in. Which means the hazard is not the target, it is the sender: a probe only
# has to be in a throwaway unit to be safe, and one wrong cgroup to be a
# board-wide problem. So the guard checks the cgroup, and it is the guard.
#
# WHAT A FIRST ATTEMPT GOT WRONG, and it is the reason this guard is shaped the
# way it is now. The first version proved "this unit is a throwaway" by testing
# `[ -e /run/user/$(id -u)/systemd/transient/$u ]` -- systemd's runtime directory
# for units it created itself. That reads like a fact about the world and is not
# one: the directory is `drwxr-xr-x` and owned by the user running the probe, so
# *the caller* can write it.
# Measured on this host, 2026-09-27, against the first version: with the live
# `paperclipai.service` cgroup and one `mkdir` of
# `/run/user/$(id -u)/systemd/transient/paperclipai.service`, the guard exited 0
# and told the operator the live unit was "throwaway, safe to send from". The
# header of that version claimed the runtime dir meant "a caller cannot vouch for
# itself". It was exactly inverted. Two `PAPERCLIP_PROBE_*` environment variables
# turned the same check off a second way, because the cgroup *file* was read from
# the environment on the enforcing path.
#
# So the properties this guard uses are the ones a caller cannot write:
#
#   * the sender's cgroup path, from /proc/self/cgroup. The kernel writes it and
#     there is exactly one of it.
#   * whether the sender's unit is one systemd created, from
#     `systemctl --user show <unit> -p UnitFileState` -- a fact about a *loaded*
#     unit, which a directory does not have.
#   * that systemd agrees this process is inside that unit, by comparing the
#     unit's MainPID's cgroup path to the sender's own. A unit name alone is a
#     string; a MainPID is a running process, and its cgroup cannot be edited
#     from a file.
#   * whether the control unit's own cgroup is the sender's, from the same
#     comparison against a unit this script names rather than one the caller
#     does.
#
# Every one of those is on the enforcing path. There is no argument, flag or
# environment variable that substitutes a fixture for any of them; the only way
# to hand the guard a synthetic fact is the `selftest` subcommand, which `guard`
# and `notify` cannot reach.
#
# The two durable halves of the fix live elsewhere and this is neither of them:
#   * The server-side scrub is sanitizeInheritedPaperclipEnv in
#     packages/adapter-utils/src/server-utils.ts, which drops these four names
#     from a run child's environment. It covers runs the control plane spawns.
#   * The unit-side half is NotifyAccess=main, which makes systemd reject a
#     datagram from anything but the main process.
# Neither covers *our* diagnostic harnesses: a shell script invoked by an agent
# run never passes through sanitizeInheritedPaperclipEnv, and the unit is still
# NotifyAccess=all until that PR lands. This is the restart-free mitigation, and
# that is why it can merge now without touching the unit.
#
# WHAT IT GUARANTEES
#   1. It scrubs NOTIFY_SOCKET, LISTEN_PID, LISTEN_FDS and LISTEN_FDNAMES from its
#      own environment before it does anything, so no send path can fall back to
#      an inherited socket. The same four names the server scrub drops, which
#      scripts/paperclip-notify-probe.test.mjs asserts by reading both sources.
#   2. It refuses to write from inside a long-lived unit's cgroup, and names the
#      unit. A throwaway transient unit is the only position from which a send is
#      allowed. Fails closed when the cgroup cannot be read, when it names no
#      unit, and when systemd cannot confirm the position.
#
#      Two positions are worth being precise about, because an earlier version of
#      this header got one of them wrong. A terminal probe is usually NOT inside
#      `user@1000.service`: a desktop session puts it in a scope
#      (`app-org.kde.konsole-2142.scope`), and systemd reports no `MainPID` for a
#      scope, so the position cannot be verified and the send is refused. The
#      refusal is real, but it is not because a scope lacks a runtime directory --
#      a scope has one, which is why the first version of this guard called it
#      disposable. It is refused because there is no main process to agree that
#      the process asking is inside it.
#   3. It sends only STATUS=, ERRNO= or BUSERROR=, and refuses every other field.
#      This is an allowlist rather than a list of known-bad keys, and the reason
#      is that the denylist was found to be incomplete by measurement. systemd's
#      protocol has more state-changing fields than the first version named. Two
#      of them, both measured on this host on 2026-09-27 against a throwaway unit:
#      `MAINPID=` re-points the unit's recorded main process -- read from outside,
#      a unit's MainPID went from 226683 to 226685 after a probe wrote it -- which
#      is exactly the process a stop signals under `KillMode=process` (PET-621's
#      gap). And `NOTIFYACCESS=` re-opens the unit's own notify access mid-flight,
#      which is the setting this whole ticket is about. Neither was on the list,
#      and neither would have been: the only way to know the list is complete is
#      to refuse the fields that were not thought of. There is no flag to widen
#      it, because a probe that needs a fourth field is the bug.
#   4. It never uses systemd-notify. systemd-notify takes no target and reads
#      NOTIFY_SOCKET from the environment, so its "target" is whatever the caller
#      happened to inherit -- the exact failure this script exists to remove. The
#      datagram is written directly, so the socket is an explicit argument.
#
# USAGE
#   paperclip-notify-probe.sh info [socket]        # print the guard's verdict, no datagram
#   paperclip-notify-probe.sh guard [socket]       # exit 0 only if a write would be allowed
#   paperclip-notify-probe.sh notify [socket] <KEY=VALUE>...
#   paperclip-notify-probe.sh scrub-env <cmd> [args...]   # run a child scrubbed
#   paperclip-notify-probe.sh selftest <fn> <facts...>     # see SELFTEST below
#
# `notify` requires the socket to be named. The scrubbed-out NOTIFY_SOCKET is
# deliberately not used as a fallback: an implicit target is the bug this script
# exists to remove. In every case the send must be wrapped so the probe runs
# *inside* a throwaway unit:
#
#   systemd-run --user --unit="pc-probe-$$" --property=Type=exec \
#     --property=NotifyAccess=all \
#     scripts/paperclip-notify-probe.sh notify "STATUS=probe-$$"
#
# --property=Type=exec, not Type=notify: a Type=notify unit is `activating` until
# it sends READY=1, which the allowlist refuses, so it would die on
# TimeoutStartSec every time. Type=exec with NotifyAccess=all is a unit that is
# live immediately, has a notify socket, and accepts a STATUS= at any time.
#
# SELFTEST is the only way to supply synthetic facts, and it is unreachable from
# `guard` and `notify` because the dispatch for those two reaches only the
# derivation below, which has no parameters:
#
#   selftest unit <cgroup-path>                       # the sender's unit name
#   selftest guard <self-cg> <ctl-cg> <ctl-why> <ownership> [socket]
#   selftest message <KEY=VALUE>...
#   selftest ownership <unit> <cgroup-path>           # needs a live user manager
#
# <self-cg> is the sender's cgroup path, <ctl-cg> the control unit main process's
# cgroup path, <ctl-why> a non-empty string when that could not be read, and
# <ownership> one of transient|long-lived|unknown. scripts/paperclip-notify-probe.test.mjs
# drives these so the decision can be tested on a host with no manager and no root.
#
# EXIT CODES: 0 allowed (or, for notify, delivered), 1 refused, 2 usage error,
# 3 no datagram transport available on this host.

set -uo pipefail

# The unit this probe must never send from, by name. It is a constant and not a
# variable on purpose: read from the environment, it is one more value a caller
# could point somewhere harmless, and it is redundant with the ownership check
# below, which asks systemd about whichever unit the sender is actually in. A
# non-default instance runs `paperclipai-<id>.service`; edit this line for one.
CONTROL_UNIT="paperclipai.service"
# This is a user-plane tool. The system manager's socket is a different manager,
# its units are not in this process's cgroup hierarchy, and nothing here can
# reason about what a write there would touch.
SYSTEM_MANAGER_SOCKET="/run/systemd/notify"

# Filled in by read_position, read only by guard_verdict.
SELF_CGROUP=""
SELF_UNIT=""
CONTROL_CGROUP=""
CONTROL_WHY=""
OWNERSHIP=""
# Filled in by guard_probe, which is the only caller of guard_verdict outside
# `selftest`. It is a variable rather than stdout so that `info` can reach the
# enforcing path and still show what the guard decided: a display command that
# called the decision directly would be a second way in.
GUARD_REASON=""

# Rule 1, and it has to be the first thing in the file: everything below is safer
# if the inherited socket is already gone, and the whole point of scrubbing is
# that it must not depend on the caller having cleaned up first.
scrub_ipc_env() {
  unset NOTIFY_SOCKET LISTEN_PID LISTEN_FDS LISTEN_FDNAMES
}

# --- facts -------------------------------------------------------------------
# Every function in this section reads the kernel or systemd, and none of them
# takes a value from the caller. That is the property the whole guard rests on.

# The cgroup v2 path of a process. cgroup v1 only: the unified line is the `0::`
# one, so a v1-only file has no such line and this reports nothing, which the
# guard treats as "cannot be proven" rather than as "no unit in the way".
cgroup_path_of() {
  local f="/proc/$1/cgroup" line
  [ -r "$f" ] || return 1
  line="$(sed -n 's|^0::||p' "$f" 2>/dev/null | head -1)"
  [ -n "$line" ] || return 1
  printf '%s' "$line"
}

# The unit a process is in, from its cgroup path. A user unit's path is
# .../<name>.service (or .scope, or .mount) as its last component. Returns 1 when
# the path names no unit -- the root cgroup `/` strips to the empty string, and a
# function that printed nothing and claimed success would be indistinguishable from
# a unit the guard had checked and found fine.
sender_unit_of() {
  local path="${1:-}" name
  [ -n "$path" ] || return 1
  name="${path##*/}"
  [ -n "$name" ] || return 1
  printf '%s' "$name"
}

# The control unit's main process cgroup path, and why it could not be read.
# Returns 1 when the answer is unknown; sets CONTROL_WHY either way, because
# "not found on this host" and "could not be asked" are different facts and the
# operator needs to be told which one applies.
read_control_cgroup() {
  local props load main
  CONTROL_CGROUP=""
  if ! command -v systemctl >/dev/null 2>&1; then
    CONTROL_WHY="systemctl is not on PATH, so this process cannot be proven to be outside $CONTROL_UNIT's cgroup"
    return 1
  fi
  props="$(systemctl --user show "$CONTROL_UNIT" -p LoadState -p MainPID 2>/dev/null)" || props=""
  load="$(printf '%s\n' "$props" | sed -n 's/^LoadState=//p')"
  main="$(printf '%s\n' "$props" | sed -n 's/^MainPID=//p')"
  case "$load" in
    not-found)
      # systemd says no unit by this name exists here, so there is no live
      # control-plane unit for a datagram to be applied to. A caller cannot make
      # this branch true while the unit is running, because systemd is the one
      # reporting it.
      CONTROL_WHY=""
      return 0
      ;;
    loaded | error | bad)
      ;;
    *)
      CONTROL_WHY="systemctl did not report LoadState for $CONTROL_UNIT, so this process cannot be proven to be outside its cgroup"
      return 1
      ;;
  esac
  case "$main" in
    '' | 0 | *[!0-9]*)
      # Loaded, but no live main process. This is NOT "safe": a deactivating unit
      # under KillMode=process can still have a populated cgroup, so a process
      # inside it is possible and the comparison below would have nothing to
      # compare. Refuse rather than assume.
      CONTROL_WHY="$CONTROL_UNIT is loaded but has no live main process, so it cannot be proven that this process is not inside its cgroup"
      return 1
      ;;
  esac
  CONTROL_CGROUP="$(cgroup_path_of "$main")" || {
    CONTROL_WHY="/proc/$main/cgroup is unreadable, so the cgroup of $CONTROL_UNIT's main process could not be read"
    CONTROL_CGROUP=""
    return 1
  }
  return 0
}

# Whether the sender's unit is one systemd created for a probe: transient, and
# with a main process that systemd places in the sender's own cgroup. Prints
# transient|long-lived|unknown; only the first is ever allowed.
#
# Neither half is a claim the caller can make. The unit name is not an input --
# it is the last component of the caller's own cgroup path, so naming a unit is
# not how you get inside it. UnitFileState is systemd's answer about a loaded
# unit, and the first version of this guard asked a directory instead, which the
# caller owns. The MainPID comparison is what stops a name from standing in for a
# position: it has to be a real process, in this exact cgroup, or the answer is
# unknown and unknown refuses.
#
# Note that UnitFileState=transient alone does NOT separate a throwaway unit from
# a session scope -- both report `transient` with an empty SourcePath. That is not
# a problem here, and the reason is worth stating so nobody "fixes" it: a scope
# reports no MainPID at all, so it never reaches the transient verdict. It is
# refused as unknown, which is the conservative answer and happens to be the one
# this guard wants.
sender_unit_ownership() {
  local u="$1" self_cg="$2" props main
  [ -n "$u" ] || { printf 'unknown'; return 0; }
  command -v systemctl >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  props="$(systemctl --user show "$u" -p UnitFileState -p MainPID 2>/dev/null)" || props=""
  main="$(printf '%s\n' "$props" | sed -n 's/^MainPID=//p')"
  case "$main" in
    '' | 0 | *[!0-9]*) printf 'unknown'; return 0 ;;
  esac
  [ "$(cgroup_path_of "$main" 2>/dev/null)" = "$self_cg" ] || { printf 'unknown'; return 0; }
  case "$(printf '%s\n' "$props" | sed -n 's/^UnitFileState=//p')" in
    transient) printf 'transient' ;;
    *) printf 'long-lived' ;;
  esac
}

# Derive every fact the decision needs, from the kernel and systemd only. There
# is no parameter here, and that is what makes the derivation un-replaceable:
# `guard` and `notify` call this and then guard_verdict, and neither can be
# handed a different answer.
read_position() {
  SELF_CGROUP=""
  SELF_UNIT=""
  if SELF_CGROUP="$(cgroup_path_of $$)"; then
    SELF_UNIT="$(sender_unit_of "$SELF_CGROUP")" || SELF_UNIT=""
  fi
  read_control_cgroup || true
  OWNERSHIP="$(sender_unit_ownership "$SELF_UNIT" "$SELF_CGROUP")"
}

# --- the decision ------------------------------------------------------------
# The guard, over facts. Prints the reason on stdout when it refuses and returns
# 1; prints nothing and returns 0 when a write would be allowed. Callers that
# only want the verdict should discard stdout.
#
#   $1 the sender's cgroup path        ("" when it could not be read)
#   $2 the control unit's MainPID cgroup path ("" when unknown)
#   $3 why $2 is empty; non-empty means "could not be proven"
#   $4 ownership of the sender's unit: transient | long-lived | unknown
#   $5 socket, optional
guard_verdict() {
  local self_cg="$1" control_cg="$2" control_why="$3" ownership="$4" sock="${5:-}" u

  # 2a, the most specific check, and the one that names the unit this guard was
  # written for. Equality of cgroup paths is exactly "this process is inside that
  # unit": a datagram is attributed to the innermost unit containing the sender,
  # and a process in a nested sub-unit of the control plane is in a *different*
  # unit with its own notify semantics, so equality and not a prefix match is the
  # correct comparison.
  if [ -z "$self_cg" ]; then
    printf 'refused: /proc/$$/cgroup could not be read, so it cannot be proven that this process is not inside a live unit; failing closed\n'
    return 1
  fi
  u="$(sender_unit_of "$self_cg")" || u=""
  if [ -z "$u" ]; then
    # The other half of failing closed. A cgroup path with no unit in its last
    # component is not a position this guard can reason about, and allowing here
    # would be the fail-open twin of the unreadable case above. It is reachable: a
    # v1-only /proc/self/cgroup is readable and has no unified line at all.
    printf 'refused: this process cgroup path (%s) names no unit, so it cannot be proven that this process is not inside a live unit; failing closed\n' "$self_cg"
    return 1
  fi

  if [ -n "$control_why" ]; then
    printf 'refused: %s; failing closed\n' "$control_why"
    return 1
  fi
  if [ -n "$control_cg" ] && [ "$self_cg" = "$control_cg" ]; then
    printf 'refused: this process is in the same cgroup as %s (compared against its own main process), and a datagram is applied to the unit that sent it (measured 2026-09-27), so sending from here edits %s. Wrap the probe: systemd-run --user --unit="pc-probe-$$" --property=Type=exec --property=NotifyAccess=all <this command>\n' \
      "$CONTROL_UNIT" "$CONTROL_UNIT"
    return 1
  fi

  # 2b, the general form of the same check, and independent of 2a: it asks
  # systemd whether whichever unit the sender is actually in is one systemd
  # created, rather than whether it equals a name this file happens to carry.
  # Both refuse the live unit, so neither is the only thing standing there.
  case "$ownership" in
    transient) ;;
    long-lived)
      printf 'refused: this process is inside the %s cgroup, systemd reports that unit as one it did not create for a probe, and a datagram is applied to the unit that sent it (measured 2026-09-27), so sending from here edits %s. Wrap the probe: systemd-run --user --unit="pc-probe-$$" --property=Type=exec --property=NotifyAccess=all <this command>\n' \
        "$u" "$u"
      return 1
      ;;
    *)
      printf 'refused: this process is inside the %s cgroup, and systemd could not confirm that this process is inside a unit it created (no such loaded unit with a main process in this cgroup), so it cannot be proven that a datagram would land on a throwaway unit; failing closed\n' \
        "$u"
      return 1
      ;;
  esac

  [ -n "$sock" ] || return 0

  case "$sock" in
    @*)
      printf 'refused: %s is an abstract socket, which this guard cannot attribute to a unit; use a filesystem socket\n' "$sock"
      return 1
      ;;
    "$SYSTEM_MANAGER_SOCKET")
      printf 'refused: %s belongs to the system manager, whose units are not in this process cgroup hierarchy; this is a user-plane probe\n' "$sock"
      return 1
      ;;
  esac

  if [ ! -S "$sock" ]; then
    printf 'refused: %s is not a socket, so it cannot be a notify socket and there is nothing to verify\n' "$sock"
    return 1
  fi

  return 0
}

# The enforcing path: derive, then decide. No arguments, because a fact this
# script cannot verify is exactly what it must not act on.
#
# It records the refusal in GUARD_REASON instead of printing it, and returns
# non-zero, so `guard`, `notify` and `info` all get the same answer from the same
# derivation. `info` is not a weaker path: it is the command an operator runs
# *before* deciding to send, so a fact substituted here would be a fact
# substituted in the advice.
guard_probe() {
  GUARD_REASON=""
  read_position
  GUARD_REASON="$(guard_verdict "$SELF_CGROUP" "$CONTROL_CGROUP" "$CONTROL_WHY" "$OWNERSHIP" "${1:-}")"
}

# Print the refusal a guard_probe recorded. A separate function so all three
# callers word it identically, and so an operator reading any of them sees the
# same message for the same position.
say_refusal() {
  [ -n "$GUARD_REASON" ] && printf '%s\n' "$GUARD_REASON"
  return 0
}

# Everything `info` prints about where the sender is. Reads the globals the
# derivation just filled in, so it cannot disagree with the verdict below it.
report_position() {
  printf 'control unit        %s\n' "$CONTROL_UNIT"
  if [ -n "$CONTROL_WHY" ]; then
    printf 'control cgroup      unknown (%s)\n' "$CONTROL_WHY"
  elif [ -n "$CONTROL_CGROUP" ]; then
    printf 'control cgroup      %s\n' "$CONTROL_CGROUP"
  else
    printf 'control cgroup      none (%s is not on this host)\n' "$CONTROL_UNIT"
  fi
  printf 'this cgroup         %s\n' "${SELF_CGROUP:-unreadable}"
  printf 'sender unit         %s\n' "${SELF_UNIT:-none (not inside a named unit)}"
  case "$OWNERSHIP" in
    transient) printf 'ownership           transient (systemd created this unit and its main process is in this cgroup)\n' ;;
    long-lived) printf 'ownership           long-lived (systemd did not create this unit)\n' ;;
    *) printf 'ownership           unknown (no loaded unit with a main process in this cgroup)\n' ;;
  esac
}

# Rule 3. A probe reports; it does not drive. An allowlist, not a list of
# known-bad keys, for the reason in the header: the previous denylist missed
# MAINPID= and NOTIFYACCESS=, both of which systemd applies, and the only defence
# against the next one is to refuse the fields nobody thought of.
ALLOWED_KEYS="STATUS ERRNO BUSERROR"

guard_message() {
  local msg key
  for msg in "$@"; do
    case "$msg" in
      *$'\n'* | *$'\r'*)
        printf 'refused: message fields must be single-line KEY=VALUE entries; newline-delimited payload injection is not allowed\n'
        return 1
        ;;
    esac
    case "$msg" in
      *=*) key="${msg%%=*}" ;;
      *)
        printf 'refused: %s is not KEY=VALUE; the notification protocol takes newline separated key=value pairs\n' "$msg"
        return 1
        ;;
    esac
    case " $ALLOWED_KEYS " in
      *" $key "*)
        ;;
      *)
        printf 'refused: %s= is not a field a probe may send; a probe may only send informational keys (%s), because every other field in the notification protocol changes the state of the unit that sent it -- including MAINPID=, which re-points the recorded main process\n' \
          "$key" "${ALLOWED_KEYS// /, }"
        return 1
        ;;
    esac
  done
  return 0
}

# The direct datagram write. No systemd-notify: see the header. One datagram,
# newline separated, which is what the notification protocol expects.
send_datagram() {
  local sock="$1" payload="$2"
  if command -v socat >/dev/null 2>&1; then
    printf '%s' "$payload" | socat -u - "UNIX-SENDTO:$sock" 2>&1 && return 0
    printf 'socat could not write to %s\n' "$sock" >&2
    return 1
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$sock" "$payload" <<'PY' 2>&1 && return 0
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
s.connect(sys.argv[1])
s.send(sys.argv[2].encode())
PY
    printf 'python3 could not write to %s\n' "$sock" >&2
    return 1
  fi
  printf 'no datagram transport: install socat, or python3\n' >&2
  return 3
}

usage() {
  printf 'usage: %s info [socket] | guard [socket] | notify [socket] <KEY=VALUE>... | scrub-env <cmd> [args...] | selftest <fn> <facts...>\n' \
    "$(basename "$0")" >&2
}

# Run now, before argument parsing: the whole point is that nothing above this
# line can have used an inherited socket.
scrub_ipc_env

case "${1:-}" in
  scrub-env)
    shift
    [ "$#" -ge 1 ] || { usage; exit 2; }
    exec env -u NOTIFY_SOCKET -u LISTEN_PID -u LISTEN_FDS -u LISTEN_FDNAMES "$@"
    ;;
  info)
    shift
    [ "$#" -le 1 ] || { usage; exit 2; }
    if [ "$#" -ge 1 ]; then
      # Reach the enforcing path, not the decision behind it: the verdict printed
      # below is the one `guard` and `notify` would act on.
      if guard_probe "$1"; then probe_verdict="ALLOWED"; else probe_verdict="REFUSED"; fi
      probe_socket="$1"
    else
      # No socket named, so there is nothing to decide; deriving alone is what
      # fills in the position lines.
      guard_probe
      probe_verdict=""
      probe_socket=""
    fi
    report_position
    if [ -n "$probe_socket" ]; then
      printf 'target              %s\n' "$probe_socket"
      printf 'verdict             %s\n' "$probe_verdict"
      if [ "$probe_verdict" = "REFUSED" ] && [ -n "$GUARD_REASON" ]; then
        printf 'reason              %s\n' "$GUARD_REASON"
      fi
    else
      # No socket named, and NOTIFY_SOCKET is gone because rule 1 ran before this.
      # So the answer is that there is none -- not the inherited path, which is the
      # whole point: the value the caller walked in with is not a target this guard
      # will act on.
      printf 'notify socket       none (the inherited NOTIFY_SOCKET is scrubbed; name one explicitly)\n'
    fi
    ;;
  guard)
    shift
    [ "$#" -le 1 ] || { usage; exit 2; }
    guard_probe "${1:-}" || { say_refusal; exit 1; }
    ;;
  notify)
    shift
    [ "$#" -ge 1 ] || { usage; exit 2; }
    sock="${1:-}"
    [ "$#" -ge 2 ] && shift
    [ -n "$sock" ] || { usage; exit 2; }
    guard_probe "$sock" || { say_refusal; exit 1; }
    guard_message "$@" || exit 1
    payload="$(printf '%s\n' "$@")"
    send_datagram "$sock" "$payload"
    exit $?
    ;;
  selftest)
    # The only path that takes facts as arguments, and reachable only from here.
    # `guard` and `notify` call guard_probe, which has no fact parameters and
    # derives them, so a test cannot and a caller cannot make the enforcing path
    # use a fixture. scripts/paperclip-notify-probe.test.mjs drives this.
    shift
    case "${1:-}" in
      unit)
        shift
        [ "$#" -ge 1 ] || { usage; exit 2; }
        sender_unit_of "$1" || exit 1
        ;;
      guard)
        shift
        [ "$#" -ge 4 ] && [ "$#" -le 5 ] || { usage; exit 2; }
        guard_verdict "$1" "$2" "$3" "$4" "${5:-}" || exit 1
        ;;
      message)
        shift
        [ "$#" -ge 1 ] || { usage; exit 2; }
        guard_message "$@" || exit 1
        ;;
      ownership)
        shift
        [ "$#" -ge 2 ] || { usage; exit 2; }
        sender_unit_ownership "$1" "$2"
        ;;
      *)
        usage
        exit 2
        ;;
    esac
    ;;
  '' | -h | --help | help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 2
    ;;
esac
