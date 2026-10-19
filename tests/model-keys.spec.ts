import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import type { z } from "zod";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { HttpModel } from "../src/engine/model";
import type { ModelRequest } from "../src/engine/types";

const modules = import.meta.glob("../convex/**/*.ts");
const env = { SERVICE_SECRET: "model-key-service", SESSION_SECRET: "model-key-session-secret-at-least-32-characters", CREDENTIAL_ENCRYPTION_KEY: "model-key-encryption-key-at-least-32-characters", LLM_PROVIDER: "openai", LLM_API_KEY: "sk-platform", LLM_MODEL_RULES: "gpt-platform-rules" };
beforeEach(() => { Object.assign(process.env, env); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const k of Object.keys(env)) if (!["SERVICE_SECRET", "SESSION_SECRET"].includes(k)) delete process.env[k]; });

test("model keys: admins save a checked, encrypted workspace key that every model call then uses instead of the platform key and budget", async () => {
  const t = convexTest(schema, modules);
  const sign = async (githubId: number) => { const id = await t.mutation(api.users.login, { secret: env.SERVICE_SECRET, githubId, login: "u" + githubId, avatar: "" }); return { id, token: await new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(env.SESSION_SECRET)) }; };
  const admin = await sign(1), member = await sign(2);
  const organizationId = await t.mutation(api.users.createOrganization, { token: admin.token, name: "Acme" });
  await t.run((ctx) => ctx.db.insert("organizationMembers", { organizationId, userId: member.id, role: "member" }));

  // The provider check: one GET with the key; this fake provider only accepts "sk-ant-good".
  const checks: { url: string; headers: Record<string, string> }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const headers = init?.headers as Record<string, string>;
    checks.push({ url: String(url), headers });
    return new Response("{}", { status: headers["x-api-key"] === "sk-ant-good" ? 200 : 401 });
  });
  // Model calls: record which key, model and budget each one would use.
  const calls: { apiKey: string; provider: string; model: string; budget: boolean }[] = [];
  vi.spyOn(HttpModel.prototype, "generate").mockImplementation(async function generate<T>(this: HttpModel, request: ModelRequest, validator: z.ZodType<T>) {
    const self = this as unknown as { config: { apiKey: string; provider: string }; billing?: unknown; modelFor(task: string): string };
    calls.push({ apiKey: self.config.apiKey, provider: self.config.provider, model: self.modelFor(request.task), budget: Boolean(self.billing) });
    return { value: validator.parse({ rule: { title: "Store money as integer cents", instructions: "Flag code that stores currency as floating-point dollars instead of integer cents.", category: "correctness", severity: "high", globs: ["src/**"] }, rationale: "Floats round." }), usage: { task: request.task, provider: "fake", model: "fake", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
  });
  const draft = async () => {
    await t.mutation(api.ruleAssistant.request, { token: admin.token, organizationId, kind: "draft", description: "We keep money in cents, never floats." });
    vi.useFakeTimers(); await t.finishAllScheduledFunctions(() => vi.runAllTimersAsync()); vi.useRealTimers();
    return calls.at(-1);
  };
  const save = (token: string, key: string, provider: "anthropic" | "openai" | "openrouter" = "anthropic") => t.action(api.modelKeyJobs.save, { token, organizationId, provider, key });
  const rows = () => t.run((ctx) => ctx.db.query("modelKeys").collect());

  // Without a workspace key: the platform key, the operator's task routing and the inference budget.
  expect(await draft()).toEqual({ apiKey: "sk-platform", provider: "openai", model: "gpt-platform-rules", budget: true });

  // Only admins save; a rejected key or an OpenRouter key without a model is never stored.
  await expect(save(member.token, "sk-ant-good")).rejects.toThrow(/Forbidden/);
  await expect(save(admin.token, "sk-ant-bad")).rejects.toThrow(/rejected/);
  await expect(save(admin.token, "sk-or-good", "openrouter")).rejects.toThrow(/OpenRouter needs a model/);
  expect(await rows()).toEqual([]);

  await save(admin.token, " sk-ant-good ");
  expect(checks.at(-1)).toMatchObject({ url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": "sk-ant-good" } });
  const [row] = await rows();
  expect([row.provider, row.credentials.includes("sk-ant-good")]).toEqual(["anthropic", false]);
  const status = await t.query(api.modelKeys.status, { token: member.token, organizationId });
  expect(status).toEqual({ provider: "anthropic", model: null, updatedAt: row.updatedAt });

  // With the key: the workspace's provider and default model, no operator routing and no budget reservation.
  expect(await draft()).toEqual({ apiKey: "sk-ant-good", provider: "anthropic", model: "claude-sonnet-5-5", budget: false });

  // Only admins remove it; afterwards calls return to the platform key.
  await expect(t.mutation(api.modelKeys.remove, { token: member.token, organizationId })).rejects.toThrow(/Forbidden/);
  await t.mutation(api.modelKeys.remove, { token: admin.token, organizationId });
  expect(await rows()).toEqual([]);
  expect(await draft()).toEqual({ apiKey: "sk-platform", provider: "openai", model: "gpt-platform-rules", budget: true });
  expect((await t.run((ctx) => ctx.db.query("auditEvents").collect())).filter((e) => e.action.startsWith("model_key.")).map((e) => e.action)).toEqual(["model_key.saved", "model_key.removed"]);
});
