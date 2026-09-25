import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createEmbeddedPostgresSupervisor, type SupervisedEmbeddedPostgres } from "../embedded-postgres-supervisor.js";

function createInstance(startError?: Error) {
  const process = new EventEmitter();
  const instance: SupervisedEmbeddedPostgres = {
    process,
    start: vi.fn(async () => { if (startError) throw startError; }),
    stop: vi.fn(async () => undefined),
  };
  return { instance, process };
}

describe("embedded PostgreSQL supervisor", () => {
  it("restarts PostgreSQL after its managed child exits unexpectedly", async () => {
    const initial = createInstance();
    const replacement = createInstance();
    const onRestarted = vi.fn();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: () => replacement.instance,
      restartDelaysMs: [0],
      onRestarted,
    });
    initial.process.emit("exit", 137, "SIGKILL");
    await supervisor.waitForRecovery();
    expect(replacement.instance.start).toHaveBeenCalledOnce();
    expect(supervisor.current()).toBe(replacement.instance);
    expect(onRestarted).toHaveBeenCalledWith(1);
  });

  it("does not restart PostgreSQL during orderly shutdown", async () => {
    const initial = createInstance();
    const createReplacement = vi.fn(() => createInstance().instance);
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: createReplacement,
      restartDelaysMs: [0],
    });
    await supervisor.shutdown();
    expect(initial.instance.stop).toHaveBeenCalledOnce();
    expect(createReplacement).not.toHaveBeenCalled();
  });

  it("bounds recovery attempts and reports the final failure", async () => {
    const initial = createInstance();
    const failures = [new Error("first"), new Error("second"), new Error("third")];
    const onRecoveryExhausted = vi.fn();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: () => createInstance(failures.shift()).instance,
      restartDelaysMs: [0, 0, 0],
      onRecoveryExhausted,
    });
    initial.process.emit("exit", 1, null);
    await supervisor.waitForRecovery();
    expect(onRecoveryExhausted).toHaveBeenCalledOnce();
    expect(onRecoveryExhausted).toHaveBeenCalledWith(expect.objectContaining({ message: "third" }));
  });

  // A `KillMode=control-group` unit SIGTERMs PostgreSQL in the same cgroup as
  // the server, so the database finishes its requested shutdown and reports
  // `code=0, signal=null` while the server is still draining runs and
  // connections. That exit is the tail of our own stop, not a fault, so it must
  // not be logged as "Embedded PostgreSQL exited unexpectedly" and must not
  // relaunch the database this process is stopping.
  it("does not report or relaunch a clean exit that lands after shutdown intent is marked", async () => {
    const initial = createInstance();
    const onUnexpectedExit = vi.fn();
    const onControlledExit = vi.fn();
    const onRestarted = vi.fn();
    const createReplacement = vi.fn(() => createInstance().instance);
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: createReplacement,
      restartDelaysMs: [0],
      onUnexpectedExit,
      onControlledExit,
      onRestarted,
    });

    supervisor.markShutdownIntent();
    initial.process.emit("exit", 0, null);
    await supervisor.waitForRecovery();

    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(onRestarted).not.toHaveBeenCalled();
    expect(createReplacement).not.toHaveBeenCalled();
    expect(onControlledExit).toHaveBeenCalledExactlyOnceWith("shutdown_requested", 0, null);
  });

  it("stops the active instance exactly once when the teardown follows an early shutdown mark", async () => {
    const initial = createInstance();
    const createReplacement = vi.fn(() => createInstance().instance);
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: createReplacement,
      restartDelaysMs: [0],
    });

    // The signal handler marks the intent first and reaches the teardown later;
    // the early mark must not turn the real teardown into a no-op.
    supervisor.markShutdownIntent();
    await supervisor.shutdown();
    expect(initial.instance.stop).toHaveBeenCalledOnce();
    expect(createReplacement).not.toHaveBeenCalled();
  });

  it("keeps the incident path for an exit that was never requested", async () => {
    const initial = createInstance();
    const replacement = createInstance();
    const onUnexpectedExit = vi.fn();
    const onControlledExit = vi.fn();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: () => replacement.instance,
      restartDelaysMs: [0],
      onUnexpectedExit,
      onControlledExit,
    });

    // A killed postmaster is the genuine crash the recovery path exists for.
    initial.process.emit("exit", null, "SIGKILL");
    await supervisor.waitForRecovery();

    expect(onUnexpectedExit).toHaveBeenCalledExactlyOnceWith(null, "SIGKILL");
    expect(onControlledExit).not.toHaveBeenCalled();
    expect(replacement.instance.start).toHaveBeenCalledOnce();
  });

  it("keeps the incident path for an unrequested crash during a pending shutdown drain", async () => {
    const initial = createInstance();
    const replacement = createInstance();
    const onUnexpectedExit = vi.fn();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: () => replacement.instance,
      restartDelaysMs: [0],
      onUnexpectedExit,
    });

    // Only the clean `code=0, signal=null` shape belongs to a requested stop. A
    // crash that arrives before the mark is still an incident, so recovery runs.
    initial.process.emit("exit", 139, null);
    await supervisor.waitForRecovery();
    expect(onUnexpectedExit).toHaveBeenCalledExactlyOnceWith(139, null);
    expect(replacement.instance.start).toHaveBeenCalledOnce();
  });
});
