import { createSign } from "node:crypto";

// A workspace's own cloud account as its model provider (Own-key mode): AWS Bedrock, Azure OpenAI and Google
// Vertex AI. All three serve the OpenAI Chat Completions format, so the existing model client talks to them; only
// the address and the credential differ. Addresses are built from validated parts, never taken as a URL, so a
// workspace cannot point our servers anywhere else. Endpoints and auth were read from the providers' docs in
// November 2026 (docs/billing.md, "Own cloud account", lists the pages); none has been run against a real account.
export const cloudProviders = ["bedrock", "azure", "vertex"] as const;
export type CloudProvider = (typeof cloudProviders)[number];
export type CloudSettings = { region?: string; resource?: string; project?: string; location?: string };
export type CloudSecret = { key: string } & CloudSettings;
export const isCloudProvider = (p: string): p is CloudProvider => (cloudProviders as readonly string[]).includes(p);

const part = (value: string | undefined, pattern: RegExp, what: string) => { const v = value?.trim() ?? ""; if (!pattern.test(v)) throw new Error(`Enter a valid ${what}`); return v; };
/** The OpenAI-compatible base URL (without /chat/completions) for a provider and its validated settings. */
export function cloudBaseUrl(provider: CloudProvider, s: CloudSettings): string {
  if (provider === "bedrock") return `https://bedrock-runtime.${part(s.region, /^[a-z]{2}(-[a-z]+){1,3}-\d$/, "AWS region, for example us-east-1")}.amazonaws.com/openai/v1`;
  if (provider === "azure") return `https://${part(s.resource, /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/i, "Azure OpenAI resource name")}.openai.azure.com/openai/v1`;
  return `https://aiplatform.googleapis.com/v1/projects/${part(s.project, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "Google Cloud project ID")}/locations/${part(s.location || "global", /^(global|[a-z]+-[a-z]+\d{1,2})$/, "Vertex location, for example global or us-central1")}/endpoints/openapi`;
}
/** Azure sends its key in an `api-key` header; Bedrock API keys and Vertex access tokens are bearer tokens. */
export const cloudKeyHeader = (provider: CloudProvider) => provider === "azure" ? "api-key" : undefined;

const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64url");
/** A one-hour Vertex access token from a service account key file (JSON), by the OAuth JWT bearer grant. */
export async function vertexAccessToken(serviceAccountJson: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<string> {
  let account: { client_email?: unknown; private_key?: unknown };
  try { account = JSON.parse(serviceAccountJson); } catch { throw new Error("The Vertex key must be a service account key file (JSON)"); }
  if (typeof account.client_email !== "string" || typeof account.private_key !== "string" || !account.private_key.includes("PRIVATE KEY")) throw new Error("The service account key file is missing client_email or private_key");
  const iat = Math.floor(now / 1000), unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }))}`;
  let signature: string;
  try { signature = b64(createSign("RSA-SHA256").update(unsigned).sign(account.private_key)); } catch { throw new Error("The service account private key could not be read"); }
  const response = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(), redirect: "error", signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => null) as { access_token?: unknown } | null;
  if (!response.ok || typeof data?.access_token !== "string") throw new Error("Google rejected this service account key");
  return data.access_token;
}
/** What the model client needs for one job. A Vertex token lasts an hour.
 *  shortcut: the Vertex token is minted once per job, so a job that runs past an hour fails its later calls; refresh inside the client if reviews get that long. */
export async function cloudModelAccess(provider: CloudProvider, secret: CloudSecret, fetchImpl: typeof fetch = fetch) {
  return { baseUrl: cloudBaseUrl(provider, secret), apiKey: provider === "vertex" ? await vertexAccessToken(secret.key, fetchImpl) : secret.key, keyHeader: cloudKeyHeader(provider) };
}
/** One cheap authenticated call when a key is saved, so a wrong key fails then and not on a review. */
export async function checkCloudKey(provider: CloudProvider, secret: CloudSecret, fetchImpl: typeof fetch = fetch) {
  // Minting the token is the check for Vertex: Google verifies the key's signature.
  const access = await cloudModelAccess(provider, secret, fetchImpl);
  if (provider === "vertex") return;
  // Bedrock lists models only on its "mantle" host; bedrock-runtime answers 404 there.
  const url = provider === "bedrock" ? `https://bedrock-mantle.${secret.region!.trim()}.api.aws/v1/models` : `${access.baseUrl}/models`;
  const response = await fetchImpl(url, { headers: access.keyHeader ? { [access.keyHeader]: access.apiKey } : { authorization: `Bearer ${access.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (response.status === 401 || response.status === 403) throw new Error("The provider rejected this key");
  // shortcut: any other answer (Azure may not list models on every resource) saves the key unchecked; send a 1-token completion instead if bad keys get saved.
}
