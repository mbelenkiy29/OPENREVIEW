import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { audit, authorize, service } from "./auth";
import { hasEntitlement, scheduleSeatSync } from "./billing";
import { revokeMemberAccess } from "./identity";
import { rateLimit } from "./rateLimit";
import { upgradeNote } from "../src/plans";
import { filterValue, groupInput, groupPatch, groupResource, highestRole, paging, scimError, scimList, scimRoles, userInput, userPatch, userResource, type ScimReply, type ScimRole, type UserInput } from "../src/scim";

// SCIM provisioning (auth.scim, Enterprise): an identity provider creates, deactivates and groups people, and the
// workspace's members follow. A provisioned person is matched to an OpenReview account by verified email; someone
// without an account yet joins at their first SSO sign-in (scimJoin, called from convex/sso.ts).
// Rules: deactivating or deleting removes the membership and signs the person out everywhere; a mapped group sets
// the role; SCIM never makes anyone an owner, never changes an owner's role, and never removes the last owner.
// Active contributors (billing) are counted from pull requests, so provisioning never changes an invoice.

class Refusal extends Error { constructor(readonly status: number, detail: string) { super(detail); } }
const membership = (ctx: QueryCtx, organizationId: Id<"organizations">, userId: Id<"users">) => ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", userId)).unique();
const groupsOf = (ctx: QueryCtx, organizationId: Id<"organizations">) => ctx.db.query("scimGroups").withIndex("by_org", (q) => q.eq("organizationId", organizationId)).take(500);
const userByName = (ctx: QueryCtx, organizationId: Id<"organizations">, userName: string) => ctx.db.query("scimUsers").withIndex("by_org_username", (q) => q.eq("organizationId", organizationId).eq("userName", userName)).unique();
// The role a person's mapped groups give them. Once the workspace maps any group, someone in none of the mapped
// groups is a member (so leaving the admins group demotes them). null while no group is mapped: roles are left alone.
async function mappedRole(ctx: QueryCtx, organizationId: Id<"organizations">, scimUserId: Id<"scimUsers">): Promise<ScimRole | null> {
  const mapped = (await groupsOf(ctx, organizationId)).filter((g) => g.role);
  return mapped.length ? highestRole(mapped.flatMap((g) => g.members.includes(scimUserId) ? [g.role!] : [])) ?? "member" : null;
}
async function accountFor(ctx: QueryCtx, email: string): Promise<Id<"users"> | undefined> {
  return (await ctx.db.query("identities").withIndex("by_email", (q) => q.eq("email", email)).take(20)).find((i) => i.emailVerified)?.userId;
}
// Makes the workspace membership match the provisioned record.
async function sync(ctx: MutationCtx, row: Doc<"scimUsers">) {
  const userId = row.userId ?? await accountFor(ctx, row.userName);
  if (!userId) return;
  if (!row.userId) await ctx.db.patch(row._id, { userId });
  const member = await membership(ctx, row.organizationId, userId), role = await mappedRole(ctx, row.organizationId, row._id);
  if (row.active) {
    if (!member) { await ctx.db.insert("organizationMembers", { organizationId: row.organizationId, userId, role: role ?? "member" }); await audit(ctx, row.organizationId, undefined, "scim.member_added", userId); await scheduleSeatSync(ctx, row.organizationId); }
    else if (role && member.role !== "owner" && member.role !== role) { await ctx.db.patch(member._id, { role }); await audit(ctx, row.organizationId, undefined, "scim.member_role_changed", userId); await scheduleSeatSync(ctx, row.organizationId); }
    return;
  }
  if (!member) return;
  if (member.role === "owner" && (await ctx.db.query("organizationMembers").withIndex("by_org", (q) => q.eq("organizationId", row.organizationId)).collect()).filter((m) => m.role === "owner").length <= 1) throw new Refusal(409, "The last workspace owner cannot be deprovisioned; make someone else an owner first");
  await ctx.db.delete(member._id);
  await revokeMemberAccess(ctx, row.organizationId, userId);
  await audit(ctx, row.organizationId, undefined, "scim.member_removed", userId);
  await scheduleSeatSync(ctx, row.organizationId);
}
/** First SSO sign-in of someone the identity provider provisioned before they had an account: they join now. */
export async function scimJoin(ctx: MutationCtx, organizationId: Id<"organizations">, userId: Id<"users">, email: string): Promise<boolean> {
  const row = await userByName(ctx, organizationId, email.toLowerCase());
  if (!row?.active || (row.userId && row.userId !== userId) || !await hasEntitlement(ctx, organizationId, "auth.scim")) return false;
  await ctx.db.patch(row._id, { userId });
  await sync(ctx, { ...row, userId });
  return true;
}

async function users(ctx: MutationCtx, org: Id<"organizations">, a: { method: string; id?: string; body?: unknown; filter?: string; startIndex?: string; count?: string }, base: string): Promise<ScimReply> {
  const find = async () => { const id = a.id ? ctx.db.normalizeId("scimUsers", a.id) : null, row = id ? await ctx.db.get(id) : null; if (!row || row.organizationId !== org) throw new Refusal(404, "User not found"); return row; };
  const apply = async (row: Doc<"scimUsers">, input: UserInput) => {
    if (input.userName && input.userName !== row.userName && await userByName(ctx, org, input.userName)) throw new Refusal(409, "Another user already has this userName");
    // A changed email is a different account: the old link is dropped and matched again.
    const renamed = Boolean(input.userName && input.userName !== row.userName);
    if (renamed && row.userId && row.active) await sync(ctx, { ...row, active: false });
    const next = { ...row, ...(input.userName ? { userName: input.userName } : {}), ...(input.externalId ? { externalId: input.externalId } : {}), ...(input.displayName ? { displayName: input.displayName } : {}), ...(input.active === undefined ? {} : { active: input.active }), ...(renamed ? { userId: undefined } : {}), updatedAt: Date.now() };
    await ctx.db.patch(row._id, { userName: next.userName, externalId: next.externalId, displayName: next.displayName, active: next.active, userId: next.userId, updatedAt: next.updatedAt });
    await sync(ctx, next);
    return { status: 200, body: userResource(next, base) };
  };
  if (a.method === "GET" && !a.id) {
    const name = filterValue(a.filter, "userName");
    if (name === null) return scimError(400, "Only the filter userName eq \"…\" is supported");
    const all = name === undefined ? await ctx.db.query("scimUsers").withIndex("by_org_username", (q) => q.eq("organizationId", org)).take(5000) : [await userByName(ctx, org, name.toLowerCase())].filter((u): u is Doc<"scimUsers"> => u !== null);
    const { startIndex, count } = paging(a.startIndex, a.count);
    return scimList(all.slice(startIndex - 1, startIndex - 1 + count).map((u) => userResource(u, base)), all.length, startIndex);
  }
  if (a.method === "GET") return { status: 200, body: userResource(await find(), base) };
  if (a.method === "POST") {
    const input = userInput(a.body);
    if (!input.userName) return scimError(400, "userName must be the person's email address");
    if (await userByName(ctx, org, input.userName)) return scimError(409, "A user with this userName already exists");
    const now = Date.now(), id = await ctx.db.insert("scimUsers", { organizationId: org, userName: input.userName, ...(input.externalId ? { externalId: input.externalId } : {}), ...(input.displayName ? { displayName: input.displayName } : {}), active: input.active ?? true, createdAt: now, updatedAt: now });
    const row = (await ctx.db.get(id))!;
    await sync(ctx, row);
    return { status: 201, body: userResource(row, base) };
  }
  if (a.method === "PUT") return apply(await find(), userInput(a.body));
  if (a.method === "PATCH") return apply(await find(), userPatch(a.body));
  if (a.method === "DELETE") {
    const row = await find();
    await sync(ctx, { ...row, active: false });
    for (const g of await groupsOf(ctx, org)) if (g.members.includes(row._id)) await ctx.db.patch(g._id, { members: g.members.filter((m) => m !== row._id), updatedAt: Date.now() });
    await ctx.db.delete(row._id);
    return { status: 204 };
  }
  return scimError(405, "Method not allowed");
}

async function groups(ctx: MutationCtx, org: Id<"organizations">, a: { method: string; id?: string; body?: unknown; filter?: string; startIndex?: string; count?: string }, base: string): Promise<ScimReply> {
  const find = async () => { const id = a.id ? ctx.db.normalizeId("scimGroups", a.id) : null, row = id ? await ctx.db.get(id) : null; if (!row || row.organizationId !== org) throw new Refusal(404, "Group not found"); return row; };
  // Only this workspace's provisioned users can be members; other ids are dropped.
  const valid = async (ids: string[]) => { const out: Id<"scimUsers">[] = []; for (const raw of new Set(ids)) { const id = ctx.db.normalizeId("scimUsers", raw), row = id ? await ctx.db.get(id) : null; if (row?.organizationId === org) out.push(row._id); } return out; };
  // Everyone whose groups changed gets their role (or lack of one) applied again.
  const resync = async (ids: Iterable<Id<"scimUsers">>) => { for (const id of new Set(ids)) { const row = await ctx.db.get(id); if (row) await sync(ctx, row); } };
  if (a.method === "GET" && !a.id) {
    const name = filterValue(a.filter, "displayName");
    if (name === null) return scimError(400, "Only the filter displayName eq \"…\" is supported");
    const all = (await groupsOf(ctx, org)).filter((g) => name === undefined || g.displayName === name), { startIndex, count } = paging(a.startIndex, a.count);
    return scimList(all.slice(startIndex - 1, startIndex - 1 + count).map((g) => groupResource(g, base)), all.length, startIndex);
  }
  if (a.method === "GET") return { status: 200, body: groupResource(await find(), base) };
  if (a.method === "POST") {
    const input = groupInput(a.body);
    if (!input.displayName) return scimError(400, "displayName is required");
    if ((await groupsOf(ctx, org)).some((g) => g.displayName === input.displayName)) return scimError(409, "A group with this displayName already exists");
    const now = Date.now(), members = await valid(input.members ?? []);
    const id = await ctx.db.insert("scimGroups", { organizationId: org, displayName: input.displayName, ...(input.externalId ? { externalId: input.externalId } : {}), members, createdAt: now, updatedAt: now });
    return { status: 201, body: groupResource((await ctx.db.get(id))!, base) };
  }
  if (a.method === "PUT" || a.method === "PATCH") {
    const row = await find(), patch = a.method === "PATCH" ? groupPatch(a.body) : null, input = patch ? null : groupInput(a.body);
    const base0 = patch ? patch.replace ? await valid(patch.replace) : row.members : await valid(input!.members ?? []);
    const removed = new Set<string>(patch ? await valid(patch.remove) : []), members = [...new Set([...base0, ...(patch ? await valid(patch.add) : [])])].filter((m) => !removed.has(m));
    const displayName = (patch ? patch.displayName : input!.displayName) ?? row.displayName;
    await ctx.db.patch(row._id, { displayName, members, updatedAt: Date.now() });
    await resync([...row.members, ...members]);
    return { status: 200, body: groupResource({ ...row, displayName, members, updatedAt: Date.now() }, base) };
  }
  if (a.method === "DELETE") { const row = await find(); await ctx.db.delete(row._id); await resync(row.members); return { status: 204 }; }
  return scimError(405, "Method not allowed");
}

// One SCIM request from the web routes (app/api/scim/v2), which pass the SHA-256 of the bearer token.
export const handle = mutation({ args: { secret: v.string(), tokenHash: v.string(), baseUrl: v.string(), resource: v.union(v.literal("Users"), v.literal("Groups")), method: v.string(), id: v.optional(v.string()), body: v.optional(v.string()), filter: v.optional(v.string()), startIndex: v.optional(v.string()), count: v.optional(v.string()) }, handler: async (ctx, a): Promise<ScimReply> => {
  service(a.secret);
  const token = /^[a-f0-9]{64}$/.test(a.tokenHash) ? await ctx.db.query("scimTokens").withIndex("by_hash", (q) => q.eq("tokenHash", a.tokenHash)).unique() : null;
  if (!token || token.revokedAt) return scimError(401, "Invalid SCIM token");
  const org = token.organizationId;
  if (!await hasEntitlement(ctx, org, "auth.scim")) return scimError(403, upgradeNote["auth.scim"]);
  // 600 requests a minute per workspace; past it the mutation throws and the route answers 429.
  await rateLimit(ctx, `scim:${org}`, 600);
  if (!token.lastUsedAt || Date.now() - token.lastUsedAt > 3600000) await ctx.db.patch(token._id, { lastUsedAt: Date.now() });
  // The body arrives as JSON text: SCIM uses field names ("$ref") that a Convex value cannot carry.
  let body: unknown;
  try { body = a.body === undefined ? undefined : JSON.parse(a.body); } catch { return scimError(400, "The request body is not JSON"); }
  try { return await (a.resource === "Users" ? users : groups)(ctx, org, { ...a, body }, a.baseUrl); }
  catch (error) { if (error instanceof Refusal) return scimError(error.status, error.message); throw error; }
} });

// ---- Admin side (Organization Settings → Organization → SCIM provisioning).
async function admin(ctx: QueryCtx, token: string, organizationId: Id<"organizations">) {
  const who = await authorize(ctx, token, organizationId, true);
  if (!await hasEntitlement(ctx, organizationId, "auth.scim")) throw new Error(upgradeNote["auth.scim"]);
  return who;
}
export const settings = query({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  await authorize(ctx, a.token, a.organizationId, true);
  const tokens = (await ctx.db.query("scimTokens").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(50)).filter((t) => !t.revokedAt);
  const provisioned = await ctx.db.query("scimUsers").withIndex("by_org_username", (q) => q.eq("organizationId", a.organizationId)).take(5000);
  return { tokens: tokens.map((t) => ({ _id: t._id, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt ?? null })), users: provisioned.length, active: provisioned.filter((u) => u.active).length, groups: (await groupsOf(ctx, a.organizationId)).map((g) => ({ _id: g._id, displayName: g.displayName, role: g.role ?? null, members: g.members.length })) };
} });
export const createToken = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), tokenHash: v.string() }, handler: async (ctx, a) => {
  const { user } = await admin(ctx, a.token, a.organizationId);
  if (!/^[a-f0-9]{64}$/.test(a.tokenHash)) throw new Error("Invalid token");
  const id = await ctx.db.insert("scimTokens", { organizationId: a.organizationId, tokenHash: a.tokenHash, createdBy: user._id, createdAt: Date.now() });
  await audit(ctx, a.organizationId, user._id, "scim.token_created", id);
} });
export const revokeToken = mutation({ args: { token: v.string(), tokenId: v.id("scimTokens") }, handler: async (ctx, a) => {
  const row = await ctx.db.get(a.tokenId);
  if (!row) throw new Error("Token not found");
  // Revoking works on any plan, so a workspace that left Enterprise can still shut the door.
  const { user } = await authorize(ctx, a.token, row.organizationId, true);
  await ctx.db.patch(row._id, { revokedAt: Date.now() });
  await audit(ctx, row.organizationId, user._id, "scim.token_revoked", row._id);
} });
export const setGroupRole = mutation({ args: { token: v.string(), groupId: v.id("scimGroups"), role: v.union(...scimRoles.map((r) => v.literal(r)), v.null()) }, handler: async (ctx, a) => {
  const group = await ctx.db.get(a.groupId);
  if (!group) throw new Error("Group not found");
  const { user } = await admin(ctx, a.token, group.organizationId);
  await ctx.db.patch(group._id, { role: a.role ?? undefined, updatedAt: Date.now() });
  await audit(ctx, group.organizationId, user._id, "scim.group_role", `${group.displayName}=${a.role ?? "none"}`);
  // Members get their role now. Clearing the last mapping leaves roles as they are.
  for (const id of group.members) { const row = await ctx.db.get(id); if (row) await sync(ctx, row); }
} });
