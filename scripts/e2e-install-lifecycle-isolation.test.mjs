import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// PET-52. The service leg of e2e-install-lifecycle.sh ends in `service
// uninstall`, which on a host whose production paperclipai.service lives under
// the real $HOME deleted the unit file and took the embedded PostgreSQL and API
// with it.
//
// The first fix here isolated HOME and XDG_CONFIG_HOME. That is necessary and it
// is not sufficient: `systemctl --user <verb> <name>` addresses units the
// manager already loaded, and XDG_CONFIG_HOME only decides where *new* unit
// files are searched. Verified on a live host -- with both variables pointed at
// an empty temp dir, `systemctl --user cat/is-active/show -p FragmentPath` still
// resolved the real unit. cli/src/__tests__/service-manager-host-isolation.test.ts
// reproduces the same result with an injected CommandRunner and no systemd.
//
// What closes it is a distinct instance id, which renames the unit to
// paperclipai-e2e.service: a name the host cannot have, so no verb can reach
// the production unit by name or by path. These tests pin that.

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "e2e-install-lifecycle.sh");
const script = readFileSync(scriptPath, "utf8");

test("script is executable and parses", () => {
  accessSync(scriptPath, constants.X_OK);
  execFileSync("bash", ["-n", scriptPath]);
});

test("the service leg runs under a distinct instance id", () => {
  // The lever `onboard` actually reads. `onboard` has no --instance flag, so
  // PAPERCLIP_INSTANCE_ID is the only way to name the leg's unit.
  assert.match(script, /export PAPERCLIP_INSTANCE_ID="\$SERVICE_INSTANCE"/);
  // ...and the unit name follows from it rather than being hardcoded.
  assert.match(script, /SERVICE_NAME="paperclipai-\$\{SERVICE_INSTANCE\}\.service"/);
});

test("the leg never adopts the production unit name as its own", () => {
  const assignments = [...script.matchAll(/^(\s*)SERVICE_NAME="([^"]*)"/gm)].map((m) => m[2]);
  assert.ok(assignments.length > 0, "expected a SERVICE_NAME assignment");
  for (const name of assignments) {
    assert.notEqual(name, "paperclipai.service", "the e2e leg must not own the production unit name");
  }
});

test("every service verb is pinned to the isolated instance", () => {
  // Anchored on the real invocation form so the pass/fail message strings
  // ("8d service stop exits 0") are not mistaken for commands.
  for (const verb of ["status", "logs", "stop", "uninstall"]) {
    const uses = [...script.matchAll(new RegExp(`SERVICE_SHIM service ${verb}[^\\n]*`, "g"))].map((m) => m[0]);
    assert.ok(uses.length > 0, `expected at least one \`SERVICE_SHIM service ${verb}\` call`);
    for (const use of uses) {
      assert.match(use, /--instance "\$SERVICE_INSTANCE"/, `\`service ${verb}\` must name the isolated instance: ${use}`);
    }
  }
});

test("onboard runs through the real shim, not the isolated one", () => {
  // Regression guard. $SERVICE_SHIM lives inside the fresh mktemp home, so
  // nothing has created it at this point -- it is what this very call creates.
  // Invoking it here exits 127 and fails 8a on every host.
  assert.match(script, /if shim onboard --yes --install-service; then/);
  assert.doesNotMatch(script, /"\$SERVICE_SHIM" onboard/);
});

test("the isolated home is created under a guard, and the caller env is restored", () => {
  // A failed mktemp leaves the variable empty, and `export HOME=""` then defeats
  // the guard it was meant to install while the script keeps going.
  assert.match(script, /SERVICE_ISOHOME="\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/e2e-service-iso\.XXXXXX"\)" \|\| \{/);
  assert.match(script, /if \[ -z "\$SERVICE_ISOHOME" \] \|\| \[ ! -d "\$SERVICE_ISOHOME" \]; then/);
  // Steps 9 and 10 run after the leg and use $HOME, so the value must come back
  // rather than being unset out from under them.
  assert.match(script, /export HOME="\$REAL_HOME"/);
  assert.doesNotMatch(script, /^\s*unset HOME XDG_CONFIG_HOME$/m);
});

test("the preflight runs before the override, and the leg asserts it held", () => {
  const preflight = script.indexOf("is-active paperclipai.service");
  const override = script.indexOf('export HOME="$SERVICE_ISOHOME"');
  assert.ok(preflight > 0 && override > 0);
  assert.ok(preflight < override, "the preflight must judge the host before the override moves HOME");
  // Post-condition: the production unit must not have been activated by the leg.
  assert.match(script, /8f isolation held/);
});

test("the mktemp template is not quote-escaped", () => {
  // `\"` inside the substitution makes mktemp receive literal quote characters.
  const templates = [...script.matchAll(/mktemp -d ([^\n]*)/g)].map((m) => m[1]);
  for (const template of templates) {
    assert.doesNotMatch(template, /\\"/, `quote-escaped mktemp template: ${template}`);
  }
  // And the line actually runs. A template that only parses is not a template
  // that works.
  const directory = mkdtempSync(join(tmpdir(), "pet221-template-"));
  try {
    const out = execFileSync("sh", ["-c", 'S="$(mktemp -d "${TMPDIR:-/tmp}/e2e-service-iso.XXXXXX")" && printf %s "$S"'], { encoding: "utf8" });
    assert.ok(out.length > 0 && out !== "", "mktemp produced no directory");
    rmSync(out, { recursive: true, force: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
