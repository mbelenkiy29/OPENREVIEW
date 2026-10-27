import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";

// The Sentry → Claude Code relay: signature check, filtering, and the routine fire that runs after the reply.
const pending = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("next/server", async (original) => ({ ...(await original<object>()), after: (task: () => Promise<unknown>) => { pending.push(task()); } }));
import { POST } from "../app/api/sentry/webhook/route";

const secret = "sentry-client-secret", fireUrl = "https://api.anthropic.com/v1/claude_code/routines/trig_test/fire";
const issue = { shortId: "OPENREVIEW-7", title: "TypeError: x is undefined", culprit: "/dashboard", level: "error", web_url: "https://example.sentry.io/issues/7/", project: { slug: "openreview" } };
let fires: [string, RequestInit][] = [];

async function deliver(payload: unknown, { resource = "issue", key = secret } = {}) {
  const body = JSON.stringify(payload);
  const response = await POST(new Request("https://review.example.com/api/sentry/webhook", { method: "POST", body, headers: { "sentry-hook-resource": resource, "sentry-hook-signature": createHmac("sha256", key).update(body).digest("hex") } }));
  await Promise.all(pending);
  return response.status;
}

beforeEach(() => {
  vi.stubEnv("SENTRY_WEBHOOK_SECRET", secret);
  vi.stubEnv("CLAUDE_ROUTINE_FIRE_URL", fireUrl);
  vi.stubEnv("CLAUDE_ROUTINE_TOKEN", "routine-token");
  vi.stubEnv("SENTRY_PROJECT", "openreview");
  fires = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => { fires.push([String(input), init ?? {}]); return new Response("{}"); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); pending.length = 0; });

test("a new issue fires the routine with its details", async () => {
  expect(await deliver({ action: "created", data: { issue } })).toBe(202);
  expect(fires).toHaveLength(1);
  const [url, init] = fires[0], headers = new Headers(init.headers);
  expect(url).toBe(fireUrl);
  expect(headers.get("authorization")).toBe("Bearer routine-token");
  expect(headers.get("anthropic-beta")).toBe("experimental-cc-routine-2026-04-01");
  expect(JSON.parse(String(init.body)).text).toBe("New Sentry issue OPENREVIEW-7 in openreview: TypeError: x is undefined\nCulprit: /dashboard\nLevel: error\nhttps://example.sentry.io/issues/7/");
});

test("a delivery not signed with the client secret is rejected", async () => {
  expect(await deliver({ action: "created", data: { issue } }, { key: "someone-else" })).toBe(401);
  expect(fires).toHaveLength(0);
});

test("other actions, resources and projects are acknowledged without a run", async () => {
  expect(await deliver({ action: "resolved", data: { issue } })).toBe(204);
  expect(await deliver({ action: "created", data: { issue } }, { resource: "event_alert" })).toBe(204);
  expect(await deliver({ action: "created", data: { issue: { ...issue, project: { slug: "other-app" } } } })).toBe(204);
  expect(fires).toHaveLength(0);
});

test("the route is off until it is configured", async () => {
  vi.stubEnv("CLAUDE_ROUTINE_TOKEN", "");
  expect(await deliver({ action: "created", data: { issue } })).toBe(404);
  expect(fires).toHaveLength(0);
});
