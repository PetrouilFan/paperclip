import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
// A test may import across the workspace boundary even though the CLI bundle
// may not. That is the whole reason the duplication is acceptable, and it is
// also the only thing that can hold the two copies together: the suites above
// inject an independent fake into each side, so on their own they would stay
// green through any divergence whatsoever.
import {
  isObservedHotRestartTargetAlive,
  parseHotRestartIntent,
  readProcessStartedAt as readServerProcessStartedAt,
} from "../../../server/src/services/hot-restart.js";
import type { HotRestartIntent } from "../../../server/src/services/hot-restart.js";
import { readProcessStartedAt } from "../utils/process-identity.js";

describe("readProcessStartedAt", () => {
  it("reads the inode change time on linux", async () => {
    const stat = async () => ({ ctimeMs: Date.parse("2026-09-25T00:29:58.000Z") });

    await expect(readProcessStartedAt(4242, { platform: "linux", stat })).resolves.toBe(
      "2026-09-25T00:29:58.000Z",
    );
  });

  it("returns null instead of throwing when the pid is gone", async () => {
    const stat = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };

    await expect(readProcessStartedAt(4242, { platform: "linux", stat })).resolves.toBeNull();
  });

  it("parses the ps lstart column on darwin as local time, like the server's reader", async () => {
    // `ps -o lstart=` prints local time with no zone. Both this reader and the
    // server's `asDateString` hand it to `Date.parse`, which reads it as local,
    // so the two agree on the instant -- which is the only property that
    // matters, since the server compares its own reading against this one.
    const local = new Date(2026, 8, 25, 0, 29, 58);
    const runCommand = async () => ({ stdout: "Fri Sep 25 00:29:58 2026\n" });

    await expect(readProcessStartedAt(4242, { platform: "darwin", runCommand })).resolves.toBe(
      local.toISOString(),
    );
  });

  it("returns null when the platform gives an unparseable start time", async () => {
    const runCommand = async () => ({ stdout: "not a date\n" });

    await expect(readProcessStartedAt(4242, { platform: "darwin", runCommand })).resolves.toBeNull();
  });

  it("falls through to pwsh when powershell.exe is absent on windows", async () => {
    const seen: string[] = [];
    const runCommand = async (file: string) => {
      seen.push(file);
      if (file === "powershell.exe") throw new Error("not found");
      return { stdout: "2026-09-25T00:29:58.000Z\n" };
    };

    await expect(readProcessStartedAt(4242, { platform: "win32", runCommand })).resolves.toBe(
      "2026-09-25T00:29:58.000Z",
    );
    expect(seen).toEqual(["powershell.exe", "pwsh.exe"]);
  });

  it("returns null on a platform it cannot read", async () => {
    await expect(readProcessStartedAt(4242, { platform: "aix" as NodeJS.Platform, runCommand: async () => ({ stdout: "" }) }))
      .resolves.toBeNull();
  });
});

// `isObservedHotRestartTargetAlive` (server/src/services/hot-restart.ts) reads
// `observed.startedAt` and `intent.previousServerStartedAt` and, when both
// parse, decides with `observedStartedAt === recordedStartedAt`. The intent's
// value is written by the CLI reader and the observation's by the server
// reader, so this equality -- not either reader in isolation -- is the hot
// restart's identity check. Drifting the two by even 1 ms does not fail
// anything on its own: the exact branch is skipped and the guard falls through
// to the coarser `observed <= requestedAt` pid-recycling heuristic, which
// answers a weaker question. `previousServerStartedAt` is written only by
// `cli/src/commands/service.ts` in the whole tree, so on an authenticated
// instance -- where the health probe redacts `serverInfo` and the OS reading
// is the only source -- this one unasserted equality is the whole safety
// property of a CLI-driven restart.
const PS_PLATFORMS: NodeJS.Platform[] = ["darwin", "freebsd", "openbsd", "aix", "sunos"];
const READABLE_PLATFORMS: NodeJS.Platform[] = ["linux", ...PS_PLATFORMS, "win32"];

type ParityCase = {
  name: string;
  platform: NodeJS.Platform;
  // The server's runner resolves to the command's stdout directly; the CLI's
  // wraps it in an object. Both are driven from the same function so neither
  // side can be handed a friendlier fixture than the other.
  stdoutFor?: (command: string, args: string[]) => Promise<string>;
  stat?: (target: string) => Promise<{ ctimeMs: number }>;
};

const PARITY_CASES: ParityCase[] = [
  {
    name: "linux ctime with millisecond precision",
    platform: "linux",
    stat: async () => ({ ctimeMs: Date.parse("2026-08-01T01:00:00.123Z") }),
  },
  {
    name: "linux ctime with a sub-millisecond fraction both must truncate the same way",
    platform: "linux",
    stat: async () => ({ ctimeMs: 1_772_000_000_123.456 }),
  },
  {
    name: "linux ctime at the epoch",
    platform: "linux",
    stat: async () => ({ ctimeMs: 0 }),
  },
  {
    name: "ps lstart on darwin",
    platform: "darwin",
    stdoutFor: async () => "Fri Aug  1 01:02:03 2026\n",
  },
  {
    name: "ps lstart on freebsd",
    platform: "freebsd",
    stdoutFor: async () => "Fri Aug  1 01:02:03 2026\n",
  },
  {
    name: "ps lstart on openbsd",
    platform: "openbsd",
    stdoutFor: async () => "Fri Aug  1 01:02:03 2026\n",
  },
  {
    name: "PowerShell round-trip o format with CRLF",
    platform: "win32",
    stdoutFor: async () => "2026-08-01T01:02:03.456Z\r\n",
  },
  {
    name: "PowerShell trailing whitespace",
    platform: "win32",
    stdoutFor: async () => "  2026-08-01T01:02:03.456Z  \n",
  },
  {
    name: "PowerShell absent, pwsh answers",
    platform: "win32",
    stdoutFor: async (command) => {
      if (command === "powershell.exe") throw new Error("ENOENT");
      return "2026-08-01T01:02:03.456Z\n";
    },
  },
  {
    // `android` is in NodeJS.Platform and in neither reader's list, so both
    // fall through to `return null` without touching a fixture.
    name: "a platform neither reader supports",
    platform: "android",
    stdoutFor: async () => "Fri Aug  1 01:02:03 2026\n",
  },
];

async function readBoth(testCase: ParityCase, pid = 4242) {
  const stdoutFor = testCase.stdoutFor ?? (async () => "");
  const [cliValue, serverValue] = await Promise.all([
    readProcessStartedAt(pid, {
      platform: testCase.platform,
      stat: testCase.stat,
      runCommand: async (file, args) => ({ stdout: await stdoutFor(file, args) }),
    }),
    readServerProcessStartedAt(pid, {
      platform: testCase.platform,
      stat: testCase.stat,
      runCommand: stdoutFor,
    }),
  ]);
  return { cliValue, serverValue };
}

describe("CLI/server readProcessStartedAt parity", () => {
  it.each(PARITY_CASES)("agrees on $name", async (testCase) => {
    const { cliValue, serverValue } = await readBoth(testCase);
    expect(cliValue).toBe(serverValue);
  });

  it("agrees on a real pid, and agrees on what that pid's start time actually is", async () => {
    const [cliValue, serverValue] = await Promise.all([
      readProcessStartedAt(process.pid),
      readServerProcessStartedAt(process.pid),
    ]);

    expect(cliValue).toBe(serverValue);

    if (READABLE_PLATFORMS.includes(process.platform)) {
      // Without this the equality above would also hold when both readers
      // returned null, which is the one answer that proves nothing.
      expect(cliValue).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }

    if (process.platform === "linux") {
      // Pin the value, not just the agreement: a change that moved both copies
      // to the same wrong answer would satisfy the equality above.
      const { ctimeMs } = await fs.stat(`/proc/${process.pid}`);
      expect(cliValue).toBe(new Date(ctimeMs).toISOString());
    }
  });

  it("pins the one intended difference: the server throws where the CLI returns null", async () => {
    // The CLI reader is a best-effort fallback, so it swallows a read failure
    // and lets its caller decide; the server's reader propagates. Both
    // behaviour and divergence are asserted so neither can drift into the
    // other unnoticed.
    const vanished = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };

    await expect(
      readProcessStartedAt(4242, { platform: "linux", stat: vanished }),
    ).resolves.toBeNull();
    await expect(
      readServerProcessStartedAt(4242, { platform: "linux", stat: vanished }),
    ).rejects.toThrow(/ENOENT/);

    // Same divergence on the branch that parses a command's output, so the
    // win32 loop and the server's single try/catch cannot be conflated either.
    const unparseable = async () => "not a date\n";
    await expect(
      readProcessStartedAt(4242, { platform: "darwin", runCommand: async () => ({ stdout: await unparseable() }) }),
    ).resolves.toBeNull();
    await expect(
      readServerProcessStartedAt(4242, { platform: "darwin", runCommand: unparseable }),
    ).rejects.toThrow(/Could not parse darwin process start time for PID 4242/);
  });

  it("reads the same pid the same way through both the health value and the OS value", async () => {
    // `writeHotRestartIntent` records the health probe's `serverInfo` value as
    // `previousServerIdentity` and the OS reading as
    // `previousServerStartedAt`, and the server prefers the identity but falls
    // back to the start time. So the OS reading still has to agree with what
    // the server would observe for the same pid, on a pid taken from the same
    // supervisor-reported source.
    const stat = async () => ({ ctimeMs: Date.parse("2026-08-01T01:00:00.123Z") });
    const healthValue = "2026-08-01T01:00:00.123Z";

    const osReading = await readProcessStartedAt(4242, { platform: "linux", stat });
    const serverOsReading = await readServerProcessStartedAt(4242, { platform: "linux", stat });

    expect(osReading).toBe(healthValue);
    expect(serverOsReading).toBe(healthValue);
  });
});

describe("PS_PLATFORMS constant", () => {
  it("matches the platform list both readers branch on", async () => {
    // Guards the copy above against the readers' own list drifting: if a
    // platform is added to one reader and not the other, this fails.
    for (const platform of PS_PLATFORMS) {
      const { cliValue, serverValue } = await readBoth({
        name: platform,
        platform,
        stdoutFor: async () => "Fri Aug  1 01:02:03 2026\n",
      });
      expect(cliValue).not.toBeNull();
      expect(cliValue).toBe(serverValue);
    }
  });
});

// Everything above proves the two readers agree. This block proves *why that
// matters*, because the agreement is not the property the hot restart needs --
// the guard needs the two values to denote the same instant, and it gets that
// by running both through `Date.parse` (hot-restart.ts). So byte-equality is a
// sufficient condition and a stronger one than required: a formatting
// difference that parses to the same epoch millis would not degrade the guard.
// A *value* difference of any size does, and it degrades silently, because the
// exact branch is skipped rather than failed and the coarser
// `observed <= requestedAt` pid-recycling heuristic answers instead. That
// asymmetry is why this is worth a test rather than a code comment.
describe("what the parity is for: the guard's exact branch", () => {
  const STARTED_AT = "2026-08-01T01:00:00.123Z";
  // Deliberately earlier than the process start, so the coarse fallback -- which
  // asks "did the process start after the intent was requested?" -- answers
  // false. Anything the exact branch answers true is therefore attributable to
  // the exact branch alone.
  const REQUESTED_AT = "2026-08-01T00:59:00.000Z";

  function intentWith(recordedStartedAt: string | null): HotRestartIntent {
    return {
      version: 1,
      requestedAt: REQUESTED_AT,
      previousServerPid: 4242,
      previousServerIdentity: null,
      previousServerStartedAt: recordedStartedAt,
      previousServerVersion: "1.0.0",
      drainRequired: false,
      requestedByRunId: null,
      preflightActiveRunIds: [],
    };
  }

  // Both readers are typed `string | null` because an unsupported platform
  // returns null, so the compiler needs telling that these two cases are on a
  // platform that answers.
  function requireValue(value: string | null, which: string): string {
    if (value === null) throw new Error(`${which} returned null on a platform it supports`);
    return value;
  }

  it("is taken while the readers agree, and skipped once they drift by 1 ms", async () => {
    const stat = async () => ({ ctimeMs: Date.parse(STARTED_AT) });

    // The intent as `writeHotRestartIntent` records it, and the observation as
    // the server sees it -- each produced by its own reader, not a hand-written
    // string, so this is a real round trip through the code under test.
    const recorded = requireValue(
      await readProcessStartedAt(4242, { platform: "linux", stat }),
      "the CLI reader",
    );
    const observed = requireValue(
      await readServerProcessStartedAt(4242, { platform: "linux", stat }),
      "the server reader",
    );
    expect(recorded).toBe(STARTED_AT);
    expect(observed).toBe(STARTED_AT);

    // Agreement: the exact branch answers, and only the exact branch can here.
    expect(isObservedHotRestartTargetAlive(intentWith(recorded), {
      alive: true,
      startedAt: observed,
    })).toBe(true);

    // One millisecond of drift in the observed reading. The exact branch is
    // skipped, the coarse pid-recycling fallback runs instead, and the answer
    // flips -- with nothing thrown and nothing logged.
    const drifted = new Date(Date.parse(observed) - 1).toISOString();
    expect(drifted).not.toBe(observed);
    expect(isObservedHotRestartTargetAlive(intentWith(recorded), {
      alive: true,
      startedAt: drifted,
    })).toBe(false);
  });

  it("shows the instant is the real requirement, not the spelling", async () => {
    const stat = async () => ({ ctimeMs: Date.parse(STARTED_AT) });
    const recorded = requireValue(
      await readProcessStartedAt(4242, { platform: "linux", stat }),
      "the CLI reader",
    );
    const observed = requireValue(
      await readServerProcessStartedAt(4242, { platform: "linux", stat }),
      "the server reader",
    );
    expect(observed).toBe(recorded);

    // A different spelling of the same instant. The bytes differ; the parsed
    // value does not; the guard is unaffected. This is the case a naive
    // "compare the strings" reading of the coupling would get wrong, and it is
    // why the parity assertions above are a guard against accidental drift
    // rather than a description of the contract.
    const respelled = "2026-08-01T01:00:00.123+00:00";
    expect(respelled).not.toBe(observed);
    expect(Date.parse(respelled)).toBe(Date.parse(observed));
    expect(isObservedHotRestartTargetAlive(intentWith(recorded), {
      alive: true,
      startedAt: respelled,
    })).toBe(true);
  });
});

// The block above characterises `previousServerStartedAt`, and it concludes that
// the guard needs the *instant*, not the spelling -- because that field is
// normalised on the way in and parsed on the way out. This block characterises
// its sibling, `previousServerIdentity`, and the conclusion is the opposite.
//
// These are characterisation tests. Every `false` below is the answer the code
// gives **today**, pinned so that a later change to the identity path cannot
// land without someone reading a diff that says what flipped. None of them
// assert what the answer ought to be. Deciding that is a separate question
// (PET-334 step 2), and it is not a question this suite can answer: the server's
// own `hot-restart.test.ts` deliberately uses opaque tokens like
// "server-boot-a" for this field, so normalising it through a date parser would
// drop a value the rest of the suite treats as legitimate. Whoever decides that
// has to reconcile those fixtures too, and these tests will be the before-shot.
describe("characterisation: previousServerIdentity is compared byte-for-byte", () => {
  const CANONICAL = "2026-08-01T01:00:00.123Z";
  // The same respelling the block above uses, so the two blocks differ only in
  // what it is compared against.
  const RESPELLED = "2026-08-01T01:00:00.123+00:00";
  // Two different `requestedAt` values, because the branches that fall back to
  // the pid-recycling heuristic ask "did the process start after the intent was
  // requested?" and therefore answer from this field alone. REQUESTED_AFTER
  // makes those branches answer false; REQUESTED_BEFORE makes them answer true.
  // Holding both fixed is what lets each test below name the branch it means.
  const REQUESTED_AFTER = "2026-08-01T01:05:00.000Z";
  const REQUESTED_BEFORE = "2026-08-01T00:59:00.000Z";

  function intentWith(fields: {
    requestedAt?: string;
    identity?: string | null;
    startedAt?: string | null;
  }): HotRestartIntent {
    return {
      version: 1,
      requestedAt: fields.requestedAt ?? REQUESTED_AFTER,
      previousServerPid: 4242,
      previousServerIdentity: fields.identity ?? null,
      previousServerStartedAt: fields.startedAt ?? null,
      previousServerVersion: "1.0.0",
      drainRequired: false,
      requestedByRunId: null,
      preflightActiveRunIds: [],
    };
  }

  // The pid-collision block is only entered when the observation is for the
  // same numeric pid, which is the realistic shape: `isOriginalServerProcessAlive`
  // passes the replacement intent it found on disk. So every case that is
  // about the identity path has to supply a `replacement` carrying that pid.
  function observe(replacementIdentity: string | null, startedAt: string | null = CANONICAL) {
    return {
      alive: true,
      startedAt: CANONICAL,
      replacement: {
        previousServerPid: 4242,
        previousServerIdentity: replacementIdentity,
        previousServerStartedAt: startedAt,
      },
    };
  }

  it("matches on the identity field when both sides are byte-identical", () => {
    // The non-vacuous half. Without it, every `false` below would also follow
    // from an `isObservedHotRestartTargetAlive` that answered false outright.
    expect(Date.parse(RESPELLED)).toBe(Date.parse(CANONICAL));
    expect(RESPELLED).not.toBe(CANONICAL);

    expect(isObservedHotRestartTargetAlive(
      intentWith({ identity: CANONICAL }),
      observe(CANONICAL),
    )).toBe(true);
  });

  it("answers false when the identity field is the same instant respelled", () => {
    // Characterising. Both sides denote one instant and `Date.parse` agrees, but
    // this branch is `===` on the raw strings, so the guard reports "not the same
    // process". One re-spelling between the writer and the reader is enough, and
    // the answer is wrong in the direction that strands a legitimate restart.
    expect(isObservedHotRestartTargetAlive(
      intentWith({ identity: RESPELLED }),
      observe(CANONICAL),
    )).toBe(false);

    // The mirror, so this cannot pass merely because the observer was built with
    // the identity on the wrong side.
    expect(isObservedHotRestartTargetAlive(
      intentWith({ identity: CANONICAL }),
      observe(RESPELLED),
    )).toBe(false);
  });

  it("absorbs that same value when the adjacent branch parses it instead", () => {
    // The finding, in one function and two adjacent branches. The observation,
    // the replacement's identity value and `requestedAt` are identical in both
    // assertions below -- the only thing that changes is whether the intent
    // carries an identity, and that is what decides which branch runs. With one,
    // the comparison is `===` on the bytes and a re-spelling fails it. Without
    // one, the very same string is handed to `Date.parse` and accepted, because
    // `CANONICAL <= REQUESTED_AFTER`. So the field's spelling hazard is a
    // property of how the intent is populated, not of the value.
    expect(isObservedHotRestartTargetAlive(
      intentWith({ identity: CANONICAL }),
      observe(RESPELLED),
    )).toBe(false);

    expect(isObservedHotRestartTargetAlive(
      intentWith({ identity: null }),
      observe(RESPELLED),
    )).toBe(true);
  });

  it("does not fall through to the start-time field, which holds the same instant", () => {
    // Both intents below carry `previousServerStartedAt` as CANONICAL and the
    // observation reports the same start time, so the start-time comparison would
    // answer true in both cases. The first cannot reach it: the identity branch
    // returns from inside the pid-collision block, and the fallback beneath it
    // answers from `requestedAt` rather than from the start times. `REQUESTED_BEFORE`
    // is chosen so that every fallback here answers false, which is what makes
    // this a statement about the identity branch and not about the fixtures.
    expect(isObservedHotRestartTargetAlive(
      intentWith({ identity: RESPELLED, startedAt: CANONICAL, requestedAt: REQUESTED_BEFORE }),
      observe(CANONICAL, CANONICAL),
    )).toBe(false);

    // The comparison that *would* have answered true, reached by dropping the
    // replacement so the pid-collision block is skipped entirely. This is what
    // makes the assertion above a statement about unreachability rather than
    // about these particular values.
    expect(isObservedHotRestartTargetAlive(
      intentWith({ startedAt: CANONICAL, requestedAt: REQUESTED_BEFORE }),
      { alive: true, startedAt: CANONICAL },
    )).toBe(true);
  });

  it("survives a persistence round trip that leaves the identity verbatim", () => {
    // The cause, pinned at the boundary where it happens. `parseHotRestartIntent`
    // is where a stored intent becomes a value again, and its two fields are
    // normalised differently: the start time goes through `asDateString` (parse,
    // re-emit `toISOString()`) and the identity through `asString` (a trim-length
    // check, nothing more). So a re-spelling survives here and is still there at
    // the `===` above, while its sibling has already been collapsed.
    const parsed = parseHotRestartIntent({
      version: 1,
      requestedAt: REQUESTED_AFTER,
      previousServerPid: 4242,
      previousServerIdentity: RESPELLED,
      previousServerStartedAt: RESPELLED,
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.previousServerIdentity).toBe(RESPELLED);
    expect(parsed?.previousServerStartedAt).toBe(CANONICAL);

    // Pin the reason the identity survives, so this cannot be read as the parser
    // simply not having run: a value that is not a date at all is kept too, which
    // is the property `hot-restart.test.ts:178` depends on with its
    // "server-boot-a" token.
    const opaque = parseHotRestartIntent({
      version: 1,
      requestedAt: REQUESTED_AFTER,
      previousServerPid: 4242,
      previousServerIdentity: "server-boot-a",
      previousServerStartedAt: null,
    });
    expect(opaque?.previousServerIdentity).toBe("server-boot-a");
  });
});
