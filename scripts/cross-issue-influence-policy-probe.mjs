#!/usr/bin/env node
/**
 * Behavioural policy probe for the cross-issue influence write gate.
 *
 * WHY THIS EXISTS (PET-195)
 *
 * The board has repeatedly tried to answer "is the cross-issue 403 fix deployed?"
 * with `grep -c targetIsBound`. That is the wrong instrument twice over:
 *
 *   1. `targetIsBound` is a *compiled JS* identifier. The TypeScript source on
 *      every branch, including the branch that implements the fallback, never
 *      contains that string. A source grep returns 0 whether or not the fix
 *      shipped.
 *   2. `paperclipai/dist/index.js` is the **CLI launcher bundle**. It has never
 *      contained the server's service code, so grepping it returns 0 for the
 *      life of the project.
 *
 * This probe instead *executes* a built `cross-issue-influence-limit.js` and
 * observes what `observeCrossIssueInfluence` actually decides. It needs no
 * database, no server, and no network: the five module imports are rewritten to
 * local stubs and the drizzle query chain is faked with the exact table
 * identity the compiled code selects on.
 *
 * It answers two questions that a grep cannot:
 *
 *   Q1 (liveness)  Does a task-less `heartbeat_timer` run get to write to an
 *                  issue it has NOT checked out?        -> `taskless.unbound`
 *   Q2 (containment) Does the 20-write cap and the fail-closed identity checks
 *                  still hold?                         -> `charged.*`, `failclosed.*`
 *
 * And it fingerprints which policy a given build implements, because three
 * different policies have been proposed for the same defect and they are not
 * interchangeable:
 *
 *   profile            taskless + no checkout   taskless + checked out
 *   -----------------  -----------------------  ----------------------
 *   unfixed (master)   denied 403               denied 403
 *   PR #5  be0b15b3a   charged to the 20 cap    charged to the 20 cap
 *   PR #6  f80a08c00   denied 403 (+ reason)    exempt (allowed)
 *
 * Usage:
 *   node scripts/cross-issue-influence-policy-probe.mjs [path ...]
 *
 * With no arguments it probes, in order:
 *   - the globally installed package that serves the instance
 *   - this repo's own build output
 *
 * Exit code 0 if every target was executed, 1 on any load/exec failure.
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const UUID_RUN = "11111111-1111-4111-8111-111111111111";
const UUID_TARGET = "22222222-2222-4222-8222-222222222222";
const UUID_OTHER = "33333333-3333-4333-8333-333333333333";
const UUID_AGENT = "44444444-4444-4444-8444-444444444444";
const UUID_COMPANY = "55555555-5555-4555-8555-555555555555";

// ---------------------------------------------------------------------------
// Stub module sources. These are inlined strings so the probe is a single
// self-contained file: copy it anywhere and run it.
// ---------------------------------------------------------------------------

const STUB_DRIZZLE = `
const col = (t, n) => ({ __col: n, __table: t });
export const eq = (a, b) => ({ __op: "eq", col: a, value: b });
export const and = (...c) => ({ __op: "and", children: c });
export const or = (...c) => ({ __op: "or", children: c });
export const count = () => ({ __op: "count" });
export const sql = (v) => ({ __op: "sql", value: v });
export const desc = (a) => ({ __op: "desc", col: a });
export const asc = (a) => ({ __op: "asc", col: a });
export { col };
export const gte = (a, b) => ({ __op: "gte", col: a, value: b });
export const lte = (a, b) => ({ __op: "lte", col: a, value: b });
export const isNull = (a) => ({ __op: "isNull", col: a });
export const inArray = (a, b) => ({ __op: "inArray", col: a, value: b });
`;

const STUB_DB = `
export const heartbeatRuns = {
  __table: "heartbeatRuns",
  id: "heartbeat_runs.id",
  companyId: "heartbeat_runs.company_id",
  agentId: "heartbeat_runs.agent_id",
  responsibleUserId: "heartbeat_runs.responsible_user_id",
  contextSnapshot: "heartbeat_runs.context_snapshot",
  status: "heartbeat_runs.status",
};
export const activityLog = {
  __table: "activityLog",
  companyId: "activity_log.company_id",
  runId: "activity_log.run_id",
  action: "activity_log.action",
};
export const issues = {
  __table: "issues",
  id: "issues.id",
  companyId: "issues.company_id",
  checkoutRunId: "issues.checkout_run_id",
  executionRunId: "issues.execution_run_id",
};
`;

const STUB_SHARED = `
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuidLike(value) {
  if (typeof value !== "string") return false;
  return UUID_RE.test(value.trim());
}
export function issueWriteDenialResponse(code) {
  return {
    status: 403,
    body: {
      error: "\\u2014",
      details: {
        code,
        boundary: "cross_issue_influence",
        whoCanAct: "the run that owns the source issue",
        sanctionedPath: "check out the target issue, or use an issue-scoped run",
      },
    },
  };
}
export const CROSS_ISSUE_INFLUENCE_LIMIT = 20;
`;

const STUB_ERRORS = `
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message ?? "HttpError");
    this.name = "HttpError";
    this.status = status;
    this.statusCode = status;
    this.code = details && typeof details === "object" ? details.code : undefined;
    this.details = details;
  }
}
export const forbidden = (message, details) => new HttpError(403, message, details);
export const notFound = (message, details) => new HttpError(404, message, details);
export const conflict = (message, details) => new HttpError(409, message, details);
export const badRequest = (message, details) => new HttpError(400, message, details);
export const unauthorized = (message, details) => new HttpError(401, message, details);
`;

const STUB_LOGGER = `
const noop = () => undefined;
export const logger = { info: noop, warn: noop, error: noop, debug: noop, trace: noop };
`;

// ---------------------------------------------------------------------------
// Loader: rewrite the five imports to the stubs above and import the subject.
// ---------------------------------------------------------------------------

const IMPORT_RE = /(\bfrom\s*)(["'])([^"']+)\2/g;

async function loadSubject(entryPath, workDir) {
  const source = readFileSync(entryPath, "utf8");
  const stubDir = workDir;
  const stubFiles = {
    "drizzle-orm": [join(stubDir, "stub.drizzle.mjs"), STUB_DRIZZLE],
    "@paperclipai/db": [join(stubDir, "stub.db.mjs"), STUB_DB],
    "@paperclipai/shared": [join(stubDir, "stub.shared.mjs"), STUB_SHARED],
    "../errors.js": [join(stubDir, "stub.errors.mjs"), STUB_ERRORS],
    "../middleware/logger.js": [join(stubDir, "stub.logger.mjs"), STUB_LOGGER],
  };
  for (const [name, [file, body]] of Object.entries(stubFiles)) {
    writeFileSync(file, body, "utf8");
  }
  const seen = new Set();
  const rewritten = source.replace(IMPORT_RE, (match, from, q, spec) => {
    const hit = stubFiles[spec];
    if (!hit) return match;
    seen.add(spec);
    return `${from}${q}${pathToFileURL(hit[0]).href}${q}`;
  });
  const subjectFile = join(stubDir, "subject.mjs");
  writeFileSync(subjectFile, rewritten, "utf8");
  const mod = await import(`${pathToFileURL(subjectFile).href}?t=${Date.now()}`);
  return { mod, unresolvedImports: [...source.matchAll(IMPORT_RE)]
    .map((m) => m[3])
    .filter((s) => !stubFiles[s]) };
}

// ---------------------------------------------------------------------------
// Fake db. Dispatches on the stub table identity the compiled code selects on.
// ---------------------------------------------------------------------------

function makeDb(scenario) {
  const inserted = [];
  const select = (table) => {
    const chain = {
      from(t) {
        return select(t);
      },
      where() {
        return chain;
      },
      for() {
        return chain;
      },
      limit() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      then(onOk, onErr) {
        let rows;
        switch (table && table.__table) {
          case "heartbeatRuns":
            rows = scenario.run ? [scenario.run] : [];
            break;
          case "issues":
            rows = scenario.targetBoundToRun ? [{ id: scenario.targetId }] : [];
            break;
          case "activityLog":
            rows = [{ count: String(scenario.priorCount ?? 0) }];
            break;
          default:
            rows = [];
        }
        return Promise.resolve().then(() => rows).then(onOk, onErr);
      },
    };
    return chain;
  };
  const tx = {
    select,
    insert(table) {
      return {
        values(row) {
          inserted.push(row);
          return Promise.resolve();
        },
      };
    },
    update() {
      return { set: () => ({ where: () => Promise.resolve() }) };
    },
  };
  const db = {
    transaction(fn) {
      return Promise.resolve().then(() => fn(tx));
    },
  };
  return { db, inserted };
}

// ---------------------------------------------------------------------------
// Scenario matrix.
//
// Group `policy` scenarios are what fingerprint the build. Group `containment`
// scenarios are invariants that must hold under every policy, including a
// policy that is more permissive than master. A build that fails one of those
// is a regression regardless of which PR shipped.
// ---------------------------------------------------------------------------

const POLICY_SCENARIOS = [
  {
    id: "taskless.unbound",
    label: "task-less run, target NOT checked out by the run",
    // This single scenario IS acceptance criterion 3 of PET-195:
    // "a task-less run writes a comment with no prior checkout and gets 201".
    criterion: "PET-195 done-when #3",
    run: { contextSnapshot: {}, status: "running" },
    targetBoundToRun: false,
    priorCount: 0,
  },
  {
    id: "taskless.bound",
    label: "task-less run, target checked out by the run",
    run: { contextSnapshot: {}, status: "running" },
    targetBoundToRun: true,
    priorCount: 0,
  },
  {
    id: "taskless.bound-terminal",
    label: "task-less run, target checked out, run is terminal",
    run: { contextSnapshot: {}, status: "failed" },
    targetBoundToRun: true,
    priorCount: 0,
  },
];

const CONTAINMENT_SCENARIOS = [
  {
    id: "scoped.same-issue",
    label: "issue-scoped run writing to its own source issue",
    run: { contextSnapshot: { issueId: UUID_TARGET }, status: "running" },
    targetBoundToRun: false,
    priorCount: 0,
    expect: "exempt",
  },
  {
    id: "scoped.other-issue",
    label: "issue-scoped run writing to a different issue, under the cap",
    run: { contextSnapshot: { issueId: UUID_OTHER }, status: "running" },
    targetBoundToRun: false,
    priorCount: 3,
    expect: "charged_allowed",
  },
  {
    id: "scoped.other-at-cap",
    label: "issue-scoped run writing to a different issue, at the 20 cap",
    run: { contextSnapshot: { issueId: UUID_OTHER }, status: "running" },
    targetBoundToRun: false,
    priorCount: 20,
    expect: "charged_denied",
  },
  {
    id: "scoped.checkout-cannot-bypass-cap",
    label:
      "issue-scoped run that checked out the target mid-run is still charged",
    run: { contextSnapshot: { issueId: UUID_OTHER }, status: "running" },
    targetBoundToRun: true,
    priorCount: 3,
    expect: "charged_allowed",
  },
  {
    id: "failclosed.malformed-run-id",
    label: "malformed run id is refused before any database cast",
    run: { contextSnapshot: {}, status: "running" },
    runIdOverride: "not-a-uuid",
    targetBoundToRun: true,
    priorCount: 0,
    expect: "denied",
  },
  {
    id: "failclosed.unknown-run",
    label: "run row does not exist",
    run: null,
    targetBoundToRun: false,
    priorCount: 0,
    expect: "denied",
  },
  {
    id: "failclosed.wrong-agent",
    label: "run row belongs to a different agent",
    run: {
      contextSnapshot: {},
      status: "running",
      agentId: "66666666-6666-4666-8666-666666666666",
    },
    targetBoundToRun: false,
    priorCount: 0,
    expect: "denied",
  },
  {
    id: "failclosed.wrong-company",
    label: "run row belongs to a different company",
    run: {
      contextSnapshot: {},
      status: "running",
      companyId: "77777777-7777-4777-8777-777777777777",
    },
    targetBoundToRun: false,
    priorCount: 0,
    expect: "denied",
  },
];

// ---------------------------------------------------------------------------

async function runScenario(mod, scenario) {
  // The caller's identity is fixed for every scenario. The `wrong-agent` and
  // `wrong-company` scenarios vary the *run row*, not the caller: that is the
  // impersonation the fail-closed gates exist to catch.
  const companyId = UUID_COMPANY;
  const agentId = UUID_AGENT;
  const runRow = scenario.run
    ? {
        id: UUID_RUN,
        companyId: scenario.run.companyId ?? companyId,
        agentId: scenario.run.agentId ?? agentId,
        responsibleUserId: null,
        contextSnapshot: scenario.run.contextSnapshot,
        status: scenario.run.status,
      }
    : null;
  const { db, inserted } = makeDb({
    run: runRow,
    targetBoundToRun: scenario.targetBoundToRun,
    targetId: UUID_TARGET,
    priorCount: scenario.priorCount,
  });
  const input = {
    companyId,
    runId: scenario.runIdOverride ?? UUID_RUN,
    agentId,
    responsibleUserId: null,
    targetIssueId: UUID_TARGET,
    targetIssueIdentifier: "PET-999",
    kind: "comment",
    now: new Date("2026-09-25T00:00:00.000Z"),
  };
  try {
    const decision = await mod.observeCrossIssueInfluence(db, input);
    if (decision === null || decision === undefined) {
      return { outcome: "exempt", inserted: inserted.length };
    }
    return {
      outcome: decision.allowed ? "charged_allowed" : "charged_denied",
      count: decision.count,
      cap: decision.cap,
      mode: decision.mode,
      inserted: inserted.length,
    };
  } catch (err) {
    const status = err?.status ?? err?.statusCode;
    const details = err?.details;
    const reason =
      details && typeof details === "object" ? details.reason : undefined;
    return {
      outcome: "denied",
      status: status ?? null,
      code: err?.code ?? details?.code ?? null,
      reason: reason ?? null,
      inserted: inserted.length,
      thrown: err?.name ?? "Error",
    };
  }
}

function fingerprint(results) {
  const get = (id) => results.find((r) => r.scenario.id === id)?.result ?? {};
  const unbound = get("taskless.unbound").outcome;
  const bound = get("taskless.bound").outcome;
  if (unbound === "charged_allowed") {
    return {
      id: "pr5-drop-refusal",
      title: "PR #5 / be0b15b3a",
      summary: "refusal removed; task-less runs are charged to the 20-write cap",
    };
  }
  if (unbound === "denied" && bound === "exempt") {
    return {
      id: "pr6-binding-fallback",
      title: "PR #6 / f80a08c00",
      summary:
        "refusal kept, but narrowed; writes to an issue the run holds are exempt",
    };
  }
  if (unbound === "denied" && (bound === "denied" || bound === "charged_allowed")) {
    return {
      id: "unfixed",
      title: "no mitigation",
      summary: "a task-less run is refused every issue write",
    };
  }
  return {
    id: "unrecognised",
    title: "unrecognised policy",
    summary: `unbound=${unbound} bound=${bound}`,
  };
}

function describe(result) {
  if (result.outcome === "denied") {
    const bits = ["DENIED 403"];
    if (result.reason) bits.push(`reason=${result.reason}`);
    if (!result.reason && result.code) bits.push(`code=${result.code}`);
    if (result.status && !result.code) bits.push(`status=${result.status}`);
    return bits.join("  ");
  }
  if (result.outcome === "exempt") return "EXEMPT    (exempt, not counted)";
  if (result.outcome === "charged_allowed") {
    return `CHARGED   allowed  ${result.count}/${result.cap}  ${result.mode}`;
  }
  return `CHARGED   denied   ${result.count}/${result.cap}  ${result.mode}`;
}

const DEFAULT_TARGETS = [
  join(
    homedir(),
    ".npm-global/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/services/cross-issue-influence-limit.js",
  ),
  resolve(
    dirname(new URL(import.meta.url).pathname),
    "../server/dist/services/cross-issue-influence-limit.js",
  ),
];

function rel(path) {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

async function main() {
  const argv = process.argv.slice(2);
  const targets = (argv.length ? argv : DEFAULT_TARGETS)
    .map((a) => resolve(a))
    .filter((p) => existsSync(p));

  if (!targets.length) {
    console.error("no built cross-issue-influence-limit.js found to probe.");
    console.error("pass one or more paths as arguments.");
    process.exit(1);
  }

  const workRoot = mkdtempSync(join(tmpdir(), "cxinf-probe-"));
  let failures = 0;
  const summary = [];

  for (const target of targets) {
    const workDir = join(workRoot, `w${summary.length}`);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(workDir, { recursive: true });

    console.log(`\n=== target: ${rel(target)}`);
    let mod;
    try {
      const loaded = await loadSubject(target, workDir);
      mod = loaded.mod;
      if (loaded.unresolvedImports.length) {
        console.log(
          `    note: left as real imports: ${loaded.unresolvedImports.join(", ")}`,
        );
      }
    } catch (err) {
      console.log(`    LOAD FAILED: ${err?.message ?? err}`);
      failures += 1;
      continue;
    }
    if (typeof mod.observeCrossIssueInfluence !== "function") {
      console.log("    LOAD FAILED: no observeCrossIssueInfluence export");
      failures += 1;
      continue;
    }
    if (typeof mod.CROSS_ISSUE_INFLUENCE_LIMIT === "number") {
      console.log(
        `    cap reported by the build: ${mod.CROSS_ISSUE_INFLUENCE_LIMIT}`,
      );
    }

    const results = [];
    for (const scenario of [...POLICY_SCENARIOS, ...CONTAINMENT_SCENARIOS]) {
      const result = await runScenario(mod, scenario);
      results.push({ scenario, result });
      const marker = scenario.expect
        ? result.outcome === scenario.expect
          ? "  ok"
          : "  ** CONTAINMENT REGRESSION **"
        : "";
      console.log(
        `    ${scenario.id.padEnd(34)} ${describe(result)}${marker}`,
      );
      if (scenario.expect && result.outcome !== scenario.expect) {
        failures += 1;
      }
    }

    const print = results.filter((r) => POLICY_SCENARIOS.includes(r.scenario));
    const fp = fingerprint(results);
    console.log(`    -> policy: ${fp.title} — ${fp.summary}`);
    if (print[0]?.scenario.criterion) {
      const r = print[0].result;
      console.log(
        `    -> ${print[0].scenario.criterion}: ${
          r.outcome === "charged_allowed"
            ? "PASS (task-less run with no checkout gets a 201-equivalent)"
            : `NOT MET (${describe(r)})`
        }`,
      );
    }
    summary.push({ target, fp });
  }

  console.log("\n=== summary");
  for (const { target, fp } of summary) {
    console.log(`  ${fp.id.padEnd(24)} ${rel(target)}`);
  }
  console.log(
    "\nNote: these results come from executing the built module. No grep was involved.",
  );
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
