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
    // `commands/run.ts` refuses to bind the server port when the doctor reports
    // any `fail`. So every way of reaching the "artifacts exist but the manifest
    // is gone" branch must resolve to a non-blocking status. A transient deploy
    // or cleanup can trip `hasManagedArtifacts` and then retreat. That must not
    // be able to make the instance unreachable on restart.
    const shapes: Array<(paths: ReturnType<typeof resolveInstallStorePaths>) => void> = [
      (paths) => fs.writeFileSync(paths.markerPath, MANAGED_STORE_MARKER),
      (paths) => fs.mkdirSync(paths.currentPath, { recursive: true }),
      (paths) => fs.mkdirSync(paths.shimPath, { recursive: true }),
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
});
