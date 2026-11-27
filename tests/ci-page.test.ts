import { test } from "node:test";
import assert from "node:assert/strict";
import { ciCheckEnabled, fetchActionsHistory, parseRepository } from "../src/ci-audit-github";
import sitemap from "../app/sitemap";

test("parseRepository accepts owner/name and github.com links, and nothing else", () => {
  assert.equal(parseRepository("acme/app"), "acme/app");
  assert.equal(parseRepository(" https://github.com/acme/app.git "), "acme/app");
  assert.equal(parseRepository("github.com/acme/app/actions?query=x"), "acme/app");
  assert.equal(parseRepository("https://www.github.com/acme/app#readme"), "acme/app");
  for (const bad of ["", "acme", "../etc", "acme/..", "https://gitlab.com/acme/app", "acme/app name", "a/b;rm"]) assert.equal(parseRepository(bad), null, bad);
});

test("the public check is on only with a token", () => {
  assert.equal(ciCheckEnabled({}), false);
  assert.equal(ciCheckEnabled({ CI_AUDIT_GITHUB_TOKEN: "  " }), false);
  assert.equal(ciCheckEnabled({ CI_AUDIT_GITHUB_TOKEN: "github_pat_x" }), true);
});

test("publicOnly refuses a private repository before reading any runs", async () => {
  const calls: string[] = [];
  const fake = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/repos/acme/secret")) return new Response(JSON.stringify({ private: true, default_branch: "main", full_name: "acme/secret" }));
    return new Response(JSON.stringify({ workflows: [] }));
  }) as typeof fetch;
  await assert.rejects(fetchActionsHistory({ repository: "acme/secret", token: "t", publicOnly: true, fetch: fake }), /not public/);
  assert.equal(calls.length, 1);
});

test("a deadline stops listing early, newest days first, and the window shrinks to what was read", async () => {
  const now = Date.parse("2026-11-27T00:00:00Z");
  let listed = 0;
  const fake = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/repos/acme/app") return new Response(JSON.stringify({ private: false, default_branch: "main", full_name: "acme/app" }));
    if (u.pathname.endsWith("/actions/workflows")) return new Response(JSON.stringify({ workflows: [] }));
    listed++;
    assert.ok(u.searchParams.get("created")!.startsWith("2026-11-26"), "the newest day is read first");
    await new Promise((r) => setTimeout(r, 30));
    return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }));
  }) as typeof fetch;
  const result = await fetchActionsHistory({ repository: "acme/app", days: 30, fetch: fake, now, deadline: Date.now() + 10 });
  assert.equal(listed, 1);
  assert.equal(result.days, 1);
  assert.match(result.truncated?.join("\n") ?? "", /Stopped listing runs/);
});

test("the sitemap lists the CI page", () => {
  assert.ok(sitemap().some((entry) => new URL(entry.url).pathname === "/ci"));
});
