import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { buildOpenApiSpec } from "../routes/openapi.js";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

/**
 * The generated document claims `x-paperclip-authorization` and a `security`
 * array per operation. An agent reads both before it decides whether it can
 * call an endpoint, so a claim that the runtime does not honour is a dead end
 * rather than a documentation nit.
 *
 * This file pins the approvals router two ways:
 *
 *  1. The declared actor must equal the gate the route actually applies. The
 *     gate is read out of `approvals.ts` rather than restated here, so adding a
 *     board-gated route and forgetting to declare it fails this test, and so
 *     does declaring a route board-only when the router does not gate it.
 *  2. The board-gated operations must actually refuse an agent actor. That is
 *     the ground truth (1) is compared against.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPROVALS_ROUTE_FILE = path.resolve(__dirname, "../routes/approvals.ts");
const APPROVALS_MOUNT = "/api";
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

const ROUTE_LITERAL_PATTERN =
  /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const BOARD_GATE_CALLEE_PATTERN = /\bassertBoard(?:OrgAccess)?\s*\(|\bassertInstanceAdmin\s*\(/;

function normalizeExpressPath(routePath: string) {
  return routePath
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
}

/** Brace-match the handler body that follows a route literal. */
function readHandlerBody(source: string, match: RegExpExecArray) {
  const open = source.indexOf("{", match.index + match[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i);
    }
  }
  return null;
}

/**
 * The operations the approvals router gates to the board, read from the route
 * source. Returns `METHOD /api/path` in OpenAPI path form.
 */
function readApprovalsRouterGates() {
  const source = fs.readFileSync(APPROVALS_ROUTE_FILE, "utf8");
  const boardGated: string[] = [];
  const agentCallable: string[] = [];

  for (const match of source.matchAll(ROUTE_LITERAL_PATTERN)) {
    const body = readHandlerBody(source, match);
    if (body === null) continue;
    const operation = `${match[1]!.toUpperCase()} ${APPROVALS_MOUNT}${normalizeExpressPath(match[2]!)}`;
    if (BOARD_GATE_CALLEE_PATTERN.test(body)) boardGated.push(operation);
    else agentCallable.push(operation);
  }

  return { boardGated: boardGated.sort(), agentCallable: agentCallable.sort() };
}

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
  const { errorHandler: routeErrorHandler } = await import("../middleware/index.js");
  const { approvalRoutes } = await import("../routes/approvals.js");
  return { errorHandler: routeErrorHandler, approvalRoutes };
});

function createRouteDb() {
  const runRows = [{ id: "run-1", companyId: "company-1", agentId: "agent-1", contextSnapshot: {} }];
  return {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) =>
            resolve(Object.keys(selection).includes("contextSnapshot") ? runRows : []),
        })),
      })),
    })),
  } as any;
}

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use(APPROVALS_MOUNT, routeModules.value.approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

describe("approvals router authorization contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("declares the actor each approvals operation actually requires", () => {
    const { boardGated, agentCallable } = readApprovalsRouterGates();
    const spec = buildOpenApiSpec() as any;

    // Guards the guard: if the route source stops being readable, the derived
    // sets must not silently empty out and make this test pass vacuously.
    expect(boardGated.length).toBeGreaterThan(0);
    expect(agentCallable.length).toBeGreaterThan(0);

    const declaredActor = (operation: string) => {
      const [method, routePath] = operation.split(" ");
      return spec.paths?.[routePath]?.[method.toLowerCase()];
    };

    const misdeclared: string[] = [];
    for (const operation of boardGated) {
      const doc = declaredActor(operation);
      if (!doc) {
        misdeclared.push(`${operation} is board-gated in approvals.ts but absent from the spec`);
        continue;
      }
      if (JSON.stringify(doc["x-paperclip-authorization"]) !== '{"actor":"board"}') {
        misdeclared.push(
          `${operation} calls assertBoard in approvals.ts but the spec declares ${JSON.stringify(doc["x-paperclip-authorization"])}`,
        );
      }
      if (JSON.stringify(doc.security) !== JSON.stringify([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }])) {
        misdeclared.push(`${operation} still advertises a non-board security requirement: ${JSON.stringify(doc.security)}`);
      }
    }
    for (const operation of agentCallable) {
      const doc = declaredActor(operation);
      if (!doc) {
        misdeclared.push(`${operation} is not gated in approvals.ts but absent from the spec`);
        continue;
      }
      if (JSON.stringify(doc["x-paperclip-authorization"]) !== '{"actor":"board_or_agent"}') {
        misdeclared.push(
          `${operation} is not gated in approvals.ts but the spec declares ${JSON.stringify(doc["x-paperclip-authorization"])}`,
        );
      }
    }

    expect(misdeclared).toEqual([]);
  });

  it("refuses an agent actor on every operation the spec declares board-only", async () => {
    const { boardGated } = readApprovalsRouterGates();
    const spec = buildOpenApiSpec() as any;
    const app = createAgentApp();

    const results: string[] = [];
    for (const operation of boardGated) {
      const [method, routePath] = operation.split(" ");
      const specOperation = spec.paths?.[routePath]?.[method.toLowerCase()];
      expect(specOperation?.["x-paperclip-authorization"]).toEqual({ actor: "board" });
      // The gate runs first, so a 403 here can only come from the actor check
      // and not from a missing approval.
      const concretePath = routePath.replace("{id}", "approval-1");
      const res = await request(app)
        [method.toLowerCase() as "post"](concretePath)
        .send({ decisionNote: "note" });
      results.push(`${operation} -> ${res.status} ${JSON.stringify(res.body)}`);
      expect(res.status, `${operation} must refuse an agent actor`).toBe(403);
      expect(res.body).toMatchObject({ error: "Board access required" });
    }

    expect(results).toHaveLength(boardGated.length);
  });

  it("keeps the approval note write available to an agent", async () => {
    mockApprovalService.addComment.mockResolvedValue({ id: "comment-1" });
    const res = await request(createAgentApp())
      .post("/api/approvals/approval-1/comments")
      .send({ body: "Still blocked on the board." });

    expect(res.status).toBe(201);
    expect(mockApprovalService.addComment).toHaveBeenCalled();
  });

  it("exposes every approvals route in the document", () => {
    const { boardGated, agentCallable } = readApprovalsRouterGates();
    const spec = buildOpenApiSpec() as any;
    const documented = new Set<string>();
    for (const [routePath, pathItem] of Object.entries<any>(spec.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        if (pathItem[method]) documented.add(`${method.toUpperCase()} ${routePath}`);
      }
    }
    const approvals = [...boardGated, ...agentCallable].filter((operation) =>
      operation.includes("/approvals"),
    );
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.filter((operation) => !documented.has(operation))).toEqual([]);
  });
});
