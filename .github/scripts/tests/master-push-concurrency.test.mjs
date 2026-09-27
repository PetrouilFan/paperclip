import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

// Every workflow that runs on `push` to master competes for the same
// GitHub-hosted runner pool as the pull-request workflows. A concurrency group
// keyed on `github.sha` gives each push its own group, so a group declared with
// `cancel-in-progress: false` never has an earlier run to serialise against and
// nothing is ever superseded. The result is one uncancellable fan-out left
// behind per merge, which is how 46 master pushes queued 491 jobs on a fork and
// pushed pull-request CI queue latency past 20 minutes per job.
//
// Ref-keyed groups (`github.ref`) are the fix: they stay one lane deep while
// still keeping each workflow outside the others' queues, because the group name
// prefix differs per workflow.
test('master-push workflows do not key concurrency on a per-push value', async () => {
  const dir = new URL('../../workflows/', import.meta.url);
  const entries = await readdir(dir);

  const offenders = [];
  for (const entry of entries) {
    if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;

    const contents = await readFile(new URL(entry, dir), 'utf8');
    if (!/^on:\s*$/m.test(contents) || !/^\s{2}push:\s*$/m.test(contents)) continue;
    if (!/^\s{4}branches:\s*\[?.*\bmaster\b/m.test(contents)) continue;

    const block = /^concurrency:\n((?:[ \t]+.*\n?)*)/m.exec(contents)?.[1];
    if (!block) continue;

    const group = /^\s*group:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? '';
    const cancel = /^\s*cancel-in-progress:\s*(\S+)$/m.exec(block)?.[1] ?? 'false';

    // A group keyed on something that is unique per push can never serialise.
    // Pairing it with cancel-in-progress: true is fine: that combination cancels
    // the superseded run. Only the false pairing is the accumulating defect.
    const perPush = /github\.(sha|head_ref)\b/.test(group);
    if (perPush && cancel === 'false') {
      offenders.push(`${entry}: group ${group} with cancel-in-progress: false`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `key a non-cancelling concurrency group on github.ref, not a per-push value:\n${offenders.join('\n')}`,
  );
});

test('the workflows fixed for master-push pile-up stay fixed', async () => {
  const expected = {
    '.github/workflows/cloud-readiness.yml': 'cloud-readiness-${{ github.ref }}',
    '.github/workflows/cloud-migrator-artifacts.yml': 'cloud-migrator-artifacts-${{ github.ref }}',
  };

  for (const [workflow, group] of Object.entries(expected)) {
    const contents = await readFile(workflow, 'utf8');
    assert.ok(
      contents.includes(`group: ${group}`),
      `${workflow} must key its concurrency group on github.ref`,
    );
  }
});
