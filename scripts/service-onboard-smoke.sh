#!/usr/bin/env bash
set -euo pipefail

PAPERCLIPAI_VERSION="${PAPERCLIPAI_VERSION:-latest}"
DATA_DIR="${DATA_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/paperclip-service-smoke.XXXXXX")}"
ONBOARD_TIMEOUT_SECONDS="${ONBOARD_TIMEOUT_SECONDS:-600}"
SMOKE_READY_TIMEOUT_SECONDS="${SMOKE_READY_TIMEOUT_SECONDS:-420}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"
SERVICE_NAME="paperclipai.service"
SHIM_PATH="${PAPERCLIP_SHIM_PATH:-$HOME/.local/bin/paperclipai}"
# Cleanup defaults to on so a local run does not leave a service behind; CI
# disables it so the diagnostics step can still inspect the unit.
SMOKE_CLEANUP="${SMOKE_CLEANUP:-true}"
SMOKE_FORCE="${SMOKE_FORCE:-false}"

# Refuse to smoke over an installed production service.
#
# The onboard step installs $SERVICE_NAME and `cleanup()` uninstalls it. The
# user manager resolves units from its own HOME (set at login), so pointing
# this script at a throwaway $HOME would not protect the real unit:
# `systemctl --user cat paperclipai.service` still finds
# /home/<user>/.config/systemd/user/paperclipai.service and
# `systemctl --user stop` still stops the live service. This guard is the
# isolation, and it runs before SMOKE_FORCE can override anything.
if command -v systemctl >/dev/null 2>&1 \
  && systemctl --user cat paperclipai.service >/dev/null 2>&1; then
  echo "Refusing to smoke: this host already has paperclipai.service installed." >&2
  echo "cleanup() would uninstall it. Uninstall it first, or run this smoke in" >&2
  echo "a container/CI job that has no Paperclip service." >&2
  exit 2
fi

fail() {
  echo "Service smoke failed: $*" >&2
  exit 1
}

diagnostics() {
  echo "--- systemctl --user status $SERVICE_NAME ---" >&2
  systemctl --user --no-pager status "$SERVICE_NAME" >&2 || true
  echo "--- journalctl --user -u $SERVICE_NAME (last 100 lines) ---" >&2
  journalctl --user -u "$SERVICE_NAME" --no-pager -n 100 >&2 || true
}

cleanup() {
  if [[ "$SMOKE_CLEANUP" == "true" ]]; then
    if [[ -x "$SHIM_PATH" ]]; then
      "$SHIM_PATH" service uninstall >/dev/null 2>&1 || true
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
# service.
if [[ "$SMOKE_FORCE" != "true" ]]; then
  if [[ -e "$SHIM_PATH" ]]; then
    fail "$SHIM_PATH already exists; set SMOKE_FORCE=true to smoke over it"
  fi
  if systemctl --user cat "$SERVICE_NAME" >/dev/null 2>&1; then
    fail "$SERVICE_NAME is already installed; set SMOKE_FORCE=true to smoke over it"
  fi
fi

echo "==> Onboarding paperclipai@$PAPERCLIPAI_VERSION with --install-service"
echo "    Data dir: $DATA_DIR"
if ! timeout "$ONBOARD_TIMEOUT_SECONDS" \
  npx --yes "paperclipai@${PAPERCLIPAI_VERSION}" onboard --yes --install-service --data-dir "$DATA_DIR"; then
  diagnostics
  fail "onboard exited non-zero"
fi

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
