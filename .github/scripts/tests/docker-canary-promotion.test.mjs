import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(new URL("../../workflows/docker.yml", import.meta.url), "utf8");
const job = workflow.split("  promote_canary_channel:\n")[1];

// Anchored to the step's name, not to "the first `run: |` block in the job".
// This job gained a resolver step ahead of the promotion, and a positional
// split silently retargeted the extraction: the fixture ran the resolver
// instead of the promotion and every assertion below became vacuous. A wrong
// script must fail the test, never pass it.
function stepBody(jobText, name) {
  const step = jobText.split(`      - name: ${name}\n`)[1];
  assert.ok(step, `docker.yml has no promote_canary_channel step named "${name}"`);
  const body = step.split("        run: |\n")[1];
  assert.ok(body, `step "${name}" has no literal run block`);
  return body.split("\n").map(line => line.replace(/^ {10}/, "")).join("\n");
}

const script = stepBody(job, "Converge the channel tags onto the current npm canary");
const sha = "a".repeat(40);

// Identity of the promotion, not a restatement of its behaviour: the npm
// dist-tags lookup is what makes this the promotion step, and the three
// fixture tests below are what judge the behaviour. Asserting the behaviour
// here instead would make this guard fire on behaviour regressions and
// blur which failure is the real one.
test("the promotion script under test is the promotion, not a neighbouring step", () => {
  assert.match(script, /registry\.npmjs\.org\/-\/package\/@paperclipai%2Fdb\/dist-tags/);
  assert.doesNotMatch(script, /resolve-image-ref/);
});

test("canary promotion waits for the standard manifest and keeps its serialized channel", () => {
  assert.match(job, /needs: \[merge-and-push\]/);
  assert.match(job, /group: docker-canary-channel-promotion/);
  assert.match(job, /cancel-in-progress: false/);
});

test("canary promotion retags the resolved lowercase reference, not github.repository", () => {
  const promotion = job.split("      - name: Converge the channel tags onto the current npm canary\n")[1];
  assert.match(promotion, /IMAGE: \$\{\{ steps\.ref\.outputs\.image \}\}/);
  assert.doesNotMatch(promotion, /IMAGE: ghcr\.io\/\$\{\{ github\.repository \}\}/);
  // The resolver is the single definition of the casing rule, so this job has
  // to actually invoke it rather than lowercase inline a second time.
  assert.match(job, /node scripts\/resolve-image-ref\.mjs "\$REPOSITORY"/);
});

for (const [name, commitPresent, imagePresent] of [
  ["promotes the current npm canary without a cloud image", true, true],
  ["waits when the standard image is missing", true, false],
  ["waits when the npm canary tag has not resolved", false, false],
]) {
  test(name, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "standard-canary-promotion-"));
    const log = path.join(dir, "calls.jsonl");
    const fixture = `#!${process.execPath}
const fs = require("node:fs");
const command = require("node:path").basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({ command, args }) + "\\n");
if (command === "curl") process.stdout.write(JSON.stringify({ canary: "2026.922.0-canary.1" }));
else if (command === "gh") { if (process.env.COMMIT_PRESENT !== "true") process.exit(1); process.stdout.write(process.env.TEST_SHA); }
else if (args.slice(0, 3).join(" ") === "buildx imagetools inspect") process.exit(process.env.IMAGE_PRESENT === "true" ? 0 : 1);
else if (args.slice(0, 3).join(" ") !== "buildx imagetools create") process.exit(99);
`;
    try {
      for (const command of ["curl", "gh", "docker"]) writeFileSync(path.join(dir, command), fixture, { mode: 0o755 });
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
        encoding: "utf8", env: {
          ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`,
          IMAGE: "ghcr.io/paperclipai/paperclip", GITHUB_REPOSITORY: "paperclipai/paperclip",
          TEST_CALLS: log, TEST_SHA: sha, COMMIT_PRESENT: String(commitPresent), IMAGE_PRESENT: String(imagePresent),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.ok(calls.find(call => call.command === "gh").args.some(arg => arg.includes("canary%2Fv2026.922.0-canary.1")));
      const docker = calls.filter(call => call.command === "docker").map(call => call.args);
      assert.deepEqual(docker, [
        ...(commitPresent ? [["buildx", "imagetools", "inspect", "ghcr.io/paperclipai/paperclip:sha-aaaaaaa"]] : []),
        ...(commitPresent && imagePresent ? [["buildx", "imagetools", "create", "-t", "ghcr.io/paperclipai/paperclip:canary", "ghcr.io/paperclipai/paperclip:sha-aaaaaaa"]] : []),
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
