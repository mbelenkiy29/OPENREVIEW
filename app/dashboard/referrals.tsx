import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { backend, origin } from "../../src/server";
import { formatMoney } from "../../src/referrals";
import { redeemReferralCredit } from "./actions";
import { Copy } from "./live";
import { ScrollTable } from "./scroll-table";

// Existing badge tones (DESIGN.md); the label still names the status.
const tones = { signed_up: "queued", pending: "queued", active: "completed", ended: "disabled", void: "cancelled" } as const;
const activityTones: Record<string, string> = { "on hold": "queued", available: "completed", reversed: "cancelled", void: "cancelled", review: "queued", processing: "running", completed: "completed", failed: "failed" };
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" });
// Settings → Referrals: the caller's personal link and the people who signed up through it (cloud only).
export async function ReferralsPanel({ token }: { token: string }) {
  await backend().mutation(api.referrals.ensureCode, { token });
  const o = await backend().query(api.referrals.overview, { token });
  if (!o.enabled || !o.code) return <section><h2>Referrals are off</h2><p>This deployment doesn’t run the referral program.</p></section>;
  const link = `${origin()}/r/${o.code}`;
  return <>
    <section aria-labelledby="referral-link-heading">
      <h2 id="referral-link-heading">Your referral link</h2>
      <p>Share this link. When someone creates an OpenReview account through it, they’re credited to you, along with the first workspace they create.</p>
      <dl className="facts">
        <dt>Link</dt><dd><code>{link}</code></dd>
        <dt>Code</dt><dd><code>{o.code}</code></dd>
      </dl>
      <div className="row"><Copy value={link} label="Copy link" failedLabel="Copy failed; select the link above" /></div>
      <p className="muted">{o.login ? `Your link shows your GitHub username, @${o.login}.` : "Your link doesn’t show your name: you have no GitHub username on OpenReview."}</p>
    </section>
    <div className="metrics">{[["Signed up", o.signedUp], ["Subscribed", o.subscribed], ["Pending", o.pending], ["Available", formatMoney(o.available, o.currency)], ["Redeemed", formatMoney(o.redeemed, o.currency)]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <section aria-labelledby="referral-redeem-heading">
      <h2 id="referral-redeem-heading">Redeem your earnings</h2>
      <p className="muted">{o.available || o.onHold || o.redeemed ? `Each commission is on hold for ${o.holdDays} days after the payment${o.onHold ? ` (${formatMoney(o.onHold, o.currency)} now)` : ""}, then counts toward your balance. A refund takes back its share of the commission, and so does a dispute or payment inquiry while it is open or if it is lost.` : "Earnings appear here once a workspace you referred pays for OpenReview."}</p>
      {o.available < 0 && <p>Refunds or disputes took back {formatMoney(-o.available, o.currency)} more than you had left after redeeming. Your next commissions pay this back first.</p>}
      {!o.notified && <p className="muted">Add a verified email in Settings → Notifications to hear when a referral subscribes.</p>}
      <h3>Credit a workspace bill</h3>
      {!o.workspaces.length ? <p className="muted">Credit goes on the Stripe bill of a workspace you own or administer, once it has subscribed or added a payment method. You have none yet.</p>
        : o.available < o.minCredit ? <p className="muted">You can apply credit once you have at least {formatMoney(o.minCredit, o.currency)} available.</p>
        : <><form action={redeemReferralCredit} className="form-grid">
          <label>Workspace<select name="organizationId" required>{o.workspaces.map((w) => <option key={w.organizationId} value={w.organizationId}>{w.name}</option>)}</select></label>
          <label>Amount (USD)<input name="amount" inputMode="decimal" required defaultValue={(o.available / 100).toFixed(2)} /></label>
          <button className="primary">Apply credit</button>
        </form><p className="muted">Stripe takes the credit off the workspace’s next invoices. The smallest credit is {formatMoney(o.minCredit, o.currency)}.</p></>}
    </section>
    <section aria-labelledby="referral-people-heading">
      <h2 id="referral-people-heading">People you referred</h2>
      {o.people.length ? <ScrollTable label="People you referred"><table><thead><tr><th>Person</th><th>Status</th><th>Signed up</th><th>Earned</th><th>Commission ends</th></tr></thead><tbody>{o.people.map((p) => <tr key={p._id}><td>{p.name}</td><td><span className={`badge ${tones[p.status]}`}>{p.label}</span></td><td>{day(p.signedUpAt)}</td><td>{formatMoney(p.earned, o.currency)}</td><td>{p.commissionEndsAt ? day(p.commissionEndsAt) : "—"}</td></tr>)}</tbody></table></ScrollTable>
        : <p className="muted">No one has signed up through your link yet.</p>}
    </section>
    <section aria-labelledby="referral-activity-heading">
      <h2 id="referral-activity-heading">Activity</h2>
      {o.activity.length ? <ScrollTable label="Referral activity"><table><thead><tr><th>Date</th><th>What</th><th>Amount</th><th>Status</th></tr></thead><tbody>{o.activity.map((r) => <tr key={r._id}><td>{day(r.at)}</td><td>{r.what}{r.reversed > 0 && <span className="muted"> · {formatMoney(r.reversed, o.currency)} taken back</span>}{r.error && <span className="muted"> · {r.error}</span>}</td><td>{formatMoney(r.amount, o.currency)}</td><td><span className={`badge ${activityTones[r.status] ?? "queued"}`}>{r.status === "on hold" && r.availableAt ? `on hold until ${day(r.availableAt)}` : r.status}</span></td></tr>)}</tbody></table></ScrollTable>
        : <p className="muted">Commissions and credits will be listed here.</p>}
    </section>
    <p className="muted"><Link href="/docs/referrals">How referrals work</Link> · <Link href="/terms">Terms</Link></p>
  </>;
}
