import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// `.github/scripts/check-pr-red-attribution.mjs` has been in the repository,
// tested and correct, with a test file beside it, since before this file existed.
// Nothing called it: the question it answers — is this red mine, or did I
// inherit it — was answered by hand on every pull request, by whichever reviewer
// happened to be awake, and the answer lived in a comment rather than on the
// commit. On 2026-09-27 `Cloud readiness` was red on one UI assertion for about
// fifty minutes and six pull requests inherited it through `verify`'s `needs:`
// with `if: always()`. This asserts the wiring exists, which is the part that was
// missing and the part that can be deleted by a later edit without any test
// noticing unless something here reads the workflow.
const workflow = readFileSync(new URL('../../workflows/pr-trusted.yml', import.meta.url), 'utf8');
// Sliced at `jobs:` first: the same indentation-anchored pattern also matches
// `workflow_call:` under `on:`, and a job that does not exist is not a lane.
const jobBlock = workflow.slice(workflow.search(/^jobs:\n/m));
const jobs = new Map(
  [...jobBlock.matchAll(/^  ([a-z_][a-z_0-9]*):\n([\s\S]*?)(?=^  [a-z_][a-z_0-9]*:\n|$(?![\s\S]))/gm)].map(
    ([, name, body]) => [name, body],
  ),
);

/**
 * The jobs that report a verdict of their own about the tests. The fan-ins are
 * excluded because they report no test of their own, and `gate` because it
 * reports the runner choice. `red_attribution` is excluded because it is the
 * job under test.
 */
const FAN_IN_JOBS = new Set(['verify', 'e2e', 'red_attribution']);

const needsOf = (body) => {
  const inline = /^ {4}needs:\s*\[([^\]]*)\]\s*$/m.exec(body)?.[1];
  if (inline !== undefined) {
    return inline.split(',').map(s => s.trim()).filter(Boolean);
  }
  const block = /^ {4}needs:\n((?: {6}- .*\n)+)/m.exec(body)?.[1] ?? '';
  return [...block.matchAll(/- (\S+)/g)].map(m => m[1]);
};

test('the attribution gate exists in the pull-request lane', () => {
  const body = jobs.get('red_attribution');
  assert.ok(body, 'pr-trusted.yml has no red_attribution job; the script is unwired again');
  // `if: always()` or the gate never runs on the one pull request it exists for:
  // a red lane fails its dependents unless they opt out of the failure.
  assert.match(body, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
});

test('the gate waits for every lane, so no verdict is read before it is reported', () => {
  const body = jobs.get('red_attribution');
  const needed = new Set(needsOf(body));

  const lanes = [...jobs.keys()].filter(name => !FAN_IN_JOBS.has(name));
  const missing = lanes.filter(name => !needed.has(name));
  assert.deepEqual(
    missing,
    [],
    `red_attribution must depend on every lane, or it reads a job that has not settled and ` +
    `calls its own evidence incomplete: add ${missing.join(', ')} to its needs`,
  );

  // `verify` is the tempting shortcut and it is wrong: its own needs list omits
  // the serialized-server, canary and e2e lanes, so a gate behind it would start
  // while those three were still running.
  const verifyNeeds = needsOf(jobs.get('verify'));
  assert.deepEqual(
    lanes.filter(name => !verifyNeeds.includes(name)),
    ['verify_serialized_server', 'canary_dry_run', 'e2e_shards'],
    'verify is expected to omit these three; if that changes this test needs re-reading',
  );
});

test('the gate is not inside the verify fan-in, so the two can disagree', () => {
  // `verify` goes red on an inherited red because the red is real. Folding the
  // gate into it would make both checks the same colour and destroy the only
  // signal this wiring produces: `verify` red, attribution green, on one commit.
  assert.ok(!needsOf(jobs.get('verify')).includes('red_attribution'));
  assert.ok(!needsOf(jobs.get('e2e')).includes('red_attribution'));
  assert.ok(!needsOf(jobs.get('red_attribution')).includes('verify'),
    'depending on verify is not a substitute for depending on the lanes verify omits');
});

test('the gate reads the lane it runs inside, and the base through the same tool', () => {
  const body = jobs.get('red_attribution');
  assert.match(body, /node \.github\/scripts\/check-pr-red-attribution\.mjs/);
  // HEAD_RUN_ID is what makes the tool read this run's jobs rather than every
  // workflow on the head. Without it a red review bot is read as a red test.
  assert.match(body, /HEAD_RUN_ID: \$\{\{ github\.run_id \}\}/);
  // Reading runs and pull requests needs those two; the workflow already grants
  // them, and this job must not be the reason that ever changes.
  assert.match(body, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(body, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(body, /PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/);
});

test('a report with no verdict is a failure, not a pass', () => {
  // The gate's own exit status is the tool's, but a crash or a changed output
  // shape has to fail here too. Reading an unreadable report as green is the
  // same defect one level up: a check that cannot say what it found must not be
  // readable as saying there is nothing to find.
  const body = jobs.get('red_attribution');
  assert.match(body, /if ! jq -e 'has\("passed"\)'/, 'a report with no passed field must exit non-zero');
  assert.match(body, /this is not a pass/);
});

test('the gate is the last job in the lane and costs one runner, not the fleet', () => {
  const body = jobs.get('red_attribution');
  // A handful of `gh` API reads. ubuntu-latest is the image the `gate` job
  // already relies on for the GitHub CLI, so this does not assume the fleet
  // image ships it.
  assert.match(body, /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(body, /^ {4}timeout-minutes: 10$/m);
  assert.doesNotMatch(body, /pnpm install/, 'a gate that installs dependencies is not a gate');
});
