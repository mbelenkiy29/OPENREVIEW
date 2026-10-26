import type { ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { checkoutTrialEnd, usdText } from "../../src/billing";
import { formatMoney, referralConfig, referralDisclosure, referralFact } from "../../src/referrals";
import { Icon } from "../ui/icons";
import { applyReferralCode, changePlan, openBillingPortal, setSpendingCap, startCheckout } from "./actions";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" });
const statusLabel = (status: string) => status[0].toUpperCase() + status.slice(1).replaceAll("_", " ");
// Organization Settings → Billing & Usage, in Greptile's cards: the plan and this month's usage meter (dollars
// for admins only), Payment Details, Past Invoices and the Billing Portal (Stripe Checkout / Customer Portal,
// cloud only), then the referral code. The usage table follows (sections/usage.tsx).
export async function BillingPanel({ token, organizationId, filters }: { token: string; organizationId: Id<"organizations">; filters: Record<string, string | undefined> }) {
  const s = await backend().query(api.billing.status, { token, organizationId });
  if (!s.enabled) return <><div className="section-heading"><h2 id="plan-heading">Billing is off</h2></div><section aria-labelledby="plan-heading"><p className="card-line">This deployment does not bill workspaces (<code>BILLING_ENABLED</code> is not set), so reviews have no plan quota. Self-hosted installs are unlimited.</p></section></>;
  const subscribed = s.plan === "starter" || s.plan === "pro", percent = s.limit ? Math.min(100, Math.round((s.used / s.limit) * 100)) : 0;
  const trial = checkoutTrialEnd(s.trialEndsAt, Date.now());
  const portal = (label: ReactNode, name?: string, className?: string) => <form action={openBillingPortal}><input type="hidden" name="organizationId" value={organizationId} /><button className={className} aria-label={name}>{label}</button></form>;
  return <>
    {filters.checkout === "success" && <p role="status" className="notice-banner">Thanks! Your subscription will appear here once Stripe confirms it.</p>}
    {filters.checkout === "cancelled" && <p role="status" className="notice-banner">Checkout was cancelled; nothing was charged.</p>}
    {filters.billing === "error" && <p role="alert" className="notice-banner"><Icon name="warning" />Billing could not be opened. Check that you are a workspace admin and try again.</p>}
    {!s.allowed && <p role="alert" className="notice-banner"><Icon name="warning" />{s.reason}</p>}
    {s.allowed && percent >= 80 && <p role="status" className="notice-banner"><Icon name="warning" />{percent >= 100 ? "This workspace used all of its included usage this month; extra usage is on, up to the monthly cap." : `This workspace used ${percent}% of its included usage this month. ${subscribed && s.capUsd > 0 ? "Extra usage covers what comes after it, up to the monthly cap." : `Reviews pause when it runs out${subscribed ? " unless an admin turns on extra usage" : "; upgrade for more"}.`}`}</p>}
    <div className="section-heading"><div><h2 id="billing-heading">Billing &amp; Usage</h2><p>Manage your plan and billing details</p></div></div>
    <section aria-labelledby="plan-heading" className="strip-card">
      <header className="card-strip"><Icon name="creditCard" /><h3 id="plan-heading">{s.planName} plan</h3><span className="role-badge">{statusLabel(s.status)}</span></header>
      <div className="strip-body">
        <div className="usage-meter"><div><strong>{percent}%</strong><span> of included usage{s.admin ? ` (${usdText(s.used)} of ${usdText(s.limit ?? 0)})` : ""}</span></div><meter min={0} max={100} value={percent} aria-label="Included usage used" /><span className="muted">Resets {day(s.resetsAt)}</span></div>
        <dl className="facts">
          {s.currentPeriodEnd && <><dt>Current period ends</dt><dd>{day(s.currentPeriodEnd)}</dd></>}
          {s.pastDueSince && <><dt>Past due since</dt><dd>{day(s.pastDueSince)} · reviews pause after {s.graceDays} days</dd></>}
          {subscribed && <><dt>Extra usage</dt><dd>{s.capUsd > 0 ? (s.admin ? `${usdText(s.overage)} of a ${usdText(s.capUsd * 1e6)} monthly cap` : "On") : "Off: reviews pause when the included usage runs out"}</dd></>}
          <dt>Reviews this month</dt><dd>{s.reviews}{s.blocked ? ` · ${s.blocked} blocked` : ""}</dd>
          <dt>Agent fixes this month</dt><dd>{s.fixes.limit ? `${s.fixes.used} of ${s.fixes.limit}` : "None on Free: copy prompts and your own agents still work"}</dd>
          <dt>Seats</dt><dd>{s.activeSeats} active (owners, admins and members; viewers are free){s.billedSeats !== null ? ` · ${s.billedSeats} billed` : ""}</dd>
          <dt>Plans</dt><dd>Free: {usdText(s.freeUsageMicros)} of model usage per workspace each month · Starter{process.env.BILLING_SEAT_PRICE_LABEL ? ` (${process.env.BILLING_SEAT_PRICE_LABEL})` : ""}: {usdText(s.usagePerSeatMicros)} and {s.starterFixesPerSeat} agent fixes per seat · Pro{process.env.BILLING_PRO_PRICE_LABEL ? ` (${process.env.BILLING_PRO_PRICE_LABEL})` : ""}: {usdText(s.proUsagePerSeatMicros)} and {s.proFixesPerSeat} agent fixes per seat, plus deep reviews, generated reproduction tests, requirements checks, learned conventions, API keys, analytics older than 30 days, SSO and the audit log. Pricier models use usage faster.</dd>
          {s.referral?.referred && <><dt>Referral</dt><dd>{referralFact(s.referral, referralConfig().discountLabel)}</dd></>}
          {s.referralCredit ? <><dt>Referral credit</dt><dd>{formatMoney(s.referralCredit)} applied from referral earnings · Stripe takes it off the next invoices</dd></> : null}
        </dl>
        {s.admin ? <div className="page-actions">
          {!subscribed && <form action={startCheckout}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="plan" value="pro" /><button className="primary">{trial ? "Start Pro trial" : "Upgrade to Pro"}</button></form>}
          {!subscribed && <form action={startCheckout}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="plan" value="starter" /><button>{trial ? "Start Starter trial" : "Choose Starter"}</button></form>}
          {subscribed && <form action={changePlan}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="plan" value={s.plan === "pro" ? "starter" : "pro"} /><button className={s.plan === "pro" ? undefined : "primary"}>{s.plan === "pro" ? "Switch to Starter" : "Switch to Pro"}</button></form>}
        </div> : <p className="muted">Only workspace owners and admins can change billing.</p>}
        {s.admin && subscribed && <p className="muted">Switching plans takes effect now and is prorated: the price difference for the rest of this period is on the next invoice.</p>}
        {s.admin && subscribed && <form action={setSpendingCap} className="setting-row cap-row stack"><input type="hidden" name="organizationId" value={organizationId} />
          <div><strong id="cap-label">Extra usage cap per month</strong><p>Usage past the included amount is billed at the end of the period, up to this cap (USD, 0 = off). During a trial, reviews stop at the included usage instead.</p></div>
          <span className="days-field">$<input type="number" name="capUsd" min={0} max={1000000} step="0.01" defaultValue={s.capUsd} required aria-labelledby="cap-label" /><button>Save cap</button></span>
        </form>}
      </div>
    </section>
    <div className="section-heading minor"><h2 id="payment-heading">Payment Details</h2>{s.admin && (s.hasCustomer ? portal(<><Icon name="plus" />Add Payment Method</>) : !subscribed && <a className="button" href="#plan-heading"><Icon name="plus" />Add Payment Method</a>)}</div>
    <div className="table-box"><table aria-labelledby="payment-heading">
      <thead><tr><th>Name</th><th><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{s.hasCustomer ? <tr><td>Kept by Stripe <span className="muted">· cards and bank details never reach OpenReview</span></td><td>{s.admin && portal("Manage", "Manage payment methods", "small")}</td></tr>
        : <tr><td colSpan={2} className="table-empty">No payment methods{s.admin && !subscribed ? <span className="muted"> · choose a plan above to add one</span> : null}</td></tr>}</tbody>
    </table></div>
    <div className="section-heading minor"><h2 id="invoices-heading">Past Invoices</h2></div>
    <div className="table-box"><table aria-labelledby="invoices-heading">
      <thead><tr><th>Date <span className="sort-caret"><Icon name="arrowDown" /></span></th><th>Amount</th></tr></thead>
      <tbody><tr><td colSpan={2} className="table-empty">{s.hasCustomer ? "Invoices are in the billing portal: choose Manage below." : "No invoice data available"}</td></tr></tbody>
    </table></div>
    <div className="section-heading"><h2 id="portal-heading">Billing Portal</h2></div>
    <section aria-labelledby="portal-heading" className="setting-row portal-card">
      <div><strong>Manage Billing <span className="role-badge">{statusLabel(s.status)}</span></strong>
        <p>{s.status === "trial" && s.trialEndsAt ? `You’re on a free trial until ${day(s.trialEndsAt)}. ` : ""}{s.hasCustomer ? "Visit the portal to update your payment method, download invoices or manage your plan." : "The Stripe billing portal opens once this workspace has a plan with a payment method."}</p></div>
      {s.admin && s.hasCustomer && portal("Manage", "Manage billing")}
    </section>
    {s.referral?.canApply && <><div className="section-heading"><div><h2 id="referral-code-heading">Referral code</h2><p>Were you referred by someone already on OpenReview? Add their code before you subscribe{referralConfig().discountLabel ? ` to get ${referralConfig().discountLabel}` : ""}.</p></div></div>
    <section aria-labelledby="referral-code-heading">
      <form action={applyReferralCode} className="toolbar-row"><input type="hidden" name="organizationId" value={organizationId} /><label className="grow"><span className="sr-only">Code</span><input name="code" aria-label="Code" placeholder="Referral code" defaultValue={filters.referral ?? ""} required maxLength={64} autoComplete="off" spellCheck={false} /></label><button>Apply code</button></form>
      <p className="muted">{referralDisclosure(null)}</p>
    </section></>}
  </>;
}
