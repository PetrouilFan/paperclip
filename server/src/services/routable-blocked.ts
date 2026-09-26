import type {
  IssueUnblockDescriptor,
  IssueUnblockOwner,
} from "@paperclipai/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

type RoutableBlockedIssue = {
  id: string;
  status: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

/**
 * A dead run that never got to settle its own work is not a hold. When the
 * recovery sweep blocks such an issue it must also name who releases it,
 * otherwise `blocked` becomes terminal in practice: nothing in the issue says
 * what would open it, and the agent that owned the work cannot check a blocked
 * issue back out to finish it.
 *
 * `owner` is the routing decision the caller has already made, not a default.
 * Name the agent when the same owner is expected to verify the recorded state
 * and resume; name the board when recovery escalates to a human operator
 * (`board_escalation_no_takeover_v1`) — the attention service already surfaces
 * a board-owned descriptor to that human as an unblock/reassign decision.
 *
 * Returns null when the issue already carries a descriptor (a separate human or
 * dependency hold owns the exit and must not be overwritten) or when there is
 * nobody to name.
 */
export function strandedRunUnblockDescriptor(input: {
  existing?: IssueUnblockDescriptor | null;
  owner?: IssueUnblockOwner | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  action: string;
}): IssueUnblockDescriptor | null {
  if (input.existing) return null;
  const owner: IssueUnblockOwner | null =
    input.owner ??
    (input.assigneeAgentId
      ? { agentId: input.assigneeAgentId }
      : input.assigneeUserId
        ? { userId: input.assigneeUserId }
        : null);
  return owner ? { owner, action: input.action } : null;
}

type ProspectiveBlockedIssue = RoutableBlockedIssue & {
  status: "blocked";
  blockedTransitionAt: Date;
};

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  wakeup: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_unblock_requested";
    idempotencyKey: string;
    payload: { issueId: string; action: string };
    contextSnapshot: { wakeReason: "issue_unblock_requested"; issueId: string; taskId: string };
  }) => Promise<unknown>;
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  now?: () => Date;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;

  await input.wakeup(owner.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt.toISOString()}`,
    payload: { issueId: issue.id, action: issue.unblockDescriptor.action },
    contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
  });
  await input.markNotified((input.now ?? (() => new Date()))());
  return true;
}
