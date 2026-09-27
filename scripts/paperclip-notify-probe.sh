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
#      allowed -- including from a plain interactive shell, which is inside
#      user@.service or a session scope and so is refused too. Fails closed when
#      the cgroup cannot be read, and when it names no unit at all.
#   3. It refuses lifecycle messages outright: STOPPING=, RELOADING=, READY=,
#      WATCHDOG=, WATCHDOG_USEC= and EXTEND_TIMEOUT_USEC= change the target unit's
#      state. A probe has no business sending any of them and there is no flag to
#      allow them, because no probe needs one.
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
# it sends READY=1, which rule 3 refuses to send, so it would die on
# TimeoutStartSec every time. Type=exec with NotifyAccess=all is a unit that is
# live immediately, has a notify socket, and accepts a STATUS= at any time.
#
# EXIT CODES: 0 allowed (or, for notify, delivered), 1 refused, 2 usage error,
# 3 no datagram transport available on this host.

set -uo pipefail

# The unit a probe must never send from. Overridable so the guard is testable and
# so an instance that names its unit differently can point this at the right one.
CONTROL_UNIT="${PAPERCLIP_PROBE_CONTROL_UNIT:-paperclipai.service}"
# The cgroup file the sender-side check reads. Overridable for tests only.
SELF_CGROUP_FILE="${PAPERCLIP_PROBE_SELF_CGROUP_FILE:-/proc/self/cgroup}"
# Where systemd puts the runtime dir of a unit it created itself.
TRANSIENT_ROOT="${PAPERCLIP_PROBE_TRANSIENT_ROOT:-/run/user/$(id -u)/systemd/transient}"
# This is a user-plane tool. The system manager's socket is a different manager,
# its units are not in this process's cgroup hierarchy, and nothing here can
# reason about what a write there would touch.
SYSTEM_MANAGER_SOCKET="/run/systemd/notify"

# Rule 1, and it has to be the first thing in the file: everything below is safer
# if the inherited socket is already gone, and the whole point of scrubbing is
# that it must not depend on the caller having cleaned up first.
scrub_ipc_env() {
  unset NOTIFY_SOCKET LISTEN_PID LISTEN_FDS LISTEN_FDNAMES
}

# The unit this process is in, from the cgroup path. A user unit's path is
# .../<name>.service (or .scope, or .mount) as its last component; the leading "0::"
# is the cgroup v2 unified line. Prints nothing when the process is not inside a
# named unit -- a bare shell in the session scope, for instance.
sender_unit() {
  local path
  path="$(sed -n 's|^0::||p' "$SELF_CGROUP_FILE" 2>/dev/null | head -1)"
  [ -n "$path" ] || return 1
  printf '%s' "${path##*/}"
}

# Was the sender's unit created by systemd-run rather than by a unit file or a
# drop-in? Decided by the runtime dir systemd created for it, which is what makes
# this a fact about the world rather than a claim about the name. A unit file
# never gets a dir under transient/.
sender_unit_is_throwaway() {
  local u="$1"
  [ -n "$u" ] && [ -e "$TRANSIENT_ROOT/$u" ]
}

# The guard. Prints the reason on stdout when it refuses and returns 1; prints
# nothing and returns 0 when a write would be allowed. Callers that only want the
# verdict should discard stdout.
guard_probe() {
  local sock="${1:-}" u

  # 2, the load-bearing check. Done before the target is even looked at, because
  # the measurement above says the target cannot change who is affected.
  if [ ! -r "$SELF_CGROUP_FILE" ]; then
    printf 'refused: %s is unreadable, so it cannot be proven that this process is not inside a live unit; failing closed\n' "$SELF_CGROUP_FILE"
    return 1
  fi
  u="$(sender_unit)" || u=""
  if [ -z "$u" ]; then
    # The other half of failing closed. A cgroup file with no v2 unified line names
    # no unit, which on a v2 host means the file is not what this guard assumes it
    # is. Allowing here would be the fail-open twin of the unreadable case above,
    # and it is reachable: a v1-only file is readable and empty as far as the
    # unified line is concerned.
    printf 'refused: %s names no unit (no cgroup v2 unified line), so it cannot be proven that this process is not inside a live unit; failing closed\n' "$SELF_CGROUP_FILE"
    return 1
  fi
  if ! sender_unit_is_throwaway "$u"; then
    printf 'refused: this process is inside the %s cgroup, and a datagram is applied to the unit that sent it (measured 2026-09-27), so sending from here edits %s. Wrap the probe: systemd-run --user --unit="pc-probe-$$" --property=Type=exec --property=NotifyAccess=all <this command>\n' \
      "$u" "$u"
    return 1
  fi

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

# Rule 3. A probe reports; it does not drive. These keys change the state of
# whichever unit the sender is in, which is the one thing this script's cgroup
# check is protecting. The list is explicit rather than a denylist of what a
# probe might need, because a probe needing one of these is the bug.
guard_message() {
  local msg key
  for msg in "$@"; do
    case "$msg" in
      *$'\n'* | *$'\r'*)
        printf 'refused: message fields must be single-line KEY=VALUE entries; newline-delimited payload injection is not allowed\n'
        return 1
        ;;
    esac
    key="${msg%%=*}"
    case "$key" in
      STOPPING | RELOADING | READY | WATCHDOG | WATCHDOG_USEC | EXTEND_TIMEOUT_USEC)
        printf 'refused: %s= changes the state of the unit that sent it; a probe may only send informational keys (STATUS=, ERRNO=, ...)\n' "$key"
        return 1
        ;;
    esac
    case "$msg" in
      *=*) ;;
      *)
        printf 'refused: %s is not KEY=VALUE; the notification protocol takes newline separated key=value pairs\n' "$msg"
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
  printf 'usage: %s info [socket] | guard [socket] | notify [socket] <KEY=VALUE>... | scrub-env <cmd> [args...]\n' \
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
    printf 'control unit        %s\n' "$CONTROL_UNIT"
    printf 'cgroup file         %s\n' "$SELF_CGROUP_FILE"
    printf 'transient root      %s\n' "$TRANSIENT_ROOT"
    if u="$(sender_unit)"; then
      printf 'sender unit         %s (%s)\n' "$u" "$(sender_unit_is_throwaway "$u" && echo 'throwaway, safe to send from' || echo 'LONG-LIVED, do not send from here')"
    else
      printf 'sender unit         none (not inside a named unit)\n'
    fi
    if [ "$#" -ge 1 ]; then
      printf 'target              %s\n' "$1"
      if verdict="$(guard_probe "$1")"; then
        printf 'verdict             ALLOWED\n'
        [ -n "$verdict" ] && printf '%s\n' "$verdict"
      else
        printf 'verdict             REFUSED\n'
        [ -n "$verdict" ] && printf 'reason              %s\n' "$verdict"
      fi
    elif [ -n "${NOTIFY_SOCKET:-}" ]; then
      printf 'notify socket       %s (inherited value is scrubbed; pass it explicitly)\n' "$NOTIFY_SOCKET"
    else
      printf 'notify socket       none\n'
    fi
    ;;
  guard)
    shift
    [ "$#" -le 1 ] || { usage; exit 2; }
    guard_probe "${1:-}" || exit 1
    ;;
  notify)
    shift
    [ "$#" -ge 1 ] || { usage; exit 2; }
    sock="${1:-}"
    [ "$#" -ge 2 ] && shift
    [ -n "$sock" ] || { usage; exit 2; }
    guard_probe "$sock" || exit 1
    guard_message "$@" || exit 1
    payload="$(printf '%s\n' "$@")"
    send_datagram "$sock" "$payload"
    exit $?
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
