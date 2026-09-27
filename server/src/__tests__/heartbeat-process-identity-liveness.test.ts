import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { isProcessIdentityAlive } from "../services/heartbeat.js";
import { readProcessStartedAt } from "../services/hot-restart.js";

async function spawnSleeper() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  return child;
}

async function reap(child: ReturnType<typeof spawnSleeper>) {
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("isProcessIdentityAlive", () => {
  it("confirms a live child whose recorded identity still matches", async () => {
    const child = await spawnSleeper();
    try {
      const pid = child.pid!;
      const observed = await readProcessStartedAt(pid);
      await expect(isProcessIdentityAlive(pid, observed)).resolves.toBe(true);
    } finally {
      await reap(child);
    }
  });

  it("rejects a live pid whose recorded identity belongs to another process", async () => {
    const child = await spawnSleeper();
    try {
      const pid = child.pid!;
      const observed = await readProcessStartedAt(pid);
      const recycledIdentity = new Date(
        new Date(observed).getTime() - 60_000,
      ).toISOString();
      expect(recycledIdentity).not.toBe(observed);
      // The pid-only predicate answers true here, which is what strands the run.
      await expect(isProcessIdentityAlive(pid, recycledIdentity)).resolves.toBe(
        false,
      );
    } finally {
      await reap(child);
    }
  });

  it("rejects a dead pid regardless of the recorded identity", async () => {
    const child = await spawnSleeper();
    const pid = child.pid!;
    const observed = await readProcessStartedAt(pid);
    await reap(child);
    await expect(isProcessIdentityAlive(pid, observed)).resolves.toBe(false);
  });

  it("stays conservative when no identity was recorded", async () => {
    const child = await spawnSleeper();
    try {
      await expect(isProcessIdentityAlive(child.pid!, null)).resolves.toBe(true);
    } finally {
      await reap(child);
    }
  });

  it("stays conservative when the identity cannot be read", async () => {
    const child = await spawnSleeper();
    try {
      await expect(
        isProcessIdentityAlive(
          child.pid!,
          new Date("2026-01-01T00:00:00.000Z"),
          () => Promise.reject(new Error("EACCES")),
        ),
      ).resolves.toBe(true);
    } finally {
      await reap(child);
    }
  });

  it("stays conservative when the recorded identity is unparseable", async () => {
    const child = await spawnSleeper();
    try {
      await expect(
        isProcessIdentityAlive(child.pid!, "not-a-date"),
      ).resolves.toBe(true);
    } finally {
      await reap(child);
    }
  });

  it("treats a null pid as dead", async () => {
    await expect(isProcessIdentityAlive(null, new Date())).resolves.toBe(false);
  });
});
