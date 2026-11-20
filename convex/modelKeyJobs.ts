"use node";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { encryptCredential } from "../src/credentials";
import { checkModelKey } from "../src/engine/model";
import { assertEgress } from "../src/egress";
import { checkCloudKey, cloudBaseUrl, isCloudProvider } from "../src/cloud-models";
import { upgradeNote } from "../src/plans";

// Saves a workspace's own model key: admins only, checked against the provider first, stored encrypted.
export const save = action({ args: { token: v.string(), organizationId: v.id("organizations"), provider: v.union(v.literal("anthropic"), v.literal("openai"), v.literal("openrouter"), v.literal("bedrock"), v.literal("azure"), v.literal("vertex")), key: v.string(), model: v.optional(v.string()), region: v.optional(v.string()), resource: v.optional(v.string()), project: v.optional(v.string()), location: v.optional(v.string()) }, handler: async (ctx, a): Promise<void> => {
  await ctx.runQuery(internal.integrations.authorizeAdmin, { token: a.token, organizationId: a.organizationId });
  if (!await ctx.runQuery(internal.billing.entitlement, { organizationId: a.organizationId, key: "model.ownKey" })) throw new Error(upgradeNote["model.ownKey"]);
  const key = a.key.trim(), model = a.model?.trim() || undefined, cloud = isCloudProvider(a.provider) ? a.provider : null;
  // A Vertex key is a service account key file (JSON); every other key is one token.
  if (!key || (a.provider === "vertex" ? key.length > 10_000 : key.length > 500 || /\s/.test(key))) throw new Error("Enter a valid API key");
  if (model && (model.length > 200 || /\s/.test(model))) throw new Error("Enter a valid model name");
  if (a.provider === "openrouter" && !model) throw new Error("OpenRouter needs a model, for example anthropic/claude-sonnet-5.5");
  if (cloud && !model) throw new Error(cloud === "azure" ? "Azure OpenAI needs your deployment name as the model" : "Enter the model ID to use on this provider");
  assertEgress("workspace-model", "Workspace model keys");
  if (cloud) {
    // The address comes from these parts only (src/cloud-models.ts); they are stored encrypted with the key.
    const secret = { key, ...(cloud === "bedrock" ? { region: a.region } : cloud === "azure" ? { resource: a.resource } : { project: a.project, location: a.location || "global" }) };
    cloudBaseUrl(cloud, secret);
    await ctx.runMutation(internal.modelKeys.checkRate, { organizationId: a.organizationId });
    await checkCloudKey(cloud, secret);
    await ctx.runMutation(internal.modelKeys.save, { token: a.token, organizationId: a.organizationId, provider: cloud, model, credentials: encryptCredential(JSON.stringify(secret), `${a.organizationId}:model`) });
    return;
  }
  await ctx.runMutation(internal.modelKeys.checkRate, { organizationId: a.organizationId });
  await checkModelKey(a.provider as "anthropic" | "openai" | "openrouter", key, model);
  await ctx.runMutation(internal.modelKeys.save, { token: a.token, organizationId: a.organizationId, provider: a.provider, model, credentials: encryptCredential(key, `${a.organizationId}:model`) });
} });
