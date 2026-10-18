"use node";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { inferenceBilling } from "./budgetModel";
import { Embeddings } from "../src/engine/embeddings";
import { redact } from "../src/engine/indexer";
import type { RankedHit } from "../src/engine/hybrid";

// Chunk-level vector search within one repository; empty when no embedding endpoint is configured.
export async function semanticHits(ctx: ActionCtx, repositoryId: Id<"repositories">, text: string, limit = 16): Promise<RankedHit[]> {
  const model = process.env.EMBEDDING_MODEL;
  if (!model || !text.trim()) return [];
  const embedder = new Embeddings(inferenceBilling(ctx)), started = Date.now();
  const embedded = await embedder.embed([redact(text).slice(0, 8000)]);
  await ctx.runMutation(internal.embeddings.usage, { repositoryId, tokens: embedded.tokens, estimatedCost: embedded.estimatedCost, durationMs: Date.now() - started });
  const matches = await ctx.vectorSearch("chunkEmbeddings", "by_vector", { vector: embedded.vectors[0], limit: Math.min(64, limit), filter: (q) => q.eq("scope", `${repositoryId}:${model}`) });
  const scores = new Map(matches.map((m) => [m._id, m._score]));
  return (await ctx.runQuery(internal.embeddings.chunkHits, { ids: matches.map((m) => m._id), repositoryId })).map((h) => ({ path: h.path, startLine: h.startLine, endLine: h.endLine, score: scores.get(h.id) ?? 0, reason: h.symbol }));
}
// Review context: a failing embedding endpoint degrades to graph and text retrieval with a coverage
// note, instead of failing the whole review.
export async function reviewSemanticHits(ctx: ActionCtx, repositoryId: Id<"repositories">, text: string, limit = 16, search = semanticHits): Promise<{ hits: RankedHit[]; note?: string }> {
  try { return { hits: await search(ctx, repositoryId, text, limit) }; }
  catch (error) {
    console.error(JSON.stringify({ event: "review.semantic_search_failed", repositoryId, error: redact(error instanceof Error ? error.message : "failed").slice(0, 200) }));
    return { hits: [], note: "Semantic code search was unavailable for this review; related code came from the code graph and text search only." };
  }
}
