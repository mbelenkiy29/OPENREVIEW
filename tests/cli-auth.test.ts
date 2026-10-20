import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { accessToken, browserSignIn, logout, readLogin, saveLogin, serverUrl, type BrowserLogin } from "../src/cli-auth";
import { remoteReview } from "../src/remote-review";
import { ART } from "../src/cli-banner";
import { markFrames, playBanner, stageReporter } from "../src/cli-animation";

const issuer = "https://review.example.com";
const metadata = { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/api/oauth/token`, registration_endpoint: `${issuer}/api/oauth/register`, revocation_endpoint: `${issuer}/api/oauth/revoke` };
const tokens = (n: number) => ({ access_token: `ora_access_token_${n}`, refresh_token: `orr_refresh_token_${n}`, expires_in: 3600, token_type: "Bearer" });
type Call = { url: string; body: string };
function server(calls: Call[], refreshDelay = 0) {
  let issued = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), body = String(init?.body ?? "");
    calls.push({ url, body });
    if (url.endsWith("/.well-known/oauth-authorization-server")) return Response.json(metadata);
    if (url === metadata.registration_endpoint) return Response.json({ client_id: "client-1" }, { status: 201 });
    if (url === metadata.token_endpoint) { await new Promise((resolve) => setTimeout(resolve, refreshDelay)); return Response.json(tokens(++issued)); }
    if (url === metadata.revocation_endpoint) return new Response(null, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
const tempFile = async () => path.join(await mkdtemp(path.join(tmpdir(), "openreview-cli-")), "config.json");

test("browser sign-in: registers a loopback client, uses PKCE and state, and exchanges the code for the MCP resource", async () => {
  const calls: Call[] = [];
  let authorize: URL | undefined;
  const login = await browserSignIn(issuer, {
    fetch: server(calls), print: () => {},
    open: (url) => { authorize = new URL(url); void fetch(`${authorize.searchParams.get("redirect_uri")}?code=the-code&state=${authorize.searchParams.get("state")}&iss=${encodeURIComponent(issuer)}`); },
  });
  const params = authorize!.searchParams;
  assert.equal(params.get("client_id"), "client-1");
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(params.get("scope"), "read write");
  assert.equal(params.get("resource"), `${issuer}/api/mcp`);
  assert.match(params.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const registration = JSON.parse(calls.find((c) => c.url === metadata.registration_endpoint)!.body);
  assert.deepEqual([registration.redirect_uris, registration.token_endpoint_auth_method], [[params.get("redirect_uri")], "none"]);
  const exchange = new URLSearchParams(calls.find((c) => c.url === metadata.token_endpoint)!.body);
  assert.equal(exchange.get("code"), "the-code");
  assert.equal(exchange.get("resource"), `${issuer}/api/mcp`);
  assert.ok(exchange.get("code_verifier")!.length >= 43);
  assert.deepEqual({ ...login, expiresAt: 0 }, { url: issuer, clientId: "client-1", tokenEndpoint: metadata.token_endpoint, revocationEndpoint: metadata.revocation_endpoint, resource: `${issuer}/api/mcp`, accessToken: "ora_access_token_1", refreshToken: "orr_refresh_token_1", expiresAt: 0 });
});

test("browser sign-in refuses a response for another request or from another server", async () => {
  for (const [query, message] of [["code=x&state=wrong", /did not match/], ["code=x&state={state}&iss=https%3A%2F%2Fevil.example", /different server/], ["error=access_denied&error_description=Denied&state={state}", /Denied/]] as const) {
    await assert.rejects(browserSignIn(issuer, { fetch: server([]), print: () => {}, open: (url) => { const u = new URL(url); void fetch(`${u.searchParams.get("redirect_uri")}?${query.replace("{state}", u.searchParams.get("state")!)}`); } }), message);
  }
  await assert.rejects(browserSignIn(issuer, { fetch: server([]), print: () => {}, open: () => {}, timeoutMs: 50 }), /Timed out/);
  assert.throws(() => serverUrl("http://review.example.com"), /HTTPS/);
  assert.equal(serverUrl("http://localhost:3000/path"), "http://localhost:3000");
});

test("saved logins are owner-only; concurrent runs refresh a stale token once and share it; logout revokes and deletes", async () => {
  const file = await tempFile(), calls: Call[] = [];
  const stale: BrowserLogin = { url: issuer, clientId: "client-1", tokenEndpoint: metadata.token_endpoint, revocationEndpoint: metadata.revocation_endpoint, resource: `${issuer}/api/mcp`, accessToken: "ora_access_token_0", refreshToken: "orr_refresh_token_0", expiresAt: Date.now() - 1 };
  await saveLogin(stale, file);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const fetcher = server(calls, 50);
  const results = await Promise.all([accessToken(stale, { file, fetch: fetcher }), accessToken(stale, { file, fetch: fetcher }), accessToken(stale, { file, fetch: fetcher })]);
  assert.deepEqual(results, ["ora_access_token_1", "ora_access_token_1", "ora_access_token_1"]);
  assert.equal(calls.filter((c) => c.url === metadata.token_endpoint).length, 1);
  assert.equal(new URLSearchParams(calls[0].body).get("refresh_token"), "orr_refresh_token_0");
  assert.equal((await readLogin(file) as BrowserLogin).refreshToken, "orr_refresh_token_1");
  // A fresh token and API keys are used as they are.
  assert.equal(await accessToken({ ...stale, expiresAt: Date.now() + 600_000 }, { file, fetch: fetcher }), "ora_access_token_0");
  assert.equal(await accessToken({ url: issuer, apiKey: "or_api_key_123456" }), "or_api_key_123456");
  await assert.rejects(accessToken(stale, { file: await tempFile(), fetch: (async () => new Response("{}", { status: 400 })) as typeof fetch }), /openreview login again/);
  await logout({ file, fetch: fetcher });
  assert.equal(new URLSearchParams(calls.at(-1)!.body).get("token"), "orr_refresh_token_1");
  assert.equal(await readLogin(file), null);
  await assert.rejects(readFile(file));
});

test("remote review: matches the checkout's repository, uploads changed files, reports stages and returns findings", async () => {
  const sent: [string, Record<string, unknown>][] = [];
  const stages: string[] = [];
  let polls = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    sent.push([name, args]);
    if (name === "list_repositories") return [{ _id: "repo1", fullName: "Acme/Shop" }];
    if (name === "review_local_changes") return { reviewId: "rev1" };
    polls++;
    return polls === 1 ? { id: "rev1", status: "running", stage: "reviewing", error: null, result: null } : { id: "rev1", status: "completed", stage: "reviewing", error: null, result: { summary: "Clean.", findings: [] } };
  };
  const input = { remote: "acme/shop", baseSha: "a".repeat(40), headSha: "b".repeat(40), title: "Add pay", security: false, diff: "diff --git a/x b/x", files: [{ path: "x", sha: "s", content: "x" }, { path: "big", sha: "s", content: "x".repeat(200_001) }] };
  const result = await remoteReview(call, input, { stage: (s) => stages.push(s), wait: async () => {} });
  assert.deepEqual(result, { repository: "Acme/Shop", summary: "Clean.", findings: [] });
  assert.deepEqual(stages, ["uploading", "reviewing"]);
  const upload = sent.find(([name]) => name === "review_local_changes")![1];
  assert.deepEqual([upload.repositoryId, (upload.files as { path: string }[]).map((f) => f.path), "mode" in upload], ["repo1", ["x"], false]);
  await assert.rejects(remoteReview(call, { ...input, remote: "acme/other" }, { stage: () => {}, wait: async () => {} }), /not a repository in your OpenReview workspace/);
  await assert.rejects(remoteReview(async (name) => name === "list_repositories" ? [{ _id: "repo1", fullName: "acme/shop" }] : name === "review_local_changes" ? { reviewId: "r" } : { status: "failed", error: "Billing: limit reached" }, input, { stage: () => {}, wait: async () => {} }), /Billing: limit reached/);
  await assert.rejects(remoteReview(call, { ...input, diff: "x".repeat(1_000_001) }, { stage: () => {}, wait: async () => {} }), /too large/);
});

test("the mark draws in line by line and the marker lands last; nothing animates outside an interactive terminal", async () => {
  const frames = markFrames(ART, "large");
  assert.equal(frames.length, 8);
  assert.ok(frames[0].sizes.large.every((row) => !row.includes("b")) && frames[0].sizes.large.some((row) => row.includes("a")));
  assert.deepEqual(frames.at(-1)!.sizes.large, ART.sizes.large);
  const written: string[] = [];
  const stream = (isTTY: boolean) => ({ isTTY, columns: 80, write: (text: string) => { written.push(text); return true; } }) as unknown as NodeJS.WriteStream;
  await playBanner({ version: "1.0.0" }, { stream: stream(false) });
  assert.equal(written.length, 0);
  await playBanner({ version: "1.0.0" }, { stream: stream(true), env: { NODE_ENV: "test", CI: "true", COLORTERM: "truecolor" } });
  assert.equal(written.length, 1);
  assert.match(written[0], /OpenReview/);
  await playBanner({}, { stream: stream(true), env: { NODE_ENV: "test", COLORTERM: "truecolor" }, frameMs: 0 });
  assert.ok(written.filter((w) => w.includes("\x1b[38;2;245;78;0m")).length >= 2);
  const plain = stageReporter(stream(false), {} as NodeJS.ProcessEnv);
  plain.stage("finding_issues");
  plain.done();
  assert.equal(written.at(-1), "finding issues\n");
});
