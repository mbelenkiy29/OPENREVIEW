"use node";
import { v } from "convex/values";
import { z } from "zod";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { budgetModel } from "./budgetModel";
import { provider } from "./scm";
import { fileInventory, indexedFiles } from "./fileReads";
import { reviewSemanticHits } from "./semanticSearch";
import { parseDiff } from "../src/engine/diff";
import { hybridRank } from "../src/engine/hybrid";
import { redact } from "../src/engine/indexer";
import { ModelFailure } from "../src/engine/model";
import { reviewChange } from "../src/engine/review";
import { categories, severities, type ModelProvider, type ModelUsage, type SourceFile } from "../src/engine/types";
import { applyRepoConfig, loadRepoConfig, type LoadedRepoConfig } from "../src/repo-config";
import { effectiveThresholds } from "../src/triggers";
import { modes, resolveTier, tiers } from "../src/review-tier";
import { repositoryGuidance, selectPacks } from "../src/guidance-packs";
import { knowledgeTokenBudgets, selectKnowledge } from "../src/knowledge-context";
import { osvClient, osvEnabled } from "../src/osv";
import { shapeLocalResult } from "../src/cli-review";

const upload = z.object({ diff: z.string(), files: z.array(z.object({ path: z.string(), sha: z.string(), content: z.string() })) });

// Reviews a CLI upload with the repository's settings, rules, index context and workspace model, the
// same way jobs.review does for a pull request.
// shortcut: the pipeline engine only, and no cascading directory settings, history, cross-repository or
// ticket context, because those need the head commit on the provider; add them if CLI and PR reviews must match.
export const run = internalAction({
  args: { id: v.id("cliReviews") },
  handler: async (ctx, a) => {
    const row = await ctx.runMutation(internal.cliReviews.claim, a);
    if (!row) return;
    try {
      const stored = await ctx.storage.get(row.inputStorageId);
      if (!stored) throw new Error("The uploaded changes are no longer available");
      const input = upload.parse(JSON.parse(await stored.text()));
      const { repo, settings, rules, preferences } = await ctx.runQuery(internal.repositories.data, { repositoryId: row.repositoryId });
      if (!repo.enabled) throw new Error("Repository disabled");
      const diff = parseDiff(input.diff);
      if (!diff.length) throw new Error("The diff has no changes to review");
      const changed = new Set(diff.filter((f) => f.status !== "removed").map((f) => f.path)), touched = new Set(diff.map((f) => f.path));
      const sources: SourceFile[] = input.files.filter((f) => changed.has(f.path));
      // Repository config as code from the base revision, as for pull requests; an unpushed base has none.
      const repoConfig = await provider(ctx, repo).then((scm) => loadRepoConfig(scm, repo.fullName, row.baseSha)).catch((): LoadedRepoConfig => ({ settings: {}, rules: [], files: [], directories: [], warnings: [] }));
      const effective = applyRepoConfig(settings, repoConfig, [...touched]).settings;
      const tier = resolveTier({ configured: z.enum(modes).catch("standard").parse(effective.mode), diff, requested: row.mode ? { mode: z.enum(tiers).parse(row.mode), source: "comment" } : undefined, cap: z.enum(tiers).catch("deep").parse(effective.maxReviewTier ?? "deep") });
      // Context outside the changed files comes from the index of the default branch.
      const paths = [...touched];
      const graph = await ctx.runQuery(internal.context.related, { repositoryId: repo._id, paths, identifiers: [...new Set(diff.flatMap((f) => f.patch.match(/[A-Za-z_]\w{3,}/g) ?? []))].slice(0, 100) });
      const neighbors = await ctx.runQuery(internal.context.neighborhood, { repositoryId: repo._id, paths, hops: 2, limit: 30 });
      const identifiers = [...new Set(diff.flatMap((f) => f.patch.match(/^\+.*$/gm)?.join("\n").match(/[A-Za-z_]\w{3,}/g) ?? []))].slice(0, 6);
      const textHits = (await Promise.all(identifiers.map((identifier) => ctx.runQuery(internal.agentTools.search, { repositoryId: repo._id, query: identifier })))).flatMap((hits) => hits.map((hit, rank) => ({ path: hit.path, score: 1 / (1 + rank), startLine: hit.line })));
      const semantic = await reviewSemanticHits(ctx, repo._id, row.title + "\n" + diff.map((f) => f.path + "\n" + f.patch.slice(0, 3000)).join("\n"), 24);
      const hybrid = hybridRank({ vector: semantic.hits, text: textHits, graph: neighbors.map((n) => ({ path: n.path, score: n.score })) }, 20);
      const context = [...new Set([...graph.paths, ...neighbors.map((n) => n.path), ...hybrid.map((hit) => hit.path), ...(repo.knowledgePaths ?? []).slice(0, 10)])].filter((path) => !touched.has(path));
      let bytes = 0;
      for (const file of await indexedFiles(ctx, repo._id, context)) {
        if (bytes > 500_000) break;
        const blob = await ctx.storage.get(file.storageId);
        if (!blob) continue;
        const content = await blob.text();
        bytes += content.length;
        sources.push({ path: file.path, sha: file.sha, content });
      }
      const inventory = await fileInventory(ctx, repo._id);
      const base = await budgetModel(ctx, repo.organizationId, settings.model);
      const record = (usage: ModelUsage) => ctx.runMutation(internal.usage.record, { repositoryId: repo._id, kind: "cli-review", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCost: usage.estimatedCost, durationMs: usage.latencyMs });
      const model: ModelProvider = {
        generate: async (request, schema) => {
          try { const result = await base.generate(request, schema); await record(result.usage); return result; }
          catch (error) { if (error instanceof ModelFailure) await record(error.usage); throw error; }
        },
        ...(base.runTools ? { runTools: async (request: Parameters<NonNullable<ModelProvider["runTools"]>>[0]) => {
          try { const turn = await base.runTools!(request); await record(turn.usage); return turn; }
          catch (error) { if (error instanceof ModelFailure) await record(error.usage); throw error; }
        } } : {}),
      };
      const thresholds = effectiveThresholds(effective);
      const guidance = repositoryGuidance(repoConfig.guides ?? []);
      const result = await reviewChange(
        {
          repository: repo.fullName,
          coverageLimits: [...repoConfig.warnings, ...(semantic.note ? [semantic.note] : []), "Reviewed from the OpenReview CLI: files outside this change come from the indexed default branch."],
          baseSha: row.baseSha,
          headSha: row.headSha,
          title: row.title,
          description: "Local commits reviewed from the OpenReview CLI before a pull request.",
          files: sources,
          contextHints: [
            ...hybrid.map((hit) => ({ path: hit.path, reason: `hybrid retrieval: ${hit.reason}`, score: Math.round(20 + 30 * hit.score) })),
            ...neighbors.map((n) => ({ path: n.path, reason: `code graph ${n.via} (${n.hops} hop${n.hops > 1 ? "s" : ""})`, score: Math.round(40 * Math.min(1, n.score)) })),
          ],
          diff,
          mode: tier.mode,
          rules: [...rules.map((r) => ({ id: r._id as string, instructions: r.instructions, severity: z.enum(severities).parse(r.severity), category: r.category, globs: r.globs, enabled: r.enabled })), ...repoConfig.rules],
          preferences: [...preferences, ...(await ctx.runQuery(internal.conventions.approvedForRepo, { repositoryId: repo._id }))],
          guidance: selectPacks(guidance.packs, diff, sources).map(({ id, version, title, body, source }) => ({ id, version, title, body, source })),
          knowledge: selectKnowledge(await ctx.runQuery(internal.knowledge.forReview, { repositoryId: repo._id }), [...touched], new Set(inventory.keys()), knowledgeTokenBudgets[tier.mode]).selected,
          settings: {
            minimumConfidence: thresholds.minimumConfidence,
            severityThreshold: z.enum(severities).parse(thresholds.severityThreshold),
            maxComments: effective.maxComments,
            ignoredPaths: effective.ignoredPaths,
            categories: row.security ? ["security"] : effective.categories.map((c) => z.enum(categories).parse(c)),
            instructions: effective.instructions,
            summarySections: effective.summarySections,
            securityScan: effective.securityScan !== false,
          },
        },
        model,
        async (stage) => { await ctx.runMutation(internal.cliReviews.stage, { id: a.id, stage }); },
        undefined,
        osvEnabled() ? { advisories: osvClient({ base: process.env.OSV_API_URL || undefined }) } : undefined,
      );
      await ctx.runMutation(internal.cliReviews.finish, { id: a.id, result: shapeLocalResult(result) });
    } catch (error) {
      await ctx.runMutation(internal.cliReviews.finish, { id: a.id, error: redact(error instanceof Error ? error.message : "Review failed").slice(0, 2000) || "Review failed" });
    }
  },
});
