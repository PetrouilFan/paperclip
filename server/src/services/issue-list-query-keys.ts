/**
 * The accepted query keys of the two issue-collection routes, in one place.
 *
 * This module exists because those keys were previously declared inside
 * `routes/issues.ts`, where the guard could read them but the OpenAPI
 * registry could not. The consequence was that the endpoint *enforced* 33
 * query parameters while its own specification *documented* one (`view`, which
 * is not a filter), so a caller working from the contract had no documented key
 * to get right and the only discoverable name was the one key that did
 * nothing. Hoisting the sets here lets `routes/openapi.ts` build the documented
 * surface from the same literal the guard enforces, so the two cannot drift
 * apart by accident.
 *
 * It is deliberately a leaf module: it imports nothing, so both the route and
 * the spec can depend on it without a cycle.
 */

/**
 * Every query key `GET /companies/:companyId/issues` actually reads.
 *
 * The handler never used to inspect the key set, so an unread key was dropped
 * silently and the caller received the *unfiltered* board — a typo like
 * `?assigneeId=` (the real key is `assigneeAgentId`) returned every issue in
 * the company instead of an error. Rejecting unknown keys turns that
 * maximally-wrong silent answer into a loud, self-describing 400.
 *
 * Two rules keep this set honest:
 *
 * 1. **Aliases are keys, not rewrites.** `parentIssueId` is a supported synonym
 *    for `parentId`, so it belongs here as its own entry.
 * 2. **Value spellings are not keys.** Every `include*` flag accepts both
 *    `"true"` and `"1"`, and `assigneeAgentId` accepts the sentinel `"null"`.
 *    Those are validated in the route and do not widen the key set.
 *
 * `server/src/__tests__/issues-unknown-query-key.test.ts` asserts this set
 * stays exactly in sync with the handler's `req.query.*` reads, and
 * `server/src/__tests__/issue-list-query-contract.test.ts` asserts the
 * OpenAPI spec documents exactly this set. Adding a filter without registering
 * it here therefore fails the suite instead of 400ing a legitimate caller in
 * production, and documenting a key the handler ignores fails instead of
 * advertising a filter that does nothing.
 */
export const ISSUE_LIST_KNOWN_QUERY_KEYS = new Set([
  "afterId",
  "assigneeAgentId",
  "assigneeUserId",
  "attention",
  "createdFromIssueId",
  "descendantOf",
  "excludeRoutineExecutions",
  "executionWorkspaceId",
  "hasPlanDocument",
  "inboxArchivedByUserId",
  "includeBlockedBy",
  "includeBlockedInboxAttention",
  "includeLiveDescendantSummary",
  "includePluginOperations",
  "includeRoutineExecutions",
  "labelId",
  "limit",
  "offset",
  "originId",
  "originKind",
  "originKindPrefix",
  "parentId",
  "parentIssueId", // documented alias for `parentId`
  "participantAgentId",
  "projectId",
  "q",
  "sortDir",
  "sortField",
  "status",
  "touchedByUserId",
  "unreadForUserId",
  "updatedSince",
  "view",
  "workspaceId",
]);

/** @internal exported for the allowlist-drift regression test. */
export const issueListKnownQueryKeys = (): readonly string[] =>
  [...ISSUE_LIST_KNOWN_QUERY_KEYS].sort();

/**
 * Query keys `GET /companies/:companyId/issues/count` reads.
 *
 * Deliberately *narrower* than `ISSUE_LIST_KNOWN_QUERY_KEYS`, and that
 * difference is the whole point. The count route is not a list route with a
 * smaller page size: it accepts a different set of filters, forces
 * `includeBlockedBy` and `includeBlockedInboxAttention` to true whatever the
 * caller sent, and ignores pagination and sorting because neither means
 * anything for a count. Reusing the list superset here would let precisely the
 * keys this change exists to catch -- `view`, `sortField`, `offset` and the
 * rest -- clear the guard and then be dropped in silence, which is the defect
 * rather than a fix for it.
 *
 * `limit` and `offset` are listed because the handler *reads* them in order to
 * reject them with a specific 400. Keeping them here is what leaves that
 * rejection reachable, with its own message, instead of being shadowed by a
 * generic unknown-key error.
 *
 * As on the list route, `parentIssueId` is a supported synonym for `parentId`
 * and so is its own entry, and value spellings (`"1"`, the `"null"` sentinel)
 * are validated in the route rather than widening the key set.
 */
export const ISSUE_COUNT_KNOWN_QUERY_KEYS = new Set([
  "assigneeAgentId",
  "assigneeUserId",
  "attention",
  "createdFromIssueId",
  "descendantOf",
  "excludeRoutineExecutions",
  "executionWorkspaceId",
  "hasPlanDocument",
  "includePluginOperations",
  "includeRoutineExecutions",
  "labelId",
  "limit",
  "offset",
  "originId",
  "originKind",
  "originKindPrefix",
  "parentId",
  "parentIssueId", // documented alias for `parentId`
  "participantAgentId",
  "projectId",
  "q",
  "status",
  "workspaceId",
]);

/** @internal exported for the allowlist-drift regression test. */
export const issueCountKnownQueryKeys = (): readonly string[] =>
  [...ISSUE_COUNT_KNOWN_QUERY_KEYS].sort();
