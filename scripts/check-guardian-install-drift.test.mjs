// Contract tests for scripts/check-guardian-install-drift.mjs.
//
// The incident: on 2026-09-27 the installed guardian was reduced to a 4-line
// `exit 0` stub and ran for hours under a timer that was `active` at a correct
// 60s cadence, with 1418 journal entries all exiting 0, the unit file present,
// the drop-ins present, the wants symlink present and the service `active`. The
// stub was executable, owned by the installing user, and 177 bytes.
//
// So these tests pin the two things that actually catch that, and they pin them
// against the stub rather than against a description of it:
//
//   1. content, and specifically the split between `stubbed` and `altered`,
//      because a presence or size check passes on the stub and a size check also
//      fires on a legitimate one-character fix — the second instance of this
//      class, where the INSTALLED copy was the correct one;
//   2. exit codes, because a check that cannot answer must not be able to say
//      "yes" either. Every unevaluated path returns 2, never 1.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXIT_DRIFT,
  EXIT_OK,
  EXIT_UNEVALUATED,
  GUARDIAN_MARKERS,
  GUARDIAN_SOURCE_PATH,
  evaluateGoldenSet,
  evaluateInstalledGuardian,
  evaluatePair,
  formatReport,
  guardianLocations,
  lineDifferences,
  runCheck,
  summarize,
} from "./check-guardian-install-drift.mjs";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const committed = execFileSync("git", ["show", `HEAD:${GUARDIAN_SOURCE_PATH}`], {
  cwd: repoRoot,
  encoding: "utf8",
});

/** A throwaway HOME holding an installed copy and a golden copy set. */
function host({ installed, golden = {}, live = {}, liveOnly = {} }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "guardian-drift-"));
  const installedPath = path.join(root, ".local", "bin", "paperclip-unit-guardian.sh");
  const stateDir = path.join(root, ".local", "state", "paperclip-unit-guardian");
  const unitDir = path.join(root, ".config", "systemd", "user");

  if (installed !== undefined) {
    mkdirSync(path.dirname(installedPath), { recursive: true });
    writeFileSync(installedPath, installed);
    chmodSync(installedPath, 0o755);
  }
  for (const [name, body] of Object.entries(golden)) {
    const p = path.join(stateDir, "golden", "dropins", name);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  if (golden.__unit !== undefined) {
    const p = path.join(stateDir, "golden", "paperclipai.service");
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, golden.__unit);
  }
  for (const [name, body] of Object.entries({ ...live, ...liveOnly })) {
    const p = path.join(unitDir, "paperclipai.service.d", name);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return {
    root,
    installedPath,
    stateDir,
    unitDir,
    locations: { installed: installedPath, unit: "paperclipai.service", unitDir, stateDir },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const collect = () => {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join("") };
};

// --- the shipped guardian, and the stub that replaced it.

test("every shipped marker is in the committed guardian at HEAD", () => {
  // The source half. If this fails the manifest has drifted from the code, which
  // is the state the precedent calls a bug in the check rather than a finding:
  // the check has nothing to compare against and must not claim otherwise.
  for (const { id, marker, why } of GUARDIAN_MARKERS) {
    assert.ok(committed.includes(marker), `marker ${id} (${why}) is not in ${GUARDIAN_SOURCE_PATH} at HEAD`);
  }
});

test("marker ids are unique so a report never double-counts one guard", () => {
  const ids = GUARDIAN_MARKERS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the committed install path is the one the guardian's own escape hatch documents", () => {
  // If the guardian's documented install location is ever renamed, this check has
  // to be renamed with it or it will report on a file nothing executes.
  assert.match(committed, /rm ~\/\.local\/bin\/paperclip-unit-guardian\.sh/);
  assert.equal(guardianLocations({ HOME: "/home/tester" }).installed, "/home/tester/.local/bin/paperclip-unit-guardian.sh");
});

test("an install that IS the committed guardian reads as matching", () => {
  const h = host({ installed: committed });
  try {
    assert.equal(evaluateInstalledGuardian({ installed: h.installedPath, committed }).state, "matching");
  } finally {
    h.cleanup();
  }
});

test("the 177-byte exit 0 stub reads as stubbed, not as ok and not as a mere mismatch", () => {
  // Measured 2026-09-27: 4 lines, `exit 0`, executable, owned by the installing
  // user, running under an active timer at a correct 60s cadence. Every metadata
  // signal about it was healthy; only the content is not.
  const stub = [
    "#!/bin/sh",
    "# Disabled 2026-09-27 by operator request: paperclipai held stopped.",
    "# Original preserved at /home/petrouil/.local/bin/paperclip-unit-guardian.sh.real-20260927",
    "exit 0",
    "",
  ].join("\n");
  const h = host({ installed: stub });
  try {
    const result = evaluateInstalledGuardian({ installed: h.installedPath, committed });
    assert.equal(result.state, "stubbed");
    // Every guard step is gone, and the report has to be able to say which.
    assert.equal(result.missingFromInstalled.length, GUARDIAN_MARKERS.length);
    assert.ok(result.missingFromInstalled.includes("freeze-resume"));
  } finally {
    h.cleanup();
  }
});

/**
 * A marker-preserving edit to the committed guardian: the step 6b threshold moved
 * by one character. This is the shape of the second instance of this class — the
 * installed copy correct, the committed one carrying a dead detector — and it also
 * serves as the `altered` fixture everywhere below.
 */
const HOST_SIDE_FIX = committed.replace('"$stopped_total" -ge 4', '"$stopped_total" -ge 0');

test("the host-side fixture is a real one-character change, not a no-op", () => {
  assert.notEqual(HOST_SIDE_FIX, committed);
  assert.equal(HOST_SIDE_FIX.length - committed.length, 0);
});

test("a one-character host fix reads as altered, and in both directions", () => {
  const shipped = step6bThresholdLine();
  const h = host({ installed: HOST_SIDE_FIX });
  try {
    const result = evaluateInstalledGuardian({ installed: h.installedPath, committed });
    assert.equal(result.state, "altered");
    // It implements every guard, so `stubbed` is ruled out: this is a disagreement,
    // not an absence.
    assert.deepEqual(result.missingFromInstalled, []);
    assert.equal(result.diffs.length, 1);
    assert.equal(result.diffs[0].line, shipped);
  } finally {
    h.cleanup();
  }
});

/** The line of the step 6b threshold in the committed guardian. */
function step6bThresholdLine() {
  const line = committed.split("\n").findIndex((l) => l.includes('"$stopped_total" -ge 4'));
  assert.ok(line >= 0, "expected the step 6b threshold in the committed guardian");
  return line + 1;
}

test("a missing install is absent, which is a different finding from a divergence", () => {
  const h = host({});
  try {
    const result = evaluateInstalledGuardian({ installed: h.installedPath, committed });
    assert.equal(result.state, "absent");
    // Nothing was read, so there is no marker list and no hash to quote.
    assert.equal(result.installedSha, null);
    assert.deepEqual(result.diffs, []);
  } finally {
    h.cleanup();
  }
});

test("a guardian gutted in the repo cannot report a permanently green board", () => {
  // Both halves stubbed at once: the installed copy and the committed copy are the
  // same 177-byte file, so a pure two-way comparison agrees and the board goes
  // green. That is the reason the source half exists.
  const gutted = "#!/bin/sh\nexit 0\n";
  const h = host({ installed: gutted });
  try {
    const result = evaluateInstalledGuardian({ installed: h.installedPath, committed: gutted });
    assert.equal(result.state, "source_gutted");
    assert.equal(result.missingFromCommitted.length, GUARDIAN_MARKERS.length);

    const out = collect();
    const code = runCheck({
      installed: h.installedPath,
      committed: gutted,
      locations: h.locations,
      write: out.write,
    });
    // Two, not one. Reporting a gutted source as a finding would blame an install
    // that is in fact exactly what the repo says it should be.
    assert.equal(code, EXIT_UNEVALUATED);
    assert.notEqual(code, EXIT_DRIFT);
    assert.match(out.text(), /the committed guardian at HEAD is missing guard steps/);
    assert.match(out.text(), /Fix that\nbefore trusting any result here\./);
  } finally {
    h.cleanup();
  }
});

test("an unreadable install is unevaluated, never a finding", () => {
  // The issue names this path explicitly. Node exits an uncaught EACCES with
  // status 1, which is the drift code, so a board consumer would read a broken
  // check as a stubbed install.
  const h = host({ installed: committed });
  try {
    const exploding = () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    const result = evaluateInstalledGuardian({
      installed: h.installedPath,
      committed,
      readFile: exploding,
    });
    assert.equal(result.state, "unreadable");
    assert.match(result.error, /EACCES/);

    const out = collect();
    const code = runCheck({
      installed: h.installedPath,
      committed,
      locations: h.locations,
      readFile: exploding,
      write: out.write,
    });
    assert.equal(code, EXIT_UNEVALUATED);
    assert.match(out.text(), /could not read it/);
    // It is reported, and it is not in the finding list.
    assert.doesNotMatch(out.text(), /^unreadable installed guardian/m);
  } finally {
    h.cleanup();
  }
});

test("no repo to compare against is unevaluated and says so in --json", () => {
  const h = host({ installed: committed });
  try {
    const out = collect();
    const code = runCheck({
      asJson: true,
      installed: h.installedPath,
      committed: null,
      locations: h.locations,
      write: out.write,
    });
    assert.equal(code, EXIT_UNEVALUATED);
    const parsed = JSON.parse(out.text());
    assert.equal(parsed.unevaluated, true);
    assert.match(parsed.error, /run this inside a checkout/);
  } finally {
    h.cleanup();
  }
});

test("exit codes stay distinct across all three install states, and clean is 0", () => {
  const cases = [
    [committed, EXIT_OK],
    ["#!/bin/sh\nexit 0\n", EXIT_DRIFT],
    [HOST_SIDE_FIX, EXIT_DRIFT],
    [undefined, EXIT_DRIFT],
  ];
  for (const [body, expected] of cases) {
    const h = host(body === undefined ? {} : { installed: body });
    try {
      const code = runCheck({ installed: h.installedPath, committed, locations: h.locations, write: () => {} });
      assert.equal(code, expected, `install ${body === undefined ? "absent" : JSON.stringify(body.slice(0, 24))}`);
    } finally {
      h.cleanup();
    }
  }
  assert.notEqual(EXIT_UNEVALUATED, EXIT_DRIFT);
  assert.notEqual(EXIT_UNEVALUATED, EXIT_OK);
});

// --- the golden copy set: the half step 2b only covers in one direction.

test("a drop-in in force with altered content is reported, which is the case step 2b misses", () => {
  // Measured on this host 2026-09-27, and it is the divergence the ticket names:
  // the live drop-in said RefuseManualStop=no and the golden copy the guardian
  // would restore said yes. Step 2b only asks "is there a golden copy", so it sees
  // nothing wrong, and the guardian never rewrites a file that already exists.
  const live = ["[Service]", "RefuseManualStop=no", ""].join("\n");
  const golden = ["[Service]", "RefuseManualStop=yes", ""].join("\n");
  const h = host({
    installed: committed,
    golden: { "90-no-manual-stop.conf": golden },
    live: { "90-no-manual-stop.conf": live },
  });
  try {
    const out = collect();
    const code = runCheck({ installed: h.installedPath, committed, locations: h.locations, write: out.write });
    assert.equal(code, EXIT_DRIFT);
    assert.match(out.text(), /DIFF 90-no-manual-stop\.conf/);
    assert.match(out.text(), /golden has "RefuseManualStop=yes", live has "RefuseManualStop=no"/);
    // And the remedy names the actual danger: a delete-and-restore silently
    // changes the unit.
    assert.match(out.text(), /deletion followed by a restore silently changes the unit/);
  } finally {
    h.cleanup();
  }
});

test("a drop-in in force with no golden copy is reported as unguarded, not as divergent", () => {
  // The step 2b gap. The guardian's step 2 loops over $GOLDEN/dropins, so a file
  // that is not there is walked straight past: its deletion is unrecoverable.
  const h = host({ installed: committed, liveOnly: { "75-restart-backoff.conf": "[Service]\nRestartSteps=5\n" } });
  try {
    const goldenSet = evaluateGoldenSet({
      unit: "paperclipai.service",
      unitDir: h.unitDir,
      stateDir: h.stateDir,
    });
    assert.equal(goldenSet.dropins[0].name, "75-restart-backoff.conf");
    assert.equal(goldenSet.dropins[0].state, "unguarded");

    const out = collect();
    const code = runCheck({ installed: h.installedPath, committed, locations: h.locations, write: out.write });
    assert.equal(code, EXIT_DRIFT);
    assert.match(out.text(), /UNGUARDED 75-restart-backoff\.conf/);
    assert.match(out.text(), /cp -p the live file into the golden dropins\/ directory/);
  } finally {
    h.cleanup();
  }
});

test("an identical golden copy set is clean, including a golden copy with nothing in force", () => {
  const h = host({
    installed: committed,
    golden: { "20-runtime-env.conf": "[Service]\nEnvironment=PAPERCLIP_SERVICE_MANAGED=1\n", "99-retired.conf": "[Service]\n" },
    live: { "20-runtime-env.conf": "[Service]\nEnvironment=PAPERCLIP_SERVICE_MANAGED=1\n" },
  });
  try {
    const out = collect();
    const code = runCheck({ installed: h.installedPath, committed, locations: h.locations, write: out.write });
    // A golden copy with nothing in force is worth printing and is not a finding:
    // the guardian is not going to install a drop-in that is already gone, it only
    // restores one that went missing.
    assert.equal(code, EXIT_OK);
    assert.match(out.text(), /ok   20-runtime-env\.conf/);
    assert.match(out.text(), /inert 99-retired\.conf/);
    assert.match(out.text(), /match their committed counterparts/);
  } finally {
    h.cleanup();
  }
});

test("the golden unit file is compared too, not only the drop-ins", () => {
  const h = host({
    installed: committed,
    golden: { __unit: "[Service]\nKillMode=process\n" },
    live: { "20-runtime-env.conf": "x\n" },
  });
  try {
    writeFileSync(path.join(h.unitDir, "paperclipai.service"), "[Service]\nKillMode=control-group\n");
    const goldenSet = evaluateGoldenSet({
      unit: "paperclipai.service",
      unitDir: h.unitDir,
      stateDir: h.stateDir,
    });
    assert.equal(goldenSet.unit.state, "divergent");
    const out = collect();
    assert.equal(
      runCheck({ installed: h.installedPath, committed, locations: h.locations, write: out.write }),
      EXIT_DRIFT,
    );
    assert.match(out.text(), /DIFF paperclipai\.service/);
  } finally {
    h.cleanup();
  }
});

test("evaluatePair separates all four outcomes on content alone", () => {
  const both = "/tmp/pair-both";
  const mk = (name, body) => {
    writeFileSync(path.join(both, name), body);
    return path.join(both, name);
  };
  mkdirSync(both, { recursive: true });
  try {
    const same = evaluatePair({ name: "a.conf", goldenPath: mk("g-a", "x\n"), livePath: mk("l-a", "x\n") });
    const different = evaluatePair({ name: "b.conf", goldenPath: mk("g-b", "x\n"), livePath: mk("l-b", "y\n") });
    const noGolden = evaluatePair({ name: "c.conf", goldenPath: "/tmp/pair-none-g", livePath: mk("l-c", "z\n") });
    const notInForce = evaluatePair({ name: "d.conf", goldenPath: mk("g-d", "x\n"), livePath: "/tmp/pair-none-l" });
    assert.equal(same.state, "matching");
    assert.equal(different.state, "divergent");
    assert.equal(noGolden.state, "unguarded");
    assert.equal(notInForce.state, "inert");
  } finally {
    rmSync(both, { recursive: true, force: true });
  }
});

// --- the report itself.

test("the stub finding says presence would have passed, and gives a remedy", () => {
  const h = host({ installed: "#!/bin/sh\nexit 0\n" });
  try {
    const guardian = evaluateInstalledGuardian({ installed: h.installedPath, committed });
    const goldenSet = evaluateGoldenSet({ unit: "paperclipai.service", unitDir: h.unitDir, stateDir: h.stateDir });
    const report = { installed: guardian, goldenSet, ...summarize({ installed: guardian, goldenSet }) };
    const text = formatReport(report);
    assert.match(text, /A presence check passes on this\. Only content does not\./);
    assert.match(text, /Restore it from the committed copy/);
    assert.match(text, /presence, mtime, size and ownership were all true of the/i);
    // One finding, and it names the install, so the operator knows which file.
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].state, "stubbed");
    assert.equal(report.findings[0].name, h.installedPath);
  } finally {
    h.cleanup();
  }
});

test("an altered install is not reported as a tamper", () => {
  // The honest reading is symmetric, and the wording has to carry it: a host fix
  // that was never pushed is indistinguishable from a tamper, and the report must
  // not pick a culprit it cannot evidence.
  const h = host({ installed: HOST_SIDE_FIX });
  try {
    const out = collect();
    runCheck({ installed: h.installedPath, committed, locations: h.locations, write: out.write });
    assert.match(out.text(), /the two disagree and this check does not say which is right/);
    assert.match(out.text(), /a one-character host fix that was never pushed looks exactly like a tamper/);
    assert.match(out.text(), /DIFF  altered/);
  } finally {
    h.cleanup();
  }
});

test("lineDifferences names the line, not a byte offset", () => {
  const diffs = lineDifferences("a\nb\nc\n", "a\nB\nc\n");
  assert.deepEqual(diffs, [{ line: 2, expected: "b", actual: "B" }]);
  assert.deepEqual(lineDifferences("a\nb\n", "a\nb\n"), []);
  // A trailing-newline difference has no line to name, so it produces no entry
  // rather than a line 2 that does not exist.
  assert.deepEqual(lineDifferences("a\n", "a"), []);
  // An insertion shows the neighbourhood that moved.
  const inserted = lineDifferences("a\nc\n", "a\nb\nc\n");
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].line, 2);
  assert.equal(inserted[0].actual, "b");
});

test("--json carries the states a consumer needs, not just prose", () => {
  const h = host({ installed: "#!/bin/sh\nexit 0\n" });
  try {
    const out = collect();
    const code = runCheck({
      asJson: true,
      installed: h.installedPath,
      committed,
      locations: h.locations,
      write: out.write,
    });
    assert.equal(code, EXIT_DRIFT);
    const parsed = JSON.parse(out.text());
    assert.equal(parsed.installed.state, "stubbed");
    assert.equal(parsed.findings.length, 1);
    assert.ok(Array.isArray(parsed.goldenSet.dropins));
    assert.equal(parsed.committedGuardianPath, undefined);
  } finally {
    h.cleanup();
  }
});
