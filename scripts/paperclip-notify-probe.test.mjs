// Contract tests for scripts/paperclip-notify-probe.sh.
//
// The hazard: every agent run on this host inherits NOTIFY_SOCKET from the control
// plane and sits inside the control plane unit's cgroup, so a probe run by an agent
// can write a notify datagram that the control plane's own unit applies to itself.
// Measured 2026-09-27, non-destructively: a STATUS= datagram sent from inside a live
// run changed `systemctl --user show paperclipai.service -p StatusText`.
//
// The measurement that decides the whole design, and the one these tests exist to
// keep quoted: a notify datagram cannot be aimed at a unit. Every unit of one
// manager shares ONE notify socket -- a throwaway `systemd-run --user` unit's own
// child reports NOTIFY_SOCKET=/run/user/1000/systemd/notify, byte-identical to the
// control plane's -- and systemd attributes a datagram to the unit the SENDING
// PROCESS is in. Proven by sending from unit A and reading the StatusText of unit A,
// unit B, and the control plane: only A changed.
//
// So the safety of a probe is entirely a question of which cgroup it runs in, and
// the guard's job is to check that and fail closed. A guard that checked the socket
// path instead would be checking something that measurement says cannot matter.
//
// The behavioural half needs no systemd and no root: the decision is a pure function
// of four strings, and `selftest` hands it those four strings as arguments. That is
// the same dispatch `guard` and `notify` reach, minus the derivation -- so these
// tests exercise the shipped decision code, and a test can never make the enforcing
// path read a fixture, because the enforcing path takes no facts as arguments at
// all. The proof against a real user manager -- which is what proves the attribution
// claim rather than the parsing -- is scripts/paperclip-notify-probe-proof.sh and
// needs a host.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scriptPath = join(repoRoot, "scripts", "paperclip-notify-probe.sh");
const script = readFileSync(scriptPath, "utf8");

// Blank the quoted strings and strip comments before scanning for a tool name. The
// header explains at length why systemd-notify is the wrong tool here, and a naive
// substring scan would read that explanation as a use of it.
const codeOnly = () =>
  script
    .split("\n")
    .map((line) => line.split("#")[0].replace(/"[^"]*"/g, '""'))
    .join("\n");

// The fields guard_message will send. An allowlist, and the reason it is one is in
// the header: the previous denylist was measured to be incomplete.
const ALLOWED_KEYS = ["STATUS", "ERRNO", "BUSERROR"];

// The fields that were measured to change the unit's state, and the two that were
// missing from the first denylist. MAINPID= re-points the unit's recorded main
// process, which is the process a stop signals under KillMode=process; NOTIFYACCESS=
// re-opens the unit's own notify access mid-flight. Both are refused now because the
// list is an allowlist, and both are named here so the two halves cannot drift.
const REFUSED_LIFECYCLE_KEYS = [
  "STOPPING",
  "RELOADING",
  "READY",
  "WATCHDOG",
  "WATCHDOG_USEC",
  "EXTEND_TIMEOUT_USEC",
  "MAINPID",
  "NOTIFYACCESS",
  "FDSTORE",
  "MONOTONIC_USEC",
];

// Run the shipped script. Nothing here sets an environment variable the script reads
// on the enforcing path -- there are none left, and a test asserting that is below.
const probe = (...args) => spawnSync("bash", [scriptPath, ...args], { encoding: "utf8" });

// guard_verdict over four explicit facts: this process's cgroup path, the control
// unit main process's cgroup path, why that is empty if it is, and the sender unit's
// ownership. Mirrors what `notify` does, with the derivation left out.
const verdict = (selfCg, controlCg, controlWhy, ownership, sock = "") =>
  probe("selftest", "guard", selfCg, controlCg, controlWhy, ownership, sock);

// The cgroup paths used throughout, shaped like the real user-slice nesting.
const LIVE_UNIT_CGROUP = "/user.slice/user-1000.slice/user@1000.service/app.slice/paperclipai.service";
const THROWAWAY_CGROUP = "/user.slice/user-1000.slice/user@1000.service/app.slice/pc-probe-42.service";
const MANAGER_CGROUP = "/user.slice/user-1000.slice/user@1000.service";
const SESSION_CGROUP = "/user.slice/user-1000.slice/user@1000.service/session-3.scope";

test("script is executable and parses", () => {
  accessSync(scriptPath, constants.X_OK);
  execFileSync("bash", ["-n", scriptPath]);
});

test("the scrub drops the same four names the server chokepoint drops", () => {
  // The server half is sanitizeInheritedPaperclipEnv in
  // packages/adapter-utils/src/server-utils.ts. Two halves of one fix that drop
  // different sets would leave a gap exactly where the other one covered, so this
  // reads the server source and compares rather than restating a list.
  assert.match(script, /scrub_ipc_env\(\) \{\n {2}unset NOTIFY_SOCKET LISTEN_PID LISTEN_FDS LISTEN_FDNAMES\n\}/);
  assert.match(script, /env -u NOTIFY_SOCKET -u LISTEN_PID -u LISTEN_FDS -u LISTEN_FDNAMES/);

  const serverSrc = readFileSync(join(repoRoot, "packages", "adapter-utils", "src", "server-utils.ts"), "utf8");
  const fn = serverSrc.match(/export function sanitizeInheritedPaperclipEnv\([\s\S]*?\n\}/);
  assert.ok(fn, "could not find sanitizeInheritedPaperclipEnv");
  const dropped = [...fn[0].matchAll(/delete env\.([A-Z_]+);/g)].map((m) => m[1]);
  for (const name of ["NOTIFY_SOCKET", "LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"]) {
    assert.ok(dropped.includes(name), `server chokepoint no longer drops ${name}; the shell half would silently diverge`);
  }
});

test("the scrub runs before anything else in the file", () => {
  // The value of scrubbing is that it cannot depend on the caller having cleaned up,
  // so it cannot depend on argument parsing having happened either. It is the first
  // executable statement after the configuration block.
  const scrubDef = script.indexOf("scrub_ipc_env() {");
  const scrubCall = script.lastIndexOf("\nscrub_ipc_env\n");
  const caseIdx = script.indexOf('case "${1:-}" in');
  assert.ok(scrubDef > 0, "expected a scrub_ipc_env definition");
  assert.ok(scrubCall > scrubDef, "expected a top-level scrub_ipc_env call after its definition");
  assert.ok(scrubCall < caseIdx, "the scrub must run before argument dispatch");
});

test("a probe never uses systemd-notify", () => {
  // systemd-notify takes no target and reads NOTIFY_SOCKET from the environment, so
  // its target is whatever the caller happened to inherit. That is the failure this
  // script exists to remove, and it is the reason the send is a direct datagram
  // write with the socket as an explicit argument.
  assert.ok(!/systemd-notify/.test(codeOnly()), "a probe must write the datagram directly, not via systemd-notify");
  assert.match(script, /socat -u - "UNIX-SENDTO:\$sock"/);
  assert.match(script, /python3 - "\$sock" "\$payload"/);
});

test("nothing on the enforcing path is configurable from the environment", () => {
  // This is the fix for two holes measured against the previous head. It read the
  // cgroup file and the transient root from PAPERCLIP_PROBE_*, so a process inside
  // the live unit could name a file it had just written, get an ALLOWED verdict, and
  // have written a datagram. A guard whose central claim can be switched off by two
  // environment variables is not evidence in the one case we would want it to be
  // evidence -- the unattributed sender of the 09:28 datagram (PET-601), whose
  // candidate set includes us.
  const envReads = [...codeOnly().matchAll(/\$\{?(PAPERCLIP_[A-Z_]+|SELF_CGROUP_FILE|TRANSIENT_ROOT)/g)].map((m) => m[1]);
  assert.deepEqual(envReads, [], `the enforcing path must read no PAPERCLIP_* or fixture variable; found ${JSON.stringify(envReads)}`);
  // In code, not in the header: the header names the two variables it removed, and
  // that is the record of why they are gone.
  assert.ok(!/PAPERCLIP_PROBE/.test(codeOnly()), "no PAPERCLIP_PROBE_* name may survive in any executable line");

  // And the shape of the fix rather than just the absence of the two names: the
  // decision is a function of arguments, the derivation is a function of nothing,
  // and the one function that joins them takes no fact from the caller.
  assert.match(script, /guard_verdict\(\) \{\n {2}local self_cg="\$1" control_cg="\$2" control_why="\$3" ownership="\$4" sock="\$\{5:-\}"/);
  assert.match(
    script,
    /guard_probe\(\) \{\n {2}GUARD_REASON=""\n {2}read_position\n {2}GUARD_REASON="\$\(guard_verdict "\$SELF_CGROUP" "\$CONTROL_CGROUP" "\$CONTROL_WHY" "\$OWNERSHIP"/,
  );
  // The derivation reads the sender's own cgroup from the kernel and nothing else.
  // A guard that took the cgroup file as an argument would be forgeable by whoever
  // supplied it, which is hole B1 exactly.
  const probeFn = script.match(/guard_probe\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(!/cgroup_path_of/.test(probeFn), "the enforcing path must not read a cgroup file of its own choosing");
  assert.ok(!/\$\{?[A-Z_]*(SELF_CGROUP_FILE|TRANSIENT_ROOT)/.test(probeFn), "no fixture may be named on the enforcing path");
});

test("guard and notify reach the derivation, and only selftest supplies facts", () => {
  // The structural half of the same property: if a future refactor gave `notify` a
  // way to name its own cgroup file, the two tests above would still pass while the
  // guard became advisory again. So assert the dispatch, not just the code.
  const dispatch = script.slice(script.indexOf('case "${1:-}" in'));
  const branches = {};
  for (const name of ["info", "guard", "notify", "selftest"]) {
    branches[name] = dispatch.match(new RegExp(`\\n {2}${name}\\)\\n[\\s\\S]*?\\n {4};;`))?.[0] ?? "";
    assert.ok(branches[name], `expected a ${name} branch`);
  }
  // Every branch that reports or enforces goes through the derivation, and none of
  // them can reach the fact-taking one. `info` is included even though it only
  // reports: it is the command an operator runs *before* deciding to send, so a
  // fixture path in it would be a fixture path in the advice.
  for (const name of ["info", "guard", "notify"]) {
    const branch = branches[name];
    assert.match(branch, /read_position|guard_probe/, `${name} must derive its facts from the kernel and systemd`);
    assert.doesNotMatch(branch, /guard_verdict/, `${name} must not call the decision directly with facts of its own`);
    assert.doesNotMatch(branch, /selftest/, `${name} must not delegate to the fact-taking subcommand`);
  }
  assert.match(branches.guard, /guard_probe/);
  assert.match(branches.notify, /guard_probe/);
  assert.match(branches.notify, /guard_message/);
  assert.match(branches.selftest, /guard_verdict/);
  assert.match(branches.selftest, /sender_unit_ownership/);
});

test("the cgroup check is the guard, and it runs before the socket is inspected", () => {
  // A datagram is applied to the sender's unit, so the target cannot change who is
  // affected. Checking it first is not a style preference: it is what makes the
  // refusal correct rather than merely sufficient.
  const cgroupIdx = script.indexOf("guard_verdict");
  const abstractIdx = script.indexOf("@*)");
  const socketKindIdx = script.indexOf('-S "$sock"');
  const ownershipIdx = script.indexOf("sender_unit_ownership");
  assert.ok(cgroupIdx > 0, "expected the decision function");
  assert.ok(ownershipIdx > 0, "expected the ownership derivation");
  assert.ok(abstractIdx > ownershipIdx, "the cgroup check must come before the abstract-socket check");
  assert.ok(socketKindIdx > ownershipIdx, "the cgroup check must come before the socket-kind check");
});

test("ownership is asked of systemd, and never of a directory", () => {
  // The previous version proved ownership with `[ -e /run/user/$(id -u)/systemd/
  // transient/$u ]`. That directory is `drwxr-xr-x` and owned by the caller, so one
  // `mkdir` made the live control unit read as "throwaway, safe to send from" -- the
  // guard permitting it and the guard's own output telling the operator the live unit
  // was disposable. A bare existence test is not a fact about the world, and a header
  // that called it one was exactly inverted.
  assert.ok(!/systemd\/transient/.test(codeOnly()), "the transient root must not be read; it is a directory the caller owns");
  assert.match(script, /sender_unit_ownership\(\) \{[\s\S]*?-p UnitFileState -p MainPID/);
  // The MainPID comparison is the half that makes the name mean something: a name is
  // a string a caller can choose, a MainPID is a running process in this cgroup.
  assert.match(script, /\[ "\$\(cgroup_path_of "\$main" 2>\/dev\/null\)" = "\$self_cg" \]/);
  // And no name prefix anywhere: naming your unit pc-probe-* is not a credential.
  assert.ok(!/case "\$u" in pc-probe/.test(codeOnly()), "a name prefix is not evidence of ownership");
  assert.ok(!/case "\$u" in \*\.service/.test(codeOnly()), "the unit's name is not evidence either");
});

test("the control unit is a constant that is actually read, and compared by cgroup", () => {
  // The previous version read PAPERCLIP_PROBE_CONTROL_UNIT, printed it in `info`, and
  // used it in no decision at all. Now it names the unit the guard denies first, by
  // comparing cgroup paths rather than names. It is a constant, because an
  // environment variable here would be one more value a caller could point
  // somewhere harmless.
  assert.match(script, /\nCONTROL_UNIT="paperclipai\.service"/);
  assert.ok(!/CONTROL_UNIT="\$\{/.test(script), "CONTROL_UNIT must not be read from the environment");
  assert.match(script, /if \[ -n "\$control_cg" \] && \[ "\$self_cg" = "\$control_cg" \]/);
  assert.match(script, /LoadState -p MainPID/);
  // Equality, not a prefix match: a process in a nested sub-unit of the control plane
  // is in a different unit with its own notify semantics, and a datagram from it is
  // applied to that sub-unit, not to the control plane.
  assert.ok(!/"\$self_cg" = "\$control_cg"\*|\*"\$control_cg"/.test(codeOnly()), "the cgroup comparison must be equality, not containment");
});

test("the guard fails closed when it cannot read the cgroup", () => {
  // An unreadable /proc/self/cgroup is exactly the case where the script cannot
  // prove it is safe, so it must refuse rather than assume. The reason has to name
  // the file, or an operator reads the refusal as a mystery.
  assert.match(script, /if \[ -z "\$self_cg" \]/);
  assert.match(script, /could not be read, so it cannot be proven that this process is not inside a live unit; failing closed/);
});

test("the control unit's own unprovable state is a refusal, not an allow", () => {
  // Three ways the control unit's cgroup cannot be read, and all three have to
  // refuse. The middle one is the subtle one: a loaded unit with no live main
  // process is NOT proof of safety, because a deactivating unit under
  // KillMode=process can still have a populated cgroup, and then the comparison
  // would have nothing to compare.
  assert.match(script, /CONTROL_WHY="systemctl is not on PATH[^"]*"/);
  assert.match(script, /CONTROL_WHY="\$CONTROL_UNIT is loaded but has no live main process[^"]*"/);
  assert.match(script, /if \[ -n "\$control_why" \]; then\n {4}printf 'refused: %s; failing closed/);
  // not-found is the one non-refusal, and it is a fact about the host rather than a
  // gap in the check: no such unit means no live control-plane unit to edit.
  assert.match(script, /not-found\)[\s\S]*?CONTROL_WHY=""\n {6}return 0/);
});

test("the refusal names the unit that would have been edited", () => {
  // "refused" with no subject is not actionable. The operator's next question is
  // always "what was I about to touch", and the answer is free to compute.
  assert.match(script, /a datagram is applied to the unit that sent it \(measured 2026-09-27\), so sending from here edits %s/);
});

test("the key allowlist is an allowlist, and there is no way to widen it", () => {
  // The previous version enumerated the fields it knew to be state-changing, and the
  // enumeration was measured to be incomplete: MAINPID= re-points a unit's recorded
  // main process (read from outside, a throwaway unit's MainPID went 226683 ->
  // 226685), and NOTIFYACCESS= re-opens the notify access this whole ticket is about.
  // A denylist can only ever be as good as the list; an allowlist refuses the field
  // nobody thought of, which is the only version of this that holds over time.
  assert.match(script, /ALLOWED_KEYS="STATUS ERRNO BUSERROR"/);
  for (const key of ALLOWED_KEYS) {
    assert.match(script, new RegExp(`\\b${key}\\b`), `${key} must be in the allowlist`);
  }
  const keyCase = script.match(/case " \$ALLOWED_KEYS " in[\s\S]*?esac/)?.[0] ?? "";
  assert.ok(keyCase.includes("ALLOWED_KEYS"), "the key check must consult the allowlist");
  assert.ok(
    !/STOPPING|RELOADING|READY|WATCHDOG|EXTEND_TIMEOUT_USEC/.test(keyCase),
    "the key check must not carry a denylist beside the allowlist; the allowlist is the point",
  );
  assert.ok(!/allow-lifecycle|force|--yes/.test(codeOnly()), "there must be no override for a refused field");
});

test("the abstract and system-manager sockets are refused by path", () => {
  // An abstract socket has no path, so it cannot be attributed to a unit at all.
  // The system manager's socket is a different manager whose units are not in this
  // process's cgroup hierarchy, so the guard would have nothing to reason about.
  assert.match(script, /@\*\)/);
  assert.match(script, /is an abstract socket/);
  assert.match(script, /"\$SYSTEM_MANAGER_SOCKET"\)/);
  assert.match(script, /belongs to the system manager/);
});

test("a target that is not a socket is refused", () => {
  // Nothing to verify means nothing was verified. Without this a typo in a path
  // would be a silent no-op that reads as success.
  assert.match(script, /if \[ ! -S "\$sock" \]/);
  assert.match(script, /is not a socket/);
});

test("the header records the measurement the design rests on", () => {
  // If someone changes the guard to a target-based check, the measurement is what
  // says they are wrong. It belongs in the file, dated, not only in a ticket.
  assert.match(script, /shares ONE notify socket/);
  assert.match(script, /always applied to the unit the sending process/);
  assert.match(script, /measured 2026-09-27/);
  // And the supported shape, so nobody has to re-derive the systemd-run incantation.
  assert.match(script, /systemd-run --user --unit="pc-probe-\$\$"/);
  // Type=notify would need READY=1, which the allowlist refuses, so it would die on
  // TimeoutStartSec. Recorded because it is the obvious first thing to try.
  assert.match(script, /--property=Type=exec, not Type=notify/);
});

test("the header records the first version's two holes, so they are not reintroduced", () => {
  // Both were measured against a shipped head, and both are the kind of bug that
  // reads as a design property in the file it lives in. The reviewer of the first
  // version found them; the file is where the next reader will look.
  assert.match(script, /It was exactly inverted/);
  assert.match(script, /one `mkdir` of/);
  // And the session-scope claim, which the first version got wrong: a scope DOES
  // have a runtime directory, so the first version called it disposable. It is still
  // refused, for a different reason, and the header has to give the real one.
  assert.match(script, /systemd reports no `MainPID` for a\n#\s+scope/);  assert.ok(!/session scope[^.]*and so is refused too/.test(script), "the old session-scope reasoning must be gone");
});

test("the deploy note a reader reaches first does not repeat the two false claims", () => {
  // Requirement 4 of the ticket is that the next reader is not misled, and the next
  // reader reads this doc rather than the script header. Two claims in it were
  // measured false against the guard it describes: the field list, which it gave as
  // an enumeration when the allowlist had already replaced it and that enumeration
  // was measured incomplete; and the terminal position, which it attributed to
  // `user@1000.service` alone when a desktop session puts a terminal in a scope.
  const doc = readFileSync(join(repoRoot, "docs", "deploy", "shadowed-service-unit.md"), "utf8");
  assert.ok(
    !/refuses `STOPPING=`, `RELOADING=`, `READY=`, `WATCHDOG=`,[\s\S]{0,80}?`EXTEND_TIMEOUT_USEC=` with no override/.test(doc),
    "the doc must not present the old field denylist as what the guard refuses",
  );
  assert.match(doc, /It is an \*\*allowlist\*\*/, "the doc must say the field check is an allowlist");
  assert.match(doc, /MAINPID=/, "the doc must name the field the old denylist missed");
  assert.ok(
    !/unsafe everywhere else, including in your own terminal\s*\(`user@1000\.service`\)/.test(doc),
    "the doc must not name a single terminal position as the unsafe case",
  );
  assert.match(doc, /konsole-\d+\.scope/, "the doc must record the session-scope position as well");
  // And the two bypasses have to be in the doc, because both read as design
  // properties in the file they lived in and both were found by review rather than by
  // the tests that existed at the time.
  assert.match(doc, /mkdir/);
  assert.match(doc, /transient\/\$\{?u\}?/);
});

test("notify requires the socket to be named", () => {
  // An implicit target taken from the environment is the bug. After the scrub there
  // is no NOTIFY_SOCKET to fall back to anyway, and a missing socket must be a usage
  // error rather than a silent no-op.
  const idx = script.indexOf('[ -n "$sock" ] || { usage; exit 2; }');
  assert.ok(idx > 0, "notify must reject a missing socket");
});

// --- behavioural: the shipped decision, over explicit facts ---------------------

test("a datagram from the control unit's own cgroup is refused, and the unit is named", () => {
  const r = verdict(LIVE_UNIT_CGROUP, LIVE_UNIT_CGROUP, "", "long-lived");
  assert.equal(r.status, 1, "a send from inside paperclipai.service must be refused");
  assert.match(r.stdout, /in the same cgroup as paperclipai\.service/);
  assert.match(r.stdout, /edits paperclipai\.service/);
  // The remedy has to be in the message, or the operator is left guessing.
  assert.match(r.stdout, /systemd-run --user/);
});

test("each cgroup rule refuses the live position on its own", () => {
  // The control-unit comparison and the ownership answer are two independent
  // refusals, and the claim that the guard cannot be switched off only holds while
  // both are there. A future refactor that deleted the control-unit comparison would
  // leave the ownership answer refusing; one that deleted the ownership derivation
  // would leave the comparison refusing. Neither may quietly become the only line.
  const onlyComparison = verdict(LIVE_UNIT_CGROUP, LIVE_UNIT_CGROUP, "", "transient");
  assert.equal(onlyComparison.status, 1, "the cgroup comparison alone must refuse");
  assert.match(onlyComparison.stdout, /same cgroup as paperclipai\.service/);

  const onlyOwnership = verdict(LIVE_UNIT_CGROUP, "", "systemctl is not on PATH", "long-lived");
  assert.equal(onlyOwnership.status, 1, "the ownership answer alone must refuse");
  assert.match(onlyOwnership.stdout, /systemctl is not on PATH/);

  // And with the comparison's input unavailable, the refusal is the unprovable one
  // rather than a silent allow. This is the composition that S1 and B1 needed: both
  // of those attacks worked by making the comparison's inputs lie, and a lie now
  // produces a refusal.
  const unprovable = verdict(THROWAWAY_CGROUP, "", "paperclipai.service is loaded but has no live main process", "transient");
  assert.equal(unprovable.status, 1);
  assert.match(unprovable.stdout, /failing closed/);
});

test("a send from inside a throwaway transient unit is allowed", () => {
  const r = verdict(THROWAWAY_CGROUP, LIVE_UNIT_CGROUP, "", "transient");
  assert.equal(r.status, 0, `a send from a throwaway unit must be allowed; got: ${r.stdout}${r.stderr}`);
  assert.equal(r.stdout, "", "an allowed verdict prints nothing");
});

test("a unit systemd did not create is refused, and so is an unverifiable one", () => {
  // long-lived: a real unit with a main process in this cgroup, but one systemd did
  // not create for a probe. This is the rule that a forged name cannot pass, and the
  // rule that refuses a terminal in user@1000.service.
  const manager = verdict(MANAGER_CGROUP, LIVE_UNIT_CGROUP, "", "long-lived");
  assert.equal(manager.status, 1);
  assert.match(manager.stdout, /inside the user@1000\.service cgroup/);
  assert.match(manager.stdout, /systemd reports that unit as one it did not create for a probe/);

  // unknown: no loaded unit with a main process in this cgroup. Measured on this
  // host, a session scope is the real case -- systemd reports no MainPID for a scope
  // at all, so a desktop terminal is refused here even though a scope does have a
  // runtime directory and the first version of this guard called it disposable.
  const session = verdict(SESSION_CGROUP, LIVE_UNIT_CGROUP, "", "unknown");
  assert.equal(session.status, 1, "a session scope cannot be verified, so it is refused");
  assert.match(session.stdout, /session-3\.scope/);
  assert.match(session.stdout, /failing closed/);
});

test("a cgroup path that names no unit is refused, and it is the fail-open twin", () => {
  // A readable /proc/self/cgroup whose path has no unit in its last component is not
  // a position this guard can reason about. Treating "no unit name" as "no unit in the
  // way" was an allow in the first version, and it is reachable: the root cgroup is
  // `/`, and a v1-only /proc/self/cgroup has no `0::` line to read at all.
  const root = verdict("/", LIVE_UNIT_CGROUP, "", "transient");
  assert.equal(root.status, 1, "the root cgroup names no unit and must be refused");
  assert.match(root.stdout, /names no unit/);
  assert.match(root.stdout, /failing closed/);

  // The unreadable sibling, which is the other fail-closed branch and prints a
  // different reason on purpose -- an operator has to be able to tell them apart.
  const unreadable = verdict("", LIVE_UNIT_CGROUP, "", "transient");
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stdout, /could not be read/);
  assert.match(unreadable.stdout, /failing closed/);
  assert.ok(
    !/names no unit/.test(unreadable.stdout),
    "an unreadable cgroup is not the same fact as one that names no unit, and must not print that reason",
  );
});

test("the target checks are reachable once the cgroup check has passed", () => {
  // Otherwise the cgroup checks would be masking them in production and they would
  // only ever be exercised by the synthetic tests above.
  const allowed = [THROWAWAY_CGROUP, LIVE_UNIT_CGROUP, "", "transient"];
  const abstract = verdict(...allowed, "@probe");
  assert.equal(abstract.status, 1);
  assert.match(abstract.stdout, /abstract socket/);

  const system = verdict(...allowed, "/run/systemd/notify");
  assert.equal(system.status, 1);
  assert.match(system.stdout, /system manager/);

  const notASocket = verdict(...allowed, "/tmp/nope.sock");
  assert.equal(notASocket.status, 1);
  assert.match(notASocket.stdout, /is not a socket/);
});

test("guard_message sends the informational keys and refuses the rest", () => {
  for (const key of REFUSED_LIFECYCLE_KEYS) {
    const r = probe("selftest", "message", `${key}=1`);
    assert.equal(r.status, 1, `${key}=1 must be refused`);
    assert.match(r.stdout, new RegExp(`${key}= is not a field a probe may send`));
  }
  // The three informational keys are the whole point of a probe: they are what the
  // guard must let through.
  const ok = probe("selftest", "message", "STATUS=hello", "ERRNO=2", "BUSERROR=13");
  assert.equal(ok.status, 0, `informational keys must pass; got: ${ok.stdout}`);
  // A bare word is a typo, and a typo that silently sends half a datagram is worse
  // than a refusal.
  const typo = probe("selftest", "message", "STATUS");
  assert.equal(typo.status, 1);
  assert.match(typo.stdout, /not KEY=VALUE/);
  // A near-miss on a refused name is refused too, which is the property a prefix
  // check would get wrong.
  for (const key of ["MAINPID2", "STATUSX", "STOPPINGS", "notifying"]) {
    const near = probe("selftest", "message", `${key}=1`);
    assert.equal(near.status, 1, `${key}=1 must be refused`);
  }
});

test("a refused key batched into one argument is not an override", () => {
  // The protocol is newline separated, and `notify` builds the payload with
  // `printf '%s\n' "$@"`, one argument per line. So a single quoted argument that
  // contains a newline is not a long value -- it is two messages, and only the
  // first one is ever parsed. Before this was refused, `STOPPING=1` FIRST was caught
  // and `STOPPING=1` SECOND was delivered: the guard read the key before the `=`
  // and validated the argument as a whole, so the second key was never inspected.
  // Measured end to end against a real user manager at the head before the fix: the
  // guard returned 0 and the sending unit went to `deactivating (stop-sigterm)`. The
  // proof that the refusal holds against a manager and not only against this parser
  // is scripts/paperclip-notify-probe-proof.sh part E.
  for (const key of [...REFUSED_LIFECYCLE_KEYS, ...ALLOWED_KEYS]) {
    // The refused key trailing an allowed one is the bypass: the allowed key is
    // what `${msg%%=*}` returns, so the refused key is never named.
    for (const arg of [`STATUS=ok\n${key}=1`, `${key}=1\nSTATUS=ok`, `STATUS=ok\r${key}=1`]) {
      const r = probe("selftest", "message", arg);
      assert.equal(r.status, 1, `${JSON.stringify(arg)} must be refused`);
      assert.match(r.stdout, /single-line KEY=VALUE/);
    }
    // Two arguments is the documented form, and the batching has to be caught
    // inside one of them or not at all: this is the case the payload builder
    // would fold into a single datagram.
    const batched = probe("selftest", "message", "STATUS=ok", `${key}=1`);
    if (ALLOWED_KEYS.includes(key)) {
      assert.equal(batched.status, 0, `two informational fields in the documented form must pass; got: ${batched.stdout}`);
    } else {
      assert.equal(batched.status, 1, `${key}=1 as its own argument must be refused`);
      assert.match(batched.stdout, new RegExp(`${key}= is not a field a probe may send`));
    }
  }
  // A second informational key is refused when batched, for the same reason: the
  // newline is the smuggling vector whatever the payload behind it is.
  const twoInformational = probe("selftest", "message", "STATUS=a\nSTATUS=b");
  assert.equal(twoInformational.status, 1);
  assert.match(twoInformational.stdout, /single-line KEY=VALUE/);
  // And the documented form still passes, so the refusal is not just "refuse
  // everything": one KEY=VALUE per argument, any number of arguments.
  const multi = probe("selftest", "message", "STATUS=ok", "ERRNO=2", "STATUS=again");
  assert.equal(multi.status, 0, `one field per argument must pass; got: ${multi.stdout}`);
});

test("the field refusal holds with the cgroup check passing, so it is not a side effect", () => {
  // `notify` runs the cgroup check first, so from a live refused position the field
  // check is never reached -- which means a guard that only ever refused fields as a
  // consequence of the cgroup check would pass every test above and still let
  // MAINPID= through from a throwaway unit. This runs the two calls `notify` makes,
  // in order, with the cgroup check allowed, and asserts the second one refuses.
  for (const key of REFUSED_LIFECYCLE_KEYS) {
    const gate = verdict(THROWAWAY_CGROUP, LIVE_UNIT_CGROUP, "", "transient");
    assert.equal(gate.status, 0, `precondition: the cgroup check must pass; got: ${gate.stdout}`);
    const field = probe("selftest", "message", `${key}=1`);
    assert.equal(field.status, 1, `${key}=1 must be refused even from an allowed position`);
  }
  // The reverse also holds, and it is the other direction a refactor could break:
  // a refused cgroup must not depend on the field check having run.
  const refusedCgroup = verdict(LIVE_UNIT_CGROUP, LIVE_UNIT_CGROUP, "", "transient");
  assert.equal(refusedCgroup.status, 1);
});

test("sender_unit reads the cgroup v2 unified line's last component", () => {
  assert.equal(probe("selftest", "unit", LIVE_UNIT_CGROUP).stdout, "paperclipai.service");
  assert.equal(probe("selftest", "unit", THROWAWAY_CGROUP).stdout, "pc-probe-42.service");
  assert.equal(probe("selftest", "unit", SESSION_CGROUP).stdout, "session-3.scope");
  // A path with no unit in its last component names no unit, and the guard's whole
  // handling of that case is a refusal. cgroup_path_of is what turns a v1-only
  // /proc/self/cgroup into this input: no `0::` line, so no path at all.
  assert.equal(probe("selftest", "unit", "/").status, 1);
  assert.equal(probe("selftest", "unit", "").status, 1);
});

test("the shipped facts come from the kernel and systemd, in this order", () => {
  // A structural assertion on read_position, because the order is the point: nothing
  // that reads a socket or a message may run before the position is known, and the
  // three derivations must be independent of each other so that a failure in one
  // leaves the others to refuse.
  const fn = script.match(/read_position\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "expected a read_position function");
  assert.match(fn, /cgroup_path_of \$\$/, "the sender's own cgroup must come from /proc/<self>/cgroup");
  assert.match(fn, /read_control_cgroup/);
  assert.match(fn, /sender_unit_ownership/);
  assert.ok(
    fn.indexOf("cgroup_path_of $$") < fn.indexOf("read_control_cgroup"),
    "the kernel fact is read before systemd is asked anything",
  );
  // And the socket is never part of the derivation: a wrong target cannot change the
  // position, which is the measurement the design rests on.
  assert.ok(!/sock|NOTIFY_SOCKET/.test(fn), "the derivation must not depend on the target");
});
