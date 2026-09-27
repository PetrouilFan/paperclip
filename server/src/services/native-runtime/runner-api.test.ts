import { describe, expect, it, vi } from "vitest";
import {
  runnerApiCatalog,
  runnerApiOperation,
  searchRunnerApi,
} from "./runner-api-catalog.js";
import {
  executeRunnerApi,
  readBoundedResponse,
  runnerApiUrl,
  validateRunnerApiCall,
  type RunnerApiIo,
} from "./runner-api-client.js";

const context = {
  companyId: "company-a",
  issueId: "issue-a",
  issueIdentifier: "API-1",
  runId: "run-a",
  workMode: "standard",
};
const projects = "GET /api/companies/{companyId}/projects";
const createProject = "POST /api/companies/{companyId}/projects";
const io = (fetcher: typeof fetch): RunnerApiIo => ({
  apiUrl: "http://127.0.0.1:3100",
  token: "private-agent-token",
  fetch: fetcher,
  readFile: async () => ({
    bytes: Buffer.from("test"),
    filename: "proof.txt",
    contentType: "text/plain",
  }),
  saveResponse: async (bytes, contentType) => ({
    artifactId: "artifact-a",
    byteSize: bytes.length,
    contentType,
  }),
});

// The zero-result assertion below needs a query that matches nothing, so every
// token of it must be a word the catalog never writes. searchRunnerApi is an OR
// ranker, so a single matchable token is enough to make the probe fail. An
// earlier probe, "nothing-zzzzzzzzzz", was nonsense only in its distinguishing
// half: it carried the ordinary word "nothing", and the issues-count
// description ends in "they mean nothing here", so the probe matched that one
// operation and the assertion read "expected 1 to be 0".
//
// That rule used to live in a comment, and a comment does not fail a build. So
// the tokens are filtered against the catalog's own word set. A token that
// catalog prose has since swallowed now fails the test by name, instead of
// surfacing later as a count.
//
// The filter does not pick a probe and does not repair one. The candidates stay
// hardcoded literals. When one rots the test fails and a human writes new
// nonsense, so the failure is legible, not self-healing.
const NEGATIVE_CONTROL_CANDIDATES = [
  "qqzzz",
  "xvvv",
  "4417",
  "zqxjwvb",
  "vvxq",
  "zzyzxw",
  "qjvzxw",
  "xzqjv",
];
const MINIMUM_NEGATIVE_CONTROL_TOKENS = 3;

// runner-api-catalog.ts does not export its tokenizer, so this vocabulary is a
// second derivation of it. It reads the same six text fields the ranker reads
// but it skips the ranker's synonym and plural folding, so it can keep a token
// the ranker still matches. Every surviving token is therefore also checked
// against the ranker itself, so a vocabulary that went stale cannot quietly let
// one through.
const catalogVocabulary = (() => {
  const vocabulary = new Set<string>();
  for (const operation of runnerApiCatalog()) {
    const ranked = `${operation.method} ${operation.path} ${operation.summary} ${operation.description} ${operation.skillReference?.description ?? ""} ${operation.skillReference?.section ?? ""}`;
    for (const word of ranked.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word) vocabulary.add(word);
    }
  }
  return vocabulary;
})();

const negativeControlTokens = (
  candidates: string[],
  minimum: number,
): string[] => {
  const swallowed = candidates.filter((candidate) =>
    catalogVocabulary.has(candidate),
  );
  expect(
    swallowed,
    `these negative-control candidates are catalog text now, so they can no longer prove a zero result; write new nonsense tokens: ${swallowed.join(", ")}`,
  ).toEqual([]);
  const kept = candidates.filter((candidate) => !catalogVocabulary.has(candidate));
  expect(
    kept.length,
    `only ${kept.length} of ${candidates.length} negative-control candidates are absent from the catalog, and the probe needs at least ${minimum}`,
  ).toBeGreaterThanOrEqual(minimum);
  const stale = kept.filter((token) => searchRunnerApi({ query: token }).total > 0);
  expect(
    stale,
    `these negative-control candidates are absent from the derived vocabulary but still match the ranker, so the vocabulary above has drifted from words(): ${stale.join(", ")}`,
  ).toEqual([]);
  return kept;
};

describe("runner API catalog", () => {
  it("accounts for unique operations with resolved request contracts", () => {
    const catalog = runnerApiCatalog();
    expect(catalog.length).toBeGreaterThan(400);
    expect(new Set(catalog.map((entry) => entry.operationId)).size).toBe(
      catalog.length,
    );
    expect(JSON.stringify(catalog)).not.toContain('"$ref"');
    expect(runnerApiOperation("GET /api/companies/{companyId}/decisions").authorization.actor).toBe("board");
    expect(runnerApiOperation("DELETE /api/issues/{id}/documents/{key}").authorization.actor).toBe("board");
    expect(runnerApiOperation("DELETE /api/issues/{id}/documents/{key}").dedicatedTools).toEqual([]);
    expect(runnerApiOperation(createProject).requestBody?.content["application/json"].schema.required).toContain("name");
    expect(runnerApiOperation(createProject).dedicatedTools).toEqual(["create_project"]);
    expect(runnerApiOperation(projects).dedicatedTools).toEqual(["list_projects"]);
    expect(runnerApiOperation("GET /api/companies/{companyId}/project-repositories").dedicatedTools).toEqual(["list_project_repositories"]);
    expect(runnerApiOperation("POST /api/companies/{companyId}/agent-hires").dedicatedTools).toEqual(["hire_agent"]);
    expect(runnerApiOperation("POST /api/companies/{companyId}/agent-hires").dedicatedToolGuidance).toContain("inherits the caller's native runtime");
  });
  it.each(
    runnerApiCatalog().filter((operation) => operation.transport === "rest"),
  )(
    "resolves the catalog route $operationId inside the bound origin",
    (operation) => {
      const pathParams = Object.fromEntries(
        operation.parameters
          .filter((parameter) => parameter.in === "path")
          .map((parameter) => [
            parameter.name,
            parameter.name === "companyId" ? context.companyId : "fixture-id",
          ]),
      );
      const url = runnerApiUrl(
        operation,
        { operationId: operation.operationId, pathParams },
        context,
        "https://paperclip.test",
      );
      expect(url.origin).toBe("https://paperclip.test");
      expect(url.pathname).not.toContain("{");
      expect(operation.responses).toBeDefined();
      expect(operation.authorization.actor).toBeTruthy();
    },
  );
  it("ranks natural language, explains dedicated alternatives, and supports exact lookup", () => {
    expect(
      searchRunnerApi({ query: "create project" }).results.map(
        (entry) => entry.operationId,
      ),
    ).toContain(createProject);
    expect(
      searchRunnerApi({ query: "GET /api/companies/{companyId}/issues" })
        .results[0].dedicatedTools,
    ).toContain("search_tasks");
    // Every token of the probe must be a word the catalog never uses, and
    // negativeControlTokens fails by name when that stops being true, so the
    // failure says which token rotted. See the note above the candidate list.
    const negativeControl = negativeControlTokens(
      NEGATIVE_CONTROL_CANDIDATES,
      MINIMUM_NEGATIVE_CONTROL_TOKENS,
    ).join("-");
    expect(searchRunnerApi({ query: negativeControl }).total).toBe(0);
  });
  it("keeps real matches when the query also carries a term the catalog never contains", () => {
    // searchRunnerApi is an OR ranker, on purpose. Natural-language queries
    // carry filler words that match nothing ("list my open issues"), and an AND
    // rule would answer those with zero results. Do not tighten it into AND
    // without a recall evaluation over the whole catalog.
    const results = searchRunnerApi({ query: "list issues zqxjwvb" }).results;
    expect(results.map((entry) => entry.operationId)).toContain(
      "GET /api/companies/{companyId}/issues",
    );
  });
  it("paginates without duplicates and rejects stale or mismatched cursors", () => {
    const first = searchRunnerApi({ query: "project", limit: 1 });
    const second = searchRunnerApi({
      query: "project",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.results[0].operationId).not.toBe(
      first.results[0].operationId,
    );
    expect(() =>
      searchRunnerApi({ query: "agent", cursor: first.nextCursor! }),
    ).toThrow("different query");
    expect(() => searchRunnerApi({ query: "project", limit: 50 })).toThrow();
  });
});

describe("runner API request boundary", () => {
  it.each([
    "POST /api/execution-workspaces/{id}/runtime-commands/{action}",
    "POST /api/projects/{id}/workspaces/{workspaceId}/runtime-services/{action}",
    "POST /api/tool-gateway/runtime-slots/{slotId}/restart",
    "POST /api/cases/{caseId}/automation/current-stage/rerun",
    "POST /api/companies/{companyId}/skills/{skillId}/test-runs",
    "POST /api/tool-gateway/sessions",
  ])(
    "keeps execution and gateway control %s out of generic dispatch",
    async (operationId) => {
      const request = vi.fn<typeof fetch>();
      await expect(
        executeRunnerApi({ operationId }, context, io(request)),
      ).rejects.toThrow(/cannot bypass|credential broker/);
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([
    "POST /api/mcp/project-tools",
    "POST /api/agents/{id}/claude-login",
    "POST /api/companies/{companyId}/adapters/{type}/login-sessions",
    "POST /api/agents/me/connections/{connectionId}/start-authorization",
  ])(
    "directs authentication handshake %s to its existing client",
    async (operationId) => {
      const request = vi.fn<typeof fetch>();
      expect(runnerApiOperation(operationId).transport).toBe("protocol");
      await expect(
        executeRunnerApi({ operationId }, context, io(request)),
      ).rejects.toThrow("existing protocol client");
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each(
    runnerApiCatalog().filter(
      (operation) =>
        !["GET", "HEAD", "OPTIONS"].includes(operation.method) &&
        /\/(routines|routine-triggers)(\/|$)/.test(operation.path) &&
        !operation.path.includes("/description/annotations"),
    ),
  )(
    "keeps scheduled execution $operationId behind its existing client",
    async (operation) => {
      const request = vi.fn<typeof fetch>();
      await expect(
        executeRunnerApi(
          { operationId: operation.operationId },
          context,
          io(request),
        ),
      ).rejects.toThrow(/cannot bypass|credential broker/);
      expect(request).not.toHaveBeenCalled();
      expect(operation.callPolicy).toBe("restricted");
    },
  );
  it.each(
    runnerApiCatalog().filter(
      (operation) =>
        !["GET", "HEAD", "OPTIONS"].includes(operation.method) &&
        operation.path.includes("/routines/{id}/description/annotations"),
    ),
  )("preserves routine collaboration $operationId", async (operation) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "thread", status: "open" }),
    );
    const pathParams = Object.fromEntries(
      operation.parameters
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => [parameter.name, "fixture"]),
    );
    await expect(
      executeRunnerApi(
        { operationId: operation.operationId, pathParams },
        context,
        io(request),
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(request).toHaveBeenCalledOnce();
    expect(operation.callPolicy).toBe("rest");
  });
  it("keeps routine metadata readable", () => {
    expect(
      validateRunnerApiCall(
        { operationId: "GET /api/companies/{companyId}/routines" },
        context,
      ).operation.callPolicy,
    ).toBe("rest");
  });
  it.each(["reopen", "resume", "interrupt"])(
    "cannot hide lifecycle intent %s in an ordinary issue patch",
    async (field) => {
      const request = vi.fn<typeof fetch>();
      await expect(
        executeRunnerApi(
          {
            operationId: "PATCH /api/issues/{id}",
            pathParams: { id: "other-issue" },
            body: { [field]: true, billingCode: "safe-extra-field" },
          },
          context,
          io(request),
        ),
      ).rejects.toThrow("lifecycle changes");
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([
    "POST /api/agents/me/secrets/{key}/value",
    "POST /api/agents/{id}/keys",
    "DELETE /api/agents/{id}/keys/{keyId}",
    "POST /api/companies/{companyId}/secret-proposals/{id}/approve",
    "POST /api/agents/me/secret-proposals",
    "PATCH /api/secrets/{id}",
    "POST /api/companies/{companyId}/exports",
    "GET /api/secret-provider-configs/{id}",
    "POST /api/chat-endpoints/{endpointId}/setup-secret",
    "POST /api/chat-endpoints/{endpointId}/principals/{principalId}/link-intent",
    "DELETE /api/chat-endpoints/{endpointId}/principals/{principalId}/link",
    "POST /api/chat-identity-links/confirm",
    "GET /api/chat-identity-links/preview",
  ])(
    "keeps sensitive operation %s out of model results and receipts",
    async (operationId) => {
      const request = vi.fn<typeof fetch>();
      await expect(
        executeRunnerApi({ operationId }, context, io(request)),
      ).rejects.toThrow("credential broker");
      expect(request).not.toHaveBeenCalled();
      expect(searchRunnerApi({ query: operationId }).results[0]).toMatchObject({
        callPolicy: "restricted",
      });
    },
  );
  it("retains safe secret metadata discovery", () => {
    for (const operationId of [
      "GET /api/agents/me/secrets",
      "GET /api/companies/{companyId}/secrets/catalog",
    ]) {
      expect(
        validateRunnerApiCall({ operationId }, context).operation.callPolicy,
      ).toBe("rest");
    }
  });
  it("binds the company and encodes query scalars", () => {
    const input = {
      operationId: projects,
      query: { q: "hello & goodbye", limit: 2, active: false },
    };
    const url = runnerApiUrl(
      runnerApiOperation(projects),
      input,
      context,
      "https://paperclip.test/api",
    );
    expect(url.origin).toBe("https://paperclip.test");
    expect(url.pathname).toBe("/api/companies/company-a/projects");
    expect(url.searchParams.get("q")).toBe("hello & goodbye");
  });
  it.each(["../secrets", ".", "..", "%2e%2e", "abc/def", "abc\\def"])(
    "rejects path injection %s",
    (id) => {
      const input = {
        operationId: "GET /api/projects/{id}",
        pathParams: { id },
      };
      expect(() =>
        runnerApiUrl(
          runnerApiOperation(input.operationId),
          input,
          context,
          "https://paperclip.test",
        ),
      ).toThrow();
    },
  );
  it("rejects unknown inputs, foreign companies, and mode bypasses", () => {
    expect(() =>
      validateRunnerApiCall(
        { operationId: projects, headers: { Authorization: "board" } },
        context,
      ),
    ).toThrow();
    expect(() =>
      validateRunnerApiCall(
        { operationId: projects, pathParams: { companyId: "foreign" } },
        context,
      ),
    ).toThrow("another company");
    for (const workMode of ["planning", "ask"]) {
      expect(() =>
        validateRunnerApiCall(
          { operationId: createProject, body: { name: "bad" } },
          { ...context, workMode },
        ),
      ).toThrow("only reads");
      expect(
        validateRunnerApiCall(
          { operationId: projects },
          { ...context, workMode },
        ).operation.method,
      ).toBe("GET");
    }
  });
  it("retains API-only issue options while guarding lifecycle fields", () => {
    const input = {
      operationId: "PATCH /api/issues/{id}",
      pathParams: { id: context.issueId },
      body: { billingCode: "cost-center" },
    };
    expect(validateRunnerApiCall(input, context).operation.method).toBe(
      "PATCH",
    );
    expect(() =>
      validateRunnerApiCall({ ...input, body: { status: "done" } }, context),
    ).toThrow("dedicated");
    expect(() =>
      validateRunnerApiCall(
        {
          operationId: "POST /api/issues/{id}/checkout",
          pathParams: { id: context.issueId },
        },
        context,
      ),
    ).toThrow("lifecycle");
  });
  it.each(["issue-a", "ISSUE-A", "API-1", "api-1", " api-1 "])(
    "cannot delete its active task using the route identity alias %s",
    (id) => {
      expect(() =>
        validateRunnerApiCall(
          { operationId: "DELETE /api/issues/{id}", pathParams: { id } },
          context,
        ),
      ).toThrow("cannot delete itself");
    },
  );
  it("forwards only server-owned authentication and preserves API denials", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "Board access required" }, { status: 403 }),
    );
    const result = await executeRunnerApi(
      { operationId: projects },
      context,
      io(request),
    );
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      data: { error: "Board access required" },
    });
    const options = request.mock.calls[0][1]!;
    expect(new Headers(options.headers).get("Authorization")).toBe(
      "Bearer private-agent-token",
    );
    expect(new Headers(options.headers).get("X-Paperclip-Run-Id")).toBe(
      context.runId,
    );
    expect(options.redirect).toBe("manual");
    expect(JSON.stringify(result)).not.toContain("private-agent-token");
  });
  it("never retries a mutation after a transport failure", async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error("socket reset");
    });
    expect(
      await executeRunnerApi(
        { operationId: createProject, body: { name: "created?" } },
        context,
        io(request),
      ),
    ).toMatchObject({ outcome: "unknown", status: null });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([500, 502, 503, 408, 302])(
    "does not claim a mutation was unapplied after HTTP %s",
    async (status) => {
      const request = vi.fn<typeof fetch>(async () =>
        Response.json(
          { error: "Request interrupted after possible commit" },
          { status },
        ),
      );
      expect(
        await executeRunnerApi(
          { operationId: createProject, body: { name: "Maybe created" } },
          context,
          io(request),
        ),
      ).toMatchObject({ status, outcome: "unknown", ok: false });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("retains uncertainty when a successful mutation returns malformed JSON", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response("truncated{", {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(
      await executeRunnerApi(
        { operationId: createProject, body: { name: "Maybe created" } },
        context,
        io(request),
      ),
    ).toMatchObject({
      status: 201,
      outcome: "unknown",
      error: "invalid_json_response",
    });
  });
  it("rejects a string-encoded object before HTTP and allows a corrected request", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ name: "Borealis" }, { status: 201 }),
    );
    await expect(
      executeRunnerApi(
        { operationId: createProject, body: '{"name":"Borealis"}' },
        context,
        io(request),
      ),
    ).rejects.toThrow("not a JSON-encoded string");
    expect(request).not.toHaveBeenCalled();
    expect(
      await executeRunnerApi(
        { operationId: createProject, body: { name: "Borealis" } },
        context,
        io(request),
      ),
    ).toMatchObject({ status: 201 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not follow redirects or pretend empty responses failed", async () => {
    expect(
      await executeRunnerApi(
        { operationId: projects },
        context,
        io(
          async () =>
            new Response(null, {
              status: 302,
              headers: { Location: "https://foreign.test" },
            }),
        ),
      ),
    ).toMatchObject({ ok: false, error: "api_redirect_not_followed" });
    expect(
      await executeRunnerApi(
        { operationId: projects },
        context,
        io(async () => new Response(null, { status: 204 })),
      ),
    ).toMatchObject({ ok: true, status: 204, data: null });
  });
  it("uploads multipart artifacts and returns download references", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response("download", {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const result = await executeRunnerApi(
      {
        operationId: createProject,
        files: [{ artifactId: "a", field: "package" }],
        body: { meta: { name: "example" } },
      },
      context,
      io(request),
    );
    const body = request.mock.calls[0][1]!.body as FormData;
    expect(body.get("meta")).toBe('{"name":"example"}');
    expect(await (body.get("package") as File).text()).toBe("test");
    expect(
      new Headers(request.mock.calls[0][1]!.headers).has("Content-Type"),
    ).toBe(false);
    expect(result).toMatchObject({
      artifact: { artifactId: "artifact-a", byteSize: 8 },
      preview: null,
    });
  });
  it("encodes text and raw file bodies without pretending they are JSON", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    await executeRunnerApi(
      {
        operationId: createProject,
        body: "plain text",
        contentType: "text/plain",
      },
      context,
      io(request),
    );
    expect(request.mock.calls[0][1]?.body).toBe("plain text");
    await executeRunnerApi(
      {
        operationId: createProject,
        files: [{ path: "sample.bin" }],
        contentType: "application/octet-stream",
      },
      context,
      io(request),
    );
    expect(
      Buffer.from(request.mock.calls[1][1]?.body as Uint8Array).toString(),
    ).toBe("test");
    await expect(
      executeRunnerApi(
        {
          operationId: createProject,
          body: "unexpected",
          files: [{ artifactId: "a" }],
          contentType: "application/octet-stream",
        },
        context,
        io(request),
      ),
    ).rejects.toThrow();
  });
  it("classifies protocols and prevents execution control through alternate routes", () => {
    const protocols = runnerApiCatalog().filter(
      (operation) => operation.transport === "protocol",
    );
    expect(
      protocols.some((operation) => operation.path.endsWith("/events/ws")),
    ).toBe(true);
    for (const operation of protocols)
      expect(() =>
        validateRunnerApiCall({ operationId: operation.operationId }, context),
      ).toThrow("protocol client");
    for (const operationId of [
      "POST /api/issues/{id}/tree-holds",
      "POST /api/issues/{id}/stalled-review-decision",
      "POST /api/agents/{id}/runtime-state/reset-session",
      "POST /api/approvals/{id}/resubmit",
    ]) {
      expect(() =>
        validateRunnerApiCall(
          { operationId, pathParams: { id: "fixture" } },
          context,
        ),
      ).toThrow("cannot bypass");
    }
  });
  it("keeps skill-test mode consistent with the advertised tool contract", () => {
    expect(
      validateRunnerApiCall(
        { operationId: createProject, body: { name: "Skill fixture" } },
        { ...context, workMode: "skill_test" },
      ).operation.method,
    ).toBe("POST");
  });
  it("cannot hide lifecycle mutations in a raw uploaded JSON body", () => {
    for (const operationId of [
      "PATCH /api/issues/{id}",
      "PATCH /api/agents/{id}",
      "POST /api/issues/{id}/comments",
    ]) {
      expect(() =>
        validateRunnerApiCall(
          {
            operationId,
            pathParams: { id: "fixture" },
            files: [{ path: "hidden-status.json" }],
            contentType: "application/json",
          },
          context,
        ),
      ).toThrow("inline JSON object");
    }
  });
  it("bounds streamed responses even without content-length", async () => {
    await expect(
      readBoundedResponse(new Response("too large"), 3),
    ).rejects.toThrow("transfer limit");
  });
});
