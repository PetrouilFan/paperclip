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
// The behavioural half needs no systemd and no root: the guard reads a cgroup file
// and a transient-unit root, and both are parameters. The proof against a real user
// manager -- which is what proves the attribution claim rather than the parsing -- is
// scripts/paperclip-notify-probe-proof.sh and needs a host.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("the cgroup check is the guard, and it runs before the socket is inspected", () => {
  // A datagram is applied to the sender's unit, so the target cannot change who is
  // affected. Checking it first is not a style preference: it is what makes the
  // refusal correct rather than merely sufficient.
  const cgroupIdx = script.indexOf("sender_unit_is_throwaway");
  const abstractIdx = script.indexOf("@*)");
  const socketKindIdx = script.indexOf('-S "$sock"');
  assert.ok(cgroupIdx > 0, "expected the transient check");
  assert.ok(abstractIdx > cgroupIdx, "the cgroup check must come before the abstract-socket check");
  assert.ok(socketKindIdx > cgroupIdx, "the cgroup check must come before the socket-kind check");
});

test("the guard fails closed when it cannot read the cgroup", () => {
  // An unreadable /proc/self/cgroup is exactly the case where the script cannot
  // prove it is safe, so it must refuse rather than assume. The reason has to name
  // the file, or an operator reads the refusal as a mystery.
  assert.match(script, /if \[ ! -r "\$SELF_CGROUP_FILE" \]/);
  assert.match(script, /failing closed/);
});

test("the refusal names the unit that would have been edited", () => {
  // "refused" with no subject is not actionable. The operator's next question is
  // always "what was I about to touch", and the answer is free to compute.
  assert.match(script, /a datagram is applied to the unit that sent it \(measured 2026-09-27\), so sending from here edits %s/);
});

test("the ownership proof is the runtime dir, not the unit's name", () => {
  // The tempting implementation is to allow anything that looks like a probe by
  // name. That is a claim about the world made by a string, and the whole point of
  // checking transient/ is that systemd's own bookkeeping is the evidence.
  assert.match(script, /sender_unit_is_throwaway\(\) \{[\s\S]*?-e "\$TRANSIENT_ROOT\/\$u"/);
  assert.ok(!/case "\$u" in pc-probe/.test(codeOnly()), "a name prefix is not evidence of ownership");
});

test("a lifecycle key is refused and there is no way to allow it", () => {
  // These six change the state of whichever unit sent the datagram, which is the
  // one thing the cgroup check protects. There is deliberately no override flag: a
  // probe that needs one of these is the bug, and a flag would be the thing that
  // makes the guard advisory.
  for (const key of ["STOPPING", "RELOADING", "READY", "WATCHDOG", "WATCHDOG_USEC", "EXTEND_TIMEOUT_USEC"]) {
    assert.match(script, new RegExp(`\\b${key}\\b`), `${key} must be named in the refusal list`);
  }
  assert.ok(!/allow-lifecycle|force|--yes/.test(codeOnly()), "there must be no override for a lifecycle key");
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
  // Type=notify would need READY=1, which rule 3 refuses, so it would die on
  // TimeoutStartSec. Recorded because it is the obvious first thing to try.
  assert.match(script, /--property=Type=exec, not Type=notify/);
});

test("notify requires the socket to be named", () => {
  // An implicit target taken from the environment is the bug. After the scrub there
  // is no NOTIFY_SOCKET to fall back to anyway, and a missing socket must be a usage
  // error rather than a silent no-op.
  const idx = script.indexOf('[ -n "$sock" ] || { usage; exit 2; }');
  assert.ok(idx > 0, "notify must reject a missing socket");
});

// --- behavioural: the shipped guard, against synthetic cgroups.

function loadProbe() {
  // Everything above the top-level scrub call is the configuration block plus the
  // functions. Extracting the shipped source is the point: what runs here is the
  // code in the file, not a paraphrase of it.
  const prelude = script.split("\nscrub_ipc_env\n")[0];
  assert.ok(prelude, "could not find the pre-dispatch portion of the probe");
  const config = prelude.match(/^[A-Z_]+=.*$/gm) ?? [];
  const fns = prelude.match(/^[a-z_]+\(\) \{[\s\S]*?^\}/gm) ?? [];
  for (const name of ["sender_unit", "sender_unit_is_throwaway", "guard_probe", "guard_message"]) {
    assert.ok(fns.some((f) => f.startsWith(`${name}() {`)), `could not extract ${name}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "notify-probe-"));
  const helper = join(dir, "probe.sh");
  writeFileSync(helper, `#!/usr/bin/env bash\nset -uo pipefail\n${config.join("\n")}\n${fns.join("\n")}\n"$@"\n`);
  execFileSync("chmod", ["+x", helper]);
  return {
    call: (fn, args = [], env = {}) =>
      spawnSync("bash", [helper, fn, ...args.map(String)], { encoding: "utf8", env: { ...process.env, ...env } }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// A cgroup file shaped like the real one: the v2 unified line, the unit as the last
// path component, nested the way the user slice actually nests it.
const cgroupFile = (dir, path) => {
  const f = join(dir, "cgroup");
  writeFileSync(f, `0::${path}\n`);
  return f;
};

const UNIT_CGROUP = "/user.slice/user-1000.slice/user@1000.service/app.slice/paperclipai.service";

test("a datagram from inside a long-lived unit is refused, and the unit is named", () => {
  const probe = loadProbe();
  const dir = mkdtempSync(join(tmpdir(), "notify-cg-"));
  try {
    const env = {
      PAPERCLIP_PROBE_SELF_CGROUP_FILE: cgroupFile(dir, UNIT_CGROUP),
      PAPERCLIP_PROBE_TRANSIENT_ROOT: join(dir, "transient"),
    };
    mkdirSync(env.PAPERCLIP_PROBE_TRANSIENT_ROOT, { recursive: true });

    // This is the false-positive guard that matters: paperclipai.service is a real
    // unit, so if the check ever degenerated into "not a throwaway-looking name" it
    // would still pass here, and the real failure would be the opposite direction.
    const r = probe.call("guard_probe", ["/run/user/1000/systemd/notify"], env);
    assert.equal(r.status, 1, "a send from inside paperclipai.service must be refused");
    assert.match(r.stdout, /inside the paperclipai\.service cgroup/);
    assert.match(r.stdout, /edits paperclipai\.service/);
    // The remedy has to be in the message, or the operator is left guessing.
    assert.match(r.stdout, /systemd-run --user/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    probe.cleanup();
  }
});

test("a send from inside a throwaway transient unit is allowed", () => {
  const probe = loadProbe();
  const dir = mkdtempSync(join(tmpdir(), "notify-cg-"));
  try {
    const transient = join(dir, "transient");
    mkdirSync(join(transient, "pc-probe-42.service"), { recursive: true });
    const env = {
      PAPERCLIP_PROBE_SELF_CGROUP_FILE: cgroupFile(dir, "/user.slice/user-1000.slice/user@1000.service/app.slice/pc-probe-42.service"),
      PAPERCLIP_PROBE_TRANSIENT_ROOT: transient,
    };
    const r = probe.call("guard_probe", ["/run/user/1000/systemd/notify"], env);
    assert.equal(r.status, 0, `a send from a throwaway unit must be allowed; got: ${r.stdout}${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    probe.cleanup();
  }
});

test("a probe name without systemd's runtime dir is still refused", () => {
  // The anti-spoofing case, and the reason the proof is a directory lookup rather
  // than a name match: nothing stops a caller from naming its unit pc-probe-anything.
  const probe = loadProbe();
  const dir = mkdtempSync(join(tmpdir(), "notify-cg-"));
  try {
    const transient = join(dir, "transient");
    mkdirSync(transient, { recursive: true });
    const env = {
      PAPERCLIP_PROBE_SELF_CGROUP_FILE: cgroupFile(dir, "/user.slice/user-1000.slice/user@1000.service/app.slice/pc-probe-forged.service"),
      PAPERCLIP_PROBE_TRANSIENT_ROOT: transient,
    };
    const r = probe.call("guard_probe", ["/run/user/1000/systemd/notify"], env);
    assert.equal(r.status, 1, "a probe-shaped name with no runtime dir must be refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    probe.cleanup();
  }
});

test("a process in no identifiable unit is refused, not assumed safe", () => {
  // Measured on a user plane, "no unit at all" is not a real position: a bare
  // interactive shell is inside user@1000.service or a session scope, so its cgroup
  // path's last component is a unit name and the guard refuses it. Both of those
  // are asserted here, because "you must wrap your terminal probe too" is a
  // behaviour an operator meets on their first try and the message has to be right.
  const probe = loadProbe();
  const dir = mkdtempSync(join(tmpdir(), "notify-cg-"));
  try {
    const transient = join(dir, "transient");
    mkdirSync(transient, { recursive: true });
    const env = { PAPERCLIP_PROBE_TRANSIENT_ROOT: transient };

    // The user manager's own unit. A terminal probe lands here.
    const manager = {
      ...env,
      PAPERCLIP_PROBE_SELF_CGROUP_FILE: cgroupFile(dir, "/user.slice/user-1000.slice/user@1000.service"),
    };
    const r = probe.call("guard_probe", ["/run/user/1000/systemd/notify"], manager);
    assert.equal(r.status, 1, "a send from the user manager's own context must be refused");
    assert.match(r.stdout, /inside the user@1000\.service cgroup/);

    // A session scope is a named unit too, and has no transient dir, so it is
    // refused on the same rule rather than on a special case.
    const session = {
      ...env,
      PAPERCLIP_PROBE_SELF_CGROUP_FILE: cgroupFile(dir, "/user.slice/user-1000.slice/user@1000.service/session-3.scope"),
    };
    const s = probe.call("guard_probe", ["/run/user/1000/systemd/notify"], session);
    assert.equal(s.status, 1, "session-3.scope is not a throwaway unit");
    assert.match(s.stdout, /session-3\.scope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    probe.cleanup();
  }
});

test("a cgroup file that names no unit is refused, and it is the fail-open twin", () => {
  // The unreadable case is the obvious fail-closed test. This is the one that was
  // actually wrong when this suite was first written: a readable file with no v2
  // unified line produced no unit name, and "no unit name" was treated as "no unit
  // in the way" -- an allow. On a v2 host the unified line is always present, so its
  // absence means the file is not what this guard assumes, which is a refusal.
  const probe = loadProbe();
  const dir = mkdtempSync(join(tmpdir(), "notify-cg-"));
  try {
    const v1 = join(dir, "cgroup-v1-only");
    writeFileSync(v1, "12:pids:/user.slice/user-1000.slice\n");
    const r = probe.call("guard_probe", ["/run/user/1000/systemd/notify"], {
      PAPERCLIP_PROBE_SELF_CGROUP_FILE: v1,
      PAPERCLIP_PROBE_TRANSIENT_ROOT: join(dir, "transient"),
    });
    assert.equal(r.status, 1, "a cgroup file naming no unit must be refused");
    assert.match(r.stdout, /names no unit/);
    assert.match(r.stdout, /failing closed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    probe.cleanup();
  }
});

test("an unreadable cgroup file is refused, not assumed safe", () => {
  const probe = loadProbe();
  try {
    const r = probe.call("guard_probe", ["/run/user/1000/systemd/notify"], {
      PAPERCLIP_PROBE_SELF_CGROUP_FILE: "/nonexistent/proc/self/cgroup",
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /unreadable/);
    assert.match(r.stdout, /failing closed/);
  } finally {
    probe.cleanup();
  }
});

test("the target checks are reachable once the cgroup check has passed", () => {
  // Otherwise the cgroup check would be masking them in production and they would
  // only ever be exercised by the synthetic tests above.
  const probe = loadProbe();
  const dir = mkdtempSync(join(tmpdir(), "notify-cg-"));
  try {
    const transient = join(dir, "transient");
    mkdirSync(join(transient, "pc-probe-7.service"), { recursive: true });
    const env = {
      PAPERCLIP_PROBE_SELF_CGROUP_FILE: cgroupFile(dir, "/user.slice/user-1000.slice/user@1000.service/app.slice/pc-probe-7.service"),
      PAPERCLIP_PROBE_TRANSIENT_ROOT: transient,
    };
    const abstract = probe.call("guard_probe", ["@probe"], env);
    assert.equal(abstract.status, 1);
    assert.match(abstract.stdout, /abstract socket/);

    const system = probe.call("guard_probe", ["/run/systemd/notify"], env);
    assert.equal(system.status, 1);
    assert.match(system.stdout, /system manager/);

    const notASocket = probe.call("guard_probe", ["/tmp/nope.sock"], env);
    assert.equal(notASocket.status, 1);
    assert.match(notASocket.stdout, /is not a socket/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    probe.cleanup();
  }
});

test("guard_message refuses the state-changing keys and passes the informational ones", () => {
  const probe = loadProbe();
  try {
    for (const key of ["STOPPING", "RELOADING", "READY", "WATCHDOG", "WATCHDOG_USEC", "EXTEND_TIMEOUT_USEC"]) {
      const r = probe.call("guard_message", [`${key}=1`]);
      assert.equal(r.status, 1, `${key}=1 must be refused`);
      assert.match(r.stdout, new RegExp(`${key}= changes the state`));
    }
    // STATUS= is the whole point of a probe: it is what the guard must let through.
    const okStatus = probe.call("guard_message", ["STATUS=hello", "ERRNO=2"]);
    assert.equal(okStatus.status, 0, `informational keys must pass; got: ${okStatus.stdout}`);
    // A bare word is a typo, and a typo that silently sends half a datagram is worse
    // than a refusal.
    const typo = probe.call("guard_message", ["STATUS"]);
    assert.equal(typo.status, 1);
    assert.match(typo.stdout, /not KEY=VALUE/);
  } finally {
    probe.cleanup();
  }
});

test("sender_unit reads the cgroup v2 unified line and nothing else", () => {
  const probe = loadProbe();
  const dir = mkdtempSync(join(tmpdir(), "notify-cg-"));
  try {
    const env = { PAPERCLIP_PROBE_SELF_CGROUP_FILE: cgroupFile(dir, UNIT_CGROUP) };
    assert.equal(probe.call("sender_unit", [], env).stdout, "paperclipai.service");

    // A v1-only file has no unified line and no unit to name, so there is nothing
    // to check and the answer is "no unit" rather than a guess.
    const v1 = join(dir, "cgroup-v1");
    writeFileSync(v1, "12:pids:/user.slice/user-1000.slice\n");
    const r = probe.call("sender_unit", [], { PAPERCLIP_PROBE_SELF_CGROUP_FILE: v1 });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    probe.cleanup();
  }
});
