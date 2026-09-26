import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const WORKFLOW = '.github/workflows/commitperclip-review.yml';

async function readWorkflow() {
  return readFile(WORKFLOW, 'utf8');
}

/**
 * Every step in the job, split on the `- name:` keys, with the step's own
 * `if:` condition and body text resolved. A step ends at the next line that is
 * indented no further than its `- name:`, which is where the next step — or
 * the end of the job — begins.
 */
function allSteps(contents) {
  const lines = contents.split('\n');
  const starts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s+- name: /.test(line))
    .map(({ line, index }) => ({ name: line.trim().slice('- name:'.length).trim(), index }));

  return starts.map((step, position) => {
    const indent = lines[step.index].search(/\S/);
    const end = starts[position + 1]?.index ?? lines.length;
    const body = lines.slice(step.index + 1, end);

    return {
      name: step.name,
      body: body.join('\n'),
      if: foldedScalar(body, indent, 'if:'),
    };
  });
}

/**
 * The value of a key inside a step, following a YAML folded scalar (`>-`)
 * whose continuation lines are indented past the key.
 */
function foldedScalar(body, stepIndent, key) {
  const keyIndex = body.findIndex((line) => new RegExp(`^${key}\\s`).test(line.trim()));
  if (keyIndex === -1) return '';

  const keyIndent = body[keyIndex].search(/\S/);
  if (keyIndent <= stepIndent) return '';

  const collected = [body[keyIndex].trim()];
  for (let i = keyIndex + 1; i < body.length; i += 1) {
    const lineIndent = body[i].search(/\S/);
    if (lineIndent === -1) continue;
    if (lineIndent <= keyIndent) break;
    collected.push(body[i].trim());
  }
  return collected.join(' ');
}

function stepByName(contents, name) {
  const step = allSteps(contents).find((candidate) => candidate.name === name);
  assert.ok(step, `workflow must contain a step named "${name}"`);
  // `body` is the step's text; `run` is the same text, named for readability
  // at the call sites that only care about the shell it runs.
  return { ...step, run: step.body };
}

/**
 * A step's `run:` block on its own, with the `if:`/`env:` keys above it
 * dropped. The literal indentation of the block scalar is preserved, which is
 * what lets the shell below be executed as written.
 */
function runBlock(step) {
  const lines = step.body.split('\n');
  const start = lines.findIndex((line) => /^\s*run:\s*\|/.test(line));
  assert.notEqual(start, -1, 'the step must carry a `run: |` block');

  const indent = lines[start].search(/\S/);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.search(/\S/) !== -1 && line.search(/\S/) <= indent);
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * The `conclusion`, `title` and `summary` a step would publish, computed by
 * running its verdict block under `bash` with `GATE_OUTCOME` bound to one
 * `steps.quality.outcome` value.
 *
 * The block is cut at `esac`, before the check-run lookup, so nothing here
 * touches the network or the API. Executing it rather than pattern-matching
 * the workflow text is the point: the defect this file exists to prevent lived
 * in a branch whose behaviour depended on which value GitHub puts in
 * `steps.quality.outcome`, and no regex over the YAML can tell whether the
 * shell treats that value correctly once it arrives.
 *
 * The step's own `set -euo pipefail` is kept, so a branch that forgets to set
 * one of the three variables fails here instead of publishing an empty title.
 */
function publishVerdict(step, gateOutcome) {
  const block = runBlock(step);
  const esac = /^\s*esac\s*$/m.exec(block);
  assert.ok(esac, 'the publish step must compute its verdict in a case statement ending in `esac`');

  const program = [
    block.slice(0, esac.index + esac[0].length),
    'printf \'%s\\n\' "conclusion=$conclusion" "title=$title" "summary=$summary"',
  ].join('\n');

  const result = spawnSync('bash', ['-c', program], {
    env: { ...process.env, GATE_OUTCOME: gateOutcome },
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `the verdict block must succeed for GATE_OUTCOME=${JSON.stringify(gateOutcome)}: ${result.stderr}`,
  );

  return Object.fromEntries(
    result.stdout
      .split('\n')
      .filter((line) => /^(conclusion|title|summary)=/.test(line))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

test('the review workflow can be re-run manually against an open pull request', async () => {
  const contents = await readWorkflow();

  assert.match(contents, /^\s{2}workflow_dispatch:/m, 'a manual re-gate trigger must exist');
  assert.match(contents, /^\s{6}pr_number:/m, 'the manual trigger must take a pull request number');
  assert.match(
    contents,
    /required:\s*true[\s\S]{0,200}?pr_number|pr_number[\s\S]{0,200}?required:\s*true/,
    'pr_number must be required, so a dispatch cannot start with no target',
  );
});

test('every steps.<id>.outputs reference resolves to a defined step and output', async () => {
  const contents = await readWorkflow();
  const steps = allSteps(contents);

  // An output only exists if the step writes it to $GITHUB_OUTPUT, so the
  // declared outputs are read back out of the step bodies rather than listed
  // here, which would just be a second copy to forget to update. Both idioms
  // this workflow uses to declare one are recognised: a literal `echo "k=…"`,
  // and a `jq -r '"k=…"'` that formats a value from the API response.
  const declaredOutput = /echo\s+"([\w-]+)=|jq\s+-r\s+'"([\w-]+)=/g;

  const idOf = (step) => /^\s+id:\s*(\S+)\s*$/m.exec(step.body)?.[1];
  const produced = new Map(
    steps
      .map((step) => [idOf(step), step])
      .filter(([id]) => id)
      .map(([id, step]) => [
        id,
        new Set([...step.body.matchAll(declaredOutput)].map((m) => m[1] ?? m[2])),
      ]),
  );
  assert.ok(produced.size > 0, 'the workflow must define at least one step id');

  const referenced = [
    ...contents.matchAll(/steps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)/g),
  ];
  assert.ok(referenced.length > 0, 'the workflow must consume at least one step output');

  for (const match of referenced) {
    const [, id, output] = match;
    const line = contents.slice(0, match.index).split('\n').length;
    const at = `steps.${id}.outputs.${output} (line ${line})`;

    assert.ok(produced.has(id), `${at} is read but no step defines id: ${id}`);
    assert.ok(
      produced.get(id).has(output),
      `${at} is read but the step with id "${id}" never writes that output to $GITHUB_OUTPUT`,
    );
  }
});

test('the pull request payload is read in exactly one place, the resolving step', async () => {
  const contents = await readWorkflow();

  // `github.event.pull_request.*` is empty on workflow_dispatch, so any read
  // outside the resolve step silently blanks a value the later steps need.
  // The resolve step is the single place allowed to read it, and only to
  // choose between the event payload and the dispatch input.
  const lines = contents.split('\n');
  const offenders = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes('github.event.pull_request'))
    .filter(({ line }) => !line.trimStart().startsWith('#'))
    .filter(({ line }) => !line.includes('inputs.pr_number'))
    .filter(({ line }) => !line.includes('rather than `github.event.pull_request'));

  assert.deepEqual(
    offenders.map(({ index }) => index + 1),
    [],
    'read github.event.pull_request outside the resolve step or in a comment',
  );
});

test('the resolve step fails closed on a bad or non-open pull request number', async () => {
  const { run } = stepByName(await readWorkflow(), 'Resolve pull request context');

  // Anything that is not a bare run of digits is rejected before it reaches
  // the API path, so it cannot be used to inject a second request.
  assert.match(run, /set -euo pipefail/, 'the step must fail on the first error');
  assert.match(
    run,
    /pr_number="\$\{REQUESTED_PR:-\}"/,
    'the requested number must be read into a local, not used inline',
  );
  assert.match(
    run,
    /\^?\[0-9\]\+\$|\^\[0-9\]\+\$/,
    'the number must be validated as digits only',
  );
  // The digits check alone would accept "0"; the range check is what rejects it.
  assert.match(
    run,
    /\[ "\$pr_number" -le 0 \]/,
    'a zero or negative number must be rejected, not just a non-numeric one',
  );
  assert.match(run, /exit 1/, 'a rejected number must fail the step');
  assert.match(
    run,
    /state"\s*!=\s*"open"/,
    'a merged or closed pull request must be rejected',
  );
});

test('the base and head refs come from the resolved step, not the event', async () => {
  const contents = await readWorkflow();
  const { run } = stepByName(contents, 'Dependency Review');

  assert.ok(
    run.includes('${{ steps.pr.outputs.base_sha }}'),
    'base-ref must use the resolved base SHA',
  );
  assert.ok(
    run.includes('${{ steps.pr.outputs.head_sha }}'),
    'head-ref must use the resolved head SHA',
  );
});

test('the quality gates read their pull request context from the resolved step', async () => {
  const { run } = stepByName(await readWorkflow(), 'Run quality gates');

  for (const output of ['number', 'author', 'head_ref']) {
    assert.ok(
      run.includes(`\${{ steps.pr.outputs.${output} }}`),
      `PR_${output} must come from the resolved step`,
    );
  }
  // run-quality-gates.mjs reads exactly these five, so each must be supplied.
  for (const variable of ['GH_TOKEN', 'GH_REPO', 'PR_NUMBER', 'PR_AUTHOR', 'PR_BRANCH']) {
    assert.match(run, new RegExp(`${variable}:\\s`), `${variable} must be set for the gates`);
  }
});

test('the manual verdict is published to the pull request head and survives a gate failure', async () => {
  const contents = await readWorkflow();
  const step = stepByName(contents, 'Publish verdict to the pull request head (manual runs only)');

  assert.match(step.if, /always\(\)/, 'the step must run even after the gate-failure step exits 1');
  assert.match(
    step.if,
    /github\.event_name\s*==\s*'workflow_dispatch'/,
    'the step must not touch automatic runs',
  );
  assert.match(
    step.run,
    /check-runs\?name=review/,
    'an existing check run must be looked up by name',
  );
  assert.match(
    step.run,
    /app\.slug\s*==\s*"github-actions"/,
    'only this repository\'s own check run may be updated',
  );
  assert.match(step.run, /--method PATCH/, 'an existing check run must be updated');
  assert.match(step.run, /--method POST/, 'a missing check run must be created');
  assert.match(
    step.run,
    /head_sha/,
    'a created check run must be attached to the pull request head',
  );
});

test('a re-gate that dies before the gates still records a failure verdict', async () => {
  const contents = await readWorkflow();
  const step = stepByName(contents, 'Publish verdict to the pull request head (manual runs only)');

  // The step must not be gated on whether the gates produced a verdict.
  // `Run quality gates` carries an `if:` with no status function, so GitHub
  // evaluates it as `success() && …`, and a failure at `Dependency Review`,
  // `Set up Node`, or the token step therefore leaves `steps.quality.outcome`
  // at `skipped`. A guard on that value skips the publish step on precisely
  // those runs, so the re-gate writes no verdict and the pull request keeps
  // the superseded one — the defect the `workflow_dispatch` trigger exists to
  // remove, reintroduced inside the step that removes it.
  assert.doesNotMatch(
    step.if,
    /steps\.quality\./,
    'the publish step must not be skipped based on steps.quality.outcome',
  );

  // What may still gate it: the resolve step's outputs, and nothing else. The
  // resolve step runs before every pre-gate step, so it cannot be the guard
  // that swallows a verdict, and the three pre-gate steps cannot be either
  // because they are never named in the condition.
  const gatedOn = [...step.if.matchAll(/steps\.([A-Za-z_][\w-]*)\./g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(gatedOn)],
    ['pr'],
    'the publish step must only be gated on steps.pr.outputs, never on a step that can be skipped',
  );
  // `head_sha` is written by the resolve step; without it there is no commit
  // to attach a verdict to.
  assert.match(step.if, /steps\.pr\.outputs\.head_sha\s*!=\s*''/, 'an unresolved head SHA must skip the publish step');

  const passed = publishVerdict(step, 'success');
  const failed = publishVerdict(step, 'failure');
  const skipped = publishVerdict(step, 'skipped');

  assert.equal(passed.conclusion, 'success', 'a completed pass must publish success');
  assert.equal(failed.conclusion, 'failure', 'gates that ran and failed must publish failure');
  assert.equal(skipped.conclusion, 'failure', 'a run that never reached the gates must not publish success');
  assert.match(
    skipped.title,
    /did not reach/i,
    'the did-not-reach-the-gates verdict must say so in its title',
  );
  // The gate script never ran on this path, so no commitperclip comment
  // exists. Pointing a reviewer at it would send them after a comment that
  // was never written.
  assert.doesNotMatch(
    skipped.summary,
    /commitperclip comment/,
    'the did-not-reach-the-gates summary must not point at a comment that was never written',
  );
  assert.match(passed.summary, /commitperclip comment/, 'a completed pass may point at the gate comment');

  // Fail closed. Only an explicit completed pass may ever render green, so a
  // cancelled run or an outcome value this workflow does not produce still
  // records the head commit as unproven.
  for (const outcome of ['', 'cancelled', 'success ', 'SUCCESS']) {
    assert.equal(
      publishVerdict(step, outcome).conclusion,
      'failure',
      `GATE_OUTCOME=${JSON.stringify(outcome)} must not publish a pass`,
    );
  }
});

test('the dependency review gate is still present and still gating', async () => {
  const { run, if: condition } = stepByName(await readWorkflow(), 'Dependency Review');

  assert.ok(
    run.includes('actions/dependency-review-action'),
    'the dependency review action must stay in the job',
  );
  assert.ok(
    !/continue-on-error:\s*true/.test(run),
    'the dependency review gate must not be demoted to advisory',
  );
  assert.doesNotMatch(
    condition,
    /continue-on-error|always\(\)/,
    'the dependency review gate must not be conditioned away',
  );
});

test('the token step keeps its fall back to the workflow token', async () => {
  const { run } = stepByName(await readWorkflow(), 'Generate commitperclip token');

  assert.match(run, /COMMITPERCLIP_KEY:-/, 'the key must be read as optional');
  assert.match(run, /TOKEN="\$\{GITHUB_TOKEN\}"/, 'the GITHUB_TOKEN fall back must remain');
  assert.match(run, /add-mask/, 'the token must stay masked');
});
