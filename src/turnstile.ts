// Cloudflare Turnstile on the forms that email anyone who asks (sign-in links, changelog sign-up).
// The widget (app/turnstile.tsx) puts a single-use token in the form; the route checks it with
// siteverify before anything else runs, so a bot that skips the page never reaches Convex
// (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
// TURNSTILE_MODE: enforce (default with both keys) rejects a failed check; monitor checks and logs
// but never blocks; off skips it. Without both keys, or offline, it is off.
import { offline } from "./egress";

export type TurnstileMode = "off" | "monitor" | "enforce";
export function turnstileConfig(env: Record<string, string | undefined> = process.env) {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() || undefined, secret = env.TURNSTILE_SECRET_KEY?.trim() || undefined, mode = env.TURNSTILE_MODE?.trim();
  return { siteKey, secret, mode: (!siteKey || !secret || offline(env) || mode === "off" ? "off" : mode === "monitor" ? "monitor" : "enforce") as TurnstileMode };
}

// Cloudflare's test secrets accept only dummy tokens, which carry no real hostname or action
// (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
const testSecrets = new Set(["1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000AA"]);

/** pass; fail (missing, invalid, expired or reused token: "timeout-or-duplicate"); or unavailable
 *  (siteverify unreachable or erroring), which callers let through to the rate limits so a Cloudflare
 *  outage never locks out accounts that can only sign in by email. */
export type TurnstileResult = { outcome: "pass" | "fail" | "unavailable"; codes: string[] };
export async function verifyTurnstile(token: unknown, o: { secret: string; action: string; hostname: string; ip?: string | null; fetchImpl?: typeof fetch }): Promise<TurnstileResult> {
  if (typeof token !== "string" || !token || token.length > 2048) return { outcome: "fail", codes: ["missing-input-response"] };
  let response: Response;
  try {
    response = await (o.fetchImpl ?? fetch)("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: o.secret, response: token, ...(o.ip ? { remoteip: o.ip } : {}) }),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch { return { outcome: "unavailable", codes: ["network-error"] }; }
  if (response.status === 429 || response.status >= 500) return { outcome: "unavailable", codes: [`http-${response.status}`] };
  const data = await response.json().catch(() => null) as { success?: unknown; action?: unknown; hostname?: unknown; "error-codes"?: unknown } | null;
  if (!data) return { outcome: "unavailable", codes: ["invalid-response"] };
  const codes = (Array.isArray(data["error-codes"]) ? data["error-codes"] : []).filter((c): c is string => typeof c === "string").slice(0, 5);
  if (codes.includes("internal-error")) return { outcome: "unavailable", codes };
  if (data.success !== true) return { outcome: "fail", codes };
  if (testSecrets.has(o.secret)) return { outcome: "pass", codes };
  if (data.action !== o.action) return { outcome: "fail", codes: ["action-mismatch"] };
  if (data.hostname !== o.hostname) return { outcome: "fail", codes: ["hostname-mismatch"] };
  return { outcome: "pass", codes };
}

/** Checks the form's token as configured: `allowed` is false only for a failed check in enforce mode. */
export async function checkTurnstile(form: FormData | null, action: string, o: { hostname: string; ip?: string | null; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }) {
  const config = turnstileConfig(o.env);
  if (config.mode === "off") return { allowed: true, mode: config.mode, result: null };
  const result = await verifyTurnstile(form?.get("cf-turnstile-response"), { secret: config.secret!, action, hostname: o.hostname, ip: o.ip, fetchImpl: o.fetchImpl });
  return { allowed: config.mode === "monitor" || result.outcome !== "fail", mode: config.mode, result };
}
