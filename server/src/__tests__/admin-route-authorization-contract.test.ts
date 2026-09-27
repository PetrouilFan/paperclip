import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";

/**
 * `/admin/` is a declaration, not a URL shape.
 *
 * `BOARD_ONLY_PREFIXES` lists `/api/admin/`, which matches the top-level admin
 * surface and nothing else. An admin operation nested under a resource path --
 * `/api/issues/{id}/admin/force-release` -- starts with `/api/issues/`, so no
 * prefix matches, and unless the operation is also named in
 * `BOARD_ONLY_OPERATIONS` it is published as `board_or_agent` with an
 * `AgentBearerAuth` security entry while the handler refuses every non-board
 * actor:
 *
 *     if (req.actor.type !== "board") {
 *       res.status(403).json({ error: "Board access required" });
 *
 * That is the class PR #119 closed for the approvals router, and the class
 * `approvals-authorization-contract.test.ts` was added to pin. It fixed three
 * named routes. It could not fix the shape, because the prefix list is a guess
 * about where admins live in a URL and a nested `/admin/` under a resource path
 * defeats it.
 *
 * So this file pins the gate instead of the list, using the same method as the
 * approvals contract test: the set of nested-admin operations is read out of the
 * route source and the spec is asserted against it, so a new nested admin route
 * fails here whether or not anybody remembers the prefix list.
 *
 * Two things this deliberately does not do, both of which would be wrong:
 *
 *  - It does not sweep every `assertBoardOrgAccess` call in the router. That
 *    callee is a company-role check, not a board-only gate; sweeping it would
 *    reclassify routes that agents holding a company role are meant to reach.
 *  - It does not assert refusal by calling a route. The approvals contract test
 *    can, because it mounts the real router. Mounting `issuesRoutes` here would
 *    drag in the whole service graph, and a stub asserting 403 would only assert
 *    the stub. Reading the gate out of the real source is the stronger check: if
 *    the gate is removed, or a new gated route is added, this set moves.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, "../routes");
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

const ROUTE_LITERAL_PATTERN =
  /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const BOARD_GATE_CALLEE_PATTERN =
  /\bassertBoard\s*\(|\bassertInstanceAdmin\s*\(|\bactor\.type\s*!==\s*"board"/;

const BOARD_ONLY_SECURITY = [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }];

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
 * True for an `admin` segment nested under a resource path, which is the shape
 * `BOARD_ONLY_PREFIXES` cannot see. `/api/admin/users` is the top-level admin
 * surface and the prefix list does match it, so it is not what this file is for.
 */
function isNestedAdminPath(routePath: string) {
  return routePath
    .split("/")
    .some((segment, index) => segment === "admin" && index > 1);
}

/**
 * Board-gated operations carrying a nested `/admin/` segment, read from the
 * route source as `METHOD /api/path` in OpenAPI path form. Sorted so failure
 * output is stable.
 */
function readNestedAdminOperations() {
  const operations = new Set<string>();

  for (const file of fs.readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    for (const match of source.matchAll(ROUTE_LITERAL_PATTERN)) {
      const routePath = `/api${normalizeExpressPath(match[2]!)}`;
      if (!isNestedAdminPath(routePath)) continue;
      const body = readHandlerBody(source, match);
      if (body === null) continue;
      if (!BOARD_GATE_CALLEE_PATTERN.test(body)) continue;
      operations.add(`${match[1]!.toUpperCase()} ${routePath}`);
    }
  }

  return [...operations].sort();
}

function specOperation(spec: any, operation: string) {
  const [method, routePath] = operation.split(" ");
  return spec.paths?.[routePath]?.[method.toLowerCase()];
}

describe("nested /admin/ route authorization contract", () => {
  it("declares every nested /admin/ operation board-only", () => {
    const spec = buildOpenApiSpec() as any;
    const nestedAdmin = readNestedAdminOperations();

    // Guards the guard. If the route source stops parsing, the derived set
    // would empty out and this file would pass while testing nothing.
    expect(nestedAdmin).toContain("POST /api/issues/{id}/admin/force-release");

    const misdeclared: string[] = [];
    for (const operation of nestedAdmin) {
      const doc = specOperation(spec, operation);
      if (!doc) {
        misdeclared.push(
          `${operation} is gated to the board in the route source but is absent from the spec`,
        );
        continue;
      }
      const authz = doc["x-paperclip-authorization"];
      if (authz?.actor !== "board") {
        misdeclared.push(
          `${operation} is board-gated but the spec declares ${JSON.stringify(authz)}`,
        );
      }
      // The security array is the other half of what an agent reads before it
      // decides whether it can call the route, so a corrected actor with a
      // leftover AgentBearerAuth entry is still a wrong document.
      if (JSON.stringify(doc.security) !== JSON.stringify(BOARD_ONLY_SECURITY)) {
        misdeclared.push(
          `${operation} is board-only but still advertises ${JSON.stringify(doc.security)}`,
        );
      }
    }

    expect(misdeclared).toEqual([]);
  });

  it("exposes every nested /admin/ operation the route source registers", () => {
    const spec = buildOpenApiSpec() as any;
    const documented = new Set<string>();
    for (const [routePath, pathItem] of Object.entries<any>(spec.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        if (pathItem[method]) documented.add(`${method.toUpperCase()} ${routePath}`);
      }
    }

    expect(readNestedAdminOperations().filter((op) => !documented.has(op))).toEqual([]);
  });

  it("keeps force-release board-only, which is the route that stranded a critical issue", () => {
    // Spelled out on its own as well as swept above, so the regression this
    // file was written for names itself in the failure output rather than
    // appearing as one line of a list.
    const spec = buildOpenApiSpec() as any;
    const doc = spec.paths?.["/api/issues/{id}/admin/force-release"]?.post;

    expect(doc?.["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(doc?.security).toEqual(BOARD_ONLY_SECURITY);
    // It is a read-modify-write returning the released issue, not a creation:
    // the handler ends in `res.json(result)`, a 200. Listed in
    // CREATED_OPERATIONS it would advertise a 201 the route never sends.
    const responses = Object.keys(doc?.responses ?? {});
    expect(responses).toContain("200");
    expect(responses).not.toContain("201");
  });

  it("declares the sibling tree-hold release board-only, as its assertBoard gate requires", () => {
    // Registered in the same `/api/issues/{id}/...` block as force-release and
    // gated by assertBoard, but with no `/admin/` segment for the prefix list to
    // key on, which is why the sweep above cannot be the only guard.
    const spec = buildOpenApiSpec() as any;
    const doc = spec.paths?.["/api/issues/{id}/tree-holds/{holdId}/release"]?.post;

    expect(doc?.["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(doc?.security).toEqual(BOARD_ONLY_SECURITY);
  });
});
