#!/usr/bin/env node

// The OCI reference this repository publishes to, derived from
// `github.repository`.
//
// `github.repository` is `owner/repo` verbatim, and an owner login may
// contain uppercase letters. OCI references must be lowercase, so a
// mixed-case value produces a reference that buildx and the registry
// client both reject:
//
//   failed to configure registry cache exporter: invalid reference
//   format: repository name (PetrouilFan/paperclip) must be lowercase
//
// buildx validates the reference when it *configures* the cache exporter,
// which is before the first layer is built, so the failure names the
// cache exporter and looks like a cache problem rather than a naming one.
//
// The value is resolved once here and consumed everywhere a reference is
// needed. Lowercasing at each use site is what let this survive a partial
// fix: one ref was corrected while the push target beside it kept the raw
// value, and any single mixed-case reference still fails the whole build.

import process from "node:process";

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;

export function resolveImageRef(repository = GITHUB_REPOSITORY) {
  if (typeof repository !== "string" || repository.trim() === "") {
    throw new Error(
      "resolve-image-ref: a repository is required (pass owner/repo, or set GITHUB_REPOSITORY)",
    );
  }

  const trimmed = repository.trim();
  if (trimmed.split("/").length !== 2) {
    throw new Error(
      `resolve-image-ref: expected an owner/repo pair, received "${trimmed}"`,
    );
  }

  return `ghcr.io/${trimmed.toLowerCase()}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    // The argument wins over the ambient variable: docker.yml passes the
    // repository as an argument, so reading only the environment would make
    // that call resolve nothing and fail.
    process.stdout.write(`${resolveImageRef(process.argv[2] ?? GITHUB_REPOSITORY)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
