/**
 * Derives the actor gate each Express route actually applies, by reading the
 * route source instead of restating it.
 *
 * Why this exists: `server/src/routes/openapi.ts` publishes
 * `x-paperclip-authorization` per operation, and the native runtime copies
 * that field into the runner API catalog, which is what an agent reads before
 * it picks an endpoint. The declaration used to be a hand-maintained set
 * (`BOARD_ONLY_OPERATIONS`) with nothing failing when a route and its
 * declaration drifted apart, so ~108 operations advertised
 * `actor: "board_or_agent"` for handlers that 403 every agent caller.
 *
 * The derivation is deliberately one-sided. A route is reported `board` only
 * when the analysis *proves* every agent request reaches a denial; a denial
 * that sits behind a branch the analysis cannot resolve is reported
 * `ambiguous` so the caller keeps the existing declaration. An operation
 * declared `board` is dropped from the runner catalog, so a false positive
 * silently removes a tool from an agent — that is the expensive failure, and
 * this module is built to fail toward the cheap one.
 *
 * The two false-positive classes the original sweep hit are handled by
 * construction rather than by list curation:
 *
 *  - Conditional gates. A denial is judged against the branch conditions
 *    enclosing it, evaluated with the request actor substituted as an agent.
 *    `if (req.actor.type === "agent") { serve(); } else { assertBoard(req) }`
 *    leaves the gate unreachable by an agent, while
 *    `if (req.actor.type === "agent") { deny(); return; } assertBoard(req)`
 *    is provable. A gate behind a *resource* condition — an external
 *    instructions bundle, a `bootstrap_ceo` invite, a `false_positive`
 *    recovery outcome — is `ambiguous`, because the analysis does not model
 *    what any given request carries.
 *  - Path derivation. Mount points come from `app.ts` and the path from the
 *    literal Express itself matches, including template literals resolved
 *    through module-level string constants, so a handler registered under two
 *    paths yields two coordinates.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

// ─── Minimal AST shape ───────────────────────────────────────────────────────
// oxc-parser emits ESTree. Only the node fields this module reads are typed.

type Node = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
]);

/** Board gates from `server/src/routes/authz.ts`: an agent caller gets a hard 403. */
const BOARD_GATE_CALLEES = new Set([
  "assertBoard",
  "assertBoardOrgAccess",
  "assertInstanceAdmin",
]);

/**
 * Non-gates, listed so a same-named local helper cannot be mistaken for the
 * authz vocabulary. `assertBoardOrAgent` permits agents; `assertCompanyAccess`
 * and `assertAuthenticated` are company/identity scope, not actor type.
 */
const NON_GATE_CALLEES = new Set([
  "assertBoardOrAgent",
  "assertCompanyAccess",
  "assertAuthenticated",
  "hasCompanyAccess",
]);

/**
 * Explicit 403 bodies that name the actor rule rather than a resource or a
 * tenant rule. Deliberately narrow: `Viewer access is read-only` and
 * `Agent key cannot access another company` are 403s too, but neither means
 * "this endpoint is not for agents", and promoting on them would drop a tool
 * from the catalog.
 */
const ACTOR_DENIAL_MESSAGE =
  /\bBoard access required\b|\bInstance admin access required\b|\bCompany membership or instance admin access required\b|board-only|board only|\bAgent actors? (cannot|can not|can no longer|may not|must not|are not|aren't)\b/i;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(__dirname, "../..");
const ROUTES_DIR = path.join(SERVER_SRC, "routes");
const APP_FILE = path.join(SERVER_SRC, "app.ts");
const REPO_ROOT = path.resolve(SERVER_SRC, "../..");

// ─── Three-valued agent-condition evaluation ─────────────────────────────────

/** `true` / `false` when decided, `null` when the expression is not modelled. */
export type Tri = true | false | null;

/** The request actor as an agent bearer-key caller sees it. */
const AGENT_ACTOR_VALUES: Record<string, string | boolean | null> = {
  "req.actor.type": "agent",
  "req.actor.source": "agent_key",
  "req.actor.isInstanceAdmin": false,
  "req.actor.companyId": "<agent-company>",
  "req.actor.agentId": "<agent-id>",
  "req.actor.runId": "<run-id>",
  "req.actor.userId": null,
  "req.actor.onBehalfOfUserId": null,
};

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function propertyName(member: Node): string | null {
  const property = member.property as Node | undefined;
  if (!property) return null;
  if (property.type === "Identifier") return property.name as string;
  if (property.type === "Literal" && typeof property.value === "string") return property.value;
  return null;
}

/** Renders a property-access chain such as `req.actor.type` back to source text. */
function memberPath(node: Node): string | null {
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "MemberExpression") {
    const name = propertyName(node);
    return name === null ? null : `${memberPath(node.object as Node) ?? "?"}.${name}`;
  }
  return null;
}

function knownValue(node: Node): string | boolean | null | undefined {
  if (node.type === "Literal") return node.value as string | boolean | null;
  if (node.type === "Identifier" && (node.name === "undefined" || node.name === "void")) {
    return undefined;
  }
  if (node.type === "TemplateLiteral") {
    if ((node.expressions as unknown[] | undefined)?.length) return undefined;
    return cooked(node);
  }
  if (node.type === "UnaryExpression" && node.operator === "void") return undefined;
  if (node.type === "MemberExpression") {
    const asPath = memberPath(node);
    return asPath !== null && asPath in AGENT_ACTOR_VALUES
      ? AGENT_ACTOR_VALUES[asPath]
      : undefined;
  }
  return undefined;
}

function cooked(template: Node): string {
  const quasis = (template.quasis as Node[] | undefined) ?? [];
  return quasis
    .map((quasi) => (quasi.value as { cooked?: string } | undefined)?.cooked ?? "")
    .join("");
}

/**
 * Evaluates a condition with the request actor substituted as an agent, using
 * Kleene logic. `null` is what keeps a genuinely agent-callable route from
 * being promoted: it means the expression reached something the model does
 * not cover.
 */
export function evaluateForAgent(node: unknown): Tri {
  if (!isNode(node)) return null;

  if (node.type === "Literal") {
    return typeof node.value === "boolean" ? (node.value as Tri) : null;
  }
  if (node.type === "Identifier") {
    if (node.name === "true") return true;
    if (node.name === "false") return false;
    if (node.name === "null" || node.name === "undefined") return false;
    return null;
  }
  if (node.type === "UnaryExpression") {
    if (node.operator !== "!") return null;
    const inner = evaluateForAgent(node.argument);
    return inner === null ? null : !inner;
  }
  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    const operator = node.operator as string;
    if (operator === "&&" || operator === "||") {
      const left = evaluateForAgent(node.left);
      const right = evaluateForAgent(node.right);
      if (operator === "&&") {
        if (left === false || right === false) return false;
        if (left === true && right === true) return true;
        return null;
      }
      if (left === true || right === true) return true;
      if (left === false && right === false) return false;
      return null;
    }
    if (operator === "===" || operator === "!==" || operator === "==" || operator === "!=") {
      const left = knownValue(node.left as Node);
      const right = knownValue(node.right as Node);
      if (left === undefined || right === undefined) return null;
      const equal = left === right;
      return operator === "===" || operator === "==" ? equal : !equal;
    }
    return null;
  }
  if (node.type === "ConditionalExpression") {
    const test = evaluateForAgent(node.test);
    if (test === null) return null;
    return test ? evaluateForAgent(node.consequent) : evaluateForAgent(node.alternate);
  }
  return null;
}

const negate = (value: Tri): Tri => (value === null ? null : !value);

// ─── Denial sites ───────────────────────────────────────────────────────────

export type DenialKind = "board-gate" | "actor-403";

export type DenialSite = {
  kind: DenialKind;
  line: number;
  /** An agent request can reach this statement. */
  reachable: boolean;
  /** Every enclosing condition is decided, so an agent always reaches it. */
  provable: boolean;
  detail: string;
};

function lineOf(source: string, node: Node): number {
  return source.slice(0, node.start).split("\n").length;
}

function calleeName(node: Node): string | null {
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "MemberExpression" && !node.computed) return propertyName(node);
  return null;
}

/** The literal `error`/`message` string of an object literal, if it has one. */
function objectMessage(object: Node): string | null {
  for (const property of (object.properties as Node[] | undefined) ?? []) {
    if (property.type !== "Property") continue;
    // An object-literal entry names its field in `key`, not in `property`.
    const key = property.key as Node | undefined;
    if (key?.type !== "Identifier" && (key?.type !== "Literal" || typeof key.value !== "string")) {
      continue;
    }
    const name = key.type === "Identifier" ? (key.name as string) : (key.value as string);
    if (name !== "error" && name !== "message") continue;
    const value = property.value as Node;
    if (value.type === "Literal" && typeof value.value === "string") return value.value;
  }
  return null;
}

/** The literal text of a single argument, whether a string or a body object. */
function messageValue(node: Node | null | undefined): string | null {
  if (!isNode(node)) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    return (node.expressions as unknown[] | undefined)?.length ? null : cooked(node);
  }
  if (node.type === "ObjectExpression") return objectMessage(node);
  return null;
}

/** The literal error/message text of a denial, or null when it is computed. */
function messageArgument(node: Node): string | null {
  return messageValue((node.arguments as Node[] | undefined)?.[0]);
}

/** `res.status(403).json(body)` / `response.status(403).send(body)` and friends. */
const RESPONDER_METHODS = new Set(["json", "send", "jsonp", "end", "write"]);

/** Walks a member/call chain down to the object a `status()` was called on. */
function responderName(node: Node): string | null {
  let current: Node | undefined = node;
  while (current) {
    if (current.type === "Identifier") return current.name as string;
    if (current.type === "MemberExpression") {
      current = current.object as Node;
      continue;
    }
    if (current.type === "CallExpression") {
      current = current.callee as Node;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Recognises a 403 that names the actor rule:
 *   res.status(403).json({ error: "…board-only…" })
 *   res.status(403).send("…")
 *   throw forbidden("Board access required")
 *   throw new HttpError(403, "Board access required")
 */
export function actorDenialIn(node: Node | null | undefined): string | null {
  if (!isNode(node) || node.type !== "CallExpression") return null;
  const callee = node.callee as Node;
  const name = calleeName(callee);

  if (name === "forbidden") {
    const message = messageArgument(node);
    return message !== null && ACTOR_DENIAL_MESSAGE.test(message) ? message : null;
  }
  if (callee.type === "NewExpression" && calleeName(callee.callee as Node) === "HttpError") {
    const status = (node.arguments as Node[] | undefined)?.[0];
    if (!status || status.type !== "Literal" || status.value !== 403) return null;
    const message = messageArgument(node);
    return message !== null && ACTOR_DENIAL_MESSAGE.test(message) ? message : null;
  }

  // `res.status(403)` on its own carries no message, so the denial can only be
  // confirmed from the responder call that wraps it — that is the node the
  // walker is looking at, not the inner `res.status(403)`.
  const response = (node.arguments as Node[] | undefined)?.[0];
  if (
    name !== null &&
    RESPONDER_METHODS.has(name) &&
    callee.type === "MemberExpression" &&
    isNode(callee.object) &&
    callee.object.type === "CallExpression"
  ) {
    const statusCall = callee.object as Node;
    const statusCallee = statusCall.callee as Node;
    if (
      statusCallee.type === "MemberExpression" &&
      propertyName(statusCallee) === "status" &&
      responderName(statusCallee.object as Node) !== null &&
      ["res", "response"].includes(responderName(statusCallee.object as Node)!)
    ) {
      const status = (statusCall.arguments as Node[] | undefined)?.[0];
      if (!status || status.type !== "Literal" || status.value !== 403) return null;
      const message = messageValue(response);
      return message !== null && ACTOR_DENIAL_MESSAGE.test(message) ? message : null;
    }
  }
  return null;
}

/** The expression a `throw`/`return` statement forwards, if any. */
function forwardedExpression(statement: Node): Node | null {
  if (statement.type === "ExpressionStatement") {
    const expression = statement.expression as Node;
    if (expression.type === "UnaryExpression" && expression.operator === "throw") {
      return expression.argument as Node;
    }
    return null;
  }
  if (statement.type === "ReturnStatement") {
    return (statement.argument as Node | null) ?? null;
  }
  return null;
}

function isFunctionNode(node: Node): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

const SKIPPED_KEYS = new Set(["type", "start", "end"]);

function childNodes(node: Node): Node[] {
  const children: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_KEYS.has(key)) continue;
    if (isNode(value)) children.push(value);
    else if (Array.isArray(value)) {
      for (const entry of value) if (isNode(entry)) children.push(entry);
    }
  }
  return children;
}

// ─── Handler classification ─────────────────────────────────────────────────

export type HandlerVerdict = "board" | "board_or_agent" | "ambiguous";

export type HandlerAnalysis = { verdict: HandlerVerdict; denials: DenialSite[] };

/**
 * A function reachable by name from a handler, with the source positions of its
 * first parameter. Board gates are conventionally `assert*(req)`, so knowing
 * which parameter receives the request is all the linking this needs.
 */
type LinkableFunction = { node: Node; firstParam: string | null };

/** How a call into another function in the same file affects the verdict. */
type HelperLink =
  | { kind: "none" }
  | { kind: "board-gate"; detail: string }
  | { kind: "ambiguous"; detail: string };

function firstParamName(node: Node): string | null {
  const params = (node.params as Node[] | undefined) ?? [];
  const first = params[0];
  return first?.type === "Identifier" ? (first.name as string) : null;
}

const MAX_HELPER_DEPTH = 4;

/**
 * Classifies a call to another function in the same file by analyzing that
 * function's own body.
 *
 * The link is deliberately narrow, because a wrong `board` here removes a tool
 * from the runner catalog. The call must pass the handler's request parameter
 * as the callee's first parameter, and the callee must contain a denial that is
 * provable from its own entry — a denial behind a branch the callee resolves
 * only for itself is reported `ambiguous` so the caller keeps its current
 * declaration.
 */
function linkHelper(
  callee: string,
  callArgs: Node[],
  handlerRequestParam: string | null,
  functions: Map<string, LinkableFunction>,
  depth: number,
): HelperLink {
  const target = functions.get(callee);
  if (!target || depth > MAX_HELPER_DEPTH) return { kind: "none" };
  if (target.firstParam === null) return { kind: "none" };

  const firstArg = callArgs[0];
  if (!firstArg || firstArg.type !== "Identifier") return { kind: "none" };
  if (firstArg.name !== handlerRequestParam) return { kind: "none" };

  const analysis = analyzeHandler(target.node, "", functions, depth + 1);
  const provable = analysis.denials.find((denial) => denial.provable);
  if (provable) return { kind: "board-gate", detail: `${callee}(…) → ${provable.detail}` };
  const reachable = analysis.denials.find((denial) => denial.reachable);
  if (reachable) return { kind: "ambiguous", detail: `${callee}(…) → ${reachable.detail}` };
  return { kind: "none" };
}

/**
 * Walks one handler body, collecting every board denial together with the
 * branch conditions an agent request satisfies on the way to it.
 */
export function analyzeHandler(
  handler: Node,
  source: string,
  functions: Map<string, LinkableFunction> = new Map(),
  depth = 0,
): HandlerAnalysis {
  const found: Array<{ kind: DenialKind; line: number; guards: Tri[]; detail: string }> = [];
  const params = (handler.params as Node[] | undefined) ?? [];
  const requestParam = params[0]?.type === "Identifier" ? (params[0].name as string) : "req";

  const record = (kind: DenialKind, node: Node, guards: Tri[], detail: string) => {
    found.push({ kind, line: lineOf(source, node), guards: [...guards], detail });
  };

  const visit = (node: unknown, guards: Tri[]) => {
    if (!isNode(node)) return;

    // A nested function may never run, or may run for another actor. Its
    // denials are real but not provable from the request path.
    if (isFunctionNode(node)) {
      for (const child of childNodes(node)) visit(child, [...guards, null]);
      return;
    }

    switch (node.type) {
      case "IfStatement": {
        const test = evaluateForAgent(node.test);
        visit(node.consequent, [...guards, test]);
        if (node.alternate) visit(node.alternate, [...guards, negate(test)]);
        return;
      }
      case "SwitchStatement": {
        // The discriminant picks the case an agent enters and this model does
        // not track it, so denials inside a switch stay ambiguous.
        for (const clause of (node.cases as Node[] | undefined) ?? []) {
          for (const child of childNodes(clause)) visit(child, [...guards, null]);
        }
        return;
      }
      case "ConditionalExpression": {
        const test = evaluateForAgent(node.test);
        visit(node.consequent, [...guards, test]);
        visit(node.alternate, [...guards, negate(test)]);
        return;
      }
      case "WhileStatement":
      case "DoWhileStatement":
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        visit(node.test ?? node.init ?? node.left ?? node.right, guards);
        visit(node.update, guards);
        visit(node.body, [...guards, null]);
        return;
      }
      case "TryStatement": {
        // Without a `catch` nothing can swallow the denial, so guards hold.
        // With one, the handler may continue past the throw — a denial inside
        // a try is never proof that the request stops here.
        if (node.handler) visit(node.block, [...guards, null]);
        else visit(node.block, guards);
        visit(node.handler, [...guards, null]);
        // A `finally` block does run, but its position relative to a denial is
        // not guaranteed, so it contributes no proof either.
        visit(node.finalizer, [...guards, null]);
        return;
      }
      case "LabeledStatement": {
        visit(node.body, guards);
        return;
      }
      case "CallExpression": {
        const name = calleeName(node.callee as Node);
        if (name && BOARD_GATE_CALLEES.has(name) && !NON_GATE_CALLEES.has(name)) {
          record("board-gate", node, guards, `${name}(...)`);
          return;
        }
        const denial = actorDenialIn(node);
        if (denial) {
          record("actor-403", node, guards, denial);
          return;
        }
        if (name && !NON_GATE_CALLEES.has(name)) {
          const link = linkHelper(
            name,
            (node.arguments as Node[] | undefined) ?? [],
            requestParam,
            functions,
            depth,
          );
          if (link.kind === "board-gate") {
            record("board-gate", node, guards, link.detail);
            return;
          }
          if (link.kind === "ambiguous") {
            // The helper's own branch is unresolved, so the denial inherits
            // that unknown: recording it with only the call-site guards would
            // promote a route the helper may well serve to an agent.
            record("actor-403", node, [...guards, null], link.detail);
            return;
          }
        }
        break;
      }
      default:
        break;
    }

    const forwarded = forwardedExpression(node);
    if (forwarded) {
      const denial = actorDenialIn(forwarded);
      if (denial) {
        record("actor-403", node, guards, denial);
        return;
      }
    }

    for (const child of childNodes(node)) visit(child, guards);
  };

  visit(handler.body ?? handler, []);

  const denials: DenialSite[] = found.map((denial) => {
    const reachable = !denial.guards.includes(false);
    return {
      kind: denial.kind,
      line: denial.line,
      reachable,
      // Proof has to survive every guard, including the ones that put the
      // denial out of reach. A denial behind `if (req.actor.type === "agent")
      // { … } else { assertBoard(req) }` sits behind a decided `false` guard:
      // an agent never reaches it, so it proves nothing, and treating it as
      // proof promotes a route the handler serves to agents.
      provable: reachable && !denial.guards.includes(null),
      detail: denial.detail,
    };
  });

  const reachable = denials.filter((denial) => denial.reachable);
  return {
    verdict: reachable.some((denial) => denial.provable)
      ? "board"
      : reachable.length > 0
        ? "ambiguous"
        : "board_or_agent",
    denials,
  };
}

// ─── Route registration scan ────────────────────────────────────────────────

function parseFile(file: string): { source: string; program: Node } {
  const source = fs.readFileSync(file, "utf8");
  const result = parseSync(path.basename(file), source, { lang: "ts" });
  if (result.errors.length > 0) {
    const first = result.errors[0] as { message?: string } | undefined;
    throw new Error(`${file}: parse failed — ${first?.message ?? "unknown error"}`);
  }
  return { source, program: result.program as unknown as Node };
}

/** `const NAME = "literal"` bindings anywhere in the file, resolvable transitively. */
function collectStringConstants(node: Node, into: Map<string, string>, depth = 0): void {
  if (!isNode(node) || depth > 60) return;
  if (node.type === "VariableDeclarator") {
    const id = node.id as Node | undefined;
    const init = node.init as Node | null;
    if (id?.type === "Identifier" && init) {
      const value = knownValue(init);
      if (typeof value === "string") into.set(id.name as string, value);
    }
  }
  for (const child of childNodes(node)) collectStringConstants(child, into, depth + 1);
}

/** Named function declarations and `const NAME = function/arrow` bindings. */
function collectNamedFunctions(node: Node, into: Map<string, LinkableFunction>, depth = 0): void {
  if (!isNode(node) || depth > 60) return;
  if (node.type === "FunctionDeclaration" && isNode(node.id)) {
    into.set((node.id as Node).name as string, { node, firstParam: firstParamName(node) });
  }
  if (node.type === "VariableDeclarator") {
    const id = node.id as Node | undefined;
    const init = node.init as Node | null;
    if (id?.type === "Identifier" && init && isFunctionNode(init)) {
      into.set(id.name as string, { node: init, firstParam: firstParamName(init) });
    }
  }
  for (const child of childNodes(node)) collectNamedFunctions(child, into, depth + 1);
}

/** Resolves a path expression, including `` `/x/${CONST}` `` shapes. */
function resolveString(
  node: unknown,
  constants: Map<string, string>,
  depth = 0,
): string | null {
  if (!isNode(node) || depth > 8) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    const quasis = (node.quasis as Node[] | undefined) ?? [];
    const expressions = (node.expressions as Node[] | undefined) ?? [];
    let out = "";
    for (let i = 0; i < quasis.length; i += 1) {
      out += (quasis[i]!.value as { cooked?: string } | undefined)?.cooked ?? "";
      if (i < expressions.length) {
        const piece = resolveString(expressions[i], constants, depth + 1);
        if (piece === null) return null;
        out += piece;
      }
    }
    return out;
  }
  if (node.type === "Identifier") return constants.get(node.name as string) ?? null;
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "ParenthesizedExpression"
  ) {
    return resolveString(node.expression, constants, depth + 1);
  }
  return null;
}

type Registration = { method: string; routePath: string; handler: Node; line: number };

function scanRegistrations(
  source: string,
): { registrations: Registration[]; functions: Map<string, LinkableFunction> } {
  const { program } = parseFileShallow(source);
  const constants = new Map<string, string>();
  const functions = new Map<string, LinkableFunction>();
  collectStringConstants(program, constants);
  collectNamedFunctions(program, functions);

  const found: Registration[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown) => {
    if (!isNode(node)) return;
    if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      if (callee.type === "MemberExpression" && !callee.computed) {
        const method = (propertyName(callee) ?? "").toLowerCase();
        const args = (node.arguments as Node[] | undefined) ?? [];
        if (HTTP_METHODS.has(method) && args.length >= 2) {
          const routePath = resolveString(args[0], constants);
          // The handler is the last function argument, or an identifier bound
          // to one. A shared handler registered under two paths yields two
          // entries: the coordinate is (method, path), not the function.
          let handler: Node | null = null;
          for (let i = args.length - 1; i >= 1 && !handler; i -= 1) {
            const arg = args[i]!;
            if (isFunctionNode(arg)) handler = arg;
            else if (arg.type === "Identifier") {
              handler = functions.get(arg.name as string)?.node ?? null;
            }
          }
          if (routePath !== null && handler) {
            const key = `${method.toUpperCase()} ${routePath}`;
            if (!seen.has(key)) {
              seen.add(key);
              found.push({
                method: method.toUpperCase(),
                routePath,
                handler,
                line: lineOf(source, node),
              });
            }
          }
        }
      }
    }
    for (const child of childNodes(node)) visit(child);
  };

  visit(program);
  return { registrations: found, functions };
}

const parseFileShallow = (source: string): { program: Node } => {
  const result = parseSync("route-file.ts", source, { lang: "ts" });
  if (result.errors.length > 0) {
    const first = result.errors[0] as { message?: string } | undefined;
    throw new Error(`route source parse failed — ${first?.message ?? "unknown error"}`);
  }
  return { program: result.program as unknown as Node };
};

// ─── Mount derivation from app.ts ───────────────────────────────────────────

/** Route file (absolute) -> the full Express mount prefixes its factories sit at. */
function deriveMountsByFile(): Map<string, string[]> {
  const { program } = parseFile(APP_FILE);
  const constants = new Map<string, string>();
  collectStringConstants(program, constants);

  /** imported local name -> route file it comes from */
  const fileByFactory = new Map<string, string>();
  for (const file of routeFiles()) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /export\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z0-9_$]+)/g,
    )) {
      fileByFactory.set(match[1]!, file);
    }
  }

  const useCalls: Array<{
    /** the object `.use` was called on, e.g. `app` or `api` */
    mountTarget: string | null;
    /** the string prefix argument, if any */
    prefix: string | null;
    /** a route-factory call among the arguments, if any */
    factory: string | null;
    /** a router variable among the arguments, if any */
    mountedRouter: string | null;
  }> = [];

  const visit = (node: unknown) => {
    if (!isNode(node)) return;
    if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      if (callee.type === "MemberExpression" && propertyName(callee) === "use") {
        const receiver = isNode(callee.object) ? callee.object : null;
        let prefix: string | null = null;
        let factory: string | null = null;
        let mountedRouter: string | null = null;
        for (const arg of (node.arguments as Node[] | undefined) ?? []) {
          const asString = resolveString(arg, constants);
          if (asString !== null) {
            if (prefix === null) prefix = asString;
          } else if (arg.type === "CallExpression") {
            const name = calleeName(arg.callee as Node);
            if (name && fileByFactory.has(name)) factory = name;
          } else if (arg.type === "Identifier") {
            mountedRouter = arg.name as string;
          }
        }
        useCalls.push({
          mountTarget: receiver?.type === "Identifier" ? (receiver.name as string) : null,
          prefix,
          factory,
          mountedRouter,
        });
      }
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(program);

  // A router variable's own mount point, e.g. `const api = express.Router()` later
  // mounted at `/api`. Without this every `api.use(...)` would resolve to the
  // root and produce a `/`-prefixed coordinate instead of `/api/...`.
  const routerBase = new Map<string, string>();
  for (const call of useCalls) {
    if (call.mountedRouter) routerBase.set(call.mountedRouter, call.prefix ?? "");
  }

  const mounts = new Map<string, string[]>();
  for (const call of useCalls) {
    if (!call.factory) continue;
    const file = fileByFactory.get(call.factory);
    if (file === undefined) continue;
    const base = call.mountTarget ? (routerBase.get(call.mountTarget) ?? "") : "";
    const full = `${base}${call.prefix ?? ""}`.replace(/\/+/g, "/");
    const existing = mounts.get(file) ?? [];
    if (!existing.includes(full)) existing.push(full);
    mounts.set(file, existing);
  }
  return mounts;
}

function routeFiles(): string[] {
  return fs
    .readdirSync(ROUTES_DIR)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts"))
    .sort()
    .map((entry) => path.join(ROUTES_DIR, entry));
}

// ─── Public API ─────────────────────────────────────────────────────────────

export type DerivedOperation = {
  /** `METHOD /api/path` in OpenAPI form. */
  key: string;
  method: string;
  /** Express route path as registered, e.g. `/agents/:id/keys`. */
  routePath: string;
  mount: string;
  /** Repo-relative source file that registers the route. */
  file: string;
  line: number;
  verdict: HandlerVerdict;
  denials: DenialSite[];
};

/** Express `:param` / `*splat` to OpenAPI `{param}`. */
export function toOpenApiPath(routePath: string): string {
  return routePath
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

/**
 * Every route registration in `server/src/routes/`, keyed by its OpenAPI
 * operation coordinate, with the verdict the analysis reached.
 */
export function deriveRouteActorGates(): DerivedOperation[] {
  const mounts = deriveMountsByFile();
  const out = new Map<string, DerivedOperation>();

  for (const file of routeFiles()) {
    const source = fs.readFileSync(file, "utf8");
    const prefixes = mounts.get(file);
    const mount = prefixes?.includes("/api")
      ? "/api"
      : prefixes?.[0] !== undefined
        ? prefixes[0]
        : null;
    if (mount === null) continue; // not mounted by app.ts: no OpenAPI coordinate
    const { registrations, functions } = scanRegistrations(source);
    for (const registration of registrations) {
      const key = `${registration.method} ${toOpenApiPath(`${mount}${registration.routePath}`)}`;
      if (out.has(key)) continue;
      const analysis = analyzeHandler(registration.handler, source, functions);
      out.set(key, {
        key,
        method: registration.method,
        routePath: registration.routePath,
        mount,
        file: path.relative(REPO_ROOT, file),
        line: registration.line,
        verdict: analysis.verdict,
        denials: analysis.denials,
      });
    }
  }

  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}
