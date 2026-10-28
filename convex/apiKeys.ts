import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { authorize, service, audit } from "./auth";
import { apiScopes, legacyScopes } from "../src/api-scopes";
import { rateLimit } from "./rateLimit";
import { hasEntitlement } from "./billing";
import { upgradeNote } from "../src/plans";
export const create = mutation({
  args: {
    token: v.string(),
    organizationId: v.id("organizations"),
    name: v.string(),
    hash: v.string(),
    prefix: v.string(),
    scopes: v.optional(v.array(v.string())),
    perforce: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { user } = await authorize(
      ctx,
      args.token,
      args.organizationId,
      true,
    );
    // A Perforce key (admin scope, Perforce routes only) works on every plan, so the P4 watcher can run on Free.
    if (!args.perforce && !await hasEntitlement(ctx, args.organizationId, "api.access")) throw new Error(upgradeNote["api.access"]);
    if (!args.name.trim() || !/^[a-f0-9]{64}$/.test(args.hash))
      throw new Error("Invalid API key");
    const scopes = args.perforce ? ["admin"] : [...new Set(args.scopes ?? ["read"])];
    if (!scopes.length || scopes.some((s) => !(apiScopes as readonly string[]).includes(s))) throw new Error("Invalid API key scopes");
    // Settings lists 100 keys; past that an active key could not be seen or revoked there.
    if ((await ctx.db.query("apiKeys").withIndex("by_org", (q) => q.eq("organizationId", args.organizationId)).filter((q) => q.eq(q.field("revoked"), false)).take(100)).length >= 100) throw new Error("A workspace can have at most 100 active API keys; revoke one first");
    const id=await ctx.db.insert("apiKeys", {
      organizationId: args.organizationId,
      userId: user._id,
      hash: args.hash,
      name: args.name.slice(0, 100),
      prefix: args.prefix.slice(0, 16),
      revoked: false,
      createdAt: Date.now(),
      scopes,
      ...(args.perforce ? { perforce: true } : {}),
    });
    await audit(ctx,args.organizationId,user._id,"api_key.created",id);
    return id;
  },
});
export const list = query({
  args: { token: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    await authorize(ctx, args.token, args.organizationId, true);
    // Newest first, every active key (create caps them at 100) before recently revoked ones.
    const recent = (revoked: boolean) => ctx.db
      .query("apiKeys")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .filter((q) => q.eq(q.field("revoked"), revoked))
      .take(100);
    const active = await recent(false);
    const keys = [...active, ...(await recent(true)).slice(0, 100 - active.length)];
    return keys.map((k) => ({
      _id: k._id,
      name: k.name,
      prefix: k.prefix,
      revoked: k.revoked,
      createdAt: k.createdAt,
      scopes: k.scopes ?? legacyScopes,
      legacy: !k.scopes,
      perforce: Boolean(k.perforce),
    }));
  },
});
export const revoke = mutation({
  args: { token: v.string(), keyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.keyId);
    if (!key) throw new Error("Key not found");
    const {user}=await authorize(ctx, args.token, key.organizationId, true);
    if(!key.revoked){
      await ctx.db.patch(key._id, { revoked: true });
      await audit(ctx,key.organizationId,user._id,"api_key.revoked",key._id);
    }
  },
});
export const resolve = query({
  args: { secret: v.string(), hash: v.string() },
  handler: async (ctx, args) => {
    service(args.secret);
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", args.hash))
      .unique();
    if (!key || key.revoked) throw new Error("Invalid API key");
    const member = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", key.organizationId).eq("userId", key.userId),
      )
      .unique();
    if (!member)
      throw new Error("API key owner no longer has workspace access");
    // Keys outlive a plan change: the caller answers 402 while the plan lacks API access.
    return { userId: key.userId, organizationId: key.organizationId, scopes: key.scopes ?? legacyScopes, perforce: Boolean(key.perforce), apiAccess: await hasEntitlement(ctx, key.organizationId, "api.access") };
  },
});
// Per-key public API budget, keyed on the key hash; the route answers 429 when it is spent.
export const consume = mutation({
  args: { secret: v.string(), hash: v.string() },
  handler: async (ctx, args) => {
    service(args.secret);
    // A boolean, not the thrown message: production Convex redacts error messages.
    return rateLimit(ctx, "api_key:" + args.hash, 120).then(() => true, () => false);
  },
});
