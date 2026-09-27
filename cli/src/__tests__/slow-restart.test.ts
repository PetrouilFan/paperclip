import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyRestartDowntime,
  emitSlowRestartSignal,
  readSlowRestartRecord,
  SLOW_RESTART_THRESHOLD_MS,
  slowRestartRecordPath,
  writeSlowRestartRecord,
  type SlowRestartRecord,
} from "../services/slow-restart.js";
import { SystemdServiceManager, type CommandRunner } from "../services/service-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-slow-restart-"));
  temporaryDirectories.push(directory);
  return directory;
}

function recordAt(elapsedMs: number, instanceRoot: string): SlowRestartRecord {
  return {
    version: 1,
    instanceId: "default",
    serviceName: "paperclipai.service",
    platform: "systemd",
    requestedAt: "2026-09-27T01:07:04.000Z",
    completedAt: "2026-09-27T01:15:44.000Z",
    elapsedMs,
    thresholdMs: SLOW_RESTART_THRESHOLD_MS,
    severity: classifyRestartDowntime(elapsedMs),
    settled: true,
    previousServerPid: 4242,
    previousServerStartedAt: "2026-09-27T00:00:00.000Z",
  };
}

describe("slow restart threshold", () => {
  it("honours AC4's 30s floor rather than merely naming it", () => {
    // The criterion is "more than 30s raises something a human will see". These
    // are the boundaries of that sentence, not of the implementation.
    expect(classifyRestartDowntime(29_999)).toBe("ok");
    expect(classifyRestartDowntime(30_000)).toBe("slow");
    expect(classifyRestartDowntime(30_001)).toBe("slow");
  });

  it("separates a 31s blip from the 520s restart measured on this host", () => {
    // Both are over AC4's floor and both must raise a signal. If they were
    // indistinguishable, an operator reading the signal could not tell a blip
    // from a restart that consumed 87% of TimeoutStartSec=600 -- and would be
    // right to ignore the second one after a week.
    expect(classifyRestartDowntime(31_000)).toBe("slow");
    expect(classifyRestartDowntime(520_000)).toBe("severe");
  });

  it("does not report a restart it failed to measure as a slow one", () => {
    expect(classifyRestartDowntime(Number.NaN)).toBe("ok");
    expect(classifyRestartDowntime(Number.POSITIVE_INFINITY)).toBe("ok");
  });
});

describe("slow restart record", () => {
  it("round-trips the measurement so a later command can report it", async () => {
    const instanceRoot = await temporaryDirectory();
    await writeSlowRestartRecord(instanceRoot, recordAt(520_000, instanceRoot));
    const read = await readSlowRestartRecord(instanceRoot);
    expect(read?.elapsedMs).toBe(520_000);
    expect(read?.severity).toBe("severe");
    expect(read?.previousServerPid).toBe(4242);
  });

  it("is readable by an operator who was never attached to the restart", async () => {
    // The record is the only channel that survives the process that wrote it
    // exiting, a discarded stdout, and a service that never comes back. If this
    // file only appeared on the restart path it would not be a channel at all.
    const instanceRoot = await temporaryDirectory();
    expect(await readSlowRestartRecord(instanceRoot)).toBeNull();
    await writeSlowRestartRecord(instanceRoot, recordAt(45_000, instanceRoot));
    expect(await fs.stat(slowRestartRecordPath(instanceRoot)).then((stat) => stat.mode & 0o777)).toBe(0o600);
  });

  it("reports nothing rather than throwing on a truncated record", async () => {
    const instanceRoot = await temporaryDirectory();
    await fs.mkdir(instanceRoot, { recursive: true });
    await fs.writeFile(slowRestartRecordPath(instanceRoot), "{not json");
    expect(await readSlowRestartRecord(instanceRoot)).toBeNull();
  });
});

describe("slow restart signal emission", () => {
  it("writes the durable record before anything that can fail", async () => {
    const instanceRoot = await temporaryDirectory();
    const lines: string[] = [];
    // A runner that always throws stands in for every best-effort channel
    // failing at once. The record must exist anyway, or a slow restart reported
    // during a bad window is a slow restart nobody ever hears about.
    await emitSlowRestartSignal(recordAt(520_000, instanceRoot), {
      instanceRoot,
      runner: async () => { throw new Error("systemd-cat is unavailable"); },
      logPath: path.join(instanceRoot, "service.err.log"),
      writeStderr: (line) => lines.push(line),
    });
    expect((await readSlowRestartRecord(instanceRoot))?.elapsedMs).toBe(520_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("520.0s");
    // The operator's own log is the same artifact `service logs` tails.
    expect(await fs.readFile(path.join(instanceRoot, "service.err.log"), "utf8")).toContain("SEVERE RESTART");
  });
});

describe("restart() measurement", () => {
  /** A command runner whose `systemctl restart` takes a controlled amount of time. */
  function runnerThatRestartsFor(restartMs: number, calls: string[][] = []): CommandRunner {
    return async (command, args) => {
      calls.push([command, ...args]);
      if (command === "systemctl" && args.includes("restart")) {
        await new Promise((resolve) => setTimeout(resolve, restartMs));
        return { stdout: "", stderr: "" };
      }
      if (command === "systemctl" && args.includes("show")) {
        return { stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=4242\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
  }

  /**
   * A real user home with a real executable shim, so `desiredDefinition()` takes
   * its normal path instead of the "refusing to write a unit with a missing
   * ExecStart target" one. `PAPERCLIP_HOME` is the third constructor argument
   * and is where the durable record lands.
   */
  const FAST_MS = 5;
  const SLOW_MS = 60;
  // The boundary is asserted at the real 30s in the threshold block above. Here
  // the threshold is injected at 20ms so the crossing is exercised end to end --
  // through `restart()`, the record and the emit -- without a 30-second test.
  const INJECTED_THRESHOLD_MS = 20;

  async function managerFor(
    restartMs: number,
    options: { shippedDefaultThreshold?: boolean; failing?: boolean } = {},

  ): Promise<{ manager: SystemdServiceManager; instanceRoot: string }> {
    const home = await temporaryDirectory();
    const instanceRoot = path.join(home, ".paperclip", "instances", "default");
    const shimPath = path.join(home, ".local", "bin", "paperclipai");
    await fs.mkdir(path.dirname(shimPath), { recursive: true });
    await fs.writeFile(shimPath, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
    const runner: CommandRunner = async (command, args) => {
      if (command === "systemctl" && args.includes("show")) {
        return { stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=4242\n", stderr: "" };
      }
      if (command === "systemctl" && args.includes("restart")) {
        await new Promise((resolve) => setTimeout(resolve, restartMs));
        if (options.failing) throw new Error("Job for paperclipai.service failed because the control process timed out.");
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    return {
      // `shippedDefaultThreshold` leaves the argument off the constructor
      // entirely, so the default-threshold test below really does exercise the
      // value production runs on rather than a second copy of it.
      manager: options.shippedDefaultThreshold
        ? new SystemdServiceManager("default", runner, path.join(home, ".paperclip"), shimPath, home)
        : new SystemdServiceManager("default", runner, path.join(home, ".paperclip"), shimPath, home, INJECTED_THRESHOLD_MS),
      instanceRoot,
    };
  }

  it("returns the elapsed time so a caller can tell a fast restart from a slow one", async () => {
    const fast = await (await managerFor(FAST_MS)).manager.restart();
    const slow = await (await managerFor(SLOW_MS)).manager.restart();

    expect(fast.severity).toBe("ok");
    expect(slow.severity).toBe("slow");
    expect(slow.elapsedMs).toBeGreaterThanOrEqual(50);
    expect(fast.elapsedMs).toBeLessThan(slow.elapsedMs);
    // The same field, same units, on both -- a caller does not have to know
    // which platform or which threshold policy produced the number.
    expect(fast.thresholdMs).toBe(INJECTED_THRESHOLD_MS);
    expect(slow.settled).toBe(true);
  });

  it("ships AC4's 30s floor as the default a real restart is measured against", async () => {
    // The injected threshold above exists so the boundary is testable in
    // milliseconds. This is the assertion that production is not quietly running
    // on the test's value: a real restart on a real host reports 30000.
    const outcome = await (await managerFor(FAST_MS, { shippedDefaultThreshold: true })).manager.restart();
    expect(outcome.thresholdMs).toBe(SLOW_RESTART_THRESHOLD_MS);
    expect(outcome.thresholdMs).toBe(30_000);
  });

  it("raises a durable record when the restart crosses the threshold, and no record when it does not", async () => {
    const quick = await managerFor(FAST_MS);
    await quick.manager.restart();
    expect(await readSlowRestartRecord(quick.instanceRoot)).toBeNull();

    const slow = await managerFor(SLOW_MS);
    const outcome = await slow.manager.restart({ previousServerPid: 4242 });
    const recorded = await readSlowRestartRecord(slow.instanceRoot);
    expect(recorded?.elapsedMs).toBe(outcome.elapsedMs);
    expect(recorded?.severity).toBe("slow");
    expect(recorded?.serviceName).toBe("paperclipai.service");
    expect(recorded?.previousServerPid).toBe(4242);
  });

  it("survives `service install` re-rendering the main unit (the PET-111 AC3 trap)", async () => {
    // The trap this asserts against is real and has already been paid for once:
    // a signal installed as host/unit config is silently lost the next time the
    // renderer rewrites the main unit, and `uninstall` then orphans the drop-ins.
    // Nothing this feature installs may live anywhere the renderer writes.
    const { manager, instanceRoot } = await managerFor(SLOW_MS);
    await manager.restart();
    const before = await fs.readFile(manager.definitionPath, "utf8");

    await manager.install({ startNow: false, startOnLogin: false });
    const after = await fs.readFile(manager.definitionPath, "utf8");

    // The re-render is byte-identical (writeIfChanged short-circuits) and, more
    // to the point, it did not have to be for the signal to still be there.
    expect(after).toBe(before);
    expect((await readSlowRestartRecord(instanceRoot))?.elapsedMs).toBeGreaterThanOrEqual(50);
    // And the signal added no drop-in, so `uninstall` is not newly gated and the
    // renderer has nothing new to clobber.
    expect(await fs.readdir(manager.dropInDirectory).catch(() => [])).toEqual([]);
  });

  it("still reports a restart that failed slowly enough to cross the threshold", async () => {
    // A start that exhausts TimeoutStartSec=600 is the worst case AC4 is about,
    // and it arrives as a thrown error. Timing only the success path would drop
    // exactly the restart an operator most needs to hear about.
    const { manager, instanceRoot } = await managerFor(SLOW_MS, { failing: true });

    await expect(manager.restart()).rejects.toThrow(/did not restart/);
    const recorded = await readSlowRestartRecord(instanceRoot);
    expect(recorded?.elapsedMs).toBeGreaterThanOrEqual(50);
    expect(recorded?.settled).toBe(false);
  });

  it("does not record a refusal as a slow restart", async () => {
    // 90-no-manual-stop.conf (PET-282) sets RefuseManualStop=yes, so
    // `systemctl --user restart` exits 4 in milliseconds. That is a refusal, not
    // an outage, and turning it into a slow-restart record would be a false
    // signal on the exact host where the record is most wanted.
    const { manager, instanceRoot } = await managerFor(0, { failing: true });
    await expect(manager.restart()).rejects.toThrow(/did not restart/);
    expect(await readSlowRestartRecord(instanceRoot)).toBeNull();
  });
});
