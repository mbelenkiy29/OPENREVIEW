// Paid tiers and the features each one unlocks (docs/roadmap/pricing-tiers.md). Security checks,
// reviews and the Issues inbox are never gated, so they have no key. With billing disabled
// (self-hosted) every key is granted.
export const tiers = ["trial", "starter", "pro", "business"] as const;
export type Tier = (typeof tiers)[number];
export const entitlementKeys = ["engine.deep", "context.requirements", "fix.pullRequests", "review.reproTests", "memory.conventions", "api.access", "analytics.history", "auth.sso", "auth.scim", "audit.export", "billing.caps"] as const;
export type EntitlementKey = (typeof entitlementKeys)[number];
export const featureNames: Record<EntitlementKey, string> = {
  "engine.deep": "Deeper review engines", "context.requirements": "Requirements check", "fix.pullRequests": "Fix pull requests and Autofix", "review.reproTests": "Generated reproduction tests",
  "memory.conventions": "Learned conventions", "api.access": "API keys and the remote MCP server", "analytics.history": "Analytics beyond 30 days", "auth.sso": "SSO", "auth.scim": "SCIM provisioning", "audit.export": "Audit log export", "billing.caps": "Spending caps",
};
const pro = ["engine.deep", "context.requirements", "fix.pullRequests", "review.reproTests", "memory.conventions", "api.access", "analytics.history"] as const;
// reviewsPerSeat is the default monthly fair-use limit; the trial's is per workspace (BILLING_TRIAL_REVIEWS).
export const planCatalog: Record<Tier, { name: string; reviewsPerSeat: number; entitlements: readonly EntitlementKey[] }> = {
  trial: { name: "Free trial", reviewsPerSeat: 200, entitlements: pro },
  starter: { name: "Starter", reviewsPerSeat: 500, entitlements: [] },
  pro: { name: "Pro", reviewsPerSeat: 1500, entitlements: pro },
  business: { name: "Business", reviewsPerSeat: 3000, entitlements: [...pro, "auth.sso", "auth.scim", "audit.export", "billing.caps"] },
};
/** The cheapest paid tier that includes a feature, for upgrade prompts. */
export const tierFor = (key: EntitlementKey): Tier => (["starter", "pro", "business"] as const).find((t) => planCatalog[t].entitlements.includes(key)) ?? "business";
/** `tier` null means no plan (the trial ended and nothing is subscribed). */
export const entitled = (tier: Tier | null, key: EntitlementKey, billingEnabled: boolean) => !billingEnabled || (tier !== null && planCatalog[tier].entitlements.includes(key));
const paidTiers = ["starter", "pro", "business"] as const;
/** Maps a subscription's Stripe price to its tier; undefined for a price this deployment does not sell. */
export function tierForPrice(price: string, env: Record<string, string | undefined> = process.env): (typeof paidTiers)[number] | undefined {
  const prices = { starter: env.STRIPE_SEAT_PRICE_ID, pro: env.STRIPE_PRO_PRICE_ID, business: env.STRIPE_BUSINESS_PRICE_ID };
  return paidTiers.find((t) => prices[t] && prices[t] === price);
}
/** Display name of a billing decision's plan. */
export const planName = (plan: string) => (tiers as readonly string[]).includes(plan) ? planCatalog[plan as Tier].name : plan;
/** What Pro adds over Starter, for plan cards. */
export const proHighlights = ["Autofix: fix pull requests, on request or automatically for critical and high findings", "Deeper agentic and hypothesis reviews", "Requirements check against Linear, Jira, Confluence and Notion", "Generated reproduction tests, learned conventions, API keys and the remote MCP server"];
