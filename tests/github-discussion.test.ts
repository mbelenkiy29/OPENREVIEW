import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Github } from "../src/github";

test("checks merge check runs with the newest status per context", async (t) => {
  const github = new Github("fixture");
  t.mock.method(github, "request", async (path: string, schema: z.ZodType) => schema.parse(path.includes("/check-runs")
    ? { check_runs: [{ name: "lint", status: "completed", conclusion: "success", html_url: "https://ci/lint" }, { name: "test", status: "in_progress", conclusion: null, html_url: null }] }
    : [{ context: "deploy", state: "failure", target_url: null, description: "Preview failed" }, { context: "deploy", state: "success", target_url: null, description: null }]));
  const checks = await github.checks("o/r", "a".repeat(40));
  assert.deepEqual(checks.map((c) => [c.name, c.status, c.conclusion]), [["lint", "completed", "success"], ["test", "in_progress", null], ["deploy", "completed", "failure"]]);
  await assert.rejects(github.checks("o/r", "main"), /exact Git commit/);
});

test("discussion orders comments, reviews and threads and marks bots and resolved threads", async (t) => {
  const github = new Github("fixture");
  const person = (login: string, bot = false) => ({ login, __typename: bot ? "Bot" : "User" });
  t.mock.method(github, "graphql", async (_q: string, _v: unknown, schema: z.ZodType) => schema.parse({ repository: { pullRequest: {
    comments: { nodes: [{ databaseId: 1, author: person("openreview", true), body: "Summary", createdAt: "2026-10-02T00:00:00Z", url: "u1" }] },
    reviews: { nodes: [{ databaseId: 2, author: person("bob"), state: "APPROVED", body: "", createdAt: "2026-10-03T00:00:00Z", url: "u2" }, { databaseId: 3, author: null, state: "COMMENTED", body: "", createdAt: "2026-10-04T00:00:00Z", url: "u3" }] },
    reviewThreads: { nodes: [{ id: "PRRT_1", isResolved: true, path: "src/a.ts", line: 4, comments: { nodes: [{ databaseId: 9, author: person("alice"), body: "Why?", createdAt: "2026-10-01T00:00:00Z", url: "u9" }] } }] },
  } } }));
  const items = await github.discussion("o/r", 7);
  assert.deepEqual(items.map((i) => i.kind), ["thread", "comment", "review"]);
  assert.deepEqual(items[0], { kind: "thread", author: "alice", bot: false, threadId: "PRRT_1", resolved: true, path: "src/a.ts", line: 4, createdAt: "2026-10-01T00:00:00Z", url: "u9", replyTo: 9, comments: [{ author: "alice", bot: false, body: "Why?", createdAt: "2026-10-01T00:00:00Z" }] });
  assert.equal(items[1].bot, true);
});
