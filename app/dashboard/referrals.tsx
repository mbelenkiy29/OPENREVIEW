import Link from "next/link";
import { api } from "../../convex/_generated/api";
import { backend, origin } from "../../src/server";
import { formatMoney } from "../../src/referrals";
import { Copy } from "./live";
import { ScrollTable } from "./scroll-table";

// Existing badge tones (DESIGN.md); the label still names the status.
const tones = { signed_up: "queued", pending: "queued", active: "completed", ended: "disabled", void: "cancelled" } as const;
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
    <div className="metrics">{[["Signed up", o.signedUp], ["Subscribed", o.subscribed], ["Pending", o.pending], ["Available", formatMoney(o.available, o.currency)], ["On hold", formatMoney(o.onHold, o.currency)]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <section aria-labelledby="referral-redeem-heading">
      <h2 id="referral-redeem-heading">Redeem your earnings</h2>
      <p className="muted">{o.available || o.onHold ? `Each commission is on hold for ${o.holdDays} days after the payment, then counts toward your balance.` : "Earnings appear here once a workspace you referred pays for OpenReview."}</p>
      {!o.notified && <p className="muted">Add a verified email in Settings → Notifications to hear when a referral subscribes.</p>}
    </section>
    <section aria-labelledby="referral-people-heading">
      <h2 id="referral-people-heading">People you referred</h2>
      {o.people.length ? <ScrollTable label="People you referred"><table><thead><tr><th>Person</th><th>Status</th><th>Signed up</th><th>Earned</th><th>Commission ends</th></tr></thead><tbody>{o.people.map((p) => <tr key={p._id}><td>{p.name}</td><td><span className={`badge ${tones[p.status]}`}>{p.label}</span></td><td>{day(p.signedUpAt)}</td><td>{formatMoney(p.earned, o.currency)}</td><td>{p.commissionEndsAt ? day(p.commissionEndsAt) : "—"}</td></tr>)}</tbody></table></ScrollTable>
        : <p className="muted">No one has signed up through your link yet.</p>}
    </section>
    <p className="muted"><Link href="/docs/referrals">How referrals work</Link> · <Link href="/terms">Terms</Link></p>
  </>;
}
