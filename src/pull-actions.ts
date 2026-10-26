import { z } from "zod";
import type { Github } from "./github";

// Pull request actions a developer takes from the dashboard. They are sent with the developer's own
// GitHub user token, so GitHub applies their permissions and branch protection and shows them as
// the actor; OpenReview's App never merges, closes or reviews on someone's behalf here.
const body = z.string().trim().max(10000);
export const pullActionSchema = z.discriminatedUnion("action", [
  // The head pins the merge to the revision on screen; GitHub refuses it if the branch moved.
  z.object({ action: z.literal("merge"), method: z.enum(["merge", "squash", "rebase"]), head: z.string().regex(/^[a-f0-9]{40}$/) }),
  z.object({ action: z.literal("approve"), body: body.optional() }),
  z.object({ action: z.literal("request_changes"), body: body.min(1, "Say what needs to change") }),
  z.object({ action: z.literal("comment"), body: body.min(1, "Write a comment") }),
  z.object({ action: z.literal("reply"), commentId: z.coerce.number().int().positive(), body: body.min(1, "Write a reply") }),
  z.object({ action: z.enum(["resolve", "unresolve"]), threadId: z.string().regex(/^[\w=-]{1,200}$/) }),
  z.object({ action: z.enum(["close", "reopen", "draft", "ready", "update_branch"]) }),
]);
export type PullAction = z.infer<typeof pullActionSchema>;
export const pullActionLabels: Record<PullAction["action"], string> = { merge: "Merged", approve: "Approved", request_changes: "Changes requested", comment: "Comment posted", close: "Closed", reopen: "Reopened", draft: "Converted to draft", ready: "Marked ready for review", update_branch: "Branch update started", reply: "Reply posted", resolve: "Conversation resolved", unresolve: "Conversation reopened" };

export async function runPullAction(github: Github, repository: string, number: number, a: PullAction): Promise<string> {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid pull request number");
  const path = `/repos/${repository}/pulls/${number}`;
  switch (a.action) {
    case "merge": {
      const merged = await github.request(`${path}/merge`, z.object({ merged: z.boolean(), message: z.string() }), { method: "PUT", body: JSON.stringify({ merge_method: a.method, sha: a.head }) });
      if (!merged.merged) throw new Error(merged.message);
      break;
    }
    case "approve":
    case "request_changes":
      await github.request(`${path}/reviews`, z.object({ id: z.number() }), { method: "POST", body: JSON.stringify({ event: a.action === "approve" ? "APPROVE" : "REQUEST_CHANGES", ...(a.body ? { body: a.body } : {}) }) });
      break;
    case "comment":
      await github.request(`/repos/${repository}/issues/${number}/comments`, z.object({ id: z.number() }), { method: "POST", body: JSON.stringify({ body: a.body }) });
      break;
    case "reply":
      await github.request(`${path}/comments/${a.commentId}/replies`, z.object({ id: z.number() }), { method: "POST", body: JSON.stringify({ body: a.body }) });
      break;
    case "resolve":
    case "unresolve":
      await github.graphql(`mutation($id: ID!) { ${a.action}ReviewThread(input: { threadId: $id }) { thread { isResolved } } }`, { id: a.threadId }, z.unknown());
      break;
    case "close":
    case "reopen":
      await github.request(path, z.object({ state: z.string() }), { method: "PATCH", body: JSON.stringify({ state: a.action === "close" ? "closed" : "open" }) });
      break;
    case "update_branch":
      await github.request(`${path}/update-branch`, z.unknown(), { method: "PUT", body: "{}" });
      break;
    case "draft":
    case "ready": {
      // REST cannot change draft state; GraphQL takes the pull request's node id.
      const { node_id } = await github.request(path, z.object({ node_id: z.string() }));
      const mutation = a.action === "draft" ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
      await github.graphql(`mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`, { id: node_id }, z.unknown());
      break;
    }
  }
  return pullActionLabels[a.action];
}
