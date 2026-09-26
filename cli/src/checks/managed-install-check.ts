import fs from "node:fs";
import path from "node:path";
import {
  MANAGED_SHIM_MARKER,
  readInstallManifest,
  resolveInstallStorePaths,
  type InstallStorePaths,
} from "../install-store.js";
import type { CheckResult } from "./index.js";
import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from "@paperclipai/shared/node-version";

function pathContains(directory: string): boolean {
  const normalized = path.resolve(directory);
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === normalized);
}

function hasStoreArtifacts(paths: InstallStorePaths): boolean {
  const inStore = [paths.manifestPath, paths.markerPath, paths.currentPath].some((entry) =>
    fs.existsSync(entry),
  );
  if (inStore) return true;
  try {
    return fs.readdirSync(paths.installsRoot).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

/** The shim a reader would actually invoke: the current path, else the one a
 *  previous install location left behind.
 *
 *  A file at either path is only a witness if it carries the managed marker.
 *  `npm install -g` puts its own command at `$HOME/.local/bin/paperclipai`, and
 *  that command `exec`s into npm's tree, never into a Paperclip store -- so its
 *  presence says nothing about whether a store exists, and treating it as one
 *  blocks the startup of a perfectly healthy global-npm install. That was
 *  measured taking `paperclipai.service` down for 3m31s via start-limit-hit while
 *  6 in-flight runs were reaped. `removeManagedShim` already gates on the same
 *  marker so it never deletes a foreign command; this keeps the doctor and the
 *  uninstaller in agreement about what is at that path. */
function findManagedShim(paths: InstallStorePaths): string | null {
  for (const candidate of new Set([paths.shimPath, paths.legacyShimPath])) {
    try {
      if (fs.readFileSync(candidate, "utf8").includes(MANAGED_SHIM_MARKER)) return candidate;
    } catch {
      // Missing, unreadable, or a directory: try the next location.
    }
  }
  return null;
}

function hasManagedArtifacts(paths: InstallStorePaths): boolean {
  return hasStoreArtifacts(paths) || findManagedShim(paths) !== null;
}

export function nodeRuntimeCheck(): CheckResult {
  return isSupportedNodeVersion(process.versions.node)
    ? { name: "Node.js runtime", status: "pass", message: `Node.js ${process.versions.node}` }
    : {
        name: "Node.js runtime",
        status: "fail",
        message: `Node.js ${process.versions.node} is unsupported`,
        repairHint: `Install Node.js ${MINIMUM_NODE_VERSION} or newer before installing or running Paperclip`,
      };
}

export function managedInstallChecks(
  paths = resolveInstallStorePaths(),
): CheckResult[] {
  if (!hasManagedArtifacts(paths)) {
    return [
      {
        name: "Managed install",
        status: "pass",
        message: "Not present (optional for npx, global npm, and source-checkout usage)",
      },
    ];
  }

  let manifest;
  try {
    manifest = readInstallManifest(paths);
  } catch (error) {
    return [
      {
        name: "Managed install manifest",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
        repairHint: "Re-run `paperclipai install` to rebuild the managed install metadata",
      },
    ];
  }

  if (!manifest) {
    // The store is empty but something still claims to be a managed install.
    // The overwhelmingly common cause is a relocated root: the shim survives at
    // the old location and still `exec`s into a store that is not there, while
    // the manifest is looked for under the new one. Saying "artifacts exist"
    // without naming the witness, and then prescribing `install`, is what made
    // this self-contradictory -- `install` writes the manifest under the root it
    // was just pointed at and leaves the shim where it was, so the operator loops
    // forever against a hint that cannot converge.
    const orphanShim = !hasStoreArtifacts(paths) ? findManagedShim(paths) : null;
    if (orphanShim) {
      return [
        {
          name: "Managed install manifest",
          status: "fail",
          message:
            `The command at ${orphanShim} is a Paperclip shim, but the install store it points into is `
            + `empty: no manifest at ${paths.manifestPath} under ${paths.paperclipHome}. `
            + `The shim and the store are being resolved from two different roots.`,
          repairHint:
            `Point both at one location: set PAPERCLIP_SHIM_PATH to the shim's current path `
            + `(${orphanShim}) so the store and the command agree, or set PAPERCLIP_HOME back to the `
            + `root that holds the store, then re-run \`paperclipai install\`.`,
        },
      ];
    }

    // Artifacts present with the manifest gone, and no orphan shim to explain
    // it, is the one state this check cannot classify: `hasManagedArtifacts` is
    // a heuristic that any single existing path trips, so a store caught
    // mid-update looks the same as one that lost its manifest.
    // `commands/run.ts` refuses to bind the server port on any `fail`, which
    // made that ambiguity able to take the instance offline on restart. The
    // provable states -- unreadable manifest above, dangling `current` below,
    // and the relocated-root shim just handled -- still fail; only the
    // unprovable one is downgraded.
    return [
      {
        name: "Managed install manifest",
        status: "warn",
        message: `Managed install artifacts exist but ${paths.manifestPath} is missing`,
        repairHint:
          "Re-run `paperclipai install` to rebuild the managed install metadata. This does not block startup; the server starts without it.",
      },
    ];
  }

  const results: CheckResult[] = [];
  const payloadPath = path.resolve(manifest.payloadPath);
  const relativePayload = path.relative(paths.installsRoot, payloadPath);
  const payloadInStore = Boolean(relativePayload) && !relativePayload.startsWith("..") && !path.isAbsolute(relativePayload);
  const payloadExists = payloadInStore && fs.existsSync(payloadPath) && fs.statSync(payloadPath).isDirectory();
  let currentMatches = false;
  try {
    currentMatches = fs.lstatSync(paths.currentPath).isSymbolicLink()
      && fs.realpathSync(paths.currentPath) === fs.realpathSync(payloadPath);
  } catch {
    currentMatches = false;
  }

  results.push(
    payloadExists && currentMatches
      ? {
          name: "Managed install store",
          status: "pass",
          message: `${manifest.source} ${manifest.version} is active`,
        }
      : {
          name: "Managed install store",
          status: "fail",
          message: !payloadExists
            ? `Manifest payload is missing or outside the install store: ${manifest.payloadPath}`
            : `Current link does not point to ${manifest.payloadPath}`,
          repairHint: "Re-run `paperclipai install` or roll back to a retained payload",
        },
  );

  // Prefer the configured path, fall back to one a previous install location
  // left behind: reporting a relocated-away shim as "missing" would tell the
  // operator to re-run `install` while the command they actually invoke is
  // sitting on their PATH. Same marker gate as `findManagedShim`, and for the
  // same reason -- one predicate, so the two cannot drift apart.
  const resolvedShim = findManagedShim(paths);
  const shimValid = resolvedShim !== null;
  const shimDisplayPath = resolvedShim ?? paths.shimPath;
  const shimElsewhere = resolvedShim !== null && resolvedShim !== paths.shimPath;
  results.push(
    shimValid
      ? {
          name: "Managed install shim",
          status: "pass",
          message: shimElsewhere
            ? `${shimDisplayPath} (a previous install location; set PAPERCLIP_SHIM_PATH to this path to keep using it)`
            : shimDisplayPath,
        }
      : {
          name: "Managed install shim",
          status: "fail",
          message: `Missing or unrecognized shim at ${shimDisplayPath}`,
          repairHint: "Re-run `paperclipai install`",
        },
  );

  const shimDirectory = path.dirname(shimDisplayPath);
  results.push(
    pathContains(shimDirectory)
      ? { name: "Managed install PATH", status: "pass", message: `${shimDirectory} is on PATH` }
      : {
          name: "Managed install PATH",
          status: "warn",
          message: `${shimDirectory} is not on PATH`,
          repairHint: 'Run `export PATH="$HOME/.local/bin:$PATH"` and add it to your shell startup file',
        },
  );

  const retained = new Set(
    [manifest, ...manifest.previous].map((record) => path.resolve(record.payloadPath)),
  );
  const orphaned: string[] = [];
  for (const source of ["npm", "git"] as const) {
    const sourceRoot = path.join(paths.installsRoot, source);
    if (!fs.existsSync(sourceRoot)) continue;
    for (const entry of fs.readdirSync(sourceRoot)) {
      const candidate = path.join(sourceRoot, entry);
      if (!entry.startsWith(".") && !retained.has(path.resolve(candidate))) orphaned.push(candidate);
    }
  }
  results.push(
    orphaned.length === 0
      ? { name: "Managed install retention", status: "pass", message: "No orphaned payloads" }
      : {
          name: "Managed install retention",
          status: "warn",
          message: `${orphaned.length} orphaned payload${orphaned.length === 1 ? "" : "s"} found`,
          repairHint: "A successful `paperclipai update` prunes unretained payloads",
        },
  );

  return results;
}
