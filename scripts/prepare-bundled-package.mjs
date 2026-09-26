#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

// A `workspace:` specifier names a sibling package, so the version that satisfies it is
// the *dependency's* version -- never the depending package's own `version`. They are
// only equal when every shipping package is stamped in lockstep, which is what
// scripts/release.sh does, so the two call paths agreed until `install --ref` began
// packaging a fresh checkout of the source tree, where nothing has been stamped:
// @paperclipai/plugin-sdk is 1.0.0 there while @paperclipai/server is 0.3.1, so
// rewriting against pkg.version produced `@paperclipai/plugin-sdk@0.3.1` -- a version
// that exists neither in the payload tarballs nor on the registry, which npm reports as
// `ETARGET No matching version found`.
//
// `resolveWorkspaceVersion` returns the dependency's real version, or undefined when the
// name is not a workspace package of this repository. Omitting it keeps the historical
// pkg.version behaviour for callers that pin a version deliberately
// (scripts/preview-artifacts.mjs) and for a tree that really is in lockstep.
export function materializePublishManifest(pkg, { resolveWorkspaceVersion } = {}) {
  const publishConfig = pkg.publishConfig ?? {};
  const publishManifest = { ...pkg };

  for (const key of ["main", "types", "exports", "bin"]) {
    if (publishConfig[key] !== undefined) publishManifest[key] = publishConfig[key];
  }

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!publishManifest[section]) continue;
    publishManifest[section] = Object.fromEntries(
      Object.entries(publishManifest[section]).map(([name, specifier]) => {
        if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) return [name, specifier];
        const range = specifier.slice("workspace:".length);
        const prefix = range === "^" || range === "~" ? range : "";
        const resolved = resolveWorkspaceVersion?.(name);
        if (resolved === undefined) {
          // No resolver, or not a package of this repository. In lockstep that is the
          // dependent's version; unstamped it would silently name a version that does
          // not exist, so say which package is unresolvable rather than packing it.
          if (resolveWorkspaceVersion) {
            throw new Error(
              `${pkg.name} declares "${name}": "${specifier}", but ${name} is not a package of this ` +
                `workspace (see scripts/release-package-manifest.json). A workspace specifier cannot be ` +
                `rewritten to a publishable version without knowing the dependency's own version.`,
            );
          }
          return [name, `${prefix}${pkg.version}`];
        }
        return [name, `${prefix}${resolved}`];
      }),
    );
  }

  delete publishManifest.publishConfig;
  return publishManifest;
}

// The real version of every workspace package, read from the checkout rather than
// assumed. scripts/release-package-manifest.json is already the authoritative list of
// shipping packages (cli/src/commands/install.ts resolves the git-install payload from
// it), so it is the one place that already has to stay in sync with what ships.
export function readWorkspacePackageVersions(sourceRoot = repoRoot) {
  const manifestPath = resolve(sourceRoot, "scripts", "release-package-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const versions = new Map();
  for (const entry of manifest) {
    const packageJsonPath = resolve(sourceRoot, entry.dir, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof packageJson.version !== "string" || packageJson.version.length === 0) continue;
    versions.set(entry.name, packageJson.version);
  }
  return versions;
}

export function createBundledInstallManifest(publishManifest, bundledDependencies) {
  const bundledDependencyNames = new Set(bundledDependencies);
  const installManifest = structuredClone(publishManifest);

  delete installManifest.devDependencies;

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!installManifest[section]) continue;
    installManifest[section] = Object.fromEntries(
      Object.entries(installManifest[section]).filter(([name]) => bundledDependencyNames.has(name)),
    );
    if (Object.keys(installManifest[section]).length === 0) delete installManifest[section];
  }

  return installManifest;
}

function patchedDependencyPackageName(specifier) {
  const versionSeparator = specifier.lastIndexOf("@");
  const packageNameEnd = specifier.startsWith("@") ? specifier.indexOf("/") : 0;
  if (packageNameEnd < 0) return specifier;
  return versionSeparator > packageNameEnd ? specifier.slice(0, versionSeparator) : specifier;
}

export function selectBundledDependencyPatches(
  destinationDir,
  bundledDependencies,
  patchedDependencies,
) {
  const patchesByPackageName = new Map();
  for (const [specifier, patchPath] of Object.entries(patchedDependencies)) {
    const packageName = patchedDependencyPackageName(specifier);
    const packagePatches = patchesByPackageName.get(packageName) ?? new Map();
    packagePatches.set(specifier, patchPath);
    patchesByPackageName.set(packageName, packagePatches);
  }

  const selectedPatches = [];
  for (const packageName of new Set(bundledDependencies)) {
    const packagePatches = patchesByPackageName.get(packageName);
    if (!packagePatches) continue;

    const installedManifestPath = resolve(
      destinationDir,
      "node_modules",
      packageName,
      "package.json",
    );
    let installedManifest;
    try {
      installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    } catch (cause) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: failed to read ${installedManifestPath}`,
        { cause },
      );
    }

    if (
      installedManifest.name !== packageName ||
      typeof installedManifest.version !== "string" ||
      installedManifest.version.length === 0
    ) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed package manifest must declare the expected name and a version`,
      );
    }

    const installedSpecifier = `${packageName}@${installedManifest.version}`;
    const patchPath = packagePatches.get(installedSpecifier);
    if (patchPath === undefined) {
      const configuredSpecifiers = [...packagePatches.keys()].sort().join(", ");
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed ${installedSpecifier}, but configured patches are ${configuredSpecifiers}`,
      );
    }
    if (typeof patchPath !== "string" || patchPath.length === 0) {
      throw new Error(`Patch path for ${installedSpecifier} must be a non-empty string`);
    }
    selectedPatches.push({ packageName, specifier: installedSpecifier, patchPath });
  }

  return selectedPatches;
}

export function applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot = repoRoot) {
  const rootPackage = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
  const patchedDependencies = rootPackage.pnpm?.patchedDependencies ?? {};

  for (const { packageName, patchPath } of selectBundledDependencyPatches(
    destinationDir,
    bundledDependencies,
    patchedDependencies,
  )) {
    execFileSync(
      "patch",
      ["-p1", "--forward", "-d", resolve(destinationDir, "node_modules", packageName)],
      {
        input: readFileSync(resolve(sourceRoot, patchPath)),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
  }
}

export function prepareBundledPackage(sourceDir, destinationDir, { sourceRoot = repoRoot } = {}) {
  const sourcePackagePath = resolve(sourceDir, "package.json");
  const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, "utf8"));
  const bundledDependencies = sourcePackage.bundleDependencies ?? sourcePackage.bundledDependencies ?? [];

  if (bundledDependencies.length === 0) {
    throw new Error(`${sourcePackage.name} does not declare bundled dependencies`);
  }

  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of sourcePackage.files ?? []) {
    const sourcePath = resolve(sourceDir, entry);
    // Every entry in `files` is a build output, not a checked-in file, so a missing one
    // means a build step was skipped rather than that the source is incomplete. cpSync
    // reports that as a bare ENOENT with a lstat frame, which reads as a corrupt
    // checkout; name the entry and the step that produces it instead.
    if (!existsSync(sourcePath)) {
      throw new Error(
        `${sourcePackage.name} declares "${entry}" in files but ${sourcePath} does not exist. ` +
          `It is a build output: run the build that produces it (for ui-dist, ` +
          `scripts/prepare-server-ui-dist.sh) before packaging.`,
      );
    }
    cpSync(sourcePath, resolve(destinationDir, entry), { recursive: true });
  }
  for (const entry of ["README.md", "LICENSE", "LICENSE.md"]) {
    const sourcePath = resolve(sourceDir, entry);
    if (existsSync(sourcePath)) cpSync(sourcePath, resolve(destinationDir, entry));
  }

  const deployedPackagePath = resolve(destinationDir, "package.json");
  const workspaceVersions = readWorkspacePackageVersions(sourceRoot);
  const publishManifest = materializePublishManifest(sourcePackage, {
    resolveWorkspaceVersion: (name) => workspaceVersions.get(name),
  });
  const installManifest = createBundledInstallManifest(publishManifest, bundledDependencies);
  writeFileSync(deployedPackagePath, `${JSON.stringify(installManifest, null, 2)}\n`);

  execFileSync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: destinationDir, stdio: "inherit" },
  );
  writeFileSync(deployedPackagePath, `${JSON.stringify(publishManifest, null, 2)}\n`);
  applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot);

  if (bundledDependencies.includes("acpx")) {
    const acpxPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/acpx/package.json"), "utf8"),
    );
    const expectedPatchMarker = {
      "0.12.0": "onAgentStderr",
      "0.13.1": "spawnEnvironment",
    }[acpxPackage.version];
    const acpxRuntime = readFileSync(
      resolve(destinationDir, "node_modules/acpx/dist/runtime.js"),
      "utf8",
    );
    if (!expectedPatchMarker || !acpxRuntime.includes(expectedPatchMarker)) {
      throw new Error(
        `staged acpx@${acpxPackage.version} runtime is missing the repository patch`,
      );
    }
  }

  if (bundledDependencies.includes("embedded-postgres")) {
    const embeddedPostgresSource = readFileSync(
      resolve(destinationDir, "node_modules/embedded-postgres/dist/index.js"),
      "utf8",
    );
    if (
      !embeddedPostgresSource.includes("const LC_MESSAGES_LOCALE = 'C';") ||
      !embeddedPostgresSource.includes("globalThis.process.env")
    ) {
      throw new Error("staged embedded-postgres runtime is missing the repository patch");
    }

    const embeddedPostgresPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/embedded-postgres/package.json"), "utf8"),
    );
    const stagedPackage = JSON.parse(readFileSync(deployedPackagePath, "utf8"));
    stagedPackage.optionalDependencies = {
      ...(stagedPackage.optionalDependencies ?? {}),
      ...(embeddedPostgresPackage.optionalDependencies ?? {}),
    };
    writeFileSync(deployedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);
    rmSync(resolve(destinationDir, "node_modules/@embedded-postgres"), { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceDir, destinationDir] = process.argv.slice(2);
  if (!sourceDir || !destinationDir) {
    console.error("Usage: prepare-bundled-package.mjs <source-dir> <destination-dir>");
    process.exit(1);
  }
  prepareBundledPackage(resolve(sourceDir), resolve(destinationDir));
}
