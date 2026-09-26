import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `github.repository` is `owner/repo` verbatim and an owner login may contain
// uppercase letters, but an OCI reference must be lowercase. docker.yml built
// its references from the raw value, so on a fork owned by a mixed-case login
// buildx refused to start:
//
//   failed to configure registry cache exporter: invalid reference format:
//   repository name (PetrouilFan/paperclip) must be lowercase
//
// buildx validates while it *configures* the cache exporter, which is before
// the first layer is built, so every architecture failed and the run named a
// cache problem rather than a naming one.
//
// These tests live in the `cli` vitest project rather than beside the other
// workflow assertions in `scripts/__tests__` on purpose: the `scripts/`
// node:test files only run under `pnpm test:release-registry`, while this
// fork's `ci` job delegates to `paperclipai/paperclip`'s own
// `pr-trusted.yml@master` and never runs them. A gate the fork does not
// execute is not a gate on the fork.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const resolver = path.join(repoRoot, "scripts/resolve-image-ref.mjs");
const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");

// Run the script the way docker.yml runs it — as a command, not an import —
// so the contract under test is the one the workflow depends on.
function resolve(repository?: string) {
  const result = spawnSync(process.execPath, [resolver, repository].filter((value) => value !== undefined), {
    encoding: "utf8",
    env: { ...process.env, GITHUB_REPOSITORY: repository ?? "" },
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function jobBodies(): Map<string, string> {
  // Bounded to the `jobs:` block: the same two-space pattern matches the
  // `on:` trigger keys above it, and those are not jobs.
  const jobsIndex = workflow.search(/^jobs:$/m);
  expect(jobsIndex, "docker.yml must declare jobs").toBeGreaterThan(-1);
  const section = workflow.slice(jobsIndex);
  const bodies = new Map<string, string>();
  const boundaries = [...section.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)];
  boundaries.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = boundaries[index + 1]?.index ?? section.length;
    bodies.set(match[1] as string, section.slice(start, end));
  });
  return bodies;
}

describe("resolve-image-ref", () => {
  it("lowercases a mixed-case owner login", () => {
    expect(resolve("PetrouilFan/paperclip").stdout).toBe("ghcr.io/petrouilfan/paperclip");
  });

  it("leaves an already-lowercase repository untouched", () => {
    expect(resolve("paperclipai/paperclip").stdout).toBe("ghcr.io/paperclipai/paperclip");
  });

  it("is stable under repeated resolution, so every job agrees on the reference", () => {
    expect(resolve("petrouilfan/paperclip").stdout).toBe(resolve("PetrouilFan/paperclip").stdout);
  });

  it("fails loudly rather than emitting an invalid reference", () => {
    for (const invalid of ["", "   ", "paperclip", "a/b/c"]) {
      const result = resolve(invalid);
      expect(result.status, `"${invalid}" must not resolve`).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/owner\/repo|required/);
    }
  });
});

describe("docker.yml image references", () => {
  // The whole class of bug is one site keeping the raw value while its
  // neighbours were corrected: a single mixed-case reference fails the build
  // no matter how many others are right. So assert on the absence of the raw
  // expression everywhere, not on the presence of the fix at some sites.
  it("never builds a reference from the raw github.repository", () => {
    expect(workflow).not.toMatch(/ghcr\.io\/\$\{\{\s*github\.repository\s*\}\}/);
  });

  it.each([...jobBodies().keys()])("resolves the reference once in %s", (job) => {
    const body = jobBodies().get(job) as string;
    const resolutions = body.match(/node scripts\/resolve-image-ref\.mjs "\$REPOSITORY"/g) ?? [];
    expect(resolutions, `${job} must resolve the reference through the shared script`).toHaveLength(1);
    expect(body).toMatch(/- name: Resolve image reference\n {8}id: ref\n/);
  });

  it("resolves the reference in every job that names an image", () => {
    for (const [name, body] of jobBodies()) {
      const namesAnImage = /steps\.ref\.outputs\.image|steps\.meta\.outputs\.tags/.test(body);
      expect(namesAnImage && !/- name: Resolve image reference/.test(body)).toBe(false);
    }
  });
});
