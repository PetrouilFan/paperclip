#!/usr/bin/env node
/**
 * Report an installed guardian — and the golden copy set it restores from — that
 * no longer matches what is committed.
 *
 * The gap this closes: `scripts/paperclip-unit-guardian.sh` is version controlled
 * and a copy is installed at `~/.local/bin/paperclip-unit-guardian.sh`, and
 * nothing compared the two. The guardian cannot check itself; its own body is the
 * thing that gets replaced.
 *
 * On 2026-09-27 the installed copy was reduced to a 4-line `exit 0` stub, and
 * every signal an operator or an agent had read as healthy stayed green for the
 * whole of it:
 *
 *   - the timer was `active` with a correct 60s cadence,
 *   - 1418 guardian runs were logged in the journal, all exiting 0,
 *   - the unit file was present, the drop-ins were present, the wants symlink
 *     was present,
 *   - the service was `active`.
 *
 * None of those is wrong. They are all facts about the unit, the timer and the
 * exit status, and every one of them is still true of a script whose entire body
 * is `exit 0`. A presence check does not catch it: the stub was executable and
 * present. A size check nearly catches it and is wrong anyway, because a
 * legitimate one-character fix is a size change too. Only content catches it.
 *
 * So this asserts content, and it does so in the same shape as
 * `check-running-build-drift.mjs`, which already does this for the served build:
 * assert content rather than a metadata claim, and check the marker twice — once
 * in the source at HEAD, so a guard deleted from the repo cannot report a
 * permanently green board, and once in the installed artifact.
 *
 * THREE STATES, NOT ONE, because the remedies differ:
 *
 *   absent  — the install is gone. Nothing runs the heal. Reinstall.
 *   stubbed — the install is there but is not the guardian: it is missing the
 *             guard steps entirely. This is the `exit 0` case. Reinstall.
 *   altered — the install implements every guard and still disagrees with HEAD.
 *             This is NOT a tamper verdict, and the report must not pretend
 *             otherwise. Measured on 2026-09-27 the two differed by ONE CHARACTER
 *             on the step 6b threshold, with the installed copy correct and the
 *             committed copy carrying a dead detector — an unpushed host fix. A
 *             content comparison catches both directions for the same reason:
 *             either way the two files disagree, and which one is authoritative
 *             is a decision this check refuses to make for you.
 *
 * A size or mtime heuristic cannot tell `stubbed` from `altered`, which is why
 * `stubbed` is decided by markers (does the installed copy still contain the
 * guards?) and `altered` by bytes (do the two copies agree?). `absent` needs
 * neither.
 *
 * The golden copy set gets the same treatment, because step 2b only half covers
 * it. Step 2b alerts on a drop-in that is in force with NO golden copy; a drop-in
 * that exists in both places with ALTERED content is invisible to it, and the
 * guardian's own header says it never rewrites a file that already exists. That
 * is how the `RefuseManualStop` golden/live divergence stayed hidden: the guard
 * under repair and the copy it would restore are two different files, and nothing
 * compared them.
 *
 * Exit codes: 0 nothing diverged, 1 something did, 2 the check could not be
 * evaluated (no repo, an unreadable source tree, an unreadable install, or a
 * marker that is no longer in the source at HEAD). Every unevaluated path returns
 * 2, never 1, so a broken check can never be read as a finding. This is the whole
 * reason the exit-code contract exists: a check that cannot answer must not be
 * able to say "yes" either.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The committed guardian. Read at HEAD, never from the working tree. */
export const GUARDIAN_SOURCE_PATH = "scripts/paperclip-unit-guardian.sh";

/**
 * The guard steps the committed guardian is supposed to contain.
 *
 * These are the manifest the source half checks. They are deliberately
 * distinctive strings from the guard bodies and the alert text rather than line
 * numbers or hashes, and each one names a step whose absence would leave the
 * timer `active` while doing nothing — which is the exact shape of the incident
 * this file exists to catch.
 */
export const GUARDIAN_MARKERS = [
  { id: "unit-restore", marker: "RESTORED unit definition", why: "step 1 restores a deleted unit file from the golden copy" },
  { id: "dropin-restore", marker: "RESTORED drop-in", why: "step 2 restores a deleted drop-in from the golden copy" },
  { id: "unguarded-dropin-alert", marker: "ALERT drop-in(s) in force with no golden copy", why: "step 2b alerts on a drop-in the guardian could not restore" },
  { id: "reenable", marker: "REENABLED", why: "step 3 restores the default.target.wants symlink" },
  { id: "start", marker: "STARTED", why: "step 4 starts a unit that is not active" },
  { id: "pause-hatch", marker: '[ -e "$PAUSE" ] && exit 0', why: "the operator escape hatch short-circuits every repair" },
  { id: "freeze-resume", marker: "pid_is_stopped", why: "step 6 resumes a SIGSTOPped main PID" },
  { id: "freeze-escalation", marker: "consecutive guardian ticks", why: "a freeze SIGCONT does not hold escalates instead of repeating quietly" },
  { id: "cgroup-freeze-count", marker: "cgroup.procs", why: "step 6b counts a freeze that spared the main PID" },
];

/** Where each half of the comparison lives on this host. All overridable. */
export function guardianLocations(env = process.env) {
  const home = env.HOME || homedir();
  return {
    installed: env.PAPERCLIP_GUARDIAN_INSTALLED || join(home, ".local", "bin", "paperclip-unit-guardian.sh"),
    unit: env.PAPERCLIP_GUARDIAN_UNIT || "paperclipai.service",
    unitDir: env.PAPERCLIP_GUARDIAN_UNIT_DIR || join(home, ".config", "systemd", "user"),
    stateDir:
      env.PAPERCLIP_GUARDIAN_STATE_DIR || join(home, ".local", "state", "paperclip-unit-guardian"),
  };
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Lines, without the empty element a trailing newline leaves behind. */
const toLines = (text) => {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/**
 * The first few line-level differences between two texts, for a report that has
 * to name what changed without sending the operator off to run a second tool.
 *
 * Prefix/suffix trim, then pair the middle by index. It is not a real diff and does
 * not need to be: the one-character case this was built for is the same length on
 * both sides, and an insert or delete still shows the neighbourhood that moved.
 *
 * A difference that is *only* a trailing newline produces no entry, because there
 * is no line to name. The caller still sees the mismatch through the two sha256s
 * and says so, rather than reporting a line 2 that does not exist.
 */
export function lineDifferences(expected, actual, limit = 4) {
  const a = toLines(expected);
  const b = toLines(actual);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const out = [];
  const end = Math.max(a.length - tail, b.length - tail);
  for (let i = head; i < end && out.length < limit; i += 1) {
    if (a[i] === b[i]) continue;
    out.push({ line: i + 1, expected: a[i] ?? "(absent)", actual: b[i] ?? "(absent)" });
  }
  return out;
}

const describeLines = (diffs, [expectedLabel, actualLabel] = ["committed", "installed"]) =>
  diffs
    .map(
      (d) =>
        `line ${d.line}: ${expectedLabel} has ${JSON.stringify(d.expected)}, ${actualLabel} has ${JSON.stringify(d.actual)}`,
    )
    .join("\n         ");

/**
 * The installed guardian, judged against the committed one.
 *
 * `git` is injected so the test can drive this without a repository, and so a git
 * failure stays distinguishable from a missing install. `readFile` is injected for
 * the same reason, plus so an unreadable install is a state rather than an
 * exception: Node exits an uncaught exception with status 1, which is the finding
 * code, and a board consumer would read a broken check as a tamper.
 */
export function evaluateInstalledGuardian({
  installed,
  committed,
  readFile = readFileSync,
  exists = existsSync,
  markers = GUARDIAN_MARKERS,
}) {
  const missingFromCommitted = markers
    .filter((m) => !committed.includes(m.marker))
    .map((m) => m.id);

  if (missingFromCommitted.length > 0) {
    return {
      state: "source_gutted",
      installed,
      missingFromCommitted,
      missingFromInstalled: [],
      diffs: [],
      committedSha: sha256(committed),
      installedSha: null,
    };
  }

  if (!exists(installed)) {
    return {
      state: "absent",
      installed,
      missingFromCommitted: [],
      missingFromInstalled: [],
      diffs: [],
      committedSha: sha256(committed),
      installedSha: null,
    };
  }

  let body;
  try {
    body = readFile(installed, "utf8");
  } catch (error) {
    return {
      state: "unreadable",
      installed,
      missingFromCommitted: [],
      missingFromInstalled: [],
      diffs: [],
      committedSha: sha256(committed),
      installedSha: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const missingFromInstalled = markers.filter((m) => !body.includes(m.marker)).map((m) => m.id);
  const identical = body === committed;
  return {
    // The split the ticket asks for. `stubbed` is a question about markers (does
    // the install still implement the guards?); `altered` is a question about
    // bytes (do the two copies agree?); `absent` is neither.
    state: missingFromInstalled.length > 0 ? "stubbed" : identical ? "matching" : "altered",
    installed,
    missingFromCommitted: [],
    missingFromInstalled,
    diffs: identical ? [] : lineDifferences(committed, body),
    committedSha: sha256(committed),
    installedSha: sha256(body),
  };
}

/** `*.conf` basenames in a directory, sorted. An unreadable directory is empty. */
function confNames(dir, readdir = readdirSync) {
  try {
    return readdir(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".conf"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** One golden-vs-live pair, judged on content only. */
export function evaluatePair({ name, goldenPath, livePath, readFile = readFileSync, exists = existsSync }) {
  const readIfPresent = (path) => {
    if (!exists(path)) return null;
    try {
      return readFile(path, "utf8");
    } catch {
      return null;
    }
  };
  const golden = readIfPresent(goldenPath);
  const live = readIfPresent(livePath);
  const base = { name, goldenPath, livePath, diffs: [] };

  // No golden copy for something in force is the step 2b gap: the guardian walks
  // straight past it, so its deletion would be an unrecoverable silent
  // degradation. Distinct from a mismatch, distinct from an inert copy.
  if (live !== null && golden === null) return { ...base, state: "unguarded" };
  // Golden copy with nothing in force. The guardian restores it on its next tick
  // if the live file is what is missing, so this is not a divergence — but it
  // usually means a drop-in was retired without retiring its copy.
  if (live === null) return { ...base, state: "inert" };
  if (golden === live) return { ...base, state: "matching" };
  return { ...base, state: "divergent", diffs: lineDifferences(golden, live) };
}

/**
 * The whole golden copy set: the unit file and every drop-in, compared pairwise.
 *
 * This is the half the issue calls out as unconsidered. Step 2b only reports a
 * drop-in that is in force with no golden copy; a drop-in present in both places
 * with different content is invisible to it, and it is invisible to the guardian,
 * whose own header says it never rewrites a file that already exists.
 */
export function evaluateGoldenSet({ unit, unitDir, stateDir, readFile = readFileSync, exists = existsSync, readdir = readdirSync }) {
  const goldenDir = join(stateDir, "golden");
  const liveDir = join(unitDir, `${unit}.d`);
  const goldenDropinDir = join(goldenDir, "dropins");
  const liveDropinDir = liveDir;

  const unitPair = evaluatePair({
    name: unit,
    goldenPath: join(goldenDir, unit),
    livePath: join(unitDir, unit),
    readFile,
    exists,
  });

  const dropinNames = [...new Set([...confNames(goldenDropinDir, readdir), ...confNames(liveDropinDir, readdir)])].sort();
  const dropins = dropinNames.map((name) =>
    evaluatePair({
      name,
      goldenPath: join(goldenDropinDir, name),
      livePath: join(liveDropinDir, name),
      readFile,
      exists,
    }),
  );

  return { goldenDir, liveDir, unit: unitPair, dropins };
}

/** Everything that makes the board red, kept separate from everything it merely reports. */
export function summarize({ installed, goldenSet }) {
  const pairs = [goldenSet.unit, ...goldenSet.dropins];
  const pairKind = (pair, kind) => ({ kind, state: pair.state, name: pair.name });
  return {
    findings: [
      // `unreadable` and `source_gutted` are not findings: they are the two states
      // in which no comparison happened. Listing them here as well as below would
      // let a broken check read as a broken install.
      ...(installed.state === "matching" || installed.state === "unreadable" || installed.state === "source_gutted"
        ? []
        : [{ kind: "installed-guardian", state: installed.state, name: installed.installed }]),
      ...pairs
        .filter((pair) => pair.state === "unguarded" || pair.state === "divergent")
        .map((pair) => pairKind(pair, pair === goldenSet.unit ? "golden-unit" : "golden-dropin")),
    ],
    unevaluated: [
      ...(installed.state === "source_gutted"
        ? [{ kind: "installed-guardian", state: installed.state, detail: installed.missingFromCommitted }]
        : []),
      ...(installed.state === "unreadable" ? [{ kind: "installed-guardian", state: installed.state }] : []),
    ],
  };
}

const INSTALLED_REMEDY = {
  absent:
    "reinstall the committed guardian over it: cp scripts/paperclip-unit-guardian.sh ~/.local/bin/paperclip-unit-guardian.sh && chmod +x ~/.local/bin/paperclip-unit-guardian.sh",
  stubbed:
    "the install is not the guardian. Restore it from the committed copy (cp scripts/paperclip-unit-guardian.sh ~/.local/bin/ && chmod +x); the preserved original, if one exists, is evidence, not a source",
  altered:
    "the two disagree and this check does not say which is right: a one-character host fix that was never pushed looks exactly like a tamper. Diff them, decide which side is authoritative, and make the other one match",
};

const GOLDEN_REMEDY = {
  unguarded: "cp -p the live file into the golden dropins/ directory, or the guardian cannot restore it if it is deleted",
  divergent:
    "the live file and the copy the guardian would restore are different, so a deletion followed by a restore silently changes the unit. Pick the intended content, then make the other side match",
};

export function formatReport(report) {
  const { installed, goldenSet } = report;
  const lines = [`installed guardian: ${installed.installed}`];

  if (installed.state === "source_gutted") {
    lines.push(
      "  BUG   the committed guardian at HEAD is missing guard steps, so this check cannot say",
      "         whether the installed copy matches. Missing: " + installed.missingFromCommitted.join(", "),
    );
    lines.push(
      "",
      "Either the guard was deleted from the repo — in which case the guardian is gone and a green",
      "line here would be a lie — or this file's marker list has drifted from the source. Fix that",
      "before trusting any result here.",
    );
    return lines.join("\n");
  }

  const mark = { matching: "ok  ", absent: "GONE ", stubbed: "STUB ", altered: "DIFF ", unreadable: "UNREAD" }[installed.state];
  lines.push(`  ${mark} ${installed.state}${installed.state === "matching" ? ` (sha256 ${installed.installedSha.slice(0, 12)})` : ""}`);
  if (installed.state === "unreadable") {
    lines.push(`         could not read it: ${installed.error}. That is an unevaluated path, not a finding.`);
  }
  if (installed.state === "stubbed") {
    lines.push(
      `         present and executable, and missing ${installed.missingFromInstalled.length} of the guard steps:`,
      `         ${installed.missingFromInstalled.join(", ")}`,
      "         A presence check passes on this. Only content does not.",
    );
  }
  if (installed.state === "altered") {
    lines.push(
      `         committed sha256 ${installed.committedSha.slice(0, 12)}, installed sha256 ${installed.installedSha.slice(0, 12)}`,
    );
    lines.push(
      installed.diffs.length > 0
        ? `         ${describeLines(installed.diffs)}`
        : "         the two differ only in trailing whitespace, and the sha256 above is the whole difference",
    );
  }

  lines.push("", `golden copy set: ${goldenSet.goldenDir}  ->  ${goldenSet.liveDir}`);
  const pairs = [goldenSet.unit, ...goldenSet.dropins];
  for (const pair of pairs) {
    const label = { matching: "ok  ", divergent: "DIFF", unguarded: "UNGUARDED", inert: "inert" }[pair.state];
    lines.push(`  ${label} ${pair.name}`);
    if (pair.state === "divergent" && pair.diffs.length > 0) {
      lines.push(`         ${describeLines(pair.diffs, ["golden", "live"])}`);
    }
  }
  const unguarded = pairs.filter((p) => p.state === "unguarded");
  if (unguarded.length > 0) {
    lines.push(
      "",
      `${unguarded.length} file(s) in force with no golden copy. Step 2b already alerts on this once`,
      "per change, but only from the guardian's own log — it is not a check anyone runs and reads.",
    );
  }

  const { findings } = report;
  lines.push("");
  if (findings.length === 0) {
    lines.push(
      "the installed guardian and every golden copy match their committed counterparts.",
    );
  } else {
    for (const finding of findings) {
      if (finding.kind === "installed-guardian") {
        lines.push(`${finding.state} installed guardian -- ${INSTALLED_REMEDY[finding.state] ?? ""}`);
      } else if (finding.state === "unguarded" || finding.state === "divergent") {
        lines.push(`${finding.state} ${finding.name} -- ${GOLDEN_REMEDY[finding.state]}`);
      } else {
        lines.push(`${finding.state} ${finding.name}`);
      }
    }
    lines.push(
      "",
      "Content is the only signal here. Presence, mtime, size and ownership were all true of the",
      "177-byte exit 0 stub while it ran under an active timer at a correct 60s cadence.",
    );
  }
  return lines.join("\n");
}

export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_UNEVALUATED = 2;

/**
 * The whole check, as a function of its inputs, returning an exit code.
 *
 * Unevaluated beats drifted. If the source half could not be read, or a marker is
 * gone from it, this file has nothing to compare against, and reporting the
 * other findings from that position would be reporting a comparison it did not
 * make.
 */
export function runCheck({
  asJson = false,
  installed,
  committed,
  locations = guardianLocations(),
  readFile = readFileSync,
  exists = existsSync,
  readdir = readdirSync,
  markers = GUARDIAN_MARKERS,
  write = (text) => process.stdout.write(text),
} = {}) {
  const emit = (payload, text) => write(asJson ? `${JSON.stringify(payload, null, 2)}\n` : `${text}\n`);

  if (typeof committed !== "string") {
    const detail = "no committed guardian to compare against; run this inside a checkout of the repo";
    emit({ error: detail, unevaluated: true }, detail);
    return EXIT_UNEVALUATED;
  }

  const guardian = evaluateInstalledGuardian({
    installed,
    committed,
    readFile,
    exists,
    markers,
  });
  const goldenSet = evaluateGoldenSet({
    unit: locations.unit,
    unitDir: locations.unitDir,
    stateDir: locations.stateDir,
    readFile,
    exists,
    readdir,
  });
  const report = { installed: guardian, goldenSet, ...summarize({ installed: guardian, goldenSet }) };
  write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);

  if (report.unevaluated.length > 0) return EXIT_UNEVALUATED;
  return report.findings.length > 0 ? EXIT_DRIFT : EXIT_OK;
}

function main(argv) {
  const asJson = argv.includes("--json");
  const locations = guardianLocations();
  let committed = null;
  try {
    // stderr is captured rather than inherited: `git` prints a multi-line "fatal:"
    // paragraph when this runs outside a checkout, and the check has its own
    // message for that case. The raw error would read like the check itself
    // failing, which is the opposite of what exit 2 means.
    committed = execFileSync("git", ["show", `HEAD:${GUARDIAN_SOURCE_PATH}`], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Deliberately null rather than fatal: runCheck reports an unreadable source
    // tree as exit 2, and an uncaught exception here would exit 1, which is the
    // finding code.
    committed = null;
  }
  return runCheck({ asJson, installed: locations.installed, committed, locations });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
