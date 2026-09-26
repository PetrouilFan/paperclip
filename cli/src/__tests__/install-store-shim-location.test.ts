import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANAGED_SHIM_MARKER,
  removeManagedShim,
  resolveInstallStorePaths,
  writeManagedShim,
  type InstallStorePaths,
} from "../install-store.js";
import { managedInstallChecks } from "../checks/managed-install-check.js";
import { resolveServiceShimPath } from "../services/service-manager.js";

let root: string;
let homeDir: string;
let previousShimPath: string | undefined;

beforeEach(() => {
  previousShimPath = process.env.PAPERCLIP_SHIM_PATH;
  delete process.env.PAPERCLIP_SHIM_PATH;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pet292-"));
  homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
});
afterEach(() => {
  if (previousShimPath === undefined) delete process.env.PAPERCLIP_SHIM_PATH;
  else process.env.PAPERCLIP_SHIM_PATH = previousShimPath;
  fs.rmSync(root, { recursive: true, force: true });
});

const relocatedHome = (name: string) => {
  const paperclipHome = path.join(root, name, ".paperclip");
  fs.mkdirSync(paperclipHome, { recursive: true });
  return paperclipHome;
};

const store = (paperclipHome: string): InstallStorePaths =>
  resolveInstallStorePaths({ paperclipHome, homeDir });

function seed(p: InstallStorePaths): void {
  const payload = path.join(p.installsRoot, "npm", "paperclipai@1.0.0");
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(
    p.manifestPath,
    JSON.stringify({ schemaVersion: 1, source: "npm", version: "1.0.0", payloadPath: payload, previous: [] }),
  );
  fs.writeFileSync(p.markerPath, "ok");
  fs.symlinkSync(payload, p.currentPath);
}

describe("PET-292: the shim location is resolvable from the same knob the service uses", () => {
  it("defaults to the historical $HOME/.local/bin path", () => {
    const p = store(relocatedHome("default"));
    expect(p.shimPath).toBe(path.join(homeDir, ".local", "bin", "paperclipai"));
    expect(p.legacyShimPath).toBe(p.shimPath);
  });

  it("honours PAPERCLIP_SHIM_PATH, and agrees with the service manager", () => {
    const custom = path.join(root, "custom", "bin", "paperclipai");
    process.env.PAPERCLIP_SHIM_PATH = custom;

    const p = store(relocatedHome("custom"));
    expect(p.shimPath).toBe(custom);
    // The invariant that keeps `service install` from writing an ExecStart at a
    // shim `install` never writes (PET-40 / 203-EXEC crash-loop).
    expect(resolveServiceShimPath(homeDir)).toBe(p.shimPath);
  });

  it("still agrees with the service manager when the variable is unset", () => {
    expect(resolveServiceShimPath(homeDir)).toBe(store(relocatedHome("agree")).shimPath);
  });
});

describe("PET-292: relocating the store no longer produces a self-contradictory finding", () => {
  it("names the orphan shim and the empty store instead of claiming artifacts exist", () => {
    const originalHome = path.join(root, "original", ".paperclip");
    fs.mkdirSync(originalHome, { recursive: true });
    seed(store(originalHome));
    // The shim the operator is actually invoking survives at the old location.
    const shimDir = path.join(homeDir, ".local", "bin");
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, "paperclipai"), `#!/bin/sh\n# ${MANAGED_SHIM_MARKER}\n`);

    const movedHome = relocatedHome("moved");
    const checks = managedInstallChecks(store(movedHome));
    const failures = checks.filter((c) => c.status === "fail");
    expect(failures).toHaveLength(1);

    const finding = failures[0];
    expect(finding.name).toBe("Managed install manifest");
    // The witness is named, so "artifacts exist" is no longer an assertion the
    // operator cannot check.
    expect(finding.message).toContain(path.join(shimDir, "paperclipai"));
    expect(finding.message).toContain(movedHome);
    expect(finding.message).not.toContain("artifacts exist but");
    // The repair converges: it names the knob, not just "install again".
    expect(finding.repairHint).toContain("PAPERCLIP_SHIM_PATH");
    expect(finding.repairHint).toContain("PAPERCLIP_HOME");
  });

  it("follows the orphan shim to a clean store once the roots agree", () => {
    const shared = relocatedHome("shared");
    const p = store(shared);
    seed(p);
    const shimDir = path.join(homeDir, ".local", "bin");
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, "paperclipai"), `#!/bin/sh\n# ${MANAGED_SHIM_MARKER}\n`);

    // Point both at the same root -- the documented remedy.
    process.env.PAPERCLIP_SHIM_PATH = path.join(shimDir, "paperclipai");
    const aligned = resolveInstallStorePaths({ paperclipHome: shared, homeDir });

    expect(managedInstallChecks(aligned).filter((c) => c.status === "fail")).toHaveLength(0);
    const shimCheck = managedInstallChecks(aligned).find((c) => c.name === "Managed install shim");
    expect(shimCheck?.status).toBe("pass");
  });

  it("still blocks with the original wording when a real store is half-torn", () => {
    const home = relocatedHome("torn");
    const p = store(home);
    seed(p);                       // manifest, marker and current all present
    fs.rmSync(p.manifestPath);     // ...except the manifest
    const finding = managedInstallChecks(p).find((c) => c.name === "Managed install manifest");
    expect(finding?.status).toBe("fail");
    expect(finding?.message).toContain("artifacts exist but");
    expect(finding?.repairHint).toBe("Re-run `paperclipai install`");
  });
});

describe("PET-292: a relocated shim is written, found and swept", () => {
  it("writes to the configured location without touching unrelated directories", () => {
    const custom = path.join(root, "opt", "pc", "bin", "paperclipai");
    process.env.PAPERCLIP_SHIM_PATH = custom;
    const p = store(relocatedHome("write"));
    seed(p);

    writeManagedShim(p);
    expect(fs.existsSync(custom)).toBe(true);
    expect(fs.statSync(custom).mode & 0o777).toBe(0o755);
    expect(managedInstallChecks(p).find((c) => c.name === "Managed install shim")?.status).toBe("pass");
  });

  it("removes a shim left behind at a previous location on uninstall", () => {
    const home = relocatedHome("sweep");
    // Install once with the default location, so the shim on disk is a real
    // managed shim written by this code, not a hand-rolled fixture.
    writeManagedShim(store(home));
    const legacy = store(home).shimPath;
    expect(legacy).toBe(path.join(homeDir, ".local", "bin", "paperclipai"));

    // Then relocate it, leaving the old one behind.
    process.env.PAPERCLIP_SHIM_PATH = path.join(root, "opt", "pc", "bin", "paperclipai");
    const p = resolveInstallStorePaths({ paperclipHome: home, homeDir });
    seed(p);
    writeManagedShim(p);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(p.shimPath)).toBe(true);

    expect(removeManagedShim(p)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(p.shimPath)).toBe(false);
  });

  it("leaves a foreign command at either location alone, and still reports it", () => {
    const legacy = path.join(homeDir, ".local", "bin", "paperclipai");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "#!/bin/sh\necho not-ours\n", { mode: 0o755 });

    const p = store(relocatedHome("foreign"));
    expect(removeManagedShim(p)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("reports success when there is no shim at all, as it always did", () => {
    expect(removeManagedShim(store(relocatedHome("empty")))).toBe(true);
  });
});

describe("PET-292: writing a relocated shim does not widen a home directory", () => {
  it("keeps 0o700 on a home directory it has to create", () => {
    const freshHome = path.join(root, "fresh", "home");
    const p = resolveInstallStorePaths({ paperclipHome: relocatedHome("modes"), homeDir: freshHome });
    seed(p);
    expect(fs.existsSync(freshHome)).toBe(false);

    writeManagedShim(p);
    expect(fs.statSync(freshHome).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(freshHome, ".local")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(p.shimPath).mode & 0o777).toBe(0o755);
  });

  it("creates only the relocated chain, never the default location's parents", () => {
    const custom = path.join(root, "opt", "pc", "bin", "paperclipai");
    process.env.PAPERCLIP_SHIM_PATH = custom;
    const p = store(relocatedHome("nocollateral"));
    seed(p);

    writeManagedShim(p);
    expect(fs.existsSync(custom)).toBe(true);
    // $HOME/.local is a different subtree once the shim is relocated; creating
    // it would be a side effect on a directory the operator never asked about.
    expect(fs.existsSync(path.join(homeDir, ".local"))).toBe(false);
  });
});
