// PET-452. Contract tests for scripts/paperclip-unit-guardian.sh.
//
// The incident: on 2026-09-27 00:50:01 every process in the paperclipai.service
// cgroup received SIGSTOP in the same second -- 138 of them, main process and all
// ten embedded postgres backends included -- and no SIGCONT followed. The unit
// file was present, the drop-ins were present, the wants symlink was present, and
// systemd reported the unit `active`, so every check the guardian made passed for
// the whole 13 minutes the board was down. A stopped process is still a running
// one as far as `is-active` is concerned.
//
// These tests pin the freeze check, and just as importantly they pin the things it
// must NOT do. The narrow blast radius is the whole point: this repo's own test
// suite pins live PIDs against reuse with SIGSTOP/SIGCONT
// (packages/paperclip-runner/src/drivers/acpx/installation-integrity.test.ts), and
// those children live in this cgroup whenever a test runs inside a detached agent
// run. A guardian that swept the cgroup with SIGCONT would resume test fixtures
// mid-assertion.
//
// The behavioural part needs no systemd: `pid_is_stopped` takes a PID and reads
// `ps`, so it is exercised here against real stopped and running children. The
// end-to-end proof against a real user manager, which is what proves the wedge
// itself, is scripts/paperclip-unit-guardian-freeze-proof.sh and needs a host.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "paperclip-unit-guardian.sh");
const script = readFileSync(scriptPath, "utf8");

test("script is executable and parses", () => {
  accessSync(scriptPath, constants.X_OK);
  execFileSync("bash", ["-n", scriptPath]);
});

test("the freeze check reads the main PID's process state", () => {
  assert.match(script, /-p MainPID --value/);
  assert.match(script, /ps -o stat= -p/);
  // Uppercase T is stopped-by-job-control-signal. The guard has to be T and not
  // a looser match on "stopped", or a traced process (ps reports lowercase t)
  // gets a SIGCONT it did not ask for from its tracer.
  assert.match(script, /case "\$s1" in \*T\*\)/);
});

test("the freeze check confirms with a second sample before acting", () => {
  // This is the only place the guardian touches a live process instead of a file,
  // and one `ps` can catch a process mid-transition or a PID that has just been
  // recycled. A single sample would let that become a signal to a stranger.
  assert.match(script, /pid_is_stopped\(\)/);
  assert.match(script, /sleep 0\.3/);
  assert.match(script, /case "\$s2" in \*T\*\)/);
});

test("the resume is SIGCONT and nothing else", () => {
  assert.match(script, /kill -CONT "\$FROZEN"/);
  // No terminating signal may appear anywhere in the script. `kill -CONT` is the
  // only form allowed, and the negative list below is what makes that a rule
  // rather than a convention.
  for (const forbidden of [
    "kill -TERM",
    "kill -KILL",
    "kill -9",
    "kill -15",
    "kill -STOP",
    "kill -INT",
    "kill -HUP",
    "kill -QUIT",
    "kill -USR1",
    "kill -ABRT",
  ]) {
    assert.ok(!script.includes(forbidden), `guardian must never send ${forbidden}`);
  }
});

test("the guardian never takes the unit down", () => {
  // Allowlist rather than a denylist, so a verb nobody thought of cannot slip in.
  // Quoted strings are blanked before the scan: the guardian's own ALERT text
  // quotes `systemctl --user kill ...` as advice for a human to run by hand, and
  // that must not read as the guardian running it.
  const ALLOWED = new Set(["daemon-reload", "show", "is-enabled", "is-active", "enable", "start"]);
  const offenders = [];
  for (const [i, line] of script.split("\n").entries()) {
    const code = line.replace(/"[^"]*"/g, '""').split("#")[0];
    for (const m of code.matchAll(/systemctl --user\s+(\S+)/g)) {
      if (!ALLOWED.has(m[1])) offenders.push(`line ${i + 1}: systemctl --user ${m[1]} -- ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "guardian may only run non-destructive systemctl verbs");
  // start is the most it is allowed to do to the lifecycle, and only when the
  // unit is not already active.
  assert.match(script, /is-active "\$UNIT"[\s\S]{0,200}systemctl --user start "\$UNIT"/);
});

test("the resume is scoped to the main PID, never the whole cgroup", () => {
  // A cgroup-wide CONT is the one-line version of this fix and it is wrong here:
  // it would resume this repo's own SIGSTOP test fixtures, which sit in the same
  // cgroup during a detached agent run. The main PID is the one process whose
  // stopped state is unambiguously fatal and never a deliberate test fixture.
  assert.ok(
    !/systemctl --user kill[^\\n]*--kill-whom=all[^\\n]*SIGCONT/.test(script),
    "guardian must not sweep the cgroup with SIGCONT",
  );
  // It may still *count* stopped processes, and must say so without signalling.
  assert.match(script, /cgroup\.procs/);
  assert.match(script, /stopped_total/);
  assert.match(script, /needs a human/);
});

test("a freeze that SIGCONT does not hold escalates instead of repeating quietly", () => {
  assert.match(script, /FREEZE_COUNT/);
  assert.match(script, /consecutive guardian ticks/);
  // The alert has to name the bypass that makes the freeze possible, because
  // RefuseManualStop=yes looks like it should have prevented this and does not.
  assert.match(script, /RefuseManualStop=yes does NOT block/);
});

test("the golden unit's own guard drop-in is what the escalation refers to", () => {
  // The measured fact, in the ticket and in the escalation text, is that
  // RefuseManualStop refuses `stop` and `restart` but not `systemctl kill`. If
  // systemd ever changes that, the guardian's advice goes stale, so it is stated
  // as a measurement with the date rather than as a systemd guarantee.
  assert.match(script, /measured: rc=0/);
});

test("PAUSE still short-circuits every repair, including the resume", () => {
  // The freeze check is the one branch that signals, so the operator escape hatch
  // has to cover it. It is checked before anything else and the check is early.
  const pauseIndex = script.indexOf('[ -e "$PAUSE" ] && exit 0');
  const frozenIndex = script.indexOf("pid_is_stopped()");
  assert.ok(pauseIndex > 0, "expected a PAUSE guard");
  assert.ok(frozenIndex > pauseIndex, "PAUSE must be checked before the freeze check");
});

test("the documented incident matches the measured reproduction", () => {
  // The reproduction needed one precondition the first report did not state: a
  // SIGSTOPped process still dies on a delivered SIGTERM's default action, so a
  // plain `sleep` unit does NOT wedge. The wedge needs a process that HANDLES
  // SIGTERM -- which is what a drain and a TimeoutStopSec are for, and what the
  // node server does. Recorded here so the claim in the comment block is not
  // quietly overstated.
  assert.match(script, /cannot act on SIGTERM/);
  assert.match(script, /TimeoutStopSec=300/);
});

// --- behavioural: the shipped detection function, against real processes.

// Extracts pid_is_stopped out of the guardian and runs it as a standalone
// function, so what is under test is the shipped source and not a paraphrase.
function loadProbe() {
  const fn = script.match(/^pid_is_stopped\(\) \{[\s\S]*?^\}/m);
  assert.ok(fn, "could not extract pid_is_stopped from the guardian");
  const dir = mkdtempSync(join(tmpdir(), "pet452-"));
  const helper = join(dir, "probe.sh");
  writeFileSync(helper, `#!/usr/bin/env bash\n${fn[0]}\n"$@"\n`);
  execFileSync("chmod", ["+x", helper]);
  return {
    // A stopped process is a "found it" answer, and a clean one is a non-zero
    // exit with no output. Both are normal, so the exit status is not an error.
    call: (pid) => spawnSync("bash", [helper, "pid_is_stopped", String(pid)], { encoding: "utf8" }).stdout.trim(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const sleepStat = (pid) => spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

// Poll rather than sleep a fixed amount: the assertions are about what the
// guardian observes, and a fixed sleep makes the test flaky on a loaded host.
const waitFor = (predicate, what) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    spawnSync("sleep", ["0.05"]);
  }
  assert.fail(`timed out waiting for ${what}`);
};

test("pid_is_stopped fires on a real stopped process and stays quiet otherwise", () => {
  const probe = loadProbe();
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  try {
    const pid = child.pid;
    waitFor(() => sleepStat(pid) !== "", "the child to appear in ps");

    // Running: must not report a freeze. This is the false-positive guard, and it
    // is the assertion that keeps the 60s timer from signalling a healthy board.
    assert.equal(probe.call(pid), "");

    process.kill(pid, "SIGSTOP");
    waitFor(() => sleepStat(pid).includes("T"), "the kernel to park the child");

    assert.equal(probe.call(pid), String(pid), "a SIGSTOPped process must be detected and its PID reported");

    process.kill(pid, "SIGCONT");
    waitFor(() => !sleepStat(pid).includes("T"), "the child to be resumed");
    assert.equal(probe.call(pid), "", "a resumed process must stop being reported as frozen");
  } finally {
    try { process.kill(child.pid, "SIGCONT"); } catch {}
    child.kill("SIGKILL");
    probe.cleanup();
  }
});

test("pid_is_stopped is quiet for a PID that cannot be a live process", () => {
  // A recycled or already-exited MainPID must not become a signal to whatever now
  // owns that number.
  const probe = loadProbe();
  try {
    // 0 is systemd's "no main process" sentinel, and must be rejected before ps
    // is asked, because `ps -p 0` is not a no-op on every implementation.
    assert.equal(probe.call(0), "");
    assert.equal(probe.call(""), "");
    // Above the default pid_max, so it cannot exist.
    assert.equal(probe.call(4194305), "");
  } finally {
    probe.cleanup();
  }
});

// --- the golden-copy coverage gap, found by hand on 2026-09-27.

test("the guardian notices in-force drop-ins it has no golden copy of", () => {
  // Step 2 restores only what $GOLDEN holds. 75-restart-backoff.conf (PET-435) was
  // in force with no counterpart in golden, so a deletion of it would have been a
  // silent degradation -- the exact class step 2 exists to prevent, and invisible
  // because a missing golden copy looks exactly like a drop-in nobody intended.
  assert.match(script, /UNPROTECTED_SEEN/);
  assert.match(script, /no golden copy/);
  // The alert has to be actionable, not just informative.
  assert.match(script, /cp -p \$DROPIN_DIR\/<name> \$GOLDEN\/dropins\/<name>/);
});

test("the golden-copy alert fires once per change, not once a minute", () => {
  // A 60s timer that re-logs the same line forever trains an operator to ignore it.
  assert.match(script, /if \[ "\$\(cat "\$UNPROTECTED_SEEN"[^\n]*!= "\$unprotected" \]/);
  // ...and clears its marker once the gap is closed, so a recurrence alerts again.
  assert.match(script, /elif \[ -f "\$UNPROTECTED_SEEN" \]; then\n\s+rm -f "\$UNPROTECTED_SEEN"/);
});
