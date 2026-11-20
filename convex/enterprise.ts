import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { audit } from "./auth";
import { ensureAccount } from "./billing";
import { requireOperator } from "./operator";
import { billingConfig, contractEnd, contractTermsError, liveSubscription, periodKey, type ContractTerms } from "../src/billing";
import { contributorCount } from "./contributors";
import { operatorEmails } from "./operator";
import { verifiedEmail } from "./referralLedger";
import { emailConfigured } from "../src/email";

// Enterprise contracts (docs/roadmap/enterprise-plan.md, E2.2). An operator enters the negotiated terms; the Stripe
// objects are made by convex/enterpriseJobs.ts. Every step needs an operator's browser session and is audited twice:
// in operatorAudit and on the workspace. The webhook, not these functions, moves the workspace to Enterprise.
export const termsArgs = { mode: v.union(v.literal("managed"), v.literal("ownKey")), startsAt: v.number(), committedContributors: v.number(), contributorPriceCents: v.number(), includedUsagePerContributorUsd: v.number(), overageMultiplier: v.number(), usagePriceId: v.optional(v.string()), netDays: v.number(), graceDays: v.number(), nonBillableAuthors: v.array(v.string()), notes: v.optional(v.string()), supportTier: v.optional(v.string()), retention: v.optional(v.object({ minDays: v.optional(v.number()), maxDays: v.optional(v.number()), auditDays: v.optional(v.number()) })) };

export const saveDraft = internalMutation({ args: { token: v.string(), organizationId: v.id("organizations"), ...termsArgs }, handler: async (ctx, { token, organizationId, ...input }) => {
  const user = await requireOperator(ctx, token), config = billingConfig();
  if (!config.enabled) throw new ConvexError("Billing is disabled on this deployment");
  const organization = await ctx.db.get(organizationId);
  if (!organization) throw new ConvexError("Workspace not found");
  const terms: ContractTerms = { ...input, nonBillableAuthors: [...new Set(input.nonBillableAuthors.map((a) => a.trim()).filter(Boolean))], notes: input.notes?.trim() || undefined, supportTier: input.supportTier?.trim() || undefined };
  const error = contractTermsError(terms, config);
  if (error) throw new ConvexError(error);
  const account = await ensureAccount(ctx, organizationId), current = account.contract;
  // While a contract is in force the form writes its renewal, which must start the day the term ends.
  const renewal = Boolean(current?.stripe?.scheduleId && Date.now() < current.endsAt), slot = renewal ? "nextContract" as const : "contract" as const;
  const old = renewal ? account.nextContract : current?.stripe?.scheduleId ? undefined : current;
  if (renewal && terms.startsAt !== current!.endsAt) throw new ConvexError(`This workspace has a contract until ${new Date(current!.endsAt).toISOString().slice(0, 10)}; a renewal starts that day`);
  if (old?.stripe?.scheduleId) throw new ConvexError("This workspace already has a renewal for the next term");
  const { usagePriceId, ...saved } = terms;
  const contract = { ...saved, endsAt: contractEnd(terms.startsAt), minimumContributors: config.enterpriseMinContributors, ...(usagePriceId ? { stripe: { usagePriceId } } : {}) };
  // A retry with the same terms keeps its id, so each Stripe call reuses its idempotency key; changed terms get a new one.
  const fingerprint = (c: Omit<typeof contract, "stripe"> & { stripe?: { usagePriceId?: string } }) => JSON.stringify([c.mode, c.startsAt, c.committedContributors, c.contributorPriceCents, c.includedUsagePerContributorUsd, c.overageMultiplier, c.netDays, c.graceDays, c.nonBillableAuthors, c.notes ?? "", c.stripe?.usagePriceId ?? "", c.supportTier ?? "", c.retention?.minDays ?? 0, c.retention?.maxDays ?? 0, c.retention?.auditDays ?? 0]);
  const same = old && fingerprint(old) === fingerprint(contract);
  const id = same ? old.id : crypto.randomUUID();
  await ctx.db.patch(account._id, { [slot]: { ...contract, id, ...(same && old.stripe ? { stripe: old.stripe } : {}) }, updatedAt: Date.now() });
  await ctx.db.insert("operatorAudit", { userId: user._id, action: "enterprise.contract_draft", createdAt: Date.now() });
  await audit(ctx, organizationId, user._id, "billing.contract_draft", id);
  // A live Starter or Pro subscription ends when the contract starts (enterpriseJobs sets its cancel_at).
  const replaces = !renewal && liveSubscription(account) && account.plan !== "enterprise" ? account.subscriptionId! : null;
  return { contractId: id, customerId: account.customerId ?? organization.stripeCustomerId ?? null, replaces };
} });

export const saveStripe = internalMutation({ args: { token: v.string(), organizationId: v.id("organizations"), contractId: v.string(), migratedFrom: v.optional(v.string()), stripe: v.object({ productId: v.string(), commitPriceId: v.string(), contributorPriceId: v.string(), usagePriceId: v.optional(v.string()), scheduleId: v.string() }) }, handler: async (ctx, a) => {
  const user = await requireOperator(ctx, a.token);
  const account = await ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).unique();
  const slot = account?.contract?.id === a.contractId ? "contract" as const : account?.nextContract?.id === a.contractId ? "nextContract" as const : null;
  if (!account || !slot) throw new ConvexError("The contract changed while it was being created; start again");
  const contract = account[slot]!;
  await ctx.db.patch(account._id, { [slot]: { ...contract, stripe: a.stripe }, updatedAt: Date.now() });
  if (a.migratedFrom) await audit(ctx, a.organizationId, user._id, "billing.migrated_from_pro", a.migratedFrom);
  await ctx.db.insert("operatorAudit", { userId: user._id, action: "enterprise.contract_created", createdAt: Date.now() });
  await audit(ctx, a.organizationId, user._id, "billing.contract_created", a.contractId);
  // A contract already in force counts this month from its reviews (and applies its non-billable authors).
  if (contract.startsAt <= Date.now()) await ctx.scheduler.runAfter(0, internal.contributors.backfill, { organizationId: a.organizationId, period: periodKey(Date.now()) });
} });

// The form's facts for choosing a commitment: the current subscription and billable contributors in each of the last
// three months. enterpriseJobs.contributorHistory rebuilds those months from reviews first.
export const history = internalQuery({ args: { token: v.string(), organizationId: v.id("organizations") }, handler: async (ctx, a) => {
  await requireOperator(ctx, a.token);
  const account = await ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", a.organizationId)).unique();
  const now = new Date(), periods = [2, 1, 0].map((back) => periodKey(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)));
  return { plan: account && liveSubscription(account) ? account.plan ?? "starter" : null, seats: account?.seats ?? 0, months: await Promise.all(periods.map(async (period) => ({ period, contributors: await contributorCount(ctx, a.organizationId, period) }))) };
} });

// Daily cron: 60 and 30 days before a contract ends, emails the workspace's owners and the operators once each, unless
// a renewal is already signed. Without one the subscription cancels at the end of the term and the workspace has no plan.
export const remindRenewals = internalMutation({ args: {}, handler: async (ctx) => {
  if (!billingConfig().enabled) return 0;
  let sent = 0;
  for (const account of await ctx.db.query("billingAccounts").collect()) {
    const contract = account.contract, daysLeft = contract ? (contract.endsAt - Date.now()) / 86400000 : 0;
    if (!contract?.stripe?.scheduleId || account.plan !== "enterprise" || account.nextContract?.stripe?.scheduleId || daysLeft <= 0) continue;
    const due = ([30, 60] as const).find((d) => daysLeft <= d);
    if (!due || contract.remindersSent?.some((d) => d <= due)) continue;
    await ctx.db.patch(account._id, { contract: { ...contract, remindersSent: [...(contract.remindersSent ?? []), due] } });
    const owners = (await ctx.db.query("organizationMembers").withIndex("by_org", (q) => q.eq("organizationId", account.organizationId)).collect()).filter((m) => m.role === "owner");
    const addresses = new Set([...(await Promise.all(owners.map((m) => verifiedEmail(ctx, m.userId)))), ...await operatorEmails(ctx)].filter((e): e is string => Boolean(e)));
    if (emailConfigured()) for (const to of addresses) await ctx.scheduler.runAfter(0, internal.lifecycleEmails.send, { to, kind: due === 60 ? "contract_ends_60" : "contract_ends_30" });
    sent++;
  }
  return sent;
} });

// One contract across several workspaces (E4.4): puts a workspace under another workspace's contract, or with
// billedOrganizationId null takes it out again, which returns it to its own plan. The workspace joining must have no
// subscription or contract of its own, so nothing is billed twice.
export const setContractGroup = mutation({ args: { token: v.string(), organizationId: v.id("organizations"), billedOrganizationId: v.union(v.id("organizations"), v.null()) }, handler: async (ctx, a) => {
  const user = await requireOperator(ctx, a.token);
  if (!billingConfig().enabled) throw new ConvexError("Billing is disabled on this deployment");
  if (!await ctx.db.get(a.organizationId)) throw new ConvexError("Workspace not found");
  const account = await ensureAccount(ctx, a.organizationId);
  if (a.billedOrganizationId) {
    const billed = await ctx.db.query("billingAccounts").withIndex("by_org", (q) => q.eq("organizationId", a.billedOrganizationId!)).unique();
    if (a.billedOrganizationId === a.organizationId || !billed?.contract?.stripe?.scheduleId || billed.contractGroupId) throw new ConvexError("Choose a workspace that holds a contract of its own");
    if (account.contract || liveSubscription(account)) throw new ConvexError("This workspace has its own subscription or contract; end that first");
    if (await ctx.db.query("billingAccounts").withIndex("by_contract_group", (q) => q.eq("contractGroupId", a.organizationId)).first()) throw new ConvexError("Other workspaces are billed under this one; move them first");
    // Being under a contract is this workspace's plan choice.
    const organization = (await ctx.db.get(a.organizationId))!;
    if (!organization.planSelectedAt) await ctx.db.patch(a.organizationId, { planSelectedAt: Date.now() });
  }
  await ctx.db.patch(account._id, { contractGroupId: a.billedOrganizationId ?? undefined, updatedAt: Date.now() });
  await ctx.db.insert("operatorAudit", { userId: user._id, action: a.billedOrganizationId ? "enterprise.contract_group_joined" : "enterprise.contract_group_left", createdAt: Date.now() });
  await audit(ctx, a.organizationId, user._id, a.billedOrganizationId ? "billing.contract_group_joined" : "billing.contract_group_left", a.billedOrganizationId ?? account.contractGroupId ?? "");
  if (a.billedOrganizationId) await audit(ctx, a.billedOrganizationId, user._id, "billing.contract_group_added", a.organizationId);
} });
