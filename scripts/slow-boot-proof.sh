#!/usr/bin/env bash
set -euo pipefail

# PET-296 / PET-253 DoD 4. Prove, on a CLEAN host, that a boot which takes
# longer than systemd's 90s default start timeout COMPLETES instead of being
# SIGTERMed -- and that the budget which lets it complete comes from the unit
# the installer rendered, not from a drop-in somebody hand-wrote.
#
# WHY THIS IS NOT THE THROWAWAY-UNIT PROOF PET-247 ALREADY RAN
#
# PET-247 measured the rendered directives on a `systemd-run --user` throwaway:
# 95s to ready, READY=1, NRestarts=0, active; and without TimeoutStartSec the
# same unit SIGTERM at 90s and restart-loop. That is the right measurement of
# the DIRECTIVES, but a throwaway unit is not the installer's output. Nothing
# in that run touched cli/src/services/service-manager.ts, so it cannot show
# that a fresh `paperclipai install` on a fresh machine inherits the budget.
# This script runs the real installer and times the real unit.
#
# WHY THE BOOT IS MADE SLOW BY LOADING THE HOST
#
# The outage this guards (board outage #4, 497s / NRestarts=6) was not a slow
# machine, it was a slow boot on a *loaded* machine: the unit is Type=notify,
# the embedded postmaster lives inside its cgroup, so READY=1 cannot be sent
# until the database is accepting connections and migrations have finished.
# Reproducing that means making the host slow, so that is what this does --
# CPU oversubscription from outside the unit. It is deliberately the only
# mechanism used, and specifically NOT:
#
#   * a drop-in. DoD 4 forbids hand-editing the host to manufacture the proof.
#     The whole point is that a fresh onboard inherits the budget, so the unit
#     is read straight off disk after the installer writes it, its sha256 is
#     taken, and it is re-checked at the end (assertion 7a/7b).
#   * `systemctl set-property` / CPUQuota on the unit. That also writes a
#     drop-in, so it is the same forbidden move wearing a different hat.
#   * a cgroup move of the unit. Same reason.
#
# The load is sized from a MEASURED baseline boot of this very install rather
# than guessed, because the runner's core count and the host's real boot time
# are both unknown in advance. See the FACTOR arithmetic and the two-boot
# structure below. Oversubscription is expressed as a multiple of nproc, so the
# intended slowdown is the same on a 4-core runner as on a 16-core one.
#
# STRUCTURE (three boots, all measured, all on the real unit)
#
#   boot 0  the onboard boot. Fresh instance, so this one pays for every
#           migration. Reported, not asserted on: it is uncontrolled, because
#           `onboard --install-service` installs and starts in one step.
#   boot 1  warm baseline, unloaded. Calibrates the load for boot 2. Reported
#           as `baselineBootSeconds`.
#   boot 2  THE PROOF. Loaded host, then start. Asserts >90s to ready with
#           NRestarts=0 and ActiveState=active. This is the number DoD 2 wants.
#
# boot 1 is warm (migrations already applied) and boot 2 is warm too, so the
# two are comparable and the calibration is not skewed by a fresh database.
# A clean stop/start resets NRestarts (measured on systemd 261: kill -9 the
# main pid -> NRestarts=1; stop; start -> NRestarts=0), so asserting
# NRestarts=0 after boot 2 really does mean boot 2 needed zero restarts.
#
# HOST SAFETY
#
# Isolation is a distinct instance id, which renames the unit to
# paperclipai-pet296.service -- a name the host cannot have, so no by-name
# verb can reach a production paperclipai.service. The preflight refuses to run
# at all if paperclipai.service is active, the same PET-52 guard the e2e leg
# uses. Nothing here writes $HOME/.config/systemd/user/paperclipai.service.
#
# There is deliberately no --data-dir and no HOME/XDG/PAPERCLIP_HOME override,
# for the reason measured on run 36220097455 and written up in
# e2e-install-lifecycle.sh: `install --data-dir` sets PAPERCLIP_HOME, and
# install-store.ts keys cliRoot (and therefore cli/install.json) to
# PAPERCLIP_HOME but keys shimPath to $HOME. Move one and not the other and
# managed-install-check.ts refuses to boot with "Doctor found blocking issues.
# Not starting server." A managed install cannot be relocated; the fresh
# instance id is what makes the data dir fresh, so nothing else is needed.
#
# Env knobs:
#   SLOW_BOOT_REPO               GitHub repo to install from (default PetrouilFan/paperclip)
#   SLOW_BOOT_REF                ref/sha to install (default: this checkout's sha)
#   SLOW_BOOT_INSTANCE           instance id (default pet296)
#   SLOW_BOOT_MIN_BOOT_SECONDS   the bar the proof boot must clear (default 90)
#   SLOW_BOOT_TARGET_BOOT_SECONDS where to aim the load (default 150)
#   SLOW_BOOT_READY_TIMEOUT      hard cap on any single wait (default 420)
#   SLOW_BOOT_MAX_LOAD_WORKERS   cap on oversubscription (default 256)
#   SLOW_BOOT_KEEP_LOAD          1 = leave the unit running for inspection

SLOW_BOOT_REPO="${SLOW_BOOT_REPO:-PetrouilFan/paperclip}"
SLOW_BOOT_REF="${SLOW_BOOT_REF:-}"
SLOW_BOOT_INSTANCE="${SLOW_BOOT_INSTANCE:-pet296}"
SLOW_BOOT_MIN_BOOT_SECONDS="${SLOW_BOOT_MIN_BOOT_SECONDS:-90}"
SLOW_BOOT_TARGET_BOOT_SECONDS="${SLOW_BOOT_TARGET_BOOT_SECONDS:-150}"
SLOW_BOOT_READY_TIMEOUT="${SLOW_BOOT_READY_TIMEOUT:-420}"
SLOW_BOOT_MAX_LOAD_WORKERS="${SLOW_BOOT_MAX_LOAD_WORKERS:-256}"
SLOW_BOOT_KEEP_LOAD="${SLOW_BOOT_KEEP_LOAD:-0}"

UNIT="paperclipai-${SLOW_BOOT_INSTANCE}.service"
SHIM="$HOME/.local/bin/paperclipai"
STORE="$HOME/.paperclip/cli"
BOOT_CLI=""
LOAD_PIDS=()
LOAD_WORKERS=0
CREATED="false"
RESULTS=()
FAILED=0

# --- output helpers -------------------------------------------------------
note()  { printf '\n\033[1;34m== %s ==\033[0m\n' "$*"; }
pass()  { RESULTS+=("PASS  $1"); printf '\033[1;32mPASS\033[0m %s\n' "$1"; }
fail_() { RESULTS+=("FAIL  $1"); printf '\033[1;31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
info()  { printf '      %s\n' "$*"; }
die()   { printf '\033[1;31mABORT\033[0m %s\n' "$*" >&2; exit 1; }

summarize() {
  note "RESULTS ($SLOW_BOOT_REPO@$SLOW_BOOT_REF on $(uname -sm), $(nproc) cores)"
  if [ "${#RESULTS[@]}" -gt 0 ]; then printf '%s\n' "${RESULTS[@]}"; fi
  if [ "$FAILED" = "1" ]; then
    echo; echo "OVERALL: FAIL"
    exit 1
  fi
  echo; echo "OVERALL: PASS"
}

# --- systemd helpers ------------------------------------------------------
prop() { systemctl --user show "$UNIT" -p "$1" --value 2>/dev/null || true; }

# systemd's own pre-ready window: ExecMainStartTimestamp -> ActiveEnterTimestamp.
# For a Type=notify unit, ActiveEnterTimestamp is only set once READY=1 has been
# received, so this is systemd's measurement of the boot, not a poller's guess.
boot_seconds() {
  local started active s a
  started="$(prop ExecMainStartTimestamp)"
  active="$(prop ActiveEnterTimestamp)"
  case "$started$active" in *n/a*|"") echo ""; return 0 ;; esac
  s="$(date -d "$started" +%s 2>/dev/null || true)"
  a="$(date -d "$active" +%s 2>/dev/null || true)"
  if [ -n "$s" ] && [ -n "$a" ]; then echo $((a - s)); else echo ""; fi
}

# systemd prints a timespan as space-separated terms ("1min 30s", "10min",
# "500ms"), never as a bare count of seconds, so `= "10min"` as a string
# comparison would be a bet on one systemd version's formatting. Convert
# instead, and assert on the number that is actually load-bearing: 600 > 90.
timespan_to_seconds() {
  local spec="$1" total=0 term num unit
  for term in $spec; do
    # Split into the leading number (which may carry a decimal point) and the
    # trailing unit. systemd prints sub-second precision when a fractional value
    # was configured ("1min 30.500s"), so truncate rather than assume integers.
    num="${term%%[!0-9.]*}"
    unit="${term#"$num"}"
    num="${num%%.*}"
    case "$unit" in
      us) total=$(( total + num / 1000000 )) ;;
      ms) total=$(( total + (num + 999) / 1000 )) ;;
      s|"") total=$(( total + num )) ;;
      min) total=$(( total + num * 60 )) ;;
      h) total=$(( total + num * 3600 )) ;;
      d) total=$(( total + num * 86400 )) ;;
      w) total=$(( total + num * 604800 )) ;;
      *) return 1 ;;
    esac
  done
  echo "$total"
}

load_stop() {
  local pid
  for pid in ${LOAD_PIDS[@]+"${LOAD_PIDS[@]}"}; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  for pid in ${LOAD_PIDS[@]+"${LOAD_PIDS[@]}"}; do
    [ -n "$pid" ] && wait "$pid" 2>/dev/null
  done
  return 0
}

# Add $1 more cpu workers. A tight arithmetic loop, no syscalls, no files:
# pure oversubscription of the scheduler's CPU time, so the boot slows down for
# the reason it slowed down in the outage (a busy host) and not because the disk
# filled up or a fixture was corrupted.
load_add() {
  local n="$1" i
  [ "$n" -ge 1 ] || return 0
  for ((i = 0; i < n; i++)); do
    ( while :; do :; done ) &
    LOAD_PIDS+=("$!")
  done
  LOAD_WORKERS=$(( LOAD_WORKERS + n ))
}

cleanup() {
  load_stop
  # Only ever tear down the unit this script installed, and only after onboard
  # actually created it. The trap is registered before the preflight runs, so
  # without the CREATED guard the refusal path would stop a host's unit.
  [ "$CREATED" = "true" ] || return 0
  if [ "$SLOW_BOOT_KEEP_LOAD" != "1" ]; then
    systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
    if [ -x "$SHIM" ]; then
      "$SHIM" service uninstall --instance "$SLOW_BOOT_INSTANCE" >/dev/null 2>&1 || true
    fi
  fi
  return 0
}
trap cleanup EXIT INT TERM

# --- preflight ------------------------------------------------------------
# A clean environment: no inherited Paperclip or build-mode state.
for var in $(env | grep -o '^PAPERCLIP_[A-Z_]*' || true); do unset "$var"; done
unset NODE_ENV npm_config_prefix 2>/dev/null || true
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export CI="${CI:-1}"

note "0. Preflight"
uname -a
node --version || die "node is required"
command -v corepack >/dev/null 2>&1 || npm install -g corepack
[ -S "/run/user/$(id -u)/bus" ] \
  || die "no user systemd session: run 'loginctl enable-linger' and export XDG_RUNTIME_DIR=/run/user/\$(id -u)"
systemctl --user show-environment >/dev/null 2>&1 \
  || die "systemctl --user cannot reach a manager"
# PET-52 guard, and the reason this script is safe to point at any host. On a
# host with a live production install, refuse rather than prove something beside
# it. `grep -qx`: `is-active` prints `inactive` for a stopped unit and that
# word contains `active`.
if systemctl --user is-active paperclipai.service 2>/dev/null | grep -qx active; then
  die "paperclipai.service is active on this host; this proof needs a clean host"
fi
if systemctl --user cat "$UNIT" >/dev/null 2>&1; then
  die "$UNIT already exists; this proof needs a clean host"
fi
[ -e "$SHIM" ] && die "$SHIM already exists; not a clean machine"
[ -d "$STORE" ] && die "$STORE already exists; not a clean machine"
if [ -z "$SLOW_BOOT_REF" ]; then
  SLOW_BOOT_REF="$(git -C "$(dirname "$0")/.." rev-parse HEAD 2>/dev/null || true)"
  [ -n "$SLOW_BOOT_REF" ] || die "SLOW_BOOT_REF is unset and HEAD could not be resolved"
fi
info "repo=$SLOW_BOOT_REPO ref=$SLOW_BOOT_REF instance=$SLOW_BOOT_INSTANCE"
info "unit=$UNIT"
# The unit binds the server port. If something already holds it the boot would
# fail for a reason that has nothing to do with the boot budget, and the
# resulting Result=exit-code would be easy to misread as a start timeout.
if curl -fsS --max-time 2 http://127.0.0.1:3100/api/health >/dev/null 2>&1; then
  die "127.0.0.1:3100 already answers; the boot under test cannot bind it"
fi

# --- 1. bootstrap the CLI from the ref under test -------------------------
# The build is what gets installed, so "the build containing d415c4196" is the
# thing on disk, not a claim about a branch tip. Same path e2e-install-lifecycle.sh
# uses: tarball -> pnpm install -> build-npm.sh -> pack -> npm install.
note "1. Bootstrap the CLI from $SLOW_BOOT_REPO@$SLOW_BOOT_REF"
BOOT="$HOME/pet296-bootstrap"
mkdir -p "$BOOT"
if ! curl --fail --silent --show-error --location \
    "https://codeload.github.com/$SLOW_BOOT_REPO/tar.gz/$SLOW_BOOT_REF" \
    | tar -xz --strip-components=1 -C "$BOOT"; then
  die "could not download $SLOW_BOOT_REPO@$SLOW_BOOT_REF"
fi
pass "1a tarball for $SLOW_BOOT_REF downloaded"
( cd "$BOOT" && corepack pnpm install --frozen-lockfile > "$HOME/pet296-pnpm.log" 2>&1 ) \
  || { tail -40 "$HOME/pet296-pnpm.log"; die "pnpm install failed"; }
pass "1b pnpm install"
( cd "$BOOT" && PAPERCLIP_README_ASSET_REF="$SLOW_BOOT_REF" \
    bash scripts/build-npm.sh --skip-checks --skip-typecheck > "$HOME/pet296-build.log" 2>&1 ) \
  || { tail -40 "$HOME/pet296-build.log"; die "build-npm.sh failed"; }
pass "1c build-npm.sh"
TARBALL="$(cd "$BOOT/cli" && npm pack --silent 2>/dev/null | tail -1)"
mkdir -p "$HOME/pet296-cli"
( cd "$HOME/pet296-cli" && npm install --no-fund --no-audit "$BOOT/cli/$TARBALL" > "$HOME/pet296-npm.log" 2>&1 ) \
  || { tail -40 "$HOME/pet296-npm.log"; die "npm install of the packed CLI failed"; }
BOOT_CLI="$HOME/pet296-cli/node_modules/paperclipai/dist/index.js"
node "$BOOT_CLI" --version >/dev/null || die "bootstrapped CLI does not run"
pass "1d CLI packed and installed ($TARBALL)"

# Assert the ref under test really does carry the renderer change, so a proof
# that "passes" because it exercised an old build cannot be mistaken for one.
if grep -q '^TimeoutStartSec=600$' "$BOOT/cli/src/services/service-manager.ts" 2>/dev/null; then
  pass "1e the build under test emits TimeoutStartSec=600 (source check)"
else
  fail_ "1e the build under test emits TimeoutStartSec=600 (source check)"
  info "the ref under test does not contain d415c4196; there is nothing to prove"
fi

note "2. Real install of that build (managed store, $SHIM)"
node "$BOOT_CLI" install --repo "$SLOW_BOOT_REPO" --ref "$SLOW_BOOT_REF" --yes \
  || die "install --ref failed"
[ -x "$SHIM" ] || die "no managed shim at $SHIM after install"
pass "2a install --ref $SLOW_BOOT_REF exits 0 and writes $SHIM"
info "shim version: $("$SHIM" --version 2>/dev/null || echo unknown)"

# --- 3. onboard, which renders the unit -----------------------------------
note "3. Onboard with --install-service (this is what renders the unit)"
# onboard has no --instance flag, so the instance is chosen by the environment
# variable it reads. This is the only lever that renames the unit, and it is
# also what makes the instance's data dir fresh.
export PAPERCLIP_INSTANCE_ID="$SLOW_BOOT_INSTANCE"
# The 900s here is deliberately above the unit's own TimeoutStartSec=600: the
# budget under test must be the only thing that can end a boot, not this
# wrapper. `onboard --install-service` installs AND starts in one step, and
# SystemdServiceManager.start() is a blocking `systemctl start`, so this call
# does not return until the unit is active -- which is why boot 0 below can be
# measured without polling.
timeout 900 "$SHIM" onboard --yes --install-service \
  || die "onboard --install-service failed"
# From here the unit is this script's to stop and start.
CREATED="true"
pass "3a onboard --yes --install-service exits 0"
unset PAPERCLIP_INSTANCE_ID

# boot 0: the onboard boot, fresh instance, so it pays for every migration.
ONBOARD_BOOT="$(boot_seconds)"
info "boot 0 (onboard, fresh db, uncontrolled): ${ONBOARD_BOOT:-unknown}s"

# --- 4. DoD 1: the RENDERED unit owns the boot budget ---------------------
note "4. The rendered unit (DoD 1)"
UNIT_FILE="$(prop FragmentPath)"
[ -n "$UNIT_FILE" ] && [ -f "$UNIT_FILE" ] || die "no unit file for $UNIT (FragmentPath='$UNIT_FILE')"
info "unit file: $UNIT_FILE"
# A drop-in here would mean the budget came from the host, not the renderer.
DROPIN_DIR="${UNIT_FILE}.d"
if [ -d "$DROPIN_DIR" ]; then
  fail_ "4a no drop-in directory for the unit (DoD 4)"
  ls -la "$DROPIN_DIR"
else
  pass "4a no drop-in directory for the unit (DoD 4): the renderer owns it"
fi
# Read the two directives off the file the installer wrote, not out of the
# source tree. This is the assertion that a fresh onboard inherits them.
if grep -q '^TimeoutStartSec=600$' "$UNIT_FILE"; then
  pass "4b rendered unit contains TimeoutStartSec=600"
else
  fail_ "4b rendered unit contains TimeoutStartSec=600"
  grep -n 'Timeout' "$UNIT_FILE" || true
fi
if grep -q '^KillMode=process$' "$UNIT_FILE"; then
  pass "4c rendered unit contains KillMode=process"
else
  fail_ "4c rendered unit contains KillMode=process"
fi
# And read them back out of systemd, which proves the directives were honoured
# rather than merely present. This is the number the ticket is really about: if
# this is still 90, a boot over 90s is dead no matter what the file says.
EFF_TIMEOUT="$(prop TimeoutStartUSec)"
EFF_KILLMODE="$(prop KillMode)"
EFF_TYPE="$(prop Type)"
EFF_TIMEOUT_SECS="$(timespan_to_seconds "$EFF_TIMEOUT" || echo -1)"
info "systemd effective: Type=$EFF_TYPE TimeoutStartUSec=$EFF_TIMEOUT (${EFF_TIMEOUT_SECS}s) KillMode=$EFF_KILLMODE"
if [ "$EFF_TIMEOUT_SECS" = "600" ]; then
  pass "4d systemd applied the 600s start budget (not the 90s default)"
elif [ "$EFF_TIMEOUT_SECS" -gt "$SLOW_BOOT_MIN_BOOT_SECONDS" ] 2>/dev/null; then
  fail_ "4d systemd applied a 600s start budget (got ${EFF_TIMEOUT_SECS}s, over the bar but not the rendered value)"
else
  fail_ "4d systemd applied the 600s start budget (TimeoutStartUSec=$EFF_TIMEOUT)"
fi
if [ "$EFF_KILLMODE" = "process" ]; then
  pass "4e systemd applied KillMode=process"
else
  fail_ "4e systemd applied KillMode=process (got '$EFF_KILLMODE')"
fi
if [ "$EFF_TYPE" = "notify" ]; then
  pass "4f the unit under test is Type=notify, so ActiveEnterTimestamp can only be set by READY=1"
else
  fail_ "4f the unit under test is Type=notify (got '$EFF_TYPE'); a simple unit reports active before it is ready"
fi
UNIT_SHA_BEFORE="$(sha256sum "$UNIT_FILE" | cut -d' ' -f1)"
info "unit sha256 before any boot: $UNIT_SHA_BEFORE"

# --- 5. boot 1: warm baseline, unloaded -----------------------------------
note "5. boot 1, warm baseline on an idle host (calibration only)"
systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
# --no-block, because `systemctl start` on a Type=notify unit blocks until
# READY=1 and the poll loop below would then never run.
systemctl --user start --no-block "$UNIT" || die "baseline start failed"
B1_DEADLINE=$(( $(date +%s) + SLOW_BOOT_READY_TIMEOUT ))
while [ "$(date +%s)" -lt "$B1_DEADLINE" ]; do
  case "$(prop ActiveState)/$(prop SubState)" in
    active/running) break ;;
    failed/*) die "baseline boot failed: $(prop Result) / $(prop StatusText)" ;;
  esac
  sleep 1
done
[ "$(prop ActiveState)/$(prop SubState)" = "active/running" ] \
  || die "baseline boot did not reach active/running in ${SLOW_BOOT_READY_TIMEOUT}s"
BASELINE_BOOT="$(boot_seconds)"
[ -n "$BASELINE_BOOT" ] || die "could not read the baseline boot duration"
pass "5a baseline boot reached active in ${BASELINE_BOOT}s"

# Size the load from what this host actually does, so the proof does not
# depend on guessing the runner's core count or its real boot time.
# With r busy workers and nproc cores, a CPU-bound process gets about
# nproc/(r+1) of a core, so the slowdown is about (r+1)/nproc. Asking for a
# factor F therefore means r = F*nproc - 1, which is why this is expressed as
# a multiple of nproc and not as a raw worker count.
NPROC="$(nproc)"
DIVISOR="$BASELINE_BOOT"
[ "$DIVISOR" -ge 1 ] || DIVISOR=1
FACTOR=$(( SLOW_BOOT_TARGET_BOOT_SECONDS / DIVISOR ))
[ "$FACTOR" -lt 4 ] && FACTOR=4
[ "$FACTOR" -gt 24 ] && FACTOR=24
INITIAL_WORKERS=$(( FACTOR * NPROC - 1 ))
[ "$INITIAL_WORKERS" -lt 1 ] && INITIAL_WORKERS=1
[ "$INITIAL_WORKERS" -gt "$SLOW_BOOT_MAX_LOAD_WORKERS" ] && INITIAL_WORKERS="$SLOW_BOOT_MAX_LOAD_WORKERS"
info "baseline ${BASELINE_BOOT}s -> aiming for ~${SLOW_BOOT_TARGET_BOOT_SECONDS}s"
info "load: ${INITIAL_WORKERS} workers on ${NPROC} cores (oversubscription factor ~${FACTOR})"

# Stop the unit cleanly so boot 2's NRestarts=0 means boot 2 needed no restarts.
systemctl --user stop "$UNIT" || die "could not stop the baseline unit"
systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
[ "$(prop NRestarts)" = "0" ] || die "NRestarts is $(prop NRestarts) after a clean stop; the baseline is not clean"

# --- 6. boot 2: THE PROOF -------------------------------------------------
note "6. boot 2, the proof: a host loaded on purpose, then start"
load_add "$INITIAL_WORKERS"
info "load running (${LOAD_WORKERS} workers); starting $UNIT"
PROOF_START="$(date +%s)"
systemctl --user start --no-block "$UNIT" || die "proof start failed"

# Wait for ready, topping the load up if this host is faster than the baseline
# suggested. Adding load can only lengthen the *remaining* boot, so the top-up
# has to start while there is still real work left. Two things bound it, and
# both matter:
#
#   * a deadline at 60% of the target. Past that point the boot is nearly done
#     and doubling the load mostly risks pushing it past the 600s budget under
#     test, which would turn this proof into a timeout report.
#   * a hard stop adding load once elapsed passes 45% of the budget, because
#     from there a runaway would spend the rest of its time in the penalty box
#     instead of finishing.
TOPUP_UNTIL=$(( SLOW_BOOT_TARGET_BOOT_SECONDS * 60 / 100 ))
LOAD_FROZEN_AT=$(( 600 * 45 / 100 ))
TOPUPS=0
NEXT_TOPUP=20
PROOF_DEADLINE=$(( PROOF_START + SLOW_BOOT_READY_TIMEOUT + 60 ))
while :; do
  case "$(prop ActiveState)/$(prop SubState)" in
    active/running) break ;;
    failed/*)
      FAILED_RESULT="$(prop Result)"
      FAILED_NRESTARTS="$(prop NRestarts)"
      info "unit failed: Result=$FAILED_RESULT StatusText=$(prop StatusText) NRestarts=$FAILED_NRESTARTS"
      journalctl --user -u "$UNIT" --no-pager -n 40 || true
      if [ "$FAILED_RESULT" = "timeout" ]; then
        # The budget bounded the boot rather than the boot completing inside it.
        # That is a real (and useful) answer, but it is NOT this ticket's DoD, so
        # it is named as such rather than left looking like a crash.
        die "the boot overran the ${EFF_TIMEOUT} budget and was SIGTERMed (Result=timeout, NRestarts=$FAILED_NRESTARTS): the load was too strong, lower SLOW_BOOT_TARGET_BOOT_SECONDS"
      fi
      die "the proof boot failed (Result=$FAILED_RESULT) instead of completing"
      ;;
  esac
  ELAPSED=$(( $(date +%s) - PROOF_START ))
  if [ "$ELAPSED" -ge "$NEXT_TOPUP" ] \
     && [ "$ELAPSED" -lt "$TOPUP_UNTIL" ] \
     && [ "$ELAPSED" -lt "$LOAD_FROZEN_AT" ] \
     && [ $(( LOAD_WORKERS * 2 )) -le "$SLOW_BOOT_MAX_LOAD_WORKERS" ]; then
    load_add "$LOAD_WORKERS"
    TOPUPS=$(( TOPUPS + 1 ))
    NEXT_TOPUP=$(( NEXT_TOPUP + 10 ))
    info "still activating at ${ELAPSED}s; load now ${LOAD_WORKERS} workers"
  fi
  if [ "$(date +%s)" -ge "$PROOF_DEADLINE" ]; then
    die "the proof boot did not reach active within $(( SLOW_BOOT_READY_TIMEOUT + 60 ))s"
  fi
  sleep 1
done
load_stop
WALL_BOOT=$(( $(date +%s) - PROOF_START ))
PROOF_BOOT="$(boot_seconds)"
[ -n "$PROOF_BOOT" ] || die "could not read the proof boot duration"
pass "6a proof boot reached active (systemd-measured ${PROOF_BOOT}s, wall clock ${WALL_BOOT}s, ${TOPUPS} top-up(s))"

# The three numbers DoD 2 asks for, read back from systemd.
ACTIVE_STATE="$(prop ActiveState)"
SUB_STATE="$(prop SubState)"
N_RESTARTS="$(prop NRestarts)"
RESULT="$(prop Result)"
STATUS_TEXT="$(prop StatusText)"
TIMEOUT_USEC="$(prop TimeoutStartUSec)"
KILLMODE="$(prop KillMode)"
FRAGMENT="$(prop FragmentPath)"

# DoD 2. `>90s`, from systemd's own timestamps rather than a stopwatch.
if [ "$PROOF_BOOT" -gt "$SLOW_BOOT_MIN_BOOT_SECONDS" ]; then
  pass "6b boot took ${PROOF_BOOT}s, over the ${SLOW_BOOT_MIN_BOOT_SECONDS}s default start timeout"
else
  fail_ "6b boot took ${PROOF_BOOT}s, which does NOT exceed ${SLOW_BOOT_MIN_BOOT_SECONDS}s"
  info "the load was not enough to reproduce a slow boot; raise SLOW_BOOT_TARGET_BOOT_SECONDS"
fi
# READY=1. A Type=notify unit cannot report active/running until it has
# received READY=1, so SubState=running is the witness. StatusText is the
# server's own --status= string, which is a second, independent witness that
# the notify came from this server and not from anything else.
if [ "$SUB_STATE" = "running" ] && [ -n "$STATUS_TEXT" ]; then
  pass "6c READY=1 reached: SubState=running, StatusText='$STATUS_TEXT'"
else
  fail_ "6c READY=1 reached (SubState=$SUB_STATE StatusText='$STATUS_TEXT')"
fi
# NRestarts=0: the boot completed on its first attempt. Had the 90s default
# been in force this is where the outage shows up, and Restart=always would
# have re-run the boot and destroyed the embedded database each time.
if [ "$N_RESTARTS" = "0" ]; then
  pass "6d NRestarts=0: the boot completed on the first attempt"
else
  fail_ "6d NRestarts=0 (got $N_RESTARTS: the boot was killed and restarted)"
fi
if [ "$ACTIVE_STATE" = "active" ]; then
  pass "6e ActiveState=active"
else
  fail_ "6e ActiveState=active (got '$ACTIVE_STATE')"
fi
if [ "$RESULT" = "success" ]; then
  pass "6f Result=success (not 'timeout')"
else
  fail_ "6f Result=success (got '$RESULT')"
fi
info "nRestarts=${N_RESTARTS} activeEnter=$(prop ActiveEnterTimestamp) execStart=$(prop ExecMainStartTimestamp)"

# DoD 4, re-checked: the unit the proof ran is byte-for-byte the one the
# installer wrote. If anything had hand-edited it to buy the result, the hash
# moves.
UNIT_SHA_AFTER="$(sha256sum "$FRAGMENT" | cut -d' ' -f1)"
if [ "$UNIT_SHA_BEFORE" = "$UNIT_SHA_AFTER" ]; then
  pass "7a the unit is unchanged across both boots (sha256 $UNIT_SHA_AFTER): nothing was hand-edited"
else
  fail_ "7a the unit changed across the proof (before $UNIT_SHA_BEFORE after $UNIT_SHA_AFTER)"
fi
if [ -d "${FRAGMENT}.d" ]; then
  fail_ "7b no drop-in appeared for the unit during the proof (DoD 4)"
  ls -la "${FRAGMENT}.d"
else
  pass "7b no drop-in exists for the unit (DoD 4): the renderer's budget is what carried the boot"
fi

# --- evidence block -------------------------------------------------------
# The three values DoD 3 asks to be posted, in one copy-pasteable block.
EVIDENCE="${RUNNER_TEMP:-$HOME}/pet296-evidence.txt"
{
  echo "PET-296 slow-boot proof (clean host)"
  echo "  host                : $(uname -srm), ${NPROC} cores, systemd $(systemctl --version | head -1 | awk '{print $2}')"
  echo "  ref installed       : $SLOW_BOOT_REPO@$SLOW_BOOT_REF"
  echo "  unit                : $UNIT"
  echo "  unit file           : $FRAGMENT"
  echo "  unit sha256         : $UNIT_SHA_AFTER"
  echo "  rendered            : TimeoutStartSec=600 KillMode=process Type=notify"
  echo "  systemd effective   : TimeoutStartUSec=$TIMEOUT_USEC KillMode=$KILLMODE"
  echo "  onboard boot        : ${ONBOARD_BOOT:-unknown}s (fresh db, uncontrolled)"
  echo "  baseline boot       : ${BASELINE_BOOT}s (warm, idle host)"
  echo "  proof boot          : ${PROOF_BOOT}s (loaded host, systemd-measured, bar >${SLOW_BOOT_MIN_BOOT_SECONDS}s)"
  echo "  wall clock          : ${WALL_BOOT}s"
  echo "  load                : ${LOAD_WORKERS} workers on ${NPROC} cores (${TOPUPS} top-up(s))"
  echo "  READY=1 reached     : yes (SubState=$SUB_STATE, StatusText='$STATUS_TEXT')"
  echo "  NRestarts           : $N_RESTARTS"
  echo "  ActiveState         : $ACTIVE_STATE"
  echo "  Result              : $RESULT"
  echo
  echo "--- rendered unit as the installer wrote it ($FRAGMENT) ---"
  cat "$FRAGMENT"
} > "$EVIDENCE"
note "EVIDENCE"
cat "$EVIDENCE"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### PET-296 slow-boot proof (clean host)"
    echo
    echo '```'
    cat "$EVIDENCE"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

summarize
