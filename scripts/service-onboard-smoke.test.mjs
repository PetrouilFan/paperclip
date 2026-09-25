import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Pins the wiring that makes the background-service smoke an effective gate.
// The service leg exists because v2026.824.0 shipped a service install that
// crash-looped on a missing shim while the Docker smoke stayed green; these
// assertions keep the job from being silently disconnected or weakened.

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "service-onboard-smoke.sh");
const script = readFileSync(scriptPath, "utf8");
const smokeWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "release-smoke.yml"), "utf8");
const releaseWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

test("smoke script is executable and parses", () => {
  accessSync(scriptPath, constants.X_OK);
  execFileSync("bash", ["-n", scriptPath]);
});

test("smoke script keeps its load-bearing assertions", () => {
  assert.match(script, /^set -euo pipefail$/m);
  // Onboards the published artifact with the service leg forced on.
  assert.match(script, /onboard --yes --install-service/);
  // Fails when the shim never materialized.
  assert.match(script, /no executable shim at .*after onboarding/);
  // Fails when the unit dies instead of serving.
  assert.match(script, /entered the failed state/);
  // Fails when health answers but the service is not what is serving --
  // the exact signature of the v2026.824.0 defect.
  assert.match(script, /something other than the service is serving/);
  // Refuses to smoke over a real install unless forced.
  assert.match(script, /SMOKE_FORCE/);
});

test("release-smoke workflow runs the service leg against the input version", () => {
  assert.match(smokeWorkflow, /^  smoke_service:$/m);
  assert.match(smokeWorkflow, /scripts\/service-onboard-smoke\.sh/);
  const serviceJob = smokeWorkflow.split(/^  smoke:$/m)[0];
  assert.match(serviceJob, /PAPERCLIPAI_VERSION: \$\{\{ inputs\.paperclip_version \}\}/);
  // Diagnostics must survive the run: cleanup stays off in CI and the
  // artifact name cannot collide with the Docker job's upload.
  assert.match(serviceJob, /SMOKE_CLEANUP: "false"/);
  assert.match(serviceJob, /\$\{\{ inputs\.artifact_name \}\}-service/);
});

test("nightly and beta smokes still route through the reusable workflow", () => {
  const calls = releaseWorkflow.match(/uses: \.\/\.github\/workflows\/release-smoke\.yml/g) ?? [];
  assert.ok(calls.length >= 2, "smoke_nightly and smoke_beta must call release-smoke.yml so smoke_service gates them");
});

// PET-52. `onboard --install-service` has no --instance flag, so it resolves the
// instance from PAPERCLIP_INSTANCE_ID and falls back to "default" -- which
// systemdServiceName maps to paperclipai.service, the production unit name. With
// the default name, this script's cleanup() ran `systemctl --user stop
// paperclipai.service` on a host running production, on every exit path,
// including the refusal below. The HOME override does not prevent that:
// `systemctl --user <verb> <name>` addresses units the manager already loaded.
// See cli/src/__tests__/service-manager-host-isolation.test.ts.

test("smoke runs under a distinct instance id, so its unit name cannot collide with production", () => {
  assert.match(script, /export PAPERCLIP_INSTANCE_ID="\$SMOKE_INSTANCE"/);
  assert.match(script, /SERVICE_NAME="paperclipai-\$\{SMOKE_INSTANCE\}\.service"/);
});

test("smoke's isolated HOME is created under a guard", () => {
  // A failed mktemp leaves the variable empty and `export HOME=""` then defeats
  // the guard itself. With PAPERCLIP_SHIM_PATH set, as CI does, cleanup() would
  // then run the real shim's `service uninstall`.
  assert.match(script, /SMOKE_ISOHOME="\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/paperclip-smoke-iso\.XXXXXX"\)" \|\| \{/);
  assert.match(script, /if \[\[ -z "\$SMOKE_ISOHOME" \|\| ! -d "\$SMOKE_ISOHOME" \]\]; then/);
});

test("cleanup cannot touch a unit this script did not create", () => {
  // The trap is registered before the guards, so cleanup() runs on the refusal
  // path. SMOKE_CREATED is the switch that keeps it from stopping production.
  assert.match(script, /SMOKE_CREATED="false"/);
  const cleanup = script.slice(script.indexOf("cleanup() {"), script.indexOf("trap cleanup"));
  assert.match(cleanup, /if \[\[ "\$SMOKE_CREATED" != "true" \]\]; then\n\s*return/);
});

test("smoke refuses to run against a live production service", () => {
  assert.match(script, /is-active paperclipai\.service/);
});

test("smoke's uninstall is pinned to its own instance", () => {
  const uses = [...script.matchAll(/service uninstall[^\n]*/g)].map((m) => m[0]);
  assert.ok(uses.length > 0, "expected a `service uninstall` call");
  for (const use of uses) {
    assert.match(use, /--instance "\$SMOKE_INSTANCE"/, `uninstall must name the smoke instance: ${use}`);
  }
});

test("the health URL cannot be pointed at a production server", () => {
  // A caller-supplied HEALTH_URL is the remaining way to report a false pass.
  assert.match(script, /^HEALTH_URL="http:\/\/127\.0\.0\.1:3100\/api\/health"$/m);
  assert.doesNotMatch(script, /HEALTH_URL="\$\{HEALTH_URL:-/);
});
