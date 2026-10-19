"use node";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { encryptCredential } from "../src/credentials";
import { checkModelKey } from "../src/engine/model";
import { assertEgress } from "../src/egress";

// Saves a workspace's own model key: admins only, checked against the provider first, stored encrypted.
export const save = action({ args: { token: v.string(), organizationId: v.id("organizations"), provider: v.union(v.literal("anthropic"), v.literal("openai"), v.literal("openrouter")), key: v.string(), model: v.optional(v.string()) }, handler: async (ctx, a): Promise<void> => {
  await ctx.runQuery(internal.integrations.authorizeAdmin, { token: a.token, organizationId: a.organizationId });
  const key = a.key.trim(), model = a.model?.trim() || undefined;
  if (!key || key.length > 500 || /\s/.test(key)) throw new Error("Enter a valid API key");
  if (model && (model.length > 200 || /\s/.test(model))) throw new Error("Enter a valid model name");
  if (a.provider === "openrouter" && !model) throw new Error("OpenRouter needs a model, for example anthropic/claude-sonnet-5-5");
  assertEgress("workspace-model", "Workspace model keys");
  await ctx.runMutation(internal.modelKeys.checkRate, { organizationId: a.organizationId });
  await checkModelKey(a.provider, key);
  await ctx.runMutation(internal.modelKeys.save, { token: a.token, organizationId: a.organizationId, provider: a.provider, model, credentials: encryptCredential(key, `${a.organizationId}:model`) });
} });
