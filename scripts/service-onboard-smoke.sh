#!/usr/bin/env bash
set -euo pipefail

# Prove that `onboard --install-service` on a released artifact leaves a
# working background service. The Docker onboard smoke can never cover this
# leg: containers have no service manager, so a release whose service install
# crash-loops on a missing shim (v2026.824.0) still passes every golden-path
# check. This script runs the published npm artifact on a real systemd user
# session and fails unless the installed service itself ends up serving
# /api/health.
#
# Requirements: a Linux host with a user systemd session. In CI that means
# `loginctl enable-linger` plus XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS
# pointing at /run/user/<uid>; see the smoke_service job in
# .github/workflows/release-smoke.yml.

PAPERCLIPAI_VERSION="${PAPERCLIPAI_VERSION:-latest}"
DATA_DIR="${DATA_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/paperclip-service-smoke.XXXXXX")}"
ONBOARD_TIMEOUT_SECONDS="${ONBOARD_TIMEOUT_SECONDS:-600}"
SMOKE_READY_TIMEOUT_SECONDS="${SMOKE_READY_TIMEOUT_SECONDS:-420}"
# Pinned, not overridable: a caller-supplied HEALTH_URL is the one way this
# smoke could be pointed at a production server and report a false pass.
HEALTH_URL="http://127.0.0.1:3100/api/health"

# PET-52: e2e scripts must not address the real service in the real $HOME.
# Run entirely against an isolated home so the smoke can never uninstall a
# production paperclipai.service.
SMOKE_ISOHOME="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-smoke-iso.XXXXXX")" || {
  echo "Service smoke failed: could not create isolated HOME" >&2
  exit 1
}
if [[ -z "$SMOKE_ISOHOME" || ! -d "$SMOKE_ISOHOME" ]]; then
  echo "Service smoke failed: isolated HOME was not created (got '${SMOKE_ISOHOME}')" >&2
  exit 1
fi
# PET-52: e2e scripts must not address the real service in the real $HOME.
#
# The isolated home below is DATA isolation only. $HOME and $XDG_CONFIG_HOME
# are deliberately NOT pointed at it, because doing so makes this script
# incapable of passing.
#
# Measured (PET-259, 2026-09-26) on a host with a live systemd --user manager
# using a throwaway unit name: `systemctl --user enable <name>` resolves unit
# files from the MANAGER's search path, captured when the manager started. A
# unit written under an overridden HOME/XDG_CONFIG_HOME is invisible to it and
# enable fails with "Failed to enable unit: Unit <name> does not exist." The
# client's environment makes no difference in either direction; with the file
# in the manager's own path the same command resolves it with no daemon-reload.
# The earlier comment here claimed the opposite, citing a measurement that only
# showed the *host* unit is not moved -- the wrong direction to test.
#
# So the override could only ever break the smoke, never protect it: this
# script has never once got as far as starting the service it exists to test.
# Isolation rests on what measurably works -- the distinct instance id, which
# renames the unit to paperclipai-smoke.service, a name the host cannot have,
# so no by-name verb can reach the production unit. The instance's own data
# still goes to the mktemp'd dir via --data-dir below, and the mktemp/guard
# checks above stay load-bearing.
SMOKE_INSTANCE="smoke"
SERVICE_NAME="paperclipai-${SMOKE_INSTANCE}.service"
export PAPERCLIP_INSTANCE_ID="$SMOKE_INSTANCE"   # what `onboard` reads
# resolveServiceShimPath is keyed to os.homedir(), so with $HOME left alone the
# shim is the one in the real ~/.local/bin. The old default pointed into
# $SMOKE_ISOHOME, which nothing creates.
SHIM_PATH="${PAPERCLIP_SHIM_PATH:-$HOME/.local/bin/paperclipai}"
# Cleanup defaults to on so a local run does not leave a service behind; CI
# disables it so the diagnostics step can still inspect the unit.
SMOKE_CLEANUP="${SMOKE_CLEANUP:-true}"
SMOKE_FORCE="${SMOKE_FORCE:-false}"
# Set once onboard has actually installed this script's own unit; cleanup()
# refuses to touch anything before that.
SMOKE_CREATED="false"

fail() {
  echo "Service smoke failed: $*" >&2
  # $HOME is no longer overridden (see above), so there is nothing to restore;
  # only the instance's own data dir goes.
  rm -rf "$SMOKE_ISOHOME"
  exit 1
}

diagnostics() {
  echo "--- systemctl --user status $SERVICE_NAME ---" >&2
  systemctl --user --no-pager status "$SERVICE_NAME" >&2 || true
  echo "--- journalctl --user -u $SERVICE_NAME (last 100 lines) ---" >&2
  journalctl --user -u "$SERVICE_NAME" --no-pager -n 100 >&2 || true
}

cleanup() {
  # Only ever tear down the unit this script created. The trap is registered
  # before the guards below, so cleanup used to run on the "refuse to smoke over
  # a real install" path and stop the host's production unit. SMOKE_CREATED is
  # the switch that stops cleanup from touching anything it did not install.
  if [[ "$SMOKE_CREATED" != "true" ]]; then
    return
  fi
  if [[ "$SMOKE_CLEANUP" == "true" ]]; then
    if [[ -x "$SHIM_PATH" ]]; then
      "$SHIM_PATH" service uninstall --instance "$SMOKE_INSTANCE" >/dev/null 2>&1 || true
    fi
    systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

command -v systemctl >/dev/null 2>&1 || fail "systemctl is not available on this host"
systemctl --user show-environment >/dev/null 2>&1 \
  || fail "no user systemd session; enable lingering and export XDG_RUNTIME_DIR first"

# Refuse to smoke over a host that already has a managed install: the
# assertions below would prove nothing, and cleanup would tear down a real
# service. The production unit is checked by its own name, because the leg runs
# under a different instance and would otherwise sail past a live install.
if [[ "$SMOKE_FORCE" != "true" ]]; then
  if [[ -e "$SHIM_PATH" ]]; then
    fail "$SHIM_PATH already exists; set SMOKE_FORCE=true to smoke over it"
  fi
  if systemctl --user cat "$SERVICE_NAME" >/dev/null 2>&1; then
    fail "$SERVICE_NAME is already installed; set SMOKE_FORCE=true to smoke over it"
  fi
  # `grep -qx`, not `grep -q`: `systemctl is-active` prints `inactive` for a
  # stopped unit and that word contains the substring `active`, so a plain
  # `grep -q active` fails this smoke on every host where production is merely
  # stopped, and names a service that is not running.
  if systemctl --user is-active paperclipai.service 2>/dev/null | grep -qx active; then
    fail "production paperclipai.service is active on this host; set SMOKE_FORCE=true to smoke anyway"
  fi
fi

echo "==> Onboarding paperclipai@$PAPERCLIPAI_VERSION with --install-service"
echo "    Data dir: $DATA_DIR"
if ! timeout "$ONBOARD_TIMEOUT_SECONDS" \
  npx --yes "paperclipai@${PAPERCLIPAI_VERSION}" onboard --yes --install-service --data-dir "$DATA_DIR"; then
  diagnostics
  fail "onboard exited non-zero"
fi
# The unit now exists under this script's own name; cleanup may touch it.
SMOKE_CREATED="true"

echo "==> Verifying the managed shim"
if [[ ! -x "$SHIM_PATH" ]]; then
  diagnostics
  fail "no executable shim at $SHIM_PATH after onboarding"
fi

echo "==> Waiting for $SERVICE_NAME to serve $HEALTH_URL"
for ((i = 1; i <= SMOKE_READY_TIMEOUT_SECONDS; i += 1)); do
  state="$(systemctl --user is-active "$SERVICE_NAME" 2>/dev/null || true)"
  if [[ "$state" == "failed" ]]; then
    diagnostics
    fail "$SERVICE_NAME entered the failed state"
  fi
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    if [[ "$state" != "active" ]]; then
      diagnostics
      fail "$HEALTH_URL answers but $SERVICE_NAME is '$state' - something other than the service is serving"
    fi
    echo "==> Service smoke passed: $SERVICE_NAME is active and serving $HEALTH_URL"
    exit 0
  fi
  sleep 1
done

diagnostics
fail "$HEALTH_URL not ready after ${SMOKE_READY_TIMEOUT_SECONDS}s (unit state: $(systemctl --user is-active "$SERVICE_NAME" 2>/dev/null || echo unknown))"
