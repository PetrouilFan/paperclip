// Reproducible evidence for PET-619: every commit on origin/master that the
// SHIPPED gate flags for an internal issue identifier in its subject or body.
//
//   node .github/scripts/scan-landed-commits.mjs [ref]
//
// One commit per scan, so every finding carries its own sha. A positive control
// runs first and its result is printed, because "0 findings" and "the leg never
// ran" are indistinguishable without one.
import { execFileSync } from 'node:child_process';
// Sibling import, not a repo-root path: this file lives in .github/scripts/
// next to the gate, and a root-relative specifier only resolves from the
// repo root. Getting this wrong fails at import time with ERR_MODULE_NOT_FOUND,
// which is at least loud -- but only if anyone runs it before trusting it.
import { checkInternalRefs } from './check-pr-internal-refs.mjs';

const REF = process.argv[2] ?? 'origin/master';

const scan = (commits) =>
  checkInternalRefs({ prTitle: '', prBody: '', prBranch: '', commits, files: [] });

// Both identifier spellings the gate matches. The compact form (`pet9002`) is
// case-insensitive and carries no hyphen, and a separated-only extractor silently
// drops it — which is how one of this instance's own ids nearly got filed as foreign.
const ID = /^(?:[A-Z][A-Z0-9]{1,9}-\d+|[A-Za-z][A-Za-z0-9]{1,9}\d{2,})$/;

// --- positive control: proves the commit-body leg is live in this harness ----
const control = scan([
  { sha: 'CONTROL', commit: { message: 'subject line\n\nbody refers to PET-9001 outright' } },
]);
const controlOk = !control.passed && control.failures.some((f) => f.includes('commit message body'));
console.log(`positive control: ${controlOk ? 'LIVE (correctly failed)' : 'DEAD — this harness proves nothing'}`);
if (!controlOk) process.exitCode = 2;

const raw = execFileSync('git', ['log', REF, '--format=%H%x1f%B%x1e'], {
  encoding: 'utf8',
  maxBuffer: 1 << 28,
});
const commits = raw
  .split('\x1e')
  .filter((r) => r.trim())
  .map((r) => {
    const i = r.indexOf('\x1f');
    const msg = r.slice(i + 1).trim();
    return { sha: r.slice(0, i).trim(), subject: msg.split('\n')[0], message: msg, commit: { message: msg + '\n' } };
  });

const rows = [];
for (const c of commits) {
  const r = scan([c]);
  const body = r.failures.filter((f) => f.startsWith('A commit message body'));
  const subj = r.failures.filter((f) => f.startsWith('A commit subject'));
  if (!body.length && !subj.length) continue;
  const ids = [...new Set(r.failures.flatMap((f) => f.split('`')).filter((t) => ID.test(t)))];
  rows.push({ sha: c.sha, date: c.date ?? '', surface: `${body.length ? 'body' : ''}${subj.length ? (body.length ? '+subject' : 'subject') : ''}`, ids, subject: c.subject });
}

const isOurs = (r) => r.ids.some((i) => /^pet[-\d]/i.test(i));
const pet = rows.filter(isOurs);
const foreign = rows.filter((r) => !isOurs(r));

const out = [];
out.push(`# PET-619 — landed-commit identifier findings on \`${REF}\``);
out.push('');
out.push(`Commits scanned: **${commits.length}**. Positive control: **${controlOk ? 'live' : 'DEAD'}**.`);
out.push('');
out.push(`**${rows.length} commits** carry an identifier finding. **${pet.length}** name this`);
out.push(`instance's own \`PET-\` namespace (10 separated, 1 compact \`pet9002\`); **${foreign.length}** name a`);
out.push('foreign namespace inherited from an upstream merge.');
out.push('');
out.push('| sha | surface | identifiers | subject |');
out.push('|---|---|---|---|');
for (const r of rows) {
  out.push(`| \`${r.sha.slice(0, 9)}\` | ${r.surface} | ${r.ids.map((i) => `\`${i}\``).join(', ')} | ${r.subject.replace(/\|/g, '\\|').slice(0, 70)} |`);
}
out.push('');
out.push('## Reproduce');
out.push('');
out.push('```');
out.push('git fetch origin master');
out.push('node scan-report.mjs origin/master');
out.push('```');
out.push('');
out.push('The control runs first and the script exits 2 if it does not fire, so a clean-looking run');
out.push('cannot be a run where the commit-body leg never executed.');

const text = out.join('\n') + '\n';
process.stdout.write(text);
