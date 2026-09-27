#!/usr/bin/env node
/**
 * Replay the shipped internal-refs gate over every commit on a ref and report
 * which ones it flags.
 *
 * ## Why one commit per scan
 *
 * `checkInternalRefs` de-duplicates its report across the commits handed to it,
 * keyed on the report string rather than on the commit. Several commits on a
 * squash-merged history share a subject, so a single batch scan over `master`
 * reports a handful of *strings* and cannot say how many commits are affected.
 * The batch number reads as a commit count and is wrong.
 *
 * So: one commit per call. Every finding then carries its own sha, and the
 * commit count is the commit count.
 *
 * ## Why the control comes first
 *
 * The obvious way to get this wrong is to pass commits in the wrong shape. The
 * gate reads `commit.commit.message`; a scan that passes `{sha, message}` finds
 * nothing, reports zero offenders, and looks like a clean tree. "No findings"
 * and "the leg never ran" are indistinguishable in the output — which is exactly
 * how a reworded commit body looked verified right up until the squash merge
 * replaced it and the reword turned out never to have been checked.
 *
 * So the control is a synthetic commit whose body names `PET-9001` outright. If
 * the body leg does not flag it, this script exits 2 and produces no report. A
 * zero-offender run is only trustworthy when the control fired.
 *
 * ## Usage
 *
 *   node .github/scripts/scan-report.mjs origin/master
 *   node .github/scripts/scan-report.mjs origin/master --json
 *
 * `--json` writes `{ scanned, ours, foreign, offenders: [...] }` to stdout
 * instead of the markdown report.
 *
 * ## Reading the result
 *
 * A commit flagged here is not a gate failure. `checkInternalRefs` runs against
 * a pull request, and it has never had this input: a landed commit has no open
 * PR, so nothing in CI scans one. This script supplies the missing input on
 * demand. It is a measurement, not a check.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkInternalRefs, DEFAULT_INTERNAL_REF_PREFIXES } from './check-pr-internal-refs.mjs';

const SUBJECT_SURFACE = 'A commit subject';
const BODY_SURFACE = 'A commit message body';

/** The address half, not the identifier half. A subject can draw both findings. */
const HOST_FINDING = 'an address that resolves to one machine';

/**
 * The two control commits. Both are synthetic and both must be flagged, one per
 * leg, so that a report proving either leg is live has to show both.
 */
export const CONTROLS = [
  {
    label: 'subject',
    sha: 'control0000000000000000000000000000subject',
    message: 'chore(ci): add a PET-9001 sentinel so the subject leg has something to catch',
  },
  {
    label: 'body',
    sha: 'control00000000000000000000000000000body',
    message: 'chore(ci): add a sentinel\n\nbody refers to PET-9001 outright\n',
  },
];

/** Run the shipped gate over exactly one commit, the shape the gate expects. */
export function scanCommit({ sha, message }) {
  return checkInternalRefs({
    prTitle: '',
    prBody: '',
    prBranch: '',
    commits: [{ sha, commit: { message } }],
    files: [],
    prefixes: DEFAULT_INTERNAL_REF_PREFIXES,
  }).failures;
}

/**
 * Reduce one scan to the identifier findings on the two commit-message surfaces.
 *
 * `report()` and `unknownReport()` both emit a message line followed by a
 * `  ↳ found in` continuation line; the surface name is what distinguishes
 * them, and the continuation lines are dropped because they carry no surface.
 *
 * The two also differ in whose namespace they found: `report()` fires on a
 * configured prefix — this instance's own — and says "carries", while
 * `unknownReport()` fires on a namespace the repository has no exemption for
 * and says "refers to". That distinction is the gate's own, so the split is
 * read off the report text rather than re-derived by a second matcher that
 * could disagree with the first.
 */
export function identifierFindings(failures) {
  const surfaces = new Set();
  const ours = new Set();
  const foreign = new Set();

  for (const failure of failures) {
    if (!failure.startsWith(SUBJECT_SURFACE) && !failure.startsWith(BODY_SURFACE)) continue;
    if (failure.includes(HOST_FINDING)) continue;

    const surface = failure.startsWith(SUBJECT_SURFACE) ? 'subject' : 'body';
    surfaces.add(surface);

    // The finding is `SURFACE carries|refersto `id`, `id` — remedy`. Only the
    // head names what was found: the remedy quotes `{PREFIX}-{NUMBER}`,
    // `git rebase -i` and `reword` in backticks too, and those are not
    // identifiers this repository carries.
    const [head] = failure.split(' — ');
    const ids = head.includes(' carries ') ? ours : foreign;
    for (const [, id] of head.matchAll(/`([^`]+)`/g)) ids.add(id);
  }

  return {
    surface: surfaces.size === 2 ? 'body+subject' : [...surfaces][0] ?? 'subject',
    ours: [...ours],
    foreign: [...foreign],
  };
}

export function runControl(control) {
  const findings = identifierFindings(scanCommit(control));
  if (findings.ours.length === 0) {
    console.error(
      `scan-report: POSITIVE CONTROL DEAD — the ${control.label} leg did not flag a commit that names ` +
      'PET-9001 outright. The gate was handed an input shape it does not read, so a zero-offender run ' +
      'below would mean "the leg never ran", not "the tree is clean". Not reporting.'
    );
    process.exit(2);
  }
  return findings.ours;
}

function readCommits(ref) {
  // \x1e is the record separator and \x1f the unit separator, so a commit message
  // containing either of the more common separators cannot split a record.
  const out = execFileSync('git', ['log', ref, '--format=%H%x1f%B%x1e'], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  return out
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim())
    .map((record) => {
      const at = record.indexOf('\x1f');
      return { sha: record.slice(0, at).trim(), message: record.slice(at + 1) };
    });
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const ref = args.find((a) => !a.startsWith('--')) ?? 'origin/master';

  const controlResults = CONTROLS.map((c) => [c.label, runControl(c)]);

  const commits = readCommits(ref);
  const offenders = [];
  for (const commit of commits) {
    const findings = identifierFindings(scanCommit(commit));
    if (findings.ours.length + findings.foreign.length === 0) continue;
    const subject = commit.message.split('\n')[0].trim();
    offenders.push({
      sha: commit.sha.slice(0, 9),
      fullSha: commit.sha,
      surface: findings.surface,
      identifiers: [...findings.ours, ...findings.foreign],
      subject,
    });
  }

  const ours = offenders.filter((o) => o.identifiers.some((id) => /^pet-?\d/i.test(id)));
  const foreign = offenders.filter((o) => !ours.includes(o));

  if (asJson) {
    console.log(
      JSON.stringify(
        { ref, scanned: commits.length, controls: controlResults, ours: ours.length, foreign: foreign.length, offenders },
        null,
        2
      )
    );
    return;
  }

  console.log(`positive control: LIVE (${controlResults.map(([l, ids]) => `${l}: ${ids.join(', ')}`).join('; ')})`);
  console.log(`# Landed-commit identifier findings on \`${ref}\``);
  console.log('');
  console.log(`Commits scanned: **${commits.length}**. Positive control: **live**.`);
  console.log('');
  console.log(
    `**${offenders.length} commits** carry an identifier finding. **${ours.length}** name this instance's own ` +
    `\`PET-\` namespace; **${foreign.length}** name a foreign namespace inherited from an upstream merge.`
  );
  console.log('');
  console.log('| sha | surface | identifiers | subject |');
  console.log('|---|---|---|---|');
  for (const o of offenders) {
    const subject = o.subject.replace(/\|/g, '\\|');
    const trimmed = subject.length > 80 ? `${subject.slice(0, 80)}…` : subject;
    console.log(`| \`${o.sha}\` | ${o.surface} | ${o.identifiers.map((i) => `\`${i}\``).join(', ')} | ${trimmed} |`);
  }
  console.log('');
  console.log('## Reproduce');
  console.log('');
  console.log('```');
  console.log('git fetch origin master');
  console.log('node .github/scripts/scan-report.mjs origin/master');
  console.log('```');
  console.log('');
  console.log(
    'The control runs first and the script exits 2 if either leg does not fire, so a clean-looking run ' +
    'cannot be a run where a leg never executed.'
  );
}

// Imported by `scan-report.test.mjs`, which needs the control and the finding
// reduction without paying for a full 4686-commit scan on every gate run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
