import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOpenApiSpec, BOARD_ONLY_DECLARED_OPERATIONS } from "../routes/openapi.js";
import { deriveRouteActorGates } from "./helpers/route-authz-derivation.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { agentService } from "../services/agents.js";

/**
 * The generated document's `x-paperclip-authorization` claim must equal the
 * gate the route actually applies, for every route in the server — not only
 * for the router that happened to drift first.
 *
 * `approvals-authorization-contract.test.ts` pins this for the approvals
 * router. This file is the same contract over `server/src/routes/` as a whole,
 * with the coordinate derived the way Express derives it: mount points from
 * `app.ts`, path from the literal the route registers, and the gate read out of
 * the handler's own AST with the request actor substituted as an agent.
 *
 * The derivation is one-sided on purpose. It reports `board` only when it can
 * prove every agent request reaches a denial, and `ambiguous` otherwise, so a
 * gate behind a condition the analysis cannot resolve keeps the declaration it
 * has today. That is the safe direction: an operation declared `board` is
 * dropped from the runner API catalog, so a false positive silently removes a
 * tool from an agent, while a missed promotion only misleads.
 *
 * Three properties are asserted:
 *
 *  1. Every operation the derivation proves board-gated is declared `board` in
 *     the document. This is the drift guard — adding `assertBoard(req)` to a
 *     handler and forgetting the declaration fails here rather than in an
 *     agent's tool surface.
 *  2. No operation the derivation proves agent-callable is declared `board`.
 *     A promotion the analysis got wrong is caught in the expensive direction.
 *  3. Every derived board-gated operation really does refuse an agent bearer
 *     key at runtime. This is the ground truth (1) is compared against; the
 *     static analysis is a fast proxy for it, not a substitute.
 *
 * The one place the two disagree is instructive rather than a failure: a
 * `try`/`catch` around a provable gate, or a gate reached only after a
 * resource lookup, is `ambiguous` by construction and is left declared as it is.
 * The runtime probe below covers those too, so a genuinely board-gated
 * operation in that class is still proven — it just needs the evidence recorded
 * here rather than a silent pass.
 */

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** A 403 body that names the actor rule, i.e. the gate's own refusal. */
const ACTOR_DENIAL = /\bBoard access required\b|\bInstance admin access required\b|board|admin/i;

/**
 * Operations the derivation proves board-gated but whose runtime probe is
 * refused *before* the actor gate, with the status and message observed on
 * 2026-09-27. Each entry names the layer that answers first, because that layer
 * is why the probe cannot produce an actor 403 for it:
 *
 *  - `body-not-expressible` — the route's zod schema carries a `.refine()` the
 *    generated OpenAPI schema cannot express, so no body built from the
 *    published document can satisfy `validate()`.
 *  - `auth-before-gate` — instance-admin routes behind auth middleware that
 *    answers 401 for a bearer key the gate itself never sees.
 *  - `resource-before-gate` — the handler resolves a resource first, so an agent
 *    key that does not own one gets a 404 instead of the 403.
 *  - `feature-flag-before-gate` — a capability check answers 403 first, so the
 *    route is refused for a reason that is not the actor rule.
 *  - `not-mounted-in-harness` — the route mounts only under a service option
 *    the test server does not set, so the request 404s at the app.
 *
 * Every entry is still a refusal, so the `board` declaration holds; it just is
 * not evidence for the gate itself. The list is an assertion, not an escape
 * hatch: a new board-gated route landing in this bucket fails here, and an entry
 * that starts reaching the gate fails here too, so it has to be re-checked and
 * removed rather than left to rot.
 */
const REFUSED_BEFORE_THE_GATE: ReadonlyArray<{
  key: string;
  status: number;
  message: string;
  reason:
    | "body-not-expressible"
    | "auth-before-gate"
    | "resource-before-gate"
    | "feature-flag-before-gate"
    | "not-mounted-in-harness";
}> = [
  {
    key: "DELETE /api/companies/{companyId}/slack/endpoints/{endpointId}/search",
    status: 403,
    message: "Chat connectors are disabled",
    reason: "feature-flag-before-gate",
  },
  {
    key: "DELETE /api/issues/{id}/queued-comments/{commentId}",
    status: 400,
    message: "Validation error",
    reason: "body-not-expressible",
  },
  {
    key: "DELETE /api/tool-applications/{applicationId}",
    status: 404,
    message: "Tool application not found",
    reason: "resource-before-gate",
  },
  {
    key: "DELETE /api/tool-connections/{connectionId}",
    status: 404,
    message: "Tool connection not found",
    reason: "resource-before-gate",
  },
  {
    key: "DELETE /api/tool-profile-entries/{entryId}",
    status: 404,
    message: "Tool profile entry not found",
    reason: "resource-before-gate",
  },
  {
    key: "DELETE /api/tool-profiles/{profileId}",
    status: 404,
    message: "Tool profile not found",
    reason: "resource-before-gate",
  },
  {
    key: "GET /api/admin/users",
    status: 401,
    message: "Unauthorized",
    reason: "auth-before-gate",
  },
  {
    key: "GET /api/admin/users/{userId}/company-access",
    status: 401,
    message: "Unauthorized",
    reason: "auth-before-gate",
  },
  {
    key: "GET /api/companies/{companyId}/slack/endpoints/{endpointId}/capabilities",
    status: 403,
    message: "Chat connectors are disabled",
    reason: "feature-flag-before-gate",
  },
  {
    key: "GET /api/companies/{companyId}/slack/endpoints/{endpointId}/search",
    status: 403,
    message: "Chat connectors are disabled",
    reason: "feature-flag-before-gate",
  },
  {
    key: "GET /api/slack/search/callback",
    status: 403,
    message: "Chat connectors are disabled",
    reason: "feature-flag-before-gate",
  },
  {
    key: "PATCH /api/companies/{companyId}/tools/policies/{policyId}",
    status: 400,
    message: "Validation error",
    reason: "body-not-expressible",
  },
  {
    key: "PATCH /api/tool-applications/{applicationId}",
    status: 400,
    message: "Validation error",
    reason: "body-not-expressible",
  },
  {
    key: "PATCH /api/tool-connections/{connectionId}",
    status: 400,
    message: "Validation error",
    reason: "body-not-expressible",
  },
  {
    key: "PATCH /api/tool-profile-entries/{entryId}",
    status: 400,
    message: "Validation error",
    reason: "body-not-expressible",
  },
  {
    key: "PATCH /api/tool-profiles/{profileId}",
    status: 400,
    message: "Validation error",
    reason: "body-not-expressible",
  },
  {
    key: "POST /api/admin/users/{userId}/demote-instance-admin",
    status: 401,
    message: "Unauthorized",
    reason: "auth-before-gate",
  },
  {
    key: "POST /api/admin/users/{userId}/promote-instance-admin",
    status: 401,
    message: "Unauthorized",
    reason: "auth-before-gate",
  },
  {
    key: "POST /api/companies/{companyId}/email/inboxes",
    status: 400,
    message: "Validation error",
    reason: "body-not-expressible",
  },
  {
    key: "POST /api/companies/{companyId}/me/user-secrets",
    status: 400,
    message: "Validation error",
    reason: "body-not-expressible",
  },
  {
    key: "POST /api/companies/{companyId}/me/user-secrets/{secretId}/rotate",
    status: 400,
    message: "Validation error",
    reason: "body-not-expressible",
  },
  {
    key: "POST /api/companies/{companyId}/slack/endpoints/{endpointId}/search/connect",
    status: 403,
    message: "Chat connectors are disabled",
    reason: "feature-flag-before-gate",
  },
  {
    key: "POST /api/companies/{companyId}/tools/apps/connect",
    status: 400,
    message: "Validation error",
    reason: "body-not-expressible",
  },
  {
    key: "POST /api/companies/{companyId}/tools/apps/{connectionId}/finalize-oauth-access",
    status: 404,
    message: "Tool connection not found",
    reason: "resource-before-gate",
  },
  {
    key: "POST /api/companies/{companyId}/tools/apps/{connectionId}/finish",
    status: 404,
    message: "Tool connection not found",
    reason: "resource-before-gate",
  },
  {
    key: "POST /api/email/inboxes/{endpointId}/control",
    status: 404,
    message: "Email inbox not found",
    reason: "resource-before-gate",
  },
  {
    key: "POST /api/email/inboxes/{endpointId}/reconnect",
    status: 404,
    message: "Email inbox not found",
    reason: "resource-before-gate",
  },
  {
    key: "POST /api/execution-workspaces/{id}/reconcile-branch",
    status: 404,
    message: "Execution workspace not found",
    reason: "resource-before-gate",
  },
  {
    key: "POST /api/instance/database-backups",
    status: 404,
    message: "API route not found",
    reason: "not-mounted-in-harness",
  },
  {
    key: "POST /api/tool-connections/{connectionId}/catalog/refresh",
    status: 404,
    message: "Tool connection not found",
    reason: "resource-before-gate",
  },
  {
    key: "POST /api/tool-connections/{connectionId}/reconnect",
    status: 404,
    message: "Tool connection not found",
    reason: "resource-before-gate",
  },
  {
    key: "POST /api/tool-profiles/{profileId}/duplicate",
    status: 404,
    message: "Tool profile not found",
    reason: "resource-before-gate",
  },
  {
    key: "POST /api/tool-profiles/{profileId}/entries",
    status: 404,
    message: "Tool profile not found",
    reason: "resource-before-gate",
  },
  {
    key: "POST /api/tool-profiles/{profileId}/new-tools/review",
    status: 404,
    message: "Tool profile not found",
    reason: "resource-before-gate",
  },
  {
    key: "PUT /api/admin/users/{userId}/company-access",
    status: 401,
    message: "Unauthorized",
    reason: "auth-before-gate",
  },
  {
    key: "PUT /api/companies/{companyId}/slack/endpoints/{endpointId}/search",
    status: 403,
    message: "Chat connectors are disabled",
    reason: "feature-flag-before-gate",
  },
  {
    key: "PUT /api/projects/{id}/repositories",
    status: 400,
    message: "Validation error",
    reason: "body-not-expressible",
  },

];

type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
};

type SpecOperation = {
  "x-paperclip-authorization"?: { actor?: string };
  security?: unknown;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
};

function buildSpec(): {
  paths: Record<string, Record<string, SpecOperation>>;
  schemas: Record<string, JsonSchema>;
} {
  const spec = buildOpenApiSpec() as unknown as {
    paths: Record<string, Record<string, SpecOperation>>;
    components?: { schemas?: Record<string, JsonSchema> };
  };
  return { paths: spec.paths ?? {}, schemas: spec.components?.schemas ?? {} };
}

function documentedActors(): Map<string, string> {
  const { paths } = buildSpec();
  const actors = new Map<string, string>();
  for (const [routePath, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation) actors.set(`${method.toUpperCase()} ${routePath}`, operation["x-paperclip-authorization"]?.actor ?? "");
    }
  }
  return actors;
}

function resolveRef(schema: JsonSchema, schemas: Record<string, JsonSchema>): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split("/").pop() ?? "";
  return schemas[name] ?? schema;
}

/**
 * Build the smallest body a route's own `validate()` will accept, from the
 * schema the document publishes for it. Hand-written bodies rot the moment a
 * schema gains a required field, and a 400 from `validate()` short-circuits
 * ahead of the actor gate — the probe would then report a 400 for a route that
 * gates correctly, which is a false failure and trains the reader to ignore it.
 */
function minimalBody(schema: JsonSchema | undefined, schemas: Record<string, JsonSchema>): unknown {
  if (!schema) return {};
  const resolved = resolveRef(schema, schemas);
  for (const branch of [...(resolved.anyOf ?? []), ...(resolved.oneOf ?? [])]) {
    const candidate = minimalBody(branch, schemas);
    if (candidate !== undefined) return candidate;
  }
  if (resolved.allOf?.length) {
    const merged: Record<string, unknown> = {};
    for (const branch of resolved.allOf) {
      const value = minimalBody(branch, schemas);
      if (value && typeof value === "object" && !Array.isArray(value)) Object.assign(merged, value);
    }
    return merged;
  }
  if (resolved.const !== undefined) return resolved.const;
  if (resolved.enum?.length) return resolved.enum[0];
  const type = Array.isArray(resolved.type) ? resolved.type[0] : resolved.type;
  switch (type) {
    case "string": {
      if (resolved.format === "uuid") return randomUUID();
      if (resolved.format === "date-time") return "2026-01-01T00:00:00.000Z";
      if (resolved.format === "uri") return "https://example.invalid/path";
      // Numeric patterns such as `/^\d+$/` are used for foreign keys whose value
      // the fixture cannot know; a digit satisfies both those and minLength.
      if (resolved.pattern && /^\\?d/.test(resolved.pattern)) return "1";
      return "x".repeat(Math.max(resolved.minLength ?? 1, 1));
    }
    case "number":
    case "integer":
      return resolved.minimum ?? 1;
    case "boolean":
      return true;
    case "array":
      return resolved.items ? [minimalBody(resolved.items, schemas)] : [];
    case "object":
    default: {
      const out: Record<string, unknown> = {};
      for (const key of resolved.required ?? []) {
        out[key] = minimalBody(resolved.properties?.[key], schemas);
      }
      return out;
    }
  }
}

function bodyFor(
  paths: Record<string, Record<string, SpecOperation>>,
  schemas: Record<string, JsonSchema>,
  method: string,
  routePath: string,
): unknown {
  const schema = paths[routePath]?.[method.toLowerCase()]?.requestBody?.content?.["application/json"]?.schema;
  return minimalBody(schema, schemas);
}

describe("route authorization contract", () => {
  it("declares board for every operation whose handler provably board-gates", () => {
    const derived = deriveRouteActorGates();
    const actors = documentedActors();

    // Guards the guard: a derivation that silently stops finding routes would
    // make the loop below vacuously pass.
    const provable = derived.filter((op) => op.verdict === "board");
    const agentCallable = derived.filter((op) => op.verdict === "board_or_agent");
    expect(provable.length).toBeGreaterThan(100);
    expect(agentCallable.length).toBeGreaterThan(100);

    const misdeclared: string[] = [];
    for (const op of provable) {
      const actor = actors.get(op.key);
      const denial = op.denials.find((denial) => denial.provable);
      if (actor === undefined) {
        misdeclared.push(`${op.key} is registered at ${op.file}:${op.line} but absent from the document`);
        continue;
      }
      if (actor !== "board") {
        misdeclared.push(
          `${op.key} calls ${denial?.detail ?? "a board gate"} at ${op.file}:${denial?.line ?? op.line} but the document declares actor "${actor}"`,
        );
      }
    }
    expect(misdeclared).toEqual([]);
  });

  it("does not declare board for an operation the derivation proves agent-callable", () => {
    const actors = documentedActors();
    const agentCallable = deriveRouteActorGates().filter((op) => op.verdict === "board_or_agent");
    // These are declared board by routes whose gate the analysis cannot see —
    // router-level middleware, a helper in another file, a resource condition.
    // They are allowed through `BOARD_ONLY_PREFIXES` and the hand-maintained
    // set, and dropping them would remove a working tool from an agent, so the
    // assertion is that the set is small and named, not that it is empty.
    const undocumented = agentCallable
      .map((op) => op.key)
      .filter((key) => actors.get(key) === "board")
      .filter((key) => !BOARD_ONLY_DECLARED_OPERATIONS.has(key))
      .filter((key) => !["/api/announcements/", "/api/auth/", "/api/admin/", "/api/plugins", "/api/instance/"].some((prefix) => key.split(" ")[1]!.startsWith(prefix)));

    expect(undocumented).toEqual([]);
  });

  it("refuses an agent bearer key on every operation the derivation proves board-gated", async () => {
    const server = await startRunnerApiTestServer();
    try {
      const fixture = await server.fixture({ conversation: true });
      const created = (await agentService(server.db).createApiKey(
        fixture.agentId,
        "route-authorization-contract",
        { kind: "standard" },
        { responsibleUserId: fixture.responsibleUserId },
      )) as unknown as { token: string };

      const provable = deriveRouteActorGates().filter((op) => op.verdict === "board");
      expect(provable.length).toBeGreaterThan(100);

      // The three operations whose zod schema is stricter than the schema the
      // document publishes for it, so no body derived from the document passes
      // `validate()`. Everything else is served by `bodyFor` above.
      const validationBypassingBodies: Record<string, unknown> = {
        "POST /api/companies/{companyId}/secrets": { name: "contract", key: "CONTRACT_KEY", value: "v" },
        "POST /api/secrets/{id}/rotate": { value: "v" },
        "PUT /api/tool-connections/{connectionId}/grants/{grantId}/members": { memberUserIds: [] },
      };

      const ids: Record<string, string> = {
        companyId: fixture.companyId,
        agentId: fixture.agentId,
        agent: fixture.agentId,
        id: fixture.issueId,
        issueId: fixture.issueId,
        runId: fixture.runId,
        projectId: fixture.projectId,
        approvalId: fixture.approvalId,
        goalId: fixture.goalId,
        type: "paperclip_runner",
      };

      const { paths, schemas } = buildSpec();

      const notRefused: string[] = [];
      const refusedBeforeTheGate: Array<{ key: string; status: number; message: string; at: string }> = [];
      const refusalsAtTheGate: string[] = [];

      for (const op of provable) {
        const [method, template] = op.key.split(" ") as [string, string];
        const concrete = template.replace(/\{([^}]+)\}/g, (_m, name: string) => ids[name] ?? randomUUID());
        // A route's `validate()` middleware runs ahead of its actor gate, so a
        // body the schema rejects is refused with a 400 that says nothing about
        // the gate. The body is therefore built from the document the route
        // itself publishes, falling back to a hand-written one only where the
        // published schema is a lossy projection of the zod schema.
        const body = validationBypassingBodies[op.key] ?? bodyFor(paths, schemas, method, template);
        const payload = body === undefined ? undefined : JSON.stringify(body).replaceAll("<companyId>", fixture.companyId);
        const res = await fetch(`${server.apiUrl}${concrete}`, {
          method,
          headers: {
            Authorization: `Bearer ${created.token}`,
            "content-type": "application/json",
            "x-paperclip-run-id": fixture.runId,
          },
          body: method === "GET" || method === "DELETE" ? undefined : (payload ?? "{}"),
        });
        const text = await res.text();
        let message = text.slice(0, 200).replace(/\s+/g, " ");
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (parsed && typeof parsed.error === "string") message = parsed.error;
        } catch {
          /* non-JSON body */
        }
        if (res.status === 403) {
          // A 403 from a tenant or resource check is not the actor gate, so the
          // message has to name the actor rule for the 403 to be evidence.
          if (ACTOR_DENIAL.test(message)) refusalsAtTheGate.push(op.key);
          else refusedBeforeTheGate.push({ key: op.key, status: res.status, message, at: `${op.file}:${op.line}` });
          continue;
        }
        if (res.status >= 200 && res.status < 400) {
          notRefused.push(`${op.key} -> ${res.status} ${message} (${op.file}:${op.line})`);
          continue;
        }
        // The agent was refused, but by a layer ahead of the actor gate: the
        // zod body check, the auth middleware, or a resource lookup. That is
        // still a refusal, so the `board` declaration holds, but it is not
        // evidence for the gate itself — so it is named rather than ignored.
        refusedBeforeTheGate.push({ key: op.key, status: res.status, message, at: `${op.file}:${op.line}` });
      }

      expect(notRefused).toEqual([]);
      expect(
        refusedBeforeTheGate
          .map(({ key, status, message }) => ({ key, status, message }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      ).toEqual(
        [...REFUSED_BEFORE_THE_GATE].map(({ key, status, message }) => ({ key, status, message })).sort((a, b) =>
          a.key.localeCompare(b.key),
        ),
      );
      // The named bucket must stay a small minority, or the test degrades into
      // asserting nothing: it would pass with every operation excused. Measured
      // 2026-09-27 against master at 252 of the 289 derived operations refusing
      // at the actor gate itself, the other 37 being the entries named above.
      expect(refusalsAtTheGate.length).toBeGreaterThanOrEqual(provable.length - REFUSED_BEFORE_THE_GATE.length);
    } finally {
      await server.close();
    }
  }, 900_000);
});
