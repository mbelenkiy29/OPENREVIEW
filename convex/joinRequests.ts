import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { audit, authenticated, authorize, service } from "./auth";
import { rateLimit } from "./rateLimit";
import { scheduleSeatSync } from "./billing";

// "Join a team", as on Greptile: a team is a GitHub organization or GitLab group connected to a workspace
// (scopes.providerTeam). The web server passes the App installations the signed-in GitHub user can access and the
// GitLab groups the GitLab user belongs to (src/join-teams.ts); the teams on them that the user can't see yet are open
// to request, and an org admin or that team's admin answers.
const githubTeamKey = (accountId: number) => JSON.stringify(["github", "https://api.github.com", String(accountId)]);
const proof = { installationIds: v.array(v.number()), gitlab: v.optional(v.object({ instance: v.string(), groupIds: v.array(v.string()) })) };
type Proof = { installationIds: number[]; gitlab?: { instance: string; groupIds: string[] } };
const teamMember = (ctx: QueryCtx | MutationCtx, teamId: Id<"teams">, userId: Id<"users">) =>
  ctx.db.query("teamMembers").withIndex("by_team_user", (q) => q.eq("teamId", teamId).eq("userId", userId)).unique();
const orgMember = (ctx: QueryCtx | MutationCtx, organizationId: Id<"organizations">, userId: Id<"users">) =>
  ctx.db.query("organizationMembers").withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", userId)).unique();

async function joinableTeams(ctx: QueryCtx | MutationCtx, userId: Id<"users">, p: Proof) {
  const found: { team: Doc<"teams">; organization: Doc<"organizations">; provider: "github" | "gitlab" }[] = [];
  const add = async (team: Doc<"teams"> | undefined, provider: "github" | "gitlab") => {
    const organization = team && await ctx.db.get(team.organizationId);
    if (!team || !organization || found.some((f) => f.team._id === team._id)) return;
    // Organization admins already see every team.
    if (["owner", "admin"].includes((await orgMember(ctx, organization._id, userId))?.role ?? "") || (await teamMember(ctx, team._id, userId))) return;
    found.push({ team, organization, provider });
  };
  for (const installationId of p.installationIds.slice(0, 200)) {
    const installation = await ctx.db.query("githubInstallations").withIndex("by_installation", (q) => q.eq("installationId", installationId)).unique();
    if (!installation?.active) continue;
    await add((await ctx.db.query("teams").withIndex("by_org", (q) => q.eq("organizationId", installation.organizationId)).collect()).find((t) => t.externalKey === githubTeamKey(installation.accountId)), "github");
  }
  // A GitLab group can be connected to several workspaces, each with its own team.
  for (const groupId of p.gitlab?.groupIds.slice(0, 200) ?? [])
    for (const team of await ctx.db.query("teams").withIndex("by_external", (q) => q.eq("externalKey", JSON.stringify(["gitlab", p.gitlab!.instance, groupId]))).take(20)) await add(team, "gitlab");
  return found;
}
const existing = (ctx: QueryCtx | MutationCtx, userId: Id<"users">, teamId: Id<"teams">) =>
  ctx.db.query("joinRequests").withIndex("by_user_team", (q) => q.eq("userId", userId).eq("teamId", teamId)).unique();

export const joinable = query({
  args: { token: v.string(), secret: v.string(), ...proof },
  handler: async (ctx, { token, secret, ...p }) => {
    service(secret);
    const user = await authenticated(ctx, token);
    return Promise.all((await joinableTeams(ctx, user._id, p)).map(async ({ team, organization, provider }) => ({
      teamId: team._id, team: team.name, organization: organization.name, provider, requested: Boolean(await existing(ctx, user._id, team._id)),
    })));
  },
});

export const request = mutation({
  args: { token: v.string(), secret: v.string(), teamId: v.id("teams"), ...proof },
  handler: async (ctx, { token, secret, teamId, ...p }) => {
    service(secret);
    const user = await authenticated(ctx, token);
    const match = (await joinableTeams(ctx, user._id, p)).find((f) => f.team._id === teamId);
    if (!match) throw new Error("Your GitHub or GitLab user can't see this team's organization or group, or you're already in the team");
    if (await existing(ctx, user._id, teamId)) return;
    await rateLimit(ctx, `join-request:${user._id}`, 10, 86_400_000);
    const id = await ctx.db.insert("joinRequests", { organizationId: match.organization._id, teamId, userId: user._id, createdAt: Date.now() });
    await audit(ctx, match.organization._id, user._id, "join_request.created", id);
    await ctx.scheduler.runAfter(0, internal.notificationJobs.joinRequest, { requestId: id });
  },
});

/** Requests the caller can answer: all of them for org owners and admins, their own teams' for team admins. */
export const pending = query({
  args: { token: v.string(), organizationId: v.id("organizations") },
  handler: async (ctx, a) => {
    const { user, member } = await authorize(ctx, a.token, a.organizationId);
    const admin = ["owner", "admin"].includes(member.role);
    const rows = await Promise.all((await ctx.db.query("joinRequests").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).take(200)).map(async (r) => {
      if (!admin && (await teamMember(ctx, r.teamId, user._id))?.role !== "admin") return null;
      const [requester, team] = await Promise.all([ctx.db.get(r.userId), ctx.db.get(r.teamId)]);
      return requester && team ? { _id: r._id, login: requester.login, team: team.name, createdAt: r.createdAt } : null;
    }));
    return rows.filter((r) => r !== null);
  },
});

export const answer = mutation({
  args: { token: v.string(), requestId: v.id("joinRequests"), approve: v.boolean() },
  handler: async (ctx, a) => {
    const request = await ctx.db.get(a.requestId);
    if (!request) throw new Error("This request was already answered");
    const { user, member } = await authorize(ctx, a.token, request.organizationId);
    if (!["owner", "admin"].includes(member.role) && (await teamMember(ctx, request.teamId, user._id))?.role !== "admin") throw new Error("Team admin required");
    if (a.approve) {
      if (!(await ctx.db.get(request.teamId))) throw new Error("This team no longer exists; decline the request");
      // Member is a seat; admins change the role afterwards in People.
      if (!(await orgMember(ctx, request.organizationId, request.userId))) await ctx.db.insert("organizationMembers", { organizationId: request.organizationId, userId: request.userId, role: "member" });
      if (!(await teamMember(ctx, request.teamId, request.userId))) await ctx.db.insert("teamMembers", { organizationId: request.organizationId, teamId: request.teamId, userId: request.userId, role: "member" });
      await scheduleSeatSync(ctx, request.organizationId);
    }
    await ctx.db.delete(request._id);
    await audit(ctx, request.organizationId, user._id, a.approve ? "join_request.approved" : "join_request.declined", request._id);
  },
});
