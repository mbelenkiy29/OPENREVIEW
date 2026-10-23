import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Github } from "../src/github";
import { pullActionSchema, runPullAction } from "../src/pull-actions";

const head = "a".repeat(40);
function fake(t: test.TestContext, responses: Record<string, unknown> = {}) {
  const github = new Github("user-token"), calls: { path: string; method: string; body?: unknown }[] = [], graph: { query: string; id: unknown }[] = [];
  t.mock.method(github, "request", async (path: string, schema: z.ZodType, init: RequestInit = {}) => {
    calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return schema.parse(responses[path] ?? { id: 1, merged: true, message: "ok", state: "closed", node_id: "PR_node" });
  });
  t.mock.method(github, "graphql", async (query: string, variables: { id: unknown }) => { graph.push({ query, id: variables.id }); return {}; });
  return { github, calls, graph };
}

test("each dashboard action calls the matching GitHub endpoint with the user's token", async (t) => {
  const { github, calls, graph } = fake(t);
  assert.equal(await runPullAction(github, "o/r", 7, { action: "merge", method: "squash", head }), "Merged");
  assert.deepEqual(calls.at(-1), { path: "/repos/o/r/pulls/7/merge", method: "PUT", body: { merge_method: "squash", sha: head } });
  await runPullAction(github, "o/r", 7, { action: "approve" });
  assert.deepEqual(calls.at(-1), { path: "/repos/o/r/pulls/7/reviews", method: "POST", body: { event: "APPROVE" } });
  await runPullAction(github, "o/r", 7, { action: "request_changes", body: "Handle 4xx" });
  assert.deepEqual(calls.at(-1)?.body, { event: "REQUEST_CHANGES", body: "Handle 4xx" });
  await runPullAction(github, "o/r", 7, { action: "comment", body: "LGTM" });
  assert.equal(calls.at(-1)?.path, "/repos/o/r/issues/7/comments");
  await runPullAction(github, "o/r", 7, { action: "close" });
  assert.deepEqual(calls.at(-1), { path: "/repos/o/r/pulls/7", method: "PATCH", body: { state: "closed" } });
  await runPullAction(github, "o/r", 7, { action: "update_branch" });
  assert.deepEqual(calls.at(-1), { path: "/repos/o/r/pulls/7/update-branch", method: "PUT", body: {} });
  await runPullAction(github, "o/r", 7, { action: "reply", commentId: 55, body: "Fixed in abc" });
  assert.deepEqual(calls.at(-1), { path: "/repos/o/r/pulls/7/comments/55/replies", method: "POST", body: { body: "Fixed in abc" } });
  await runPullAction(github, "o/r", 7, { action: "resolve", threadId: "PRRT_kw" });
  assert.match(graph.at(-1)!.query, /resolveReviewThread/);
  await runPullAction(github, "o/r", 7, { action: "draft" });
  assert.match(graph.at(-1)!.query, /convertPullRequestToDraft/);
  assert.equal(graph.at(-1)!.id, "PR_node");
});

test("a refused merge surfaces GitHub's reason; malformed actions never reach GitHub", async (t) => {
  const { github } = fake(t, { "/repos/o/r/pulls/7/merge": { merged: false, message: "Head branch was modified" } });
  await assert.rejects(runPullAction(github, "o/r", 7, { action: "merge", method: "merge", head }), /Head branch was modified/);
  await assert.rejects(runPullAction(github, "o/r", 0, { action: "close" }), /Invalid pull request number/);
  assert.equal(pullActionSchema.safeParse({ action: "merge", method: "merge", head: "main" }).success, false);
  assert.equal(pullActionSchema.safeParse({ action: "request_changes", body: "  " }).success, false);
  assert.equal(pullActionSchema.safeParse({ action: "delete_branch" }).success, false);
  assert.equal(pullActionSchema.safeParse({ action: "resolve", threadId: "x}){evil" }).success, false);
});
