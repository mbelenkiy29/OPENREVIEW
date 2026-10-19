import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { audit, authorize } from "./auth";
import { rateLimit } from "./rateLimit";

// A workspace's own model provider key (bring your own key). modelKeyJobs.save checks and encrypts it;
// only budgetModel decrypts it, and `status` never returns it.
const keyOf = (ctx: QueryCtx, organizationId: Id<"organizations">) => ctx.db.query("modelKeys").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).unique();

export const status = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  await authorize(ctx, a.token, a.organizationId);
  const key = await keyOf(ctx, a.organizationId);
  return key ? { provider: key.provider, model: key.model ?? null, updatedAt: key.updatedAt } : null;
} });
export const save = internalMutation({ args: { token: v.string(), organizationId: v.id("organizations"), provider: v.union(v.literal("anthropic"), v.literal("openai"), v.literal("openrouter")), credentials: v.string(), model: v.optional(v.string()) }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  const existing = await keyOf(ctx, a.organizationId);
  const row = { organizationId: a.organizationId, provider: a.provider, credentials: a.credentials, ...(a.model ? { model: a.model } : {}), updatedBy: user._id, updatedAt: Date.now() };
  if (existing) await ctx.db.replace(existing._id, row); else await ctx.db.insert("modelKeys", row);
  await audit(ctx, a.organizationId, user._id, "model_key.saved", a.provider);
} });
// Each save sends the key to the provider, so a workspace cannot use it to test many keys from our servers.
export const checkRate = internalMutation({ args: { organizationId: v.id("organizations") }, handler: (ctx, a) => rateLimit(ctx, `model-key:${a.organizationId}`, 5, 3600000) });
export const remove = mutation({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  const { user } = await authorize(ctx, a.token, a.organizationId, true);
  const key = await keyOf(ctx, a.organizationId);
  if (!key) return;
  await ctx.db.delete(key._id);
  await audit(ctx, a.organizationId, user._id, "model_key.removed", key.provider);
} });
export const forWorkspace = internalQuery({ args: { organizationId: v.id("organizations") }, handler: (ctx, a) => keyOf(ctx, a.organizationId) });
