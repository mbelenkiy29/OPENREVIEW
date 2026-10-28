import { recordFindingFeedback } from "./feedbackCore";
import { query, mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { authorize, authorizeRepository, visibleRepositories,repositoryScope,audit } from "./auth";
import { ruleApplies, validRepositoryPattern } from "../src/rule-scopes";
import { repositorySourceUrl } from "../src/source-url";
import {contextReadable,requireFindingReader} from "./repositoryContext";
import type {Id} from "./_generated/dataModel";
import {repositoryIdentity} from "./repositoryIdentity";

// Per-rule stats from findings that cite the rule (Greptile's Usage / Addressed rate columns).
const ruleUseCap=1000;
export const rulesPage=query({
  args:{token:v.string(),organizationId:v.id("organizations"),teamId:v.optional(v.id("teams")),repositoryId:v.optional(v.id("repositories")),cursor:v.optional(v.string()),search:v.optional(v.string()),status:v.optional(v.union(v.literal("active"),v.literal("disabled")))},
  handler:async(ctx,args)=>{
    await authorize(ctx,args.token,args.organizationId);
    const repositories=await visibleRepositories(ctx,args.token,args.organizationId,args.teamId);
    if(args.repositoryId&&!repositories.some(r=>r._id===args.repositoryId))throw new Error("Repository not accessible in this scope");
    // Rules that apply to the selected repository (any scope), or every rule whose scope the reader can see.
    const selected=args.repositoryId?repositories.find(r=>r._id===args.repositoryId):undefined;
    const teamIds=new Set(repositories.map(r=>r.teamId).filter(Boolean).map(String)),visible=new Set(repositories.map(r=>String(r._id)));
    const search=args.search?.trim().toLowerCase();
    const page=await ctx.db.query("customRules").withIndex("by_org",q=>q.eq("organizationId",args.organizationId)).order("desc").paginate({numItems:10,cursor:args.cursor??null});
    // shortcut: search and status filter after paging, so a page can come back short; move them into the index if rule counts grow.
    const rules=page.page.filter(r=>(selected?ruleApplies(r,selected):r.repositoryId?repositories.some(x=>x._id===r.repositoryId):r.teamId?teamIds.has(String(r.teamId)):true)
      &&(!args.status||r.enabled===(args.status==="active"))&&(!search||`${r.title}\n${r.instructions}`.toLowerCase().includes(search)));
    const monthStart=new Date(new Date().setUTCDate(1)).setUTCHours(0,0,0,0);
    return {...page,page:await Promise.all(rules.map(async r=>{
      const cited=await ctx.db.query("findings").withIndex("by_org_rule",q=>q.eq("organizationId",args.organizationId).eq("ruleId",r._id)).take(ruleUseCap);
      const uses=cited.filter(f=>visible.has(String(f.repositoryId)));
      return {...r,stats:{uses:uses.length,capped:cited.length===ruleUseCap,addressed:uses.filter(f=>f.status==="resolved").length,usesThisMonth:uses.filter(f=>f.createdAt>=monthStart).length,useful:uses.filter(f=>f.lastFeedback==="useful").length,notUseful:uses.filter(f=>f.lastFeedback==="not_useful"||f.lastFeedback==="false_positive").length}};
    }))};
  }
});

// The latest findings that cite a rule, for the rule's side panel.
export const ruleUsage=query({
  args:{token:v.string(),organizationId:v.id("organizations"),ruleId:v.id("customRules"),teamId:v.optional(v.id("teams"))},
  handler:async(ctx,args)=>{
    await authorize(ctx,args.token,args.organizationId);
    const rule=await ctx.db.get(args.ruleId);
    if(!rule||rule.organizationId!==args.organizationId)return [];
    const visible=new Set((await visibleRepositories(ctx,args.token,args.organizationId,args.teamId)).map(r=>String(r._id)));
    const cited=await ctx.db.query("findings").withIndex("by_org_rule",q=>q.eq("organizationId",args.organizationId).eq("ruleId",args.ruleId)).order("desc").take(50);
    return cited.filter(f=>visible.has(String(f.repositoryId))).sort((a,b)=>b.createdAt-a.createdAt).slice(0,5).map(f=>({_id:f._id,title:f.title,repositoryId:f.repositoryId,prNumber:f.prNumber,reviewId:f.reviewId,status:f.status,createdAt:f.createdAt}));
  }
});

export const overview = query({
  args: { token: v.string(), organizationId: v.id("organizations"),teamId:v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const {user}=await authorize(ctx, args.token, args.organizationId);
    const [reviews, findings, usage, members, rules] =
      await Promise.all([
        ctx.db
          .query("reviews")
          .withIndex("by_org", (q) =>
            q.eq("organizationId", args.organizationId),
          )
          .order("desc")
          .take(100),
        ctx.db
          .query("findings")
          .withIndex("by_org", (q) =>
            q.eq("organizationId", args.organizationId),
          )
          .order("desc")
          .take(200),
        ctx.db
          .query("usageEvents")
          .withIndex("by_org", (q) =>
            q.eq("organizationId", args.organizationId),
          )
          .order("desc")
          .take(1000),
        ctx.db
          .query("organizationMembers")
          .withIndex("by_org", (q) =>
            q.eq("organizationId", args.organizationId),
          )
          .collect(),
        ctx.db
          .query("customRules")
          .withIndex("by_org", (q) =>
            q.eq("organizationId", args.organizationId),
          )
          .take(200),
      ]);
    const {repos:permitted,writable}=await repositoryScope(ctx, args.token, args.organizationId,args.teamId);
    const allowed = new Set(permitted.map(r => String(r._id)));
    const teamIds=new Set(permitted.map(r=>r.teamId).filter(Boolean).map(String));
    const readable=new Map<Id<"reviews">,Promise<boolean>>();
    const mayReadReview=(id:Id<"reviews">)=>{
      let result=readable.get(id);
      if(!result){result=(async()=>{const review=await ctx.db.get(id);return !!review&&review.organizationId===args.organizationId&&allowed.has(review.repositoryId)&&await contextReadable(ctx,user._id,review);})();readable.set(id,result);}
      return result;
    };
    const reviewAccess=await Promise.all(reviews.map(r=>mayReadReview(r._id)));
    const findingAccess=await Promise.all(findings.map(async f=>{
      if(!allowed.has(f.repositoryId)||!await mayReadReview(f.reviewId))return false;
      try{await requireFindingReader(ctx,user._id,f);return true;}catch{return false;}
    }));
    const usageAccess=await Promise.all(usage.map(async u=>allowed.has(u.repositoryId)&&(!u.reviewId||await mayReadReview(u.reviewId))));
    return {
      repositories: await Promise.all(permitted.map(async r=>({...r,provider:await repositoryIdentity(ctx,r)}))),
      writableRepositoryIds:permitted.filter(writable).map(r=>r._id),
      reviews: reviews.filter((_,i)=>reviewAccess[i]),
      findings: findings.filter((_,i)=>findingAccess[i]),
      usage: usage.filter((_,i)=>usageAccess[i]),
      // Same visibility as rulesPage: team rules only for readers of that team's repositories.
      rules: rules.filter(r => r.repositoryId ? allowed.has(r.repositoryId) : !r.teamId || teamIds.has(String(r.teamId))),
      indexJobs: await Promise.all(
        permitted.map((r) =>
          ctx.db
            .query("indexJobs")
            .withIndex("by_repo", (q) => q.eq("repositoryId", r._id))
            .order("desc")
            .first(),
        ),
      ),
      members: await Promise.all(
        members.map(async (m) => ({ ...m, user: await ctx.db.get(m.userId) })),
      ),
      bounded: true,
    };
  },
});
// One scope per rule (none = workspace), and it must belong to the rule's workspace.
export async function assertRuleScope(ctx: MutationCtx, organizationId: Id<"organizations">, scope: { repositoryId?: Id<"repositories">; teamId?: Id<"teams">; repositoryPattern?: string }) {
  if ([scope.repositoryId, scope.teamId, scope.repositoryPattern].filter((x) => x !== undefined && x !== "").length > 1)
    throw new Error("Choose one rule scope: workspace, team, repository pattern or repository");
  if (scope.repositoryId && (await ctx.db.get(scope.repositoryId))?.organizationId !== organizationId)
    throw new Error("Invalid repository scope");
  if (scope.teamId && (await ctx.db.get(scope.teamId))?.organizationId !== organizationId)
    throw new Error("Invalid team scope");
  if (scope.repositoryPattern !== undefined && scope.repositoryPattern !== "" && !validRepositoryPattern(scope.repositoryPattern))
    throw new Error("Invalid repository pattern; use owner/name globs such as acme/*-service");
}
export const rules = mutation({
  args: {
    token: v.string(),
    organizationId: v.id("organizations"),
    id: v.optional(v.id("customRules")),
    remove: v.optional(v.boolean()),
    repositoryId: v.optional(v.id("repositories")),
    teamId: v.optional(v.id("teams")),
    repositoryPattern: v.optional(v.string()),
    title: v.string(),
    instructions: v.string(),
    category: v.string(),
    severity: v.string(),
    globs: v.array(v.string()),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { user } = await authorize(ctx, args.token, args.organizationId, true);
    if (args.id) {
      const old = await ctx.db.get(args.id);
      if (!old || old.organizationId !== args.organizationId)
        throw new Error("Rule not found");
      if (args.remove) {
        await ctx.db.delete(args.id);
        await audit(ctx, args.organizationId, user._id, "rule.deleted", args.id);
        return;
      }
    }
    await assertRuleScope(ctx, args.organizationId, args);
    if (
      !args.title.trim() ||
      !args.instructions.trim() ||
      args.instructions.length > 10000 ||
      !["critical", "high", "medium", "low"].includes(args.severity)
    )
      throw new Error("Invalid rule");
    const rule = {
      organizationId: args.organizationId,
      repositoryId: args.repositoryId,
      teamId: args.teamId,
      repositoryPattern: args.repositoryPattern || undefined,
      title: args.title,
      instructions: args.instructions,
      category: args.category,
      severity: args.severity,
      globs: args.globs,
      enabled: args.enabled,
      updatedAt: Date.now(),
    };
    if (args.id) { await ctx.db.patch(args.id, rule); await audit(ctx, args.organizationId, user._id, "rule.updated", args.id); }
    else await audit(ctx, args.organizationId, user._id, "rule.created", await ctx.db.insert("customRules", { ...rule, createdAt: Date.now() }));
  },
});
export const feedback = mutation({
  args: {
    token: v.string(),
    findingId: v.id("findings"),
    value: v.string(),
    comment: v.string(),
  },
  handler: async (ctx, args) => {
    const finding = await ctx.db.get(args.findingId);
    if (!finding) throw new Error("Finding not found");
    const { user } = await authorizeRepository(ctx, args.token, finding.repositoryId,true);
    if (
      ![
        "useful",
        "not_useful",
        "resolved",
        "wont_fix",
        "false_positive",
      ].includes(args.value) ||
      args.comment.length > 5000
    )
      throw new Error("Invalid feedback");
    await recordFindingFeedback(ctx, finding, { value: args.value, comment: args.comment, userId: user._id });
  },
});
export const knowledge = query({
  args: { token: v.string(), repositoryId: v.id("repositories"), search: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) throw new Error("Repository not found");
    const {user}=await authorizeRepository(ctx, args.token, repo._id);
    if ((args.search?.length ?? 0) > 200) throw new Error("Knowledge search is too long");
    const connection = repo.connectionId ? await ctx.db.get(repo.connectionId) : null;
    const source = connection?.organizationId === repo.organizationId ? connection : undefined;
    const search = args.search?.trim().toLowerCase();
    // ponytail: scan compact repository subsystem records; use a search index if this grows beyond Convex read limits.
    const entries = (await ctx.db
      .query("knowledgeEntries")
      .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
      .collect()).filter(entry => !search || [entry.subsystem, entry.description, ...entry.files, ...entry.dependencies, ...entry.risks, ...entry.conventions].some(value => value.toLowerCase().includes(search)));
    const findings = await ctx.db
      .query("findings")
      .withIndex("by_repo", (q) => q.eq("repositoryId", repo._id))
      .order("desc")
      .take(100);
    const readable=new Map<Id<"reviews">,Promise<boolean>>();
    const permitted=await Promise.all(findings.map(async finding=>{
      let result=readable.get(finding.reviewId);
      if(!result){result=(async()=>{const review=await ctx.db.get(finding.reviewId);return !!review&&review.repositoryId===repo._id&&review.organizationId===repo.organizationId&&await contextReadable(ctx,user._id,review);})();readable.set(finding.reviewId,result);}
      if(!await result)return false;
      try{await requireFindingReader(ctx,user._id,finding);return true;}catch{return false;}
    }));
    const visibleFindings=findings.filter((_,i)=>permitted[i]);
    return entries.map((entry) => ({
      ...entry,
      sources: entry.files.map(path => {
        try {
          if (repo.connectionId && !source) throw new Error("Provider connection unavailable");
          return { path, url: repositorySourceUrl(source?.kind ?? "github", source?.instance ?? "https://github.com", repo.fullName, entry.sha, path, repo.externalId) };
        } catch { return { path, url: undefined }; }
      }),
      pastFindings: visibleFindings
        .filter((finding) => entry.files.includes(finding.filePath))
        .map((finding) => ({
          id: finding._id,
          title: finding.title,
          status: finding.status,
          prNumber: finding.prNumber,
          reviewId: finding.reviewId,
        })),
    }));
  },
});
