import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managedInstallChecks } from "../checks/managed-install-check.js";
import {
  MANAGED_STORE_MARKER,
  buildNextManifest,
  flipCurrentAtomic,
  resolveInstallStorePaths,
  writeInstallManifestAtomic,
  writeManagedShim,
} from "../install-store.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("managed install doctor checks", () => {
  it("passes for a consistent store, manifest, current link, shim, and PATH", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    const payloadPath = path.join(paths.installsRoot, "npm", "1.2.3");
    fs.mkdirSync(path.join(payloadPath, "dist"), { recursive: true });
    const manifest = buildNextManifest(
      {
        source: "npm",
        version: "1.2.3",
        channel: "latest",
        payloadPath,
        installedAt: "2026-07-22T00:00:00.000Z",
      },
      null,
    );
    flipCurrentAtomic(payloadPath, paths);
    writeInstallManifestAtomic(manifest, paths);
    writeManagedShim(paths);
    process.env.PATH = `${path.dirname(paths.shimPath)}${path.delimiter}${originalPath ?? ""}`;

    expect(managedInstallChecks(paths).every((result) => result.status === "pass")).toBe(true);
  });

  it("warns, and never fails, when managed artifacts exist without a manifest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    fs.mkdirSync(paths.cliRoot, { recursive: true });
    fs.writeFileSync(paths.markerPath, MANAGED_STORE_MARKER);

    expect(managedInstallChecks(paths)).toEqual([
      expect.objectContaining({ name: "Managed install manifest", status: "warn" }),
    ]);
  });

  it("does not contribute a startup-blocking failure for any artifact-without-manifest shape", () => {
    // Every way of reaching the "artifacts exist but the manifest is gone"
    // branch must resolve to a non-blocking status, because `commands/run.ts`
    // refuses to bind the server port on any `fail`.
    //
    // A *directory* at the shim path is deliberately absent: it is not a managed
    // artifact at all, so it never reaches this branch. See the test below.
    const shapes: Array<(paths: ReturnType<typeof resolveInstallStorePaths>) => void> = [
      (paths) => fs.writeFileSync(paths.markerPath, MANAGED_STORE_MARKER),
      (paths) => fs.mkdirSync(paths.currentPath, { recursive: true }),
      (paths) => fs.mkdirSync(path.join(paths.installsRoot, "npm", "1.2.3"), { recursive: true }),
    ];

    for (const seed of shapes) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
      const paths = resolveInstallStorePaths({
        paperclipHome: path.join(root, ".paperclip"),
        homeDir: root,
      });
      fs.mkdirSync(paths.cliRoot, { recursive: true });
      seed(paths);

      const results = managedInstallChecks(paths);
      expect(results.filter((result) => result.status === "fail")).toEqual([]);
      expect(results.filter((result) => result.status === "warn")).toHaveLength(1);
    }
  });

  it("does not treat a directory at the shim path as a managed artifact", () => {
    // A shim witness has to be a file carrying the managed marker, so a
    // directory where the command belongs is not one. Nothing in the store
    // exists either, so there is no half-state to warn about: this is a clean
    // "not a managed install", and it must not reach the manifest branch at
    // all. It also must not be escalated to a `fail` for being unrecognised.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    fs.mkdirSync(paths.cliRoot, { recursive: true });
    fs.mkdirSync(paths.shimPath, { recursive: true });

    expect(managedInstallChecks(paths)).toEqual([
      expect.objectContaining({ name: "Managed install", status: "pass" }),
    ]);
  });

  it("still fails when the manifest exists but cannot be read", () => {
    // The ambiguous half-state warns. A store that is provably corrupt still
    // fails, so `paperclipai doctor` keeps its signal for real breakage.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    fs.mkdirSync(paths.cliRoot, { recursive: true });
    fs.writeFileSync(paths.markerPath, MANAGED_STORE_MARKER);
    fs.writeFileSync(paths.manifestPath, "{ this is not json");

    expect(managedInstallChecks(paths)).toEqual([
      expect.objectContaining({ name: "Managed install manifest", status: "fail" }),
    ]);
  });

  it("ignores the shared CLI directory when it only contains update notice state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    fs.mkdirSync(paths.cliRoot, { recursive: true });
    fs.writeFileSync(path.join(paths.cliRoot, "update-check.json"), "{}\n");

    expect(managedInstallChecks(paths)).toEqual([
      expect.objectContaining({ name: "Managed install", status: "pass" }),
    ]);
  });

  it("ignores an empty installs directory left by a harmless lock lifecycle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    fs.mkdirSync(paths.installsRoot, { recursive: true });

    expect(managedInstallChecks(paths)).toEqual([
      expect.objectContaining({ name: "Managed install", status: "pass" }),
    ]);
  });

  // Regression for the measured 2026-07-25 outage: a global-npm install, a
  // `PAPERCLIP_HOME` that holds no managed store, and the npm command sitting
  // at `$HOME/.local/bin/paperclipai`. `paperclipai.service` printed a blocking
  // "Managed install manifest" finding, exited 1, hit start-limit, and left the
  // board down 3m31s while 6 in-flight runs were reaped.
  //
  // The command at the shim path is a witness only if it is a *managed* shim. An
  // npm-installed command execs into npm's own tree, never into a Paperclip
  // store, so it is not evidence of one -- and `removeManagedShim` already
  // refuses to delete a file at that path unless it carries the managed marker.
  // The doctor has to agree with the uninstaller about what lives there.
  it("does not treat a foreign command at the shim path as a managed install", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, "relocated", ".paperclip"),
      homeDir: path.join(root, "real-home"),
    });
    fs.mkdirSync(path.dirname(paths.legacyShimPath), { recursive: true });
    fs.writeFileSync(
      paths.legacyShimPath,
      '#!/bin/sh\nexec node "/usr/lib/node_modules/paperclipai/dist/index.js" "$@"\n',
      { mode: 0o755 },
    );

    // `run.ts` gates startup on `summary.failed > 0`, so a fail here is an
    // outage, not a warning.
    expect(managedInstallChecks(paths)).toEqual([
      expect.objectContaining({ name: "Managed install", status: "pass" }),
    ]);
  });

  // The counterpart: a real managed shim whose store is gone is a genuine
  // orphan, and must still block with a message that names the witness.
  it("still blocks on a managed shim left pointing at an empty store", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, "relocated", ".paperclip"),
      homeDir: path.join(root, "real-home"),
    });
    writeManagedShim(paths);
    fs.rmSync(paths.cliRoot, { recursive: true, force: true });

    const [result] = managedInstallChecks(paths);
    expect(result.status).toBe("fail");
    expect(result.message).toContain(paths.shimPath);
  });
});
