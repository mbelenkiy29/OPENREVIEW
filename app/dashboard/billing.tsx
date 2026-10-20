import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { checkoutTrialEnd, usdText } from "../../src/billing";
import { formatMoney, referralConfig, referralDisclosure, referralFact } from "../../src/referrals";
import { applyReferralCode, changePlan, openBillingPortal, setSpendingCap, startCheckout } from "./actions";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" });
// Settings → Billing: plan, the monthly usage meter (dollars for admins only), extra usage, seats, and
// Stripe Checkout / Customer Portal (cloud only).
export async function BillingPanel({ token, organizationId, filters }: { token: string; organizationId: Id<"organizations">; filters: Record<string, string | undefined> }) {
  const s = await backend().query(api.billing.status, { token, organizationId });
  if (!s.enabled) return <section><h2>Billing is off</h2><p>This deployment does not bill workspaces (<code>BILLING_ENABLED</code> is not set), so reviews have no plan quota. Self-hosted installs are unlimited.</p></section>;
  const subscribed = s.plan === "starter" || s.plan === "pro", percent = s.limit ? Math.min(100, Math.round((s.used / s.limit) * 100)) : 0;
  return <>
    {filters.checkout === "success" && <p role="status">Thanks! Your subscription will appear here once Stripe confirms it.</p>}
    {filters.checkout === "cancelled" && <p role="status">Checkout was cancelled; nothing was charged.</p>}
    {filters.billing === "error" && <p role="alert">Billing could not be opened. Check that you are a workspace admin and try again.</p>}
    {!s.allowed && <p role="alert">{s.reason}</p>}
    <section aria-labelledby="plan-heading">
      <h2 id="plan-heading">{s.planName} plan</h2>
      <dl className="facts">
        <dt>Status</dt><dd><span className={`badge ${s.status}`}>{s.status.replaceAll("_", " ")}</span></dd>
        {s.currentPeriodEnd && <><dt>Current period ends</dt><dd>{day(s.currentPeriodEnd)}</dd></>}
        {s.pastDueSince && <><dt>Past due since</dt><dd>{day(s.pastDueSince)} · reviews pause after {s.graceDays} days</dd></>}
        <dt>Usage this month</dt><dd><meter min={0} max={100} value={percent} aria-label="Included usage used" /> {percent}% of included usage{s.admin ? ` (${usdText(s.used)} of ${usdText(s.limit ?? 0)})` : ""} · resets {day(s.resetsAt)}</dd>
        {subscribed && <><dt>Extra usage</dt><dd>{s.capUsd > 0 ? (s.admin ? `${usdText(s.overage)} of a ${usdText(s.capUsd * 1e6)} monthly cap` : "On") : "Off: reviews pause when the included usage runs out"}</dd></>}
        <dt>Reviews this month</dt><dd>{s.reviews}{s.blocked ? ` · ${s.blocked} blocked` : ""}</dd>
        <dt>Seats</dt><dd>{s.activeSeats} active (owners, admins and members; viewers are free){s.billedSeats !== null ? ` · ${s.billedSeats} billed` : ""}</dd>
        <dt>Plans</dt><dd>Free: {usdText(s.freeUsageMicros)} of model usage per workspace each month · Starter{process.env.BILLING_SEAT_PRICE_LABEL ? ` (${process.env.BILLING_SEAT_PRICE_LABEL})` : ""}: {usdText(s.usagePerSeatMicros)} per seat · Pro{process.env.BILLING_PRO_PRICE_LABEL ? ` (${process.env.BILLING_PRO_PRICE_LABEL})` : ""}: {usdText(s.proUsagePerSeatMicros)} per seat, plus deep reviews, generated reproduction tests, fix pull requests, requirements checks, learned conventions, API keys, analytics older than 30 days, SSO and the audit log. Pricier models use usage faster.</dd>
        {s.referral?.referred && <><dt>Referral</dt><dd>{referralFact(s.referral, referralConfig().discountLabel)}</dd></>}
        {s.referralCredit ? <><dt>Referral credit</dt><dd>{formatMoney(s.referralCredit)} applied from referral earnings · Stripe takes it off the next invoices</dd></> : null}
      </dl>
      {s.admin ? <div className="row">
        {!subscribed && <form action={startCheckout}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="plan" value="pro" /><button className="primary">{checkoutTrialEnd(s.trialEndsAt, Date.now()) ? "Start Pro trial" : "Upgrade to Pro"}</button></form>}
        {!subscribed && <form action={startCheckout}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="plan" value="starter" /><button>{checkoutTrialEnd(s.trialEndsAt, Date.now()) ? "Start Starter trial" : "Choose Starter"}</button></form>}
        {subscribed && <form action={changePlan}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="plan" value={s.plan === "pro" ? "starter" : "pro"} /><button className={s.plan === "pro" ? undefined : "primary"}>{s.plan === "pro" ? "Switch to Starter" : "Switch to Pro"}</button></form>}
        {s.hasCustomer && <form action={openBillingPortal}><input type="hidden" name="organizationId" value={organizationId} /><button>Manage billing</button></form>}
      </div> : <p className="muted">Only workspace owners and admins can change billing.</p>}
      {s.admin && subscribed && <p className="muted">Switching plans takes effect now and is prorated: the price difference for the rest of this period is on the next invoice.</p>}
      {s.admin && subscribed && <form action={setSpendingCap} className="filter-bar"><input type="hidden" name="organizationId" value={organizationId} /><label>Extra usage cap per month (USD, 0 = off)<input type="number" name="capUsd" min={0} max={1000000} step="0.01" defaultValue={s.capUsd} required /></label><button>Save cap</button><span className="muted">Usage past the included amount is billed at the end of the period, up to this cap.</span></form>}
    </section>
    {s.referral?.canApply && <section aria-labelledby="referral-code-heading">
      <h2 id="referral-code-heading">Referral code</h2>
      <p>Were you referred by someone already on OpenReview? Add their code before you subscribe{referralConfig().discountLabel ? ` to get ${referralConfig().discountLabel}` : ""}.</p>
      <form action={applyReferralCode} className="form-grid"><input type="hidden" name="organizationId" value={organizationId} /><label>Code<input name="code" defaultValue={filters.referral ?? ""} required maxLength={64} autoComplete="off" spellCheck={false} /></label><button>Apply code</button></form>
      <p className="muted">{referralDisclosure(null)}</p>
    </section>}
  </>;
}
