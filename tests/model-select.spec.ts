import { afterEach, beforeEach, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import type { ReactElement } from "react";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { ModelSelect } from "../app/dashboard/model-select";

const modules = import.meta.glob("../convex/**/*.ts");
const env = { SERVICE_SECRET: "model-select-service", SESSION_SECRET: "model-select-session-secret-at-least-32-characters", LLM_PROVIDER: "openrouter", LLM_MODEL: "openai/gpt-4.1", INFERENCE_PRICES: JSON.stringify({ "openrouter:openai/gpt-4.1": { input: 2, output: 8 }, "openrouter:anthropic/claude-sonnet-5-5": { input: 3, output: 15 } }) };
beforeEach(() => { Object.assign(process.env, env); });
afterEach(() => { for (const k of Object.keys(env)) if (!["SERVICE_SECRET", "SESSION_SECRET"].includes(k)) delete process.env[k]; });

test("Settings → AI Model: a saved non-default model reads back and the select remounts on it", async () => {
  const t = convexTest(schema, modules);
  const id = await t.mutation(api.users.login, { secret: env.SERVICE_SECRET, githubId: 1, login: "admin", avatar: "" });
  const token = await new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(env.SESSION_SECRET));
  const organizationId = await t.mutation(api.users.createOrganization, { token, name: "Acme" });
  const render = async () => { const c = await t.query(api.scopes.modelChoice, { token, organizationId }); return ModelSelect({ name: "model", value: c.model ?? "", models: c.models, empty: "OpenReview default" }) as ReactElement<{ defaultValue: string }>; };

  const before = await render();
  expect(before.props.defaultValue).toBe("");
  await t.mutation(api.scopes.setWorkspaceModel, { token, organizationId, model: "anthropic/claude-sonnet-5-5" });
  const after = await render();
  expect(after.props.defaultValue).toBe("anthropic/claude-sonnet-5-5");
  // React keeps a mounted <select> on its first defaultValue when the form resets after the action; a new key remounts it.
  expect(after.key).not.toBe(before.key);
});
