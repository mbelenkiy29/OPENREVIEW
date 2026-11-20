import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { checkCloudKey, cloudBaseUrl, cloudKeyHeader, cloudModelAccess, vertexAccessToken } from "../src/cloud-models";
import { HttpModel } from "../src/engine/model";
import { egressAllowed } from "../src/egress";
import { z } from "zod";

test("cloud model addresses are built from validated parts only", () => {
  assert.equal(cloudBaseUrl("bedrock", { region: "us-east-1" }), "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1");
  assert.equal(cloudBaseUrl("azure", { resource: "Acme-Prod" }), "https://Acme-Prod.openai.azure.com/openai/v1");
  assert.equal(cloudBaseUrl("vertex", { project: "acme-prod-1" }), "https://aiplatform.googleapis.com/v1/projects/acme-prod-1/locations/global/endpoints/openapi");
  assert.equal(cloudBaseUrl("vertex", { project: "acme-prod-1", location: "us-central1" }).includes("/locations/us-central1/"), true);
  for (const bad of [() => cloudBaseUrl("bedrock", { region: "evil.example.com/x" }), () => cloudBaseUrl("bedrock", {}), () => cloudBaseUrl("azure", { resource: "a.evil.com#" }), () => cloudBaseUrl("azure", { resource: "-x" }), () => cloudBaseUrl("vertex", { project: "../x" }), () => cloudBaseUrl("vertex", { project: "acme-prod-1", location: "us/../x" })]) assert.throws(bad, /Enter a valid/);
  assert.deepEqual([cloudKeyHeader("azure"), cloudKeyHeader("bedrock"), cloudKeyHeader("vertex")], ["api-key", undefined, undefined]);
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = JSON.stringify({ client_email: "reviews@acme-prod-1.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
type Call = { url: string; headers: Headers; body: string };
const recorder = (answer: (url: string) => Response) => { const calls: Call[] = []; const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") }); return answer(String(input)); }) as typeof fetch; return { calls, fetchImpl }; };

test("a Vertex service account key is exchanged for an access token with a signed, scoped assertion", async () => {
  const { calls, fetchImpl } = recorder(() => Response.json({ access_token: "ya29.token" }));
  assert.equal(await vertexAccessToken(serviceAccount, fetchImpl, Date.UTC(2026, 10, 19)), "ya29.token");
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  const form = new URLSearchParams(calls[0].body), [header, payload, signature] = form.get("assertion")!.split(".");
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), { iss: "reviews@acme-prod-1.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: Date.UTC(2026, 10, 19) / 1000, exp: Date.UTC(2026, 10, 19) / 1000 + 3600 });
  assert.equal(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, "base64url")), true);
  await assert.rejects(vertexAccessToken("not json", fetchImpl), /service account key file/);
  await assert.rejects(vertexAccessToken("{}", fetchImpl), /missing client_email or private_key/);
  await assert.rejects(vertexAccessToken(serviceAccount, recorder(() => Response.json({ error: "invalid_grant" }, { status: 400 })).fetchImpl), /Google rejected/);
});

test("saving a cloud key checks it with one authenticated call in that provider's own way", async () => {
  const bedrock = recorder(() => Response.json({ data: [] }));
  await checkCloudKey("bedrock", { key: "bedrock-key", region: "eu-west-1" }, bedrock.fetchImpl);
  assert.deepEqual([bedrock.calls[0].url, bedrock.calls[0].headers.get("authorization")], ["https://bedrock-mantle.eu-west-1.api.aws/v1/models", "Bearer bedrock-key"]);
  const azure = recorder(() => Response.json({ data: [] }));
  await checkCloudKey("azure", { key: "azure-key", resource: "acme" }, azure.fetchImpl);
  assert.deepEqual([azure.calls[0].url, azure.calls[0].headers.get("api-key"), azure.calls[0].headers.get("authorization")], ["https://acme.openai.azure.com/openai/v1/models", "azure-key", null]);
  await assert.rejects(checkCloudKey("azure", { key: "bad", resource: "acme" }, recorder(() => new Response("", { status: 401 })).fetchImpl), /rejected this key/);
  const vertex = recorder(() => Response.json({ access_token: "ya29.token" }));
  await checkCloudKey("vertex", { key: serviceAccount, project: "acme-prod-1" }, vertex.fetchImpl);
  assert.deepEqual(vertex.calls.map((c) => c.url), ["https://oauth2.googleapis.com/token"]);
  assert.deepEqual(await cloudModelAccess("vertex", { key: serviceAccount, project: "acme-prod-1" }, vertex.fetchImpl), { baseUrl: "https://aiplatform.googleapis.com/v1/projects/acme-prod-1/locations/global/endpoints/openapi", apiKey: "ya29.token", keyHeader: undefined });
});

test("the model client sends chat completions to the cloud address with that provider's key header, and offline mode allows none of it", async (t) => {
  const seen: Call[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) }); return Response.json({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }); });
  for (const [provider, secret, model] of [["azure", { key: "azure-key", resource: "acme" }, "reviews-deployment"], ["bedrock", { key: "bedrock-key", region: "us-east-1" }, "openai.gpt-oss-120b"]] as const) {
    const access = await cloudModelAccess(provider, secret);
    const client = new HttpModel({ provider: "compatible", model, ...access, workspaceKey: true });
    assert.deepEqual((await client.generate({ task: "summary", system: "s", input: { n: provider } }, z.object({ ok: z.boolean() }))).value, { ok: true });
  }
  assert.deepEqual(seen.map((c) => [c.url, c.headers.get("api-key"), c.headers.get("authorization"), JSON.parse(c.body).model]), [
    ["https://acme.openai.azure.com/openai/v1/chat/completions", "azure-key", null, "reviews-deployment"],
    ["https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions", null, "Bearer bedrock-key", "openai.gpt-oss-120b"],
  ]);
  assert.equal(egressAllowed("workspace-model", { OPENREVIEW_OFFLINE: "true" }), false);
});
