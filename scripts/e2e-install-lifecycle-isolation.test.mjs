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
  //
  // The shim path is matched with the optional quoting spelled out, because the
  // script quotes it -- `"$SERVICE_SHIM" service stop` -- and a bare
  // `SERVICE_SHIM service stop` pattern matches nothing there. That is a
  // technicality, not a safety property: every verb in the shipped script does
  // carry `--instance "$SERVICE_INSTANCE"`, and that is what this test exists to
  // enforce. Anchoring on the quoting instead would have let the test go red on a
  // correct script while saying nothing about an unpinned verb, which is the
  // failure mode PET-255 is about.
  const shim = '"?\\$SERVICE_SHIM"?';
  for (const verb of ["status", "logs", "stop", "uninstall"]) {
    const uses = [...script.matchAll(new RegExp(`${shim} service ${verb}[^\\n]*`, "g"))].map((m) => m[0]);
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

test("the isolated home is created under a guard, and no env var is moved", () => {
  // A failed mktemp leaves the variable empty, and any consumer of it would then
  // defeat the guard it was meant to install while the script keeps going.
  assert.match(script, /SERVICE_ISOHOME="\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/e2e-service-iso\.XXXXXX"\)"/);
  assert.match(script, /if \[ -z "\$SERVICE_ISOHOME" \] \|\| \[ ! -d "\$SERVICE_ISOHOME" \]; then/);

  // The leg does NOT move HOME. It used to: it exported HOME="$SERVICE_ISOHOME"
  // and then exported HOME="$REAL_HOME" again for steps 9 and 10. That override
  // was removed, for two measured reasons recorded at the call site in
  // e2e-install-lifecycle.sh:
  //
  //   1. systemd's unit search path is captured when the *manager* starts, so a
  //      unit file written under an overridden HOME/XDG_CONFIG_HOME is invisible
  //      to `systemctl --user enable <name>` -- 8a failed on every host with a
  //      running user manager, and no product change can rescue it.
  //   2. install-store.ts keys cliRoot to PAPERCLIP_HOME but shimPath to $HOME,
  //      so moving one of them produces exactly the split-root state that
  //      managed-install-check.ts reports as blocking.
  //
  // Isolation is now the distinct instance id (below), and the mktemp'd dir is
  // still load-bearing as the log capture path. So these assertions are the
  // regression guard in the direction that matters: HOME must come back
  // untouched, and must not be unset either. A future edit that reintroduces the
  // override -- in any spelling, including the bare `unset HOME` it replaced --
  // fails here instead of breaking 8a on every real host.
  assert.doesNotMatch(script, /^\s*export HOME=/m, "the leg must not move HOME; isolate by instance id instead");
  assert.doesNotMatch(script, /^\s*export XDG_CONFIG_HOME=/m, "the leg must not move XDG_CONFIG_HOME either");
  assert.doesNotMatch(script, /^\s*unset HOME/m, "the leg must leave HOME set for steps 9 and 10");
  assert.doesNotMatch(script, /REAL_HOME/, "REAL_HOME only existed to undo the removed override");
});

test("the preflight runs before the leg takes its instance id, and the leg asserts it held", () => {
  const preflight = script.indexOf("is-active paperclipai.service");
  // The isolation lever, not an env override: `onboard` has no --instance flag,
  // so PAPERCLIP_INSTANCE_ID is the only thing that renames the unit, and the
  // derived SERVICE_NAME follows from it.
  const isolation = script.indexOf('export PAPERCLIP_INSTANCE_ID="$SERVICE_INSTANCE"');
  assert.ok(preflight > 0, "could not find the PET-52 preflight in the script");
  assert.ok(isolation > 0, "could not find the leg's instance-id export in the script");
  assert.ok(
    preflight < isolation,
    "the preflight must judge the host's own unit before the leg takes an instance id",
  );
  // Post-condition: the production unit must not have been activated by the leg.
  assert.match(script, /8f isolation held/);
});

// The tests above pin the source text. Text is not behaviour. Three defects
// got through on exactly that gap, and each one is now executed here:
//
//   1. both guards were `fail_` + `skip_`, and those two only append to RESULTS
//      and set FAILED, so a firing guard was decoration and control still
//      reached `export HOME=""` and `onboard`;
//   2. the preflight branch did `rm -rf "$SERVICE_ISOHOME"` and then fell
//      through into the code that reads it;
//   3. `is-active ... | grep -q active` matches the string `inactive`, so a
//      stopped host read as live and the leg was always skipped.
//
// So these tests slice the guard text OUT OF THE SHIPPED SCRIPT and run it
// under a stubbed host. A copy in the test file could drift; the shipped text
// cannot.

const guardStart = script.indexOf('SERVICE_ISOHOME="$(mktemp -d');
const guardEnd = script.indexOf('SERVICE_INSTANCE="e2e"');
assert.ok(guardStart > 0 && guardEnd > guardStart, "could not locate the step 8 guards in the script");
/** The mktemp guard and the preflight, exactly as the script ships them. */
const shippedGuards = dedent(script.slice(guardStart, guardEnd));

function dedent(text) {
  const lines = text.split("\n");
  const width = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.trimStart().slice(Math.min(width, l.length - l.trimStart().length))).join("\n");
}

/** Runs the shipped guards, then the override, against a stubbed host. */
function runGuards({ mktempFails, unitState }) {
  const preamble = `
    RESULTS=(); FAILED=0
    note()  { printf '== %s ==\\n' "$*"; }
    pass()  { RESULTS+=("PASS  $1"); }
    fail_() { RESULTS+=("FAIL  $1\${2:+ - $2}"); FAILED=1; }
    skip_() { RESULTS+=("SKIP  $1\${2:+ - $2}"); }
    summarize() {
      printf '%s\\n' "\${RESULTS[@]}"
      [ "$FAILED" = "1" ] && exit 1
      echo REACHED-END
    }
    abort_() { fail_ "$1" "\${2:-}"; skip_ "$1" "\${3:-aborted}"; summarize; }
    systemctl() { [ "$1 $2" = "--user is-active" ] && printf '%s\\n' "${unitState}"; return 0; }
    mktemp() { ${mktempFails ? "return 1" : 'd="$(command mktemp -d "$@")" && printf %s "$d"'}; }
    ${shippedGuards}
    # Whatever the script does next with the isolated home.
    export HOME="$SERVICE_ISOHOME"
    export XDG_CONFIG_HOME="$SERVICE_ISOHOME/.config"
    echo "LEAKED HOME=[$HOME] XDG=[$XDG_CONFIG_HOME] isohome-exists=$([ -d "$SERVICE_ISOHOME" ] && echo yes || echo no)"
    echo REACHED-END
  `;
  try {
    return execFileSync("bash", ["-c", preamble], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: process.env.TMPDIR || tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
  } catch (error) {
    // exit 1 out of summarize is the expected result of a guard that fires.
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

test("a failed mktemp stops the leg instead of exporting HOME=\"\"", () => {
  const out = runGuards({ mktempFails: true, unitState: "inactive" });
  assert.doesNotMatch(out, /LEAKED/, `the leg ran with an empty isolated home:\n${out}`);
  assert.doesNotMatch(out, /REACHED-END/, `the script continued past the mktemp guard:\n${out}`);
  assert.match(out, /could not create isolated HOME/);
});

test("an active production unit stops the leg instead of only recording a skip", () => {
  const out = runGuards({ mktempFails: false, unitState: "active" });
  assert.doesNotMatch(out, /LEAKED/, `the leg ran on a host with a live production unit:\n${out}`);
  assert.doesNotMatch(out, /REACHED-END/, `the script continued past the preflight:\n${out}`);
  assert.match(out, /PET-52 guard/);
});

test("a stopped production unit does not read as active", () => {
  // `systemctl is-active` prints `inactive`, and `inactive` contains the
  // substring `active`. A plain `grep -q active` therefore calls every stopped
  // host live, skips the leg, and the e2e service leg never runs anywhere.
  // The healthy path must reach the override with a real isolated home.
  const out = runGuards({ mktempFails: false, unitState: "inactive" });
  assert.doesNotMatch(out, /PET-52 guard/, `an "inactive" host was treated as live:\n${out}`);
  assert.match(out, /REACHED-END/, `the guards blocked a healthy host:\n${out}`);
  assert.match(out, /isohome-exists=yes/, `the isolated home was not usable:\n${out}`);
  assert.match(out, /HOME=\[\/[^/]/, `HOME was not the isolated home:\n${out}`);
});

test("the guards are abort_, not a bare fail_ + skip_ pair", () => {
  // fail_() and skip_() do not exit. Every guard in step 8 must name abort_.
  const step8 = script.slice(script.indexOf('note "8. service lifecycle'), script.indexOf('note "9.'));
  assert.ok(step8.length > 0, "could not find step 8");
  assert.doesNotMatch(
    step8,
    /fail_ "8 service lifecycle[^\n]*\n\s*skip_ "8 service lifecycle/,
    "a guard in step 8 still uses fail_ + skip_ without abort_",
  );
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
