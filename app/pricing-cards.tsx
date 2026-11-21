import Link from "next/link";
import { billingConfig, usdText } from "../src/billing";
import { enterpriseOffer } from "../src/plans";

// Cloud plan cards shared by the home page and /pricing.
export function PricingCards() {
  const billing = billingConfig();
  const enterprise = enterpriseOffer(billing.enabled);
  return <>
    <div className="feature-grid" data-stagger>
      <article className="feature-card"><h3>Starter</h3><p className="price">{process.env.BILLING_SEAT_PRICE_LABEL ?? "Per seat, billed monthly"}</p><p>{usdText(billing.usagePerSeatMicros)} of model usage per seat each month, pooled across the workspace, then optional pay-as-you-go extra usage up to a cap you set. {billing.starterFixesPerSeat} OpenReview agent fixes per seat each month, each opened as a pull request, and your own model key. Owners, admins and members are seats; viewers are free. {billing.trialDays}-day trial, no credit card.</p><p className="pricing-action"><Link className="button" href={`/signup?next=${encodeURIComponent("/dashboard/onboarding/plan?intent=starter")}`}>Choose Starter</Link></p></article>
      <article className="feature-card"><h3>Pro</h3><p className="price">{process.env.BILLING_PRO_PRICE_LABEL ?? "Per seat, billed monthly"}</p><p>{usdText(billing.proUsagePerSeatMicros)} of model usage and {billing.proFixesPerSeat} OpenReview agent fixes per seat each month, plus deep reviews with the agentic engines, generated reproduction tests, requirements checks, SSO, the audit log and API keys. {billing.trialDays}-day trial; Checkout collects a card.</p><p className="pricing-action"><Link className="button primary" href={`/signup?next=${encodeURIComponent("/dashboard/onboarding/plan?intent=pro")}`}>Start Pro trial</Link></p></article>
      {enterprise && <article className="feature-card"><h3>Enterprise</h3><p className="price">{enterprise.priceLabel}</p><p>Pay for active contributors, not seats: only people whose pull requests were reviewed that month count, and bots never do. From {billing.enterpriseMinContributors} contributors, on an annual contract paid by invoice. Run reviews on our model with usage included, or on your own model key with nothing metered. Everything in Pro, plus SCIM provisioning, audit log export, one contract across several workspaces, custom retention terms and a named support tier.</p><p className="pricing-action"><a className="button" href={enterprise.contactUrl}>Talk to us</a></p></article>}
    </div>
    <p className="muted" data-reveal>Self-hosting is free and unlimited: <Link href="/docs/self-hosting">self-hosting guide</Link>. Companies that self-host can buy a support and updates contract; it unlocks nothing, because nothing is locked.</p>
  </>;
}

export function PricingSection({ heading = "h2" }: { heading?: "h1" | "h2" }) {
  return <section id="pricing" className="pricing" aria-labelledby="pricing-heading">
    {heading === "h1" ? <h1 id="pricing-heading">Pricing</h1> : <h2 id="pricing-heading" data-split>Pricing</h2>}
    <PricingCards />
  </section>;
}
