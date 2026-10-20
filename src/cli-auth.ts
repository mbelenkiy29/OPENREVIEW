import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

// CLI sign-in. `openreview login` signs in through the browser with the server's OAuth flow (the one MCP
// clients use: dynamic registration, PKCE, a loopback redirect); `--token` saves an API key instead, for
// CI and scripts. Saved owner-only in ~/.config/openreview/config.json.
export const defaultServer = "https://openreview.tech";
export const configFile = path.join(homedir(), ".config", "openreview", "config.json");
const apiKeyLogin = z.object({ url: z.string().url(), apiKey: z.string().min(16) });
const browserLogin = z.object({ url: z.string().url(), clientId: z.string().min(1), tokenEndpoint: z.string().url(), revocationEndpoint: z.string().url().optional(), resource: z.string().url(), accessToken: z.string().min(16), refreshToken: z.string().min(16), expiresAt: z.number() });
export const savedLogin = z.union([browserLogin, apiKeyLogin]);
export type SavedLogin = z.infer<typeof savedLogin>;
export type BrowserLogin = z.infer<typeof browserLogin>;
type Fetch = typeof fetch;

export function serverUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) throw new Error("Server URL must use HTTPS");
  return parsed.origin;
}

export async function readLogin(file = configFile): Promise<SavedLogin | null> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  try { return savedLogin.parse(JSON.parse(text)); } catch { return null; }
}
// Written to a temporary file and renamed, so a concurrent reader never sees half a file.
export async function saveLogin(login: SavedLogin, file = configFile) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(login), { mode: 0o600 });
  await rename(temporary, file);
}

const metadataSchema = z.object({ issuer: z.string().url(), authorization_endpoint: z.string().url(), token_endpoint: z.string().url(), registration_endpoint: z.string().url(), revocation_endpoint: z.string().url().optional() });
const tokenSchema = z.object({ access_token: z.string().min(16), refresh_token: z.string().min(16), expires_in: z.number().positive() });
async function json(response: Response, what: string) {
  const body = await response.json().catch(() => null) as { error_description?: string; error?: string } | null;
  if (!response.ok) throw new Error(`${what} failed: ${body?.error_description ?? body?.error ?? `HTTP ${response.status}`}`);
  return body;
}
const base64url = (bytes: Buffer) => bytes.toString("base64url");
export function pkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}
export function openBrowser(url: string) {
  const [file, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["explorer.exe", [url]] : ["xdg-open", [url]];
  execFile(file, args, () => { /* The URL is printed too, for machines without a browser. */ });
}

export type LoginIo = { fetch?: Fetch; open?: (url: string) => void; print: (line: string) => void; timeoutMs?: number };
export async function browserSignIn(server: string, io: LoginIo): Promise<BrowserLogin> {
  const request = io.fetch ?? fetch, base = serverUrl(server);
  const metadata = metadataSchema.parse(await json(await request(`${base}/.well-known/oauth-authorization-server`), "Reading the server's sign-in settings"));
  const resource = `${metadata.issuer.replace(/\/+$/, "")}/api/mcp`;
  const { verifier, challenge } = pkce(), state = base64url(randomBytes(16));
  let finish!: (result: { code: string } | { error: string }) => void;
  const callback = new Promise<{ code: string } | { error: string }>((resolve) => { finish = resolve; });
  const listener = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const params = url.searchParams, iss = params.get("iss");
    // A stray or forged callback must not end the sign-in; keep waiting for the real one.
    if (params.get("state") !== state) { res.writeHead(400).end(); return; }
    const result = iss && iss.replace(/\/+$/, "") !== metadata.issuer.replace(/\/+$/, "") ? { error: "The sign-in response came from a different server" }
      : params.get("error") ? { error: params.get("error_description") ?? params.get("error")! }
      : params.get("code") ? { code: params.get("code")! } : { error: "The sign-in response had no code" };
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>OpenReview CLI</title><body style="font:16px system-ui;padding:3rem">${"code" in result ? "Signed in. You can close this tab and return to your terminal." : "Sign-in failed. Return to your terminal for details."}</body>`);
    finish(result);
  });
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  try {
    const redirectUri = `http://127.0.0.1:${(listener.address() as { port: number }).port}/callback`;
    const client = z.object({ client_id: z.string().min(1) }).parse(await json(await request(metadata.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "OpenReview CLI", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) }), "Registering the CLI"));
    const authorize = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", scope: "read write", state, resource })) authorize.searchParams.set(key, value);
    io.print(`Opening your browser to sign in. If it does not open, visit:\n${authorize}`);
    (io.open ?? openBrowser)(authorize.toString());
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([callback, new Promise<{ error: string }>((resolve) => { timer = setTimeout(() => resolve({ error: "Timed out waiting for the browser sign-in" }), io.timeoutMs ?? 300_000); })]).finally(() => clearTimeout(timer));
    if ("error" in result) throw new Error(result.error);
    const tokens = tokenSchema.parse(await json(await request(metadata.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: result.code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri, resource }) }), "Signing in"));
    return { url: base, clientId: client.client_id, tokenEndpoint: metadata.token_endpoint, ...(metadata.revocation_endpoint ? { revocationEndpoint: metadata.revocation_endpoint } : {}), resource, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  } finally {
    listener.close();
  }
}

// Refresh tokens rotate, and presenting a used one revokes the whole grant, so concurrent CLI runs (an
// agent's parallel tool calls) refresh one at a time and reuse a token another run already refreshed.
async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  for (let waited = 0; ; waited += 100) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lock).then((s) => s.mtimeMs).catch(() => Date.now()));
      if (age > 30_000) { await rm(lock, { recursive: true, force: true }); continue; }
      if (waited > 20_000) throw new Error(`Another openreview process holds ${lock}; remove it if none is running`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await work(); } finally { await rm(lock, { recursive: true, force: true }); }
}
const fresh = (login: SavedLogin) => "apiKey" in login || login.expiresAt - 60_000 > Date.now();
export async function accessToken(login: SavedLogin, options: { file?: string; fetch?: Fetch } = {}): Promise<string> {
  if ("apiKey" in login) return login.apiKey;
  if (fresh(login)) return login.accessToken;
  const file = options.file ?? configFile;
  return locked(file, async () => {
    const current = await readLogin(file);
    if (current && "accessToken" in current && current.url === login.url && fresh(current)) return current.accessToken;
    const from = current && "refreshToken" in current && current.url === login.url ? current : login;
    const response = await (options.fetch ?? fetch)(from.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: from.refreshToken, client_id: from.clientId, resource: from.resource }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("Your OpenReview sign-in expired or was revoked. Run openreview login again.");
    const tokens = tokenSchema.parse(await response.json());
    await saveLogin({ ...from, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 }, file);
    return tokens.access_token;
  });
}

// Revokes a browser sign-in on the server (best effort) and removes the saved login.
export async function logout(options: { file?: string; fetch?: Fetch } = {}) {
  const file = options.file ?? configFile, login = await readLogin(file);
  if (login && "refreshToken" in login && login.revocationEndpoint)
    await (options.fetch ?? fetch)(login.revocationEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: login.refreshToken, client_id: login.clientId }), signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
  await rm(file, { force: true });
  return login;
}
// Saves a new login in place of the current one, revoking a browser sign-in it replaces.
export async function replaceLogin(login: SavedLogin, options: { file?: string; fetch?: Fetch } = {}) {
  await logout(options);
  await saveLogin(login, options.file);
}
