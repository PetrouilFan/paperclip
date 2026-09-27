import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installNulledSocketWriteContainment,
  isPostgresNulledSocketDeferredWrite,
} from "../services/postgres-deferred-write-containment.js";

/**
 * Verbatim `err.stack` captured from pristine upstream `postgres@3.4.9` driven
 * through its CommonJS entry -- the entry the deployed server resolves -- with
 * no probe and no injected error, so the driver threw on its own. Reserving a
 * connection, letting the backend close gracefully, and churning best-effort
 * writes against it reaches `nextWrite` after the close path has nulled the
 * socket.
 */
const CAPTURED_PRODUCTION_STACK =
  "TypeError: Cannot read properties of null (reading 'write')\n" +
  "    at Immediate.nextWrite " +
  "(/home/petrouil/.npm-global/lib/node_modules/paperclipai/node_modules/postgres/cjs/src/connection.js:255:22)\n" +
  "    at process.processImmediate (node:internal/timers:574:21)";

const DEPLOYED_NEXT_WRITE_FRAME =
  "at Immediate.nextWrite " +
  "(/home/petrouil/.npm-global/lib/node_modules/paperclipai/node_modules/postgres/cjs/src/connection.js:255:22)";

function nulledSocketWriteError(stackFrame = DEPLOYED_NEXT_WRITE_FRAME): TypeError {
  const err = new TypeError("Cannot read properties of null (reading 'write')");
  err.stack = `TypeError: Cannot read properties of null (reading 'write')\n    ${stackFrame}\n    at process.processImmediate (node:internal/timers:574:21)`;
  return err;
}

const log = () => ({ warn: vi.fn(), error: vi.fn() });

describe("isPostgresNulledSocketDeferredWrite", () => {
  it("recognises the verbatim stack captured from the deployed driver's entry", () => {
    const err = new TypeError("Cannot read properties of null (reading 'write')");
    err.stack = CAPTURED_PRODUCTION_STACK;
    expect(isPostgresNulledSocketDeferredWrite(err)).toBe(true);
  });

  it("recognises the deployed driver's null-socket deferred-write throw", () => {
    expect(isPostgresNulledSocketDeferredWrite(nulledSocketWriteError())).toBe(true);
  });

  it("recognises the ESM path, the aliased frame V8 emits, and the pre-Node-16 wording", () => {
    const err = new TypeError("Cannot read property 'write' of null");
    err.stack = "TypeError: Cannot read property 'write' of null\n" +
      "    at Immediate.nextWrite [as _onImmediate] (file:///app/node_modules/postgres/src/connection.js:255:23)";
    expect(isPostgresNulledSocketDeferredWrite(err)).toBe(true);
  });

  it("does not match a non-TypeError that reads .write of null", () => {
    const err = new Error("Cannot read properties of null (reading 'write')");
    err.stack = `Error: x\n    ${DEPLOYED_NEXT_WRITE_FRAME}`;
    expect(isPostgresNulledSocketDeferredWrite(err)).toBe(false);
  });

  it("does not match a Paperclip bug that happens to read .write of null", () => {
    const err = new TypeError("Cannot read properties of null (reading 'write')");
    err.stack = "TypeError: Cannot read properties of null (reading 'write')\n" +
      "    at drainRetainedRunnerdMaintenanceOperations (/srv/paperclip/dist/services/heartbeat.js:412:19)";
    expect(isPostgresNulledSocketDeferredWrite(err)).toBe(false);
  });

  it("does not match a different function inside the driver", () => {
    const err = new TypeError("Cannot read properties of null (reading 'write')");
    err.stack = "TypeError: Cannot read properties of null (reading 'write')\n" +
      "    at drain (/app/node_modules/postgres/src/connection.js:120:9)";
    expect(isPostgresNulledSocketDeferredWrite(err)).toBe(false);
  });

  it("does not match the driver's own CONNECTION_CLOSED error", () => {
    const err = new Error("write CONNECTION_CLOSED 127.0.0.1:54329");
    err.stack = `Error: write CONNECTION_CLOSED 127.0.0.1:54329\n    ${DEPLOYED_NEXT_WRITE_FRAME}`;
    expect(isPostgresNulledSocketDeferredWrite(err)).toBe(false);
  });
});

describe("installNulledSocketWriteContainment", () => {
  const installed: Array<{ uninstall(): boolean }> = [];

  const arm = (isShuttingDown: () => boolean, exitOnUncaught = vi.fn()) => {
    const logger = log();
    const handle = installNulledSocketWriteContainment({ isShuttingDown, log: logger, exitOnUncaught });
    installed.push(handle);
    return { logger, exitOnUncaught, handle };
  };

  afterEach(() => {
    while (installed.length) installed.pop()!.uninstall();
  });

  it("contains the signature during shutdown and keeps the process alive", () => {
    const { logger, exitOnUncaught, handle } = arm(() => true);

    process.emit("uncaughtException", nulledSocketWriteError());

    expect(handle.contained()).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(exitOnUncaught).not.toHaveBeenCalled();
  });

  it("counts every contained occurrence so the shutdown log can report it", () => {
    const { handle } = arm(() => true);

    process.emit("uncaughtException", nulledSocketWriteError());
    process.emit("uncaughtException", nulledSocketWriteError());

    expect(handle.contained()).toBe(2);
  });

  it("stays fatal for this signature outside a drain", () => {
    const { logger, exitOnUncaught, handle } = arm(() => false);

    process.emit("uncaughtException", nulledSocketWriteError());

    expect(handle.contained()).toBe(0);
    expect(exitOnUncaught).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("stays fatal for every other error during shutdown", () => {
    const { exitOnUncaught, handle } = arm(() => true);
    const realBug = new TypeError("x is not a function");
    realBug.stack = "TypeError: x is not a function\n    at tick (/srv/paperclip/dist/index.js:9:1)";

    process.emit("uncaughtException", realBug);

    expect(handle.contained()).toBe(0);
    expect(exitOnUncaught).toHaveBeenCalledWith(1);
  });

  it("follows shutdown state instead of latching at install time", () => {
    let shuttingDown = false;
    const { exitOnUncaught, handle } = arm(() => shuttingDown);

    process.emit("uncaughtException", nulledSocketWriteError());
    expect(exitOnUncaught).toHaveBeenCalledTimes(1);

    shuttingDown = true;
    exitOnUncaught.mockClear();
    process.emit("uncaughtException", nulledSocketWriteError());

    expect(handle.contained()).toBe(1);
    expect(exitOnUncaught).not.toHaveBeenCalled();
  });

  it("removes its listener on uninstall, restoring the default fatal path", () => {
    const exitOnUncaught = vi.fn();
    const handle = installNulledSocketWriteContainment({
      isShuttingDown: () => true,
      log: log(),
      exitOnUncaught,
    });

    expect(handle.uninstall()).toBe(true);
    expect(handle.uninstall()).toBe(false);
  });
});
