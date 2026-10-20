import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { inferencePrice, inferenceMicros, reservationMicros } from "../src/inference-billing";
import { billingConfig } from "../src/billing";
import { reserveUsage, settleUsage } from "./billing";

export const initialize = internalMutation({ args: { limitMicros: v.number(), baselineMicros: v.number(), source: v.string() }, handler: async (ctx, a) => {
  if (![a.limitMicros, a.baselineMicros].every(n => Number.isSafeInteger(n) && n >= 0) || a.limitMicros < a.baselineMicros || !a.source.trim() || a.source.length > 1000) throw new Error("Invalid inference budget baseline");
  const old = await ctx.db.query("inferenceBudgets").unique();
  if (old) {
    if (old.limitMicros !== a.limitMicros || old.baselineMicros !== a.baselineMicros || old.source !== a.source) throw new Error("Inference budget already initialized; cannot reset spending");
    return old._id;
  }
  return ctx.db.insert("inferenceBudgets", { ...a, committedMicros: a.baselineMicros, reservedMicros: 0, createdAt: Date.now() });
} });
// One reservation covers the deployment-wide cap and, with billing on, the workspace's monthly usage.
export const reserve = internalMutation({ args: { provider: v.string(), model: v.string(), baseUrl: v.string(), inputTokenCeiling: v.number(), outputTokenCeiling: v.number(), organizationId: v.optional(v.id("organizations")) }, handler: async (ctx, { organizationId, ...a }) => {
  const budget = await ctx.db.query("inferenceBudgets").unique();
  if (!budget && !(organizationId && billingConfig().enabled)) return null;
  const price = inferencePrice(a), micros = reservationMicros(a.inputTokenCeiling, a.outputTokenCeiling, price);
  if (!micros || (budget && budget.committedMicros + budget.reservedMicros + micros > budget.limitMicros)) throw new Error("Inference budget exhausted; no provider request was sent");
  const usageId = organizationId ? await reserveUsage(ctx, organizationId, micros) : null;
  const id = await ctx.db.insert("inferenceReservations", { ...(budget ? { budgetId: budget._id } : {}), ...(usageId ? { usageId } : {}), ...a, inputPrice: price.input, outputPrice: price.output, ...(price.cacheRead !== undefined ? { cacheReadPrice: price.cacheRead } : {}), ...(price.cacheWrite !== undefined ? { cacheWritePrice: price.cacheWrite } : {}), reservedMicros: micros, status: "reserved", createdAt: Date.now() });
  if (budget) await ctx.db.patch(budget._id, { reservedMicros: budget.reservedMicros + micros });
  return id;
} });
export const settle = internalMutation({ args: { id: v.id("inferenceReservations"), inputTokens: v.number(), outputTokens: v.number(), cacheReadTokens: v.optional(v.number()), cacheWriteTokens: v.optional(v.number()) }, handler: async (ctx, a) => {
  const reservation = await ctx.db.get(a.id); if (!reservation) throw new Error("Inference reservation missing");
  const amount = inferenceMicros(a.inputTokens, a.outputTokens, { input: reservation.inputPrice, output: reservation.outputPrice, cacheRead: reservation.cacheReadPrice, cacheWrite: reservation.cacheWritePrice }, { read: a.cacheReadTokens, write: a.cacheWriteTokens });
  if (a.inputTokens > reservation.inputTokenCeiling || a.outputTokens > reservation.outputTokenCeiling || amount > reservation.reservedMicros) throw new Error("Inference receipt exceeds reserved ceiling; reservation retained");
  if (reservation.status === "settled") {
    if (reservation.inputTokens !== a.inputTokens || reservation.outputTokens !== a.outputTokens || (reservation.cacheReadTokens ?? 0) !== (a.cacheReadTokens ?? 0) || (reservation.cacheWriteTokens ?? 0) !== (a.cacheWriteTokens ?? 0)) throw new Error("Inference receipt already settled differently");
    return;
  }
  const budget = reservation.budgetId ? await ctx.db.get(reservation.budgetId) : null;
  if (reservation.budgetId && !budget) throw new Error("Inference budget missing");
  if (budget) await ctx.db.patch(budget._id, { reservedMicros: budget.reservedMicros - reservation.reservedMicros, committedMicros: budget.committedMicros + amount });
  if (reservation.usageId) await settleUsage(ctx, reservation.usageId, reservation.reservedMicros, amount);
  await ctx.db.patch(reservation._id, { status: "settled", inputTokens: a.inputTokens, outputTokens: a.outputTokens, ...(a.cacheReadTokens ? { cacheReadTokens: a.cacheReadTokens } : {}), ...(a.cacheWriteTokens ? { cacheWriteTokens: a.cacheWriteTokens } : {}), settledMicros: amount, settledAt: Date.now() });
} });
export const status = internalQuery({ args: {}, handler: async ctx => ctx.db.query("inferenceBudgets").unique() });
