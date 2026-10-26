import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { repositoryDisplay } from "../../src/provider-display";
import { Icon } from "../ui/icons";
import { disconnectSlack, removeSlackChannel, saveNotificationPreferences, saveSlackChannel, setNotificationEmail } from "./actions";
import { Confirm, RowMenu } from "./org-ui";
import { ScrollTable } from "./scroll-table";

const eventLabels: Record<string, string> = { "review.completed": "Review completed", "finding.high": "High-severity findings" };
const levelLabels: Record<string, string> = { off: "Off", mine: "My pull requests", all: "All repositories I can access" };
// Organization Settings → Notifications: Slack workspace + channel links (admins) and personal email preferences,
// as Greptile's section headings over setting rows and tables.
export async function NotificationsPanel({ token, organizationId, repositories, filters }: { token: string; organizationId: Id<"organizations">; repositories: Doc<"repositories">[]; filters: Record<string, string | undefined> }) {
  const s = await backend().query(api.notifications.settings, { token, organizationId });
  const name = (id: string) => { const r = repositories.find((x) => x._id === id); return r ? repositoryDisplay(r) : "Unavailable repository"; };
  return <>
    {filters.slack === "connected" && <p role="status" className="notice-banner">Slack is connected.</p>}
    {filters.slack === "error" && <p role="alert" className="notice-banner"><Icon name="warning" />Slack could not be connected. Try again, and check that the app&apos;s redirect URL matches this deployment.</p>}
    {filters.email === "verified" && <p role="status" className="notice-banner">Your notification email is verified.</p>}
    {filters.email === "invalid" && <p role="alert" className="notice-banner"><Icon name="warning" />That verification link is invalid or expired. Set your email again to get a new link.</p>}
    {s.admin && <>
      <div className="section-heading"><div><h2 id="slack-heading">Slack</h2><p>Post review updates to channels, and answer @OpenReview questions there.</p></div>
        {s.slack && !s.offline && s.slackConfigured && <Confirm trigger="Disconnect Slack" triggerClassName="danger" title="Disconnect Slack" action={disconnectSlack} fields={{ organizationId }} confirm="Disconnect Slack">OpenReview stops posting to <strong>{s.slack.teamName}</strong> and unlinks every channel.</Confirm>}</div>
      <section aria-labelledby="slack-heading">
        {s.offline ? <p className="card-line">Offline mode is on (OPENREVIEW_OFFLINE=true), so Slack is turned off for this deployment.</p>
          : !s.slackConfigured ? <p className="card-line">Slack is not configured for this deployment. An operator must create the Slack app from docs/slack-app-manifest.yml and set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET.</p>
          : !s.slack ? <div className="setting-row"><div><strong>Not connected</strong><p>Connect a Slack workspace to link channels.</p></div><a className="button primary" href={`/api/slack/install?organization=${organizationId}`}>Add to Slack</a></div>
          : <>
            <p className="card-line">Connected to <strong>{s.slack.teamName}</strong>. In linked channels, members can mention @OpenReview with a question about the linked repositories, and run <code>/openreview status</code>.</p>
            <ScrollTable label="Linked Slack channels" className="table-box channel-table">
              <table>
                <thead><tr><th>Channel</th><th>Notify about</th><th>Repositories</th><th>Q&amp;A</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {s.channels.map((c) => <tr key={c._id}>
                    <td><code>{c.channelId}</code></td>
                    <td>{c.events.length ? c.events.map((e) => eventLabels[e] ?? e).join(", ") : "No notifications"}</td>
                    <td className="wrap">{c.repositoryIds.length ? c.repositoryIds.map(name).join(", ") : "All repositories"}</td>
                    <td>{c.qa ? "On" : "Notifications only"}</td>
                    <td><RowMenu label={`Actions for ${c.channelId}`}><Confirm trigger="Unlink channel" title="Unlink channel" action={removeSlackChannel} fields={{ channelId: c._id }} confirm="Unlink channel">OpenReview stops posting to <code>{c.channelId}</code> and answering questions there.</Confirm></RowMenu></td>
                  </tr>)}
                  {!s.channels.length && <tr><td colSpan={5} className="table-empty">No channels linked yet.</td></tr>}
                </tbody>
              </table>
            </ScrollTable>
            <details className="config-details">
              <summary className="button"><Icon name="plus" />Link channel</summary>
              <form action={saveSlackChannel} className="form-grid">
                <input type="hidden" name="organizationId" value={organizationId} />
                <label>Slack channel ID<input name="channelId" required pattern="[CG][A-Z0-9]{8,12}" placeholder="C0123456789" /></label>
                <fieldset><legend>Notify about</legend>{Object.entries(eventLabels).map(([k, label]) => <label className="check" key={k}><input type="checkbox" name="events" value={k} defaultChecked={k === "finding.high"} /> {label}</label>)}</fieldset>
                <fieldset className="wide"><legend>Repositories (none selected = notifications for all; Q&A needs 1–5)</legend>{repositories.map((r) => <label className="check" key={r._id}><input type="checkbox" name="repositoryIds" value={r._id} /> {repositoryDisplay(r)}</label>)}</fieldset>
                <label className="check wide"><input type="checkbox" name="qa" /> Answer @OpenReview questions in this channel about the selected repositories (anyone in the channel can ask; answers cite code)</label>
                <div className="wide setting-actions"><button className="primary">Link channel</button></div>
              </form>
            </details>
          </>}
      </section>
    </>}
    <div className="section-heading"><div><h2 id="email-heading">Email</h2><p>Your own notifications for this workspace.</p></div></div>
    <section aria-labelledby="email-heading">
      {!s.emailConfigured && <p className="notice-banner"><Icon name="warning" />{s.offline ? "Offline mode is on (OPENREVIEW_OFFLINE=true), so email is turned off." : "Email delivery is not configured for this deployment (RESEND_API_KEY and EMAIL_FROM)."} Preferences are saved but nothing is sent.</p>}
      <form action={setNotificationEmail} className="setting-row stack">
        <input type="hidden" name="organizationId" value={organizationId} />
        <div><strong id="notify-email">Notification email</strong><p>{s.preferences.email ? (s.preferences.verified ? "Verified." : "Waiting for verification: check your inbox for the link.") : "No address set."}</p></div>
        <span className="days-field"><input name="email" type="email" required maxLength={254} defaultValue={s.preferences.email ?? ""} aria-labelledby="notify-email" className="email-input" /><button>{s.preferences.email ? "Change and verify" : "Save and verify"}</button></span>
      </form>
      <form action={saveNotificationPreferences} className="stack">
        <input type="hidden" name="organizationId" value={organizationId} />
        <div className="setting-row"><div><strong id="notify-review">Review completed</strong><p>When a review finishes.</p></div><select name="reviewCompleted" defaultValue={s.preferences.reviewCompleted} aria-labelledby="notify-review">{Object.entries(levelLabels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="setting-row"><div><strong id="notify-high">High-severity findings</strong><p>When a review raises a critical or high finding.</p></div><select name="highSeverity" defaultValue={s.preferences.highSeverity} aria-labelledby="notify-high">{Object.entries(levelLabels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="setting-actions"><button>Save email preferences</button></div>
      </form>
    </section>
  </>;
}
