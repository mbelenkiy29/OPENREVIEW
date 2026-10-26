// Cloud plans. Usage allowances live in billingConfig (env); this is which plan unlocks which feature.
// With billing disabled (self-hosted) the plan is "disabled" and everything is unlocked.
export const plans = ["free", "starter", "pro"] as const;
export type Plan = (typeof plans)[number];
// Pro features: the ones that cost us to run, plus the team and admin features. Security checks never are.
export const entitlements = ["review.deep", "review.reproTests", "fix.pullRequests", "context.requirements", "memory.conventions", "api.access", "analytics.history", "auth.sso", "audit.log"] as const;
export type Entitlement = (typeof entitlements)[number];
export const planCatalog: Record<Plan, { name: string; entitlements: readonly Entitlement[] }> = {
  free: { name: "Free", entitlements: [] },
  starter: { name: "Starter", entitlements: [] },
  pro: { name: "Pro", entitlements },
};
// legacy: a Starter subscription from before Pro existed keeps every feature it had (grandfathered).
export const planEntitlements = (plan: Plan | "disabled", legacy = false): readonly Entitlement[] => plan === "disabled" || (legacy && plan === "starter") ? entitlements : planCatalog[plan].entitlements;
export const entitled = (plan: Plan | "disabled", key: Entitlement, legacy = false) => planEntitlements(plan, legacy).includes(key);
export const upgradeNote: Record<Entitlement, string> = {
  "review.deep": "Deep reviews are on the Pro plan, so this review ran at the standard tier.",
  "review.reproTests": "Generated reproduction tests are on the Pro plan.",
  "fix.pullRequests": "Fix pull requests are on the Pro plan; a workspace admin can upgrade in Organization Settings → Billing & Usage.",
  "context.requirements": "Linked Linear, Jira, Confluence and Notion requirements are on the Pro plan, so they were not checked in this review.",
  "memory.conventions": "Learning conventions from review comments is on the Pro plan; approved conventions keep applying.",
  "api.access": "API keys are on the Pro plan; a workspace admin can upgrade in Organization Settings → Billing & Usage. Your keys are kept and work again after upgrading.",
  "analytics.history": "Analytics older than 30 days are on the Pro plan; a workspace admin can upgrade in Organization Settings → Billing & Usage.",
  "auth.sso": "Single sign-on is on the Pro plan; a workspace admin can upgrade in Organization Settings → Billing & Usage.",
  "audit.log": "The audit log is on the Pro plan; a workspace admin can upgrade in Organization Settings → Billing & Usage. Changes are still recorded.",
};
// When the Pro gates shipped: SSO connections created before then stay fully editable on any plan.
export const proGatesAt = Date.UTC(2026, 9, 21);
// Without analytics.history, analytics reach back to the start of the UTC day 30 days ago.
export const historyFloor = (now: number) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 30); };
// The paid plan a Stripe seat price belongs to (monthly or annual); unknown prices map to nothing.
export function planForPrice(price: string | undefined, env: Record<string, string | undefined> = process.env): "starter" | "pro" | undefined {
  if (!price) return undefined;
  if ([env.STRIPE_PRO_PRICE_ID, env.STRIPE_PRO_ANNUAL_PRICE_ID].includes(price)) return "pro";
  if ([env.STRIPE_SEAT_PRICE_ID, env.STRIPE_SEAT_ANNUAL_PRICE_ID].includes(price)) return "starter";
  return undefined;
}
// The monthly seat price Checkout uses for a plan; annual prices are switched to in the Customer Portal.
export function priceFor(plan: "starter" | "pro", env: Record<string, string | undefined> = process.env) {
  const name = plan === "pro" ? "STRIPE_PRO_PRICE_ID" : "STRIPE_SEAT_PRICE_ID", id = env[name];
  if (!id || !/^price_[A-Za-z0-9]+$/.test(id)) throw new Error(`Configure ${name}`);
  return id;
}
