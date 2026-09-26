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
# TWO MODES
#
#   proof  the deliverable. One real install, one boot made to exceed 90s on
#          purpose, and the DoD asserted on it.
#   probe  measures what this host can actually be made to do, one boot per
#          candidate lever, and prints the table. Exists because the obvious
#          lever is wrong and guessing cost a cycle to find out (see below).
#
# WHY THE OBVIOUS LEVER IS WRONG (measured, run 36248896352)
#
# The first version slowed the host with CPU oversubscription only, on the
# theory that the outage was a loaded machine. On a clean runner:
#
#   boot 0  onboard, fresh db, all migrations, idle      9s
#   boot 1  warm, idle (calibration baseline)            5s
#   boot 2  warm, 190 CPU spinners on 4 cores            ~10s
#
# 190 spinners bought 2x, where the (r+1)/nproc model predicts ~48x. The boot
# is not CPU-bound: `Type=notify` means READY=1 waits on the embedded
# postmaster and migrations, which on an idle host is a short, largely serial,
# largely *I/O-bound* sequence. Spinning cores contend for CPU the boot barely
# uses. A boot that waits cannot be stretched by starving a CPU it is not using,
# and the irreducible I/O wait is a floor no amount of CPU contention moves.
# So the levers below are typed by WHAT they slow, and every boot records how
# much CPU it actually got, so a weak lever can never again be mistaken for an
# ineffective one.
#
#   idle     nothing. The control every other number is read against.
#   cpu:N    N CPU spinners outside the unit's cgroup. Absolute count.
#   cpu:xN   N * nproc spinners, so the same oversubscription on any runner.
#   io:RATE  cgroup v2 `io.max` on the unit's cgroup: RATE bytes/sec of
#            read+write, e.g. `io:8m`. This is the lever that speaks to the
#            bottleneck, and it is also the closest stand-in for the real
#            cause -- outage #4 was a host whose disk could not keep up, on a
#            box where swap was exhausted and the postmaster was thrashing.
#   swap:MB  hold MB resident to push the boot's own allocations onto a
#            swapfile. Requires a swapfile; the workflow creates one and the
#            lever reports itself skipped when there is none.
#
# DoD 4 is intact under all of them. `io.max` and swap are properties of the
# machine, applied from outside: no drop-in is created, no unit property is
# set, `systemctl set-property` is never called, and the unit file is hashed
# before and after the proof and compared (assertions 7a/7b). Deliberately
# NOT used, and why:
#
#   * a drop-in. DoD 4 forbids hand-editing the host to manufacture the proof;
#     the point is that a fresh onboard inherits the budget.
#   * `systemctl set-property` / CPUQuota / IOWeight on the unit. All of those
#     write a drop-in -- the same forbidden move wearing a different hat.
#   * a cgroup *move* of the unit. Same reason.
#   * patching the server to sleep before it notifies. That would prove the
#     budget is sufficient while proving nothing about a real boot.
#
# STRUCTURE (proof mode: four boots, all on the real unit)
#
#   boot 0  the onboard boot. Fresh instance, so this one pays for every
#           migration. Reported, not asserted on: it is uncontrolled, because
#           `onboard --install-service` installs and starts in one step.
#   boot 1  warm baseline, unloaded. Calibrates boot 2. Reported as
#           `baselineBootSeconds`.
#   boot 2  THE PROOF. The host is slowed on purpose, then start. Asserts >90s
#           to ready with NRestarts=0 and ActiveState=active. This is the
#           number DoD 2 wants.
#   boot 3  THE CONTROL. The same lever, against a unit that differs from the
#           rendered one in exactly one respect: TimeoutStartSec removed, so
#           the 90s default applies. This is what makes boot 2 mean something.
#           Without it, ">90s and it worked" is equally consistent with the
#           budget being irrelevant. Asserted to FAIL with Result=timeout and
#           NRestarts>=1 -- a control that passes is a broken control, so it
#           is asserted to fail rather than merely reported.
#
# boot 1 and boot 2 are both warm, so they are comparable and the calibration
# is not skewed by a fresh database. A clean stop/start resets NRestarts
# (measured on systemd 261: kill -9 the main pid -> NRestarts=1; stop; start
# -> NRestarts=0), so asserting NRestarts=0 after boot 2 really does mean boot
# 2 needed zero restarts. The control's unit is restored and re-verified
# byte-identical afterwards, so the host is left as it was found.
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
#   SLOW_BOOT_MODE              proof | probe (default proof)
#   SLOW_BOOT_LEVERS            probe mode: space-separated lever list
#   SLOW_BOOT_LEVER             proof mode: the lever that gets boot 2 over the bar
#   SLOW_BOOT_REPO              GitHub repo to install from (default PetrouilFan/paperclip)
#   SLOW_BOOT_REF               ref/sha to install (default: this checkout's sha)
#   SLOW_BOOT_INSTANCE          instance id (default pet296)
#   SLOW_BOOT_MIN_BOOT_SECONDS  the bar the proof boot must clear (default 90)
#   SLOW_BOOT_READY_TIMEOUT     hard cap on any single wait (default 420)
#   SLOW_BOOT_PROBE_CAP         hard cap on one probe boot (default 240)
#   SLOW_BOOT_KEEP_LEVER        1 = leave the lever applied for inspection

SLOW_BOOT_MODE="${SLOW_BOOT_MODE:-proof}"
SLOW_BOOT_LEVERS="${SLOW_BOOT_LEVERS:-idle cpu:x8 cpu:x32 cpu:x64 io:64m io:8m io:1m swap:2048}"
SLOW_BOOT_LEVER="${SLOW_BOOT_LEVER:-io:8m}"
SLOW_BOOT_REPO="${SLOW_BOOT_REPO:-PetrouilFan/paperclip}"
SLOW_BOOT_REF="${SLOW_BOOT_REF:-}"
SLOW_BOOT_INSTANCE="${SLOW_BOOT_INSTANCE:-pet296}"
SLOW_BOOT_MIN_BOOT_SECONDS="${SLOW_BOOT_MIN_BOOT_SECONDS:-90}"
SLOW_BOOT_READY_TIMEOUT="${SLOW_BOOT_READY_TIMEOUT:-420}"
SLOW_BOOT_PROBE_CAP="${SLOW_BOOT_PROBE_CAP:-240}"
SLOW_BOOT_KEEP_LEVER="${SLOW_BOOT_KEEP_LEVER:-0}"

UNIT="paperclipai-${SLOW_BOOT_INSTANCE}.service"
SHIM="$HOME/.local/bin/paperclipai"
STORE="$HOME/.paperclip/cli"
BOOT_CLI=""
CREATED="false"
RESULTS=()
FAILED=0
TABLE=()

# lever state, all released by lever_release / the EXIT trap
LOAD_PIDS=()
LOAD_WORKERS=0
SWAP_PIDS=()
IO_CG=""
IO_DEV=""
IO_PREV=""

# --- output helpers -------------------------------------------------------
note()  { printf '\n\033[1;34m== %s ==\033[0m\n' "$*"; }
pass()  { RESULTS+=("PASS  $1"); printf '\033[1;32mPASS\033[0m %s\n' "$1"; }
fail_() { RESULTS+=("FAIL  $1"); printf '\033[1;31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip()  { printf '\033[1;33mSKIP\033[0m %s\n' "$*"; }
info()  { printf '      %s\n' "$*"; }
die()   { printf '\033[1;31mABORT\033[0m %s\n' "$*" >&2; exit 1; }

# `printf` with a leading dash in the format is a portability trap, and the
# table is built from measured numbers, so keep every column non-empty and
# space separated rather than padding by hand.
row() { printf '      %-14s %8s %6s %6s %8s  %s\n' "$@"; }

summarize() {
  note "RESULTS ($SLOW_BOOT_REPO@$SLOW_BOOT_REF on $(uname -sm), $(nproc) cores, mode=$SLOW_BOOT_MODE)"
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

# --- levers ---------------------------------------------------------------
# Every wait on a killed child goes through `|| true`. A child that ends on
# SIGTERM makes `wait` return non-zero, and under `set -e` that is a silent
# exit of the whole script -- which is exactly how run 36248896352 reported
# `script_exit=1` with no FAIL and no ABORT, immediately after a proof boot
# that had actually succeeded. Reproduced in isolation before the fix.
load_stop() {
  local pid
  for pid in ${LOAD_PIDS[@]+"${LOAD_PIDS[@]}"}; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in ${LOAD_PIDS[@]+"${LOAD_PIDS[@]}"}; do
    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi
  done
  LOAD_PIDS=()
  LOAD_WORKERS=0
  return 0
}

# Add $1 more cpu workers. A tight arithmetic loop, no syscalls, no files:
# pure oversubscription of the scheduler's CPU time.
load_add() {
  local n="$1" i
  [ "$n" -ge 1 ] || return 0
  for ((i = 0; i < n; i++)); do
    ( while :; do :; done ) &
    LOAD_PIDS+=("$!")
  done
  LOAD_WORKERS=$(( LOAD_WORKERS + n ))
}

# Hold $2 bytes resident in each of $1 processes, so the kernel has to put
# them somewhere. With a swapfile present and already full of the other
# holders, the boot's own anonymous pages get evicted -- which is the
# mechanism behind outage #4, where swap was at 100% and the postmaster was
# thrashing inside the unit's own boot.
swap_add() {
  local n="$1" bytes="$2" i
  [ "$n" -ge 1 ] || return 0
  for ((i = 0; i < n; i++)); do
    ( timeout --signal=KILL 86400 perl -e '
        my $b = $ARGV[0];
        my @chunks = ("x" x (1024*1024)) x $b;
        my $i = 0;
        while (1) { $i = ($i + 1) % scalar @chunks; }
      ' "$bytes" ) &
    SWAP_PIDS+=("$!")
  done
}

swap_stop() {
  local pid
  for pid in ${SWAP_PIDS[@]+"${SWAP_PIDS[@]}"}; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in ${SWAP_PIDS[@]+"${SWAP_PIDS[@]}"}; do
    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi
  done
  SWAP_PIDS=()
  return 0
}

# Write to a cgroup file, escalating to sudo only if the plain write is
# refused, and saying which of the two happened. Enabling a controller in a
# subtree_control needs root even when the cgroup is otherwise yours.
cg_write() {
  local path="$1" value="$2"
  if printf '%s' "$value" > "$path" 2>/dev/null; then
    return 0
  fi
  if printf '%s' "$value" | sudo tee "$path" >/dev/null 2>&1; then
    return 1
  fi
  return 2
}

# cgroup v2 only creates io.max in a cgroup once `io` is in its PARENT's
# cgroup.subtree_control, so the controller has to be switched on at every
# level from the root down to the unit's parent. Enabling it needs the cgroup
# to hold no processes directly (the "no internal process" rule), so failures
# here are expected on some hosts and are reported, never assumed either way.
io_enable() {
  local target="$1" chain=() cur c rc
  [ -d "/sys/fs/cgroup$target" ] || { info "io: no cgroup at $target"; return 1; }
  cur="$target"
  while [ "$cur" != "/" ] && [ -d "/sys/fs/cgroup$cur" ]; do
    chain=("$cur" "${chain[@]+"${chain[@]}"}")
    cur="$(dirname "$cur")"
  done
  for c in "${chain[@]+"${chain[@]}"}"; do
    local sc="/sys/fs/cgroup$c/cgroup.subtree_control"
    [ -f "$sc" ] || continue
    grep -qw io "$sc" 2>/dev/null && continue
    cg_write "$sc" "+io" || true
  done
  [ -f "/sys/fs/cgroup$target/io.max" ] || {
    info "io: the io controller is not available for $target on this host"
    info "io: (a cgroup holding processes directly cannot enable it for its children)"
    return 1
  }
  return 0
}

# Which block device the instance's data actually lives on. io.max is keyed by
# the physical device, so this has to be the real major:minor and not the
# device the filesystem is mounted through.
io_device() {
  local dir="$1"
  findmnt -no MAJ:MIN --target "$dir" 2>/dev/null | head -1 | tr -d ' '
}

# Apply the rate to both directions. A boot is mostly reads, but the
# postmaster writes WAL and migrations write rows, so a read-only throttle
# would let the boot's write path through untouched.
io_apply() {
  local dev="$1" rate="$2" file="/sys/fs/cgroup$IO_CG/io.max"
  IO_PREV="$(cat "$file" 2>/dev/null || true)"
  if ! printf '%s rbps=%s wbps=%s\n' "$dev" "$rate" "$rate" | sudo tee "$file" >/dev/null 2>&1; then
    info "io: could not write $file"
    return 1
  fi
  if ! grep -q "$dev rbps=$rate" "$file" 2>/dev/null; then
    info "io: kernel did not accept the limit; read-back is: $(cat "$file" 2>/dev/null)"
    return 1
  fi
  info "io: $file limited to $rate rbps/wbps on $dev"
  return 0
}

io_release() {
  [ -n "$IO_CG" ] || return 0
  local file="/sys/fs/cgroup$IO_CG/io.max"
  if [ -f "$file" ] && [ -n "$IO_DEV" ]; then
    printf '%s rbps=max wbps=max\n' "$IO_DEV" | sudo tee "$file" >/dev/null 2>&1 || true
  fi
  return 0
}

lever_release() {
  if [ "$SLOW_BOOT_KEEP_LEVER" = "1" ]; then return 0; fi
  load_stop
  swap_stop
  io_release
  return 0
}

cleanup() {
  lever_release
  # Only ever tear down the unit this script installed, and only after onboard
  # actually created it. The trap is registered before the preflight runs, so
  # without the CREATED guard the refusal path would stop a host's unit.
  [ "$CREATED" = "true" ] || return 0
  if [ "$SLOW_BOOT_KEEP_LEVER" != "1" ]; then
    systemctl --user stop "paperclipai-${SLOW_BOOT_INSTANCE}.service" >/dev/null 2>&1 || true
    if [ -x "$SHIM" ]; then
      "$SHIM" service uninstall --instance "$SLOW_BOOT_INSTANCE" >/dev/null 2>&1 || true
    fi
  fi
  return 0
}

# lever_apply <spec>. Returns 1 when the lever is not available on this host,
# which the caller reports as SKIP rather than as a pass.
lever_apply() {
  local spec="$1" n
  case "$spec" in
    idle) info "lever: nothing applied (control)"; return 0 ;;
    cpu:*)
      n="${spec#cpu:}"
      case "$n" in
        x*) load_add $(( ${n#x} * $(nproc) )) ;;
        *)  load_add "$n" ;;
      esac
      info "lever: ${LOAD_WORKERS} cpu spinners on $(nproc) cores"
      return 0
      ;;
    swap:*)
      n="${spec#swap:}"
      if ! swapon --show 2>/dev/null | grep -q .; then
        info "swap: no swapfile on this host, cannot apply swap:$n"
        return 1
      fi
      swap_add 2 $(( n * 1024 * 1024 ))
      # Give the kernel a moment to fault the pages in before the boot starts
      # competing for them; otherwise the first moments of the boot are fast
      # and the measurement flatters the lever.
      sleep 5
      info "lever: ${#SWAP_PIDS[@]} processes holding $n MB each, swap: $(free -m | awk '/^Swap:/{print $3"/"$2" MB used"}')"
      return 0
      ;;
    io:*)
      n="${spec#io:}"
      if ! io_enable "$IO_CG"; then return 1; fi
      IO_DEV="$(io_device "$HOME/.paperclip/instances/$SLOW_BOOT_INSTANCE")"
      if [ -z "$IO_DEV" ]; then
        info "io: could not resolve the block device for the instance data dir"
        return 1
      fi
      if ! io_apply "$IO_DEV" "$n"; then return 1; fi
      return 0
      ;;
    *) info "lever: unknown spec '$spec'"; return 1 ;;
  esac
}

# --- host CPU accounting --------------------------------------------------
# Sampled across a boot, so a boot that was "slow" while the host sat idle can
# be told apart from one that was slow because the lever was actually biting.
# Summed in the shell rather than in awk: the obvious awk version passes "|"
# as a split() separator, which is an empty-matching regex, not a literal.
CPU_BUSY=0
CPU_IDLE=0
cpu_accounting_reset() { CPU_BUSY=0; CPU_IDLE=0; }
cpu_accounting_sample() {
  local _tag u n s i iow irq sirq st _g _gn _rest
  read -r _tag u n s i iow irq sirq st _g _gn _rest < /proc/stat || return 0
  # guest and guest_nice are already counted inside user/nice, so they are
  # read only to be discarded rather than added a second time.
  CPU_BUSY=$(( CPU_BUSY + u + n + s + iow + irq + sirq + st ))
  CPU_IDLE=$(( CPU_IDLE + i ))
  return 0
}
cpu_percent() {
  local total=$(( CPU_BUSY + CPU_IDLE ))
  if [ "$total" -le 0 ]; then echo 0; else echo $(( 100 * CPU_BUSY / total )); fi
}

# Registered before the preflight so a lever can never be left applied because
# the script died early. cleanup() returns immediately until onboard has
# actually created a unit, so the refusal path cannot stop anything that
# belongs to the host.
trap 'cleanup' EXIT INT TERM

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
info "unit=$UNIT mode=$SLOW_BOOT_MODE"
info "swap: $(swapon --show 2>/dev/null | tail -n +2 | wc -l) swap area(s), $(free -m | awk '/^Swap:/{print $2}') MB total"
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
# The cgroup the levers act on, and the device the instance data lives on.
IO_CG="$(prop ControlGroup)"
info "unit cgroup: ${IO_CG:-unknown}"
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
info "the bar to clear is ${SLOW_BOOT_MIN_BOOT_SECONDS}s, i.e. $(( SLOW_BOOT_MIN_BOOT_SECONDS * 100 / (BASELINE_BOOT < 1 ? 1 : BASELINE_BOOT) ))% of the baseline boot"
systemctl --user stop "$UNIT" || die "could not stop the baseline unit"
systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
# A clean stop/start resets NRestarts, so NRestarts=0 after a later boot means
# that boot needed zero restarts rather than inheriting a count.
[ "$(prop NRestarts)" = "0" ] || die "NRestarts is $(prop NRestarts) after a clean stop; the baseline is not clean"

# --- one boot, under whatever lever is currently applied -------------------
# Shared by probe mode and by boots 2/3 in proof mode, so both measure the
# same things the same way. Prints nothing on success; sets BOOT_OUT to a
# space-separated record: <seconds|none> <ActiveState> <SubState> <NRestarts>
# <Result> <cpu-percent-of-one-core>. A boot that never becomes ready reports
# "none" and the systemd state that explains why.
BOOT_OUT=""
measure_boot() {
  local label="$1" cap="$2"
  local start deadline elapsed out
  start="$(date +%s)"
  deadline=$(( start + cap ))
  cpu_accounting_reset
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
  if ! systemctl --user start --no-block "$UNIT"; then
    BOOT_OUT="none $(prop ActiveState) $(prop SubState) $(prop NRestarts) startrefused 0"
    return 1
  fi
  while :; do
    case "$(prop ActiveState)/$(prop SubState)" in
      active/running) break ;;
      failed/*) break ;;
      inactive/*)
        # A unit killed by a start timeout lands here rather than in failed/,
        # because Restart=always means systemd is about to try again.
        ;;
    esac
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$cap" ]; then
      # Leave it in whatever state it reached; the caller reports it as
      # "did not finish inside the cap" rather than guessing why.
      BOOT_OUT="none $(prop ActiveState) $(prop SubState) $(prop NRestarts) cap:${elapsed}s 0"
      return 1
    fi
    cpu_accounting_sample
    sleep 1
  done
  local seconds
  seconds="$(boot_seconds)"
  [ -n "$seconds" ] || seconds="none"
  BOOT_OUT="$seconds $(prop ActiveState) $(prop SubState) $(prop NRestarts) $(prop Result) $(cpu_percent)"
  return 0
}

# ===========================================================================
# PROBE MODE
# ===========================================================================
if [ "$SLOW_BOOT_MODE" = "probe" ]; then
  note "6. PROBE: what can this host actually be made to do to a real boot?"
  info "one warm boot per lever; the idle row is the control for all the others"
  info "cpu% is the unit's share of total host CPU time across the boot, so a"
  info "row that is slow while cpu% is ~100 means the lever was not the constraint"
  row LEVER BOOTS NRES RESULT CPU% NOTE
  for LEVER in $SLOW_BOOT_LEVERS; do
    systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
    systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
    if ! lever_apply "$LEVER"; then
      row "$LEVER" - - - - "lever unavailable on this host"
      TABLE+=("$LEVER|unavailable|-|-|-|-")
      continue
    fi
    set +e
    measure_boot "$LEVER" "$SLOW_BOOT_PROBE_CAP"
    mrc=$?
    set -e
    lever_release
    # shellcheck disable=SC2086
    set -- $BOOT_OUT
    P_BOOT="$1"; P_STATE="$2"; P_SUB="$3"; P_NRES="$4"; P_RESULT="$5"; P_CPU="$6"
    NOTE=""
    if [ "$mrc" != "0" ] && [ "$P_RESULT" = "timeout" ]; then
      NOTE="SIGTERMed at the 600s budget"
    elif [ "$mrc" != "0" ]; then
      NOTE="$P_RESULT"
    elif [ "$P_BOOT" -gt "$SLOW_BOOT_MIN_BOOT_SECONDS" ] 2>/dev/null; then
      NOTE="CLEARS THE ${SLOW_BOOT_MIN_BOOT_SECONDS}s BAR"
    fi
    row "$LEVER" "$P_BOOT" "$P_NRES" "$P_RESULT" "${P_CPU}%" "$NOTE"
    TABLE+=("$LEVER|$P_BOOT|$P_NRES|$P_RESULT|$P_CPU|$NOTE")
  done

  note "PROBE TABLE"
  printf '      %-14s %8s %6s %10s %6s  %s\n' LEVER BOOTS NRES RESULT CPU% NOTE
  for line in ${TABLE[@]+"${TABLE[@]}"}; do
    IFS='|' read -r l b n r c note_ <<< "$line"
    printf '      %-14s %8s %6s %10s %6s  %s\n' "$l" "$b" "$n" "$r" "${c}%" "$note_"
  done

  # The probe writes the same evidence file the proof does, so the workflow's
  # artifact upload (if-no-files-found: error) has something to pick up and the
  # table is a durable artifact rather than only a line in a CI log that
  # expires. Its schema is the probe's, not the proof's: there is no proof boot
  # here, so PROOF_BOOT and the control numbers would be lies.
  EVIDENCE="${RUNNER_TEMP:-$HOME}/pet296-evidence.txt"
  # Recomputed here rather than reusing the proof's UNIT_SHA_AFTER, which is
  # assigned after this block. If the levers did write a drop-in, this is where
  # the probe would show it.
  UNIT_SHA_AFTER="$(sha256sum "$UNIT_FILE" 2>/dev/null | cut -d' ' -f1)"
  {
    echo "PET-296 slow-boot lever probe (clean host)"
    echo "  host                : $(uname -srm), $(nproc) cores, systemd $(systemctl --version | head -1 | awk '{print $2}')"
    echo "  ref installed       : $SLOW_BOOT_REPO@$SLOW_BOOT_REF"
    echo "  unit                : paperclipai-${SLOW_BOOT_INSTANCE}.service"
    echo "  unit sha256         : $UNIT_SHA_AFTER (was $UNIT_SHA_BEFORE before any probe boot)"
    echo "  rendered            : TimeoutStartSec=600 KillMode=process Type=notify"
    echo "  mode                : probe (no proof boot; this measures which lever can make one)"
    echo "  bar for a lever     : >${SLOW_BOOT_MIN_BOOT_SECONDS}s to ready, with headroom under the 600s budget"
    echo "  onboard boot        : ${ONBOARD_BOOT:-unknown}s (fresh db, uncontrolled)"
    echo "  drop-in dir         : $([ -d "${UNIT_FILE}.d" ] && echo "EXISTS - a lever wrote to the unit, which DoD 4 forbids" || echo "absent (the levers are host-level only)")"
    echo "  unit unchanged      : $([ "$UNIT_SHA_BEFORE" = "$UNIT_SHA_AFTER" ] && echo "yes" || echo "NO - the unit file changed during the probe")"
    echo
    echo "  LEVER       BOOTS  NRES     RESULT   CPU%  NOTE"
    for line in ${TABLE[@]+"${TABLE[@]}"}; do
      IFS='|' read -r l b n r c note_ <<< "$line"
      printf '  %-12s %7s %5s %9s %5s  %s\n' "$l" "$b" "$n" "$r" "$c" "$note_"
    done
  } > "$EVIDENCE"
  note "EVIDENCE"
  cat "$EVIDENCE"

  note "READING THIS TABLE"
  cat <<'EOF'
  The lever for the proof is the cheapest row that CLEARS THE BAR and leaves
  headroom under the 600s budget -- a row that only just clears it is a row
  that will flake on the next runner, and one that reaches 600s proves the
  budget bounded the boot rather than the boot completing inside it.

  cpu% near 100 with a boot that did not move says the CPU was the constraint
  and there was not enough of it. cpu% far below 100 says the boot was waiting
  on something else, and only a lever that slows that something will move it.
EOF

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### PET-296 slow-boot lever probe (clean host)"
      echo
      echo '```'
      printf '%-14s %8s %6s %10s %6s  %s\n' LEVER BOOTS NRES RESULT CPU% NOTE
      for line in ${TABLE[@]+"${TABLE[@]}"}; do
        IFS='|' read -r l b n r c note_ <<< "$line"
        printf '%-14s %8s %6s %10s %6s  %s\n' "$l" "$b" "$n" "$r" "${c}%" "$note_"
      done
      echo '```'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  summarize
fi

# ===========================================================================
# PROOF MODE
# ===========================================================================
note "6. boot 2, THE PROOF: $SLOW_BOOT_LEVER applied, then start"
if ! lever_apply "$SLOW_BOOT_LEVER"; then
  die "the lever '$SLOW_BOOT_LEVER' is not available on this host, so boot 2 cannot be made slow. Run SLOW_BOOT_MODE=probe to find one that is."
fi
set +e
measure_boot "proof" $(( SLOW_BOOT_READY_TIMEOUT + 60 ))
PROOF_RC=$?
set -e
# shellcheck disable=SC2086
set -- $BOOT_OUT
PROOF_BOOT="$1"; ACTIVE_STATE="$2"; SUB_STATE="$3"; N_RESTARTS="$4"; RESULT="$5"
PROOF_CPU="$6"
info "boot 2: ${PROOF_BOOT}s  ActiveState=$ACTIVE_STATE SubState=$SUB_STATE NRestarts=$N_RESTARTS Result=$RESULT cpu=${PROOF_CPU}%"
if [ "$PROOF_RC" != "0" ]; then
  if [ "$RESULT" = "timeout" ]; then
    die "the boot overran the ${EFF_TIMEOUT} budget and was SIGTERMed (Result=timeout): the lever was too strong, weaken SLOW_BOOT_LEVER"
  fi
  journalctl --user -u "$UNIT" --no-pager -n 40 || true
  die "the proof boot failed (Result=$RESULT, ActiveState=$ACTIVE_STATE) instead of completing"
fi
lever_release

# The three numbers DoD 2 asks for, read back from systemd.
STATUS_TEXT="$(prop StatusText)"
TIMEOUT_USEC="$(prop TimeoutStartUSec)"
KILLMODE="$(prop KillMode)"
FRAGMENT="$(prop FragmentPath)"

# DoD 2. `>90s`, from systemd's own timestamps rather than a stopwatch.
if [ "$PROOF_BOOT" -gt "$SLOW_BOOT_MIN_BOOT_SECONDS" ]; then
  pass "6b boot took ${PROOF_BOOT}s, over the ${SLOW_BOOT_MIN_BOOT_SECONDS}s default start timeout"
else
  fail_ "6b boot took ${PROOF_BOOT}s, which does NOT exceed ${SLOW_BOOT_MIN_BOOT_SECONDS}s"
  info "the lever was not enough to reproduce a slow boot; probe for a stronger one"
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

# --- 7. boot 3, THE CONTROL: the same load, the 90s default ---------------
# Everything about boot 3 is boot 2 with one line changed, so the only
# explanation left for the difference is the rendered budget. The changed line
# lives in a copy of the rendered unit under a second name, so the unit under
# test keeps its own file untouched and this host is left as it was found.
note "7. boot 3, THE CONTROL: same lever, TimeoutStartSec removed"
CONTROL_UNIT="paperclipai-${SLOW_BOOT_INSTANCE}-control.service"
CONTROL_FILE="$HOME/.config/systemd/user/$CONTROL_UNIT"
CONTROL_SHA="$(sha256sum "$FRAGMENT" | cut -d' ' -f1)"
[ "$CONTROL_SHA" = "$UNIT_SHA_BEFORE" ] \
  || die "the unit changed between boot 2 and the control (before $UNIT_SHA_BEFORE now $CONTROL_SHA)"
sed -e 's/^TimeoutStartSec=600$//' \
    -e "s/^Description=.*/Description=Paperclip AI (${SLOW_BOOT_INSTANCE} CONTROL, no start budget)/" \
    "$FRAGMENT" > "$CONTROL_FILE"
systemctl --user daemon-reload
CONTROL_EFF="$(systemctl --user show "$CONTROL_UNIT" -p TimeoutStartUSec --value 2>/dev/null || true)"
CONTROL_EFF_SECS="$(timespan_to_seconds "$CONTROL_EFF" || echo -1)"
info "control unit: $CONTROL_FILE (TimeoutStartSec line removed)"
info "control effective TimeoutStartUSec=$CONTROL_EFF (${CONTROL_EFF_SECS}s)"
# The control is a different unit name, so point the measurement helpers at it
# for the length of this boot and put them back afterwards.
UNIT="$CONTROL_UNIT"
if [ "$CONTROL_EFF_SECS" != "90" ]; then
  fail_ "7a the control really does run on the 90s default (got ${CONTROL_EFF_SECS}s); without that the control proves nothing"
  systemctl --user stop "$CONTROL_UNIT" >/dev/null 2>&1 || true
else
  pass "7a the control runs on systemd's 90s default (TimeoutStartUSec=$CONTROL_EFF)"
fi

if lever_apply "$SLOW_BOOT_LEVER"; then :; else
  fail_ "7b the control could not apply $SLOW_BOOT_LEVER, so it cannot be a control for boot 2"
fi
set +e
measure_boot "control" $(( CONTROL_EFF_SECS + 90 ))
CTL_RC=$?
set -e
# shellcheck disable=SC2086
set -- $BOOT_OUT
CTL_BOOT="$1"; CTL_STATE="$2"; CTL_SUB="$3"; CTL_NRES="$4"; CTL_RESULT="$5"
lever_release
info "control: boot ${CTL_BOOT:-did not complete}  ActiveState=$CTL_STATE SubState=$CTL_SUB NRestarts=$CTL_NRES Result=$CTL_RESULT"
journalctl --user -u "$CONTROL_UNIT" --no-pager -n 12 || true
# Asserted to FAIL. A control that completed is a broken control: it would mean
# the boot was never actually under pressure, and boot 2's result would be
# explaining itself with the one difference that is supposed to matter.
if [ "$CTL_RESULT" = "timeout" ] && [ "$CTL_NRES" -ge 1 ] 2>/dev/null; then
  pass "7b the control was SIGTERMed at ${CONTROL_EFF_SECS}s and restarted (Result=timeout, NRestarts=$CTL_NRES)"
elif [ "$CTL_BOOT" != "none" ] && [ "${CTL_BOOT:-0}" -gt "$SLOW_BOOT_MIN_BOOT_SECONDS" ] 2>/dev/null; then
  fail_ "7b the control completed in ${CTL_BOOT}s on a 90s budget, so the load is not what the proof turns on"
  info "the lever must make a boot exceed 90s even with no budget at all"
else
  fail_ "7b the control did not show the outage (Result=$CTL_RESULT NRestarts=$CTL_NRES); it should have been SIGTERMed at ${CONTROL_EFF_SECS}s"
fi
systemctl --user stop "$CONTROL_UNIT" >/dev/null 2>&1 || true
rm -f "$CONTROL_FILE"
systemctl --user daemon-reload
systemctl --user reset-failed "$CONTROL_UNIT" >/dev/null 2>&1 || true
UNIT="paperclipai-${SLOW_BOOT_INSTANCE}.service"

# DoD 4, re-checked: the unit the proof ran is byte-for-byte the one the
# installer wrote. If anything had hand-edited it to buy the result, the hash
# moves.
UNIT_SHA_AFTER="$(sha256sum "$FRAGMENT" | cut -d' ' -f1)"
if [ "$UNIT_SHA_BEFORE" = "$UNIT_SHA_AFTER" ]; then
  pass "8a the unit is unchanged across every boot (sha256 $UNIT_SHA_AFTER): nothing was hand-edited"
else
  fail_ "8a the unit changed across the proof (before $UNIT_SHA_BEFORE after $UNIT_SHA_AFTER)"
fi
if [ -d "${FRAGMENT}.d" ]; then
  fail_ "8b no drop-in appeared for the unit during the proof (DoD 4)"
  ls -la "${FRAGMENT}.d"
else
  pass "8b no drop-in exists for the unit (DoD 4): the renderer's budget is what carried the boot"
fi

# --- evidence block -------------------------------------------------------
# The three values DoD 3 asks to be posted, in one copy-pasteable block.
EVIDENCE="${RUNNER_TEMP:-$HOME}/pet296-evidence.txt"
{
  echo "PET-296 slow-boot proof (clean host)"
  echo "  host                : $(uname -srm), $(nproc) cores, systemd $(systemctl --version | head -1 | awk '{print $2}')"
  echo "  ref installed       : $SLOW_BOOT_REPO@$SLOW_BOOT_REF"
  echo "  unit                : paperclipai-${SLOW_BOOT_INSTANCE}.service"
  echo "  unit file           : $FRAGMENT"
  echo "  unit sha256         : $UNIT_SHA_AFTER (identical before and after every boot)"
  echo "  rendered            : TimeoutStartSec=600 KillMode=process Type=notify"
  echo "  systemd effective   : TimeoutStartUSec=$TIMEOUT_USEC KillMode=$KILLMODE"
  echo "  lever under test    : $SLOW_BOOT_LEVER (host-level, no drop-in, no unit property)"
  echo "  onboard boot        : ${ONBOARD_BOOT:-unknown}s (fresh db, uncontrolled)"
  echo "  baseline boot       : ${BASELINE_BOOT}s (warm, idle host)"
  echo "  proof boot          : ${PROOF_BOOT}s (loaded host, systemd-measured, bar >${SLOW_BOOT_MIN_BOOT_SECONDS}s)"
  echo "  proof cpu share     : ${PROOF_CPU}% of host CPU time"
  echo "  READY=1 reached     : yes (SubState=$SUB_STATE, StatusText='$STATUS_TEXT')"
  echo "  NRestarts           : $N_RESTARTS"
  echo "  ActiveState         : $ACTIVE_STATE"
  echo "  Result              : $RESULT"
  echo
  echo "  -- control: identical, with TimeoutStartSec removed --"
  echo "  control budget      : TimeoutStartUSec=$CONTROL_EFF (${CONTROL_EFF_SECS}s, the 90s default)"
  echo "  control boot        : ${CTL_BOOT:-did not complete}"
  echo "  control NRestarts   : $CTL_NRES"
  echo "  control Result      : $CTL_RESULT"
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
