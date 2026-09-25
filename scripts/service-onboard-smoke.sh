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
export HOME="$SMOKE_ISOHOME"
export XDG_CONFIG_HOME="$SMOKE_ISOHOME/.config"

# A distinct instance id is the part that actually makes this safe, and the HOME
# override alone is not. `systemctl --user <verb> <name>` addresses units the
# manager already loaded; XDG_CONFIG_HOME only decides where *new* unit files are
# searched. Measured on a host with a live paperclipai.service: with HOME and
# XDG_CONFIG_HOME pointed at an empty temp dir, `systemctl --user cat/is-active`
# still resolved the real unit. So the override protects the unit file that
# uninstall deletes by path, but NOT the by-name stop/disable in the same
# uninstall, and NOT the `systemctl --user stop` in cleanup() below.
# Its own instance renames the unit to paperclipai-smoke.service, a name the host
# cannot have, so no verb can reach the production unit.
SMOKE_INSTANCE="smoke"
SERVICE_NAME="paperclipai-${SMOKE_INSTANCE}.service"
export PAPERCLIP_INSTANCE_ID="$SMOKE_INSTANCE"   # what `onboard` reads
SHIM_PATH="${PAPERCLIP_SHIM_PATH:-$SMOKE_ISOHOME/.local/bin/paperclipai}"
# Cleanup defaults to on so a local run does not leave a service behind; CI
# disables it so the diagnostics step can still inspect the unit.
SMOKE_CLEANUP="${SMOKE_CLEANUP:-true}"
SMOKE_FORCE="${SMOKE_FORCE:-false}"
# Set once onboard has actually installed this script's own unit; cleanup()
# refuses to touch anything before that.
SMOKE_CREATED="false"

fail() {
  echo "Service smoke failed: $*" >&2
  # Restore HOME before exit so the caller's environment is not poisoned.
  unset HOME XDG_CONFIG_HOME
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
  if systemctl --user is-active paperclipai.service 2>/dev/null | grep -q active; then
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
