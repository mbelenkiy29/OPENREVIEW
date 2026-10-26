import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import type { Entitlement } from "../../src/plans";
import { Dialog } from "../ui/dialog";
import { Icon } from "../ui/icons";
import { cancelWorkspaceDeletion, requestWorkspaceDeletion, saveDataSettings } from "./actions";
import { ConfirmFooter, CopyButton, DialogForm } from "./org-ui";
import { SsoSettings } from "./sso-settings";

const when = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
// Organization Settings → Organization, as on Greptile: Organization Details, Enterprise SSO, Settings
// (data sharing and retention) and the Danger Zone (owner-only deletion after a grace period).
export async function OrganizationSettings({ token, organizationId, admin, locked }: { token: string; organizationId: Id<"organizations">; admin: boolean; locked: readonly Entitlement[] }) {
  const s = await backend().query(api.dataControls.settings, { token, organizationId });
  const canEdit = ["owner", "admin"].includes(s.role), scheduled = s.deletion?.status === "scheduled";
  return <>
    {s.deletion && <p role="alert" className="notice-banner"><Icon name="warning" />This workspace is scheduled for deletion {s.deletion.status === "purging" ? "and is being deleted now" : `on ${when(s.deletion.scheduledFor)}`}.</p>}
    <div className="section-heading"><h2 id="org-details-heading">Organization Details</h2></div>
    <section aria-labelledby="org-details-heading" className="org-details">
      <div className="field-rows">
        <label>Name<input readOnly value={s.name} /></label>
        <label>ID<input readOnly value={organizationId} className="mono" /></label>
      </div>
      <CopyButton value={organizationId} label="Copy ID" done="Copied" />
    </section>
    <div className="section-heading"><h2 id="sso-heading">Enterprise SSO</h2></div>
    {admin ? <SsoSettings token={token} organizationId={organizationId} locked={locked} />
      : <section aria-labelledby="sso-heading"><p className="card-line">Single sign-on for this organization is managed by its admins.</p></section>}
    <div className="section-heading"><h2 id="data-heading">Settings</h2></div>
    <section aria-labelledby="data-heading">
      <form action={saveDataSettings} className="stack"><fieldset disabled={!canEdit} className="settings-fieldset">
        <legend className="sr-only">Data sharing and retention</legend>
        <input type="hidden" name="organizationId" value={organizationId} />
        <div className="setting-row">
          <div><strong id="share-label">Share aggregate counts</strong><p id="share-help">Include this workspace’s review and finding counts, by category and severity, in operator statistics. Off keeps review data private to this workspace (the default).</p></div>
          {/* Checked sends "aggregate" first; the hidden field is the value when it is off. */}
          <input type="checkbox" role="switch" name="dataSharing" value="aggregate" defaultChecked={s.dataSharing === "aggregate"} aria-labelledby="share-label" aria-describedby="share-help" /><input type="hidden" name="dataSharing" value="private" />
        </div>
        <div className="setting-row">
          <div><strong id="review-retention">Keep reviews and findings</strong><p>Days to keep them. Blank keeps them until the workspace is deleted.</p></div>
          <span className="days-field"><input type="number" name="reviewRetentionDays" min={7} max={3650} defaultValue={s.reviewRetentionDays ?? ""} placeholder="Forever" aria-labelledby="review-retention" />days</span>
        </div>
        <div className="setting-row">
          <div><strong id="transcript-retention">Keep transcripts</strong><p>Agent runs, chat and pull request Q&amp;A. Blank keeps them until the workspace is deleted.</p></div>
          <span className="days-field"><input type="number" name="transcriptRetentionDays" min={7} max={3650} defaultValue={s.transcriptRetentionDays ?? ""} placeholder="Forever" aria-labelledby="transcript-retention" />days</span>
        </div>
        <div className="setting-actions">{!canEdit && <p className="muted">Only workspace owners and admins can change these settings.</p>}<button>Save data settings</button></div>
      </fieldset></form>
    </section>
    <div className="section-heading"><h2 id="delete-heading">Danger Zone</h2></div>
    <section aria-labelledby="delete-heading" className="danger-zone">
      <div>
        <strong><Icon name="warningCircle" />Delete this Organization</strong>
        <p>{scheduled ? `Deletion is scheduled for ${when(s.deletion!.scheduledFor)}. You can cancel until then.`
          : s.deletion ? "This workspace is being deleted now."
          : `This permanently deletes every review, finding, rule, index, setting, member and file of this workspace, ${s.graceDays} day${s.graceDays === 1 ? "" : "s"} after you confirm. Personal accounts stay.`}
          {s.role !== "owner" && " Only the workspace owner can delete it."}</p>
      </div>
      {s.role === "owner" && scheduled ? <form action={cancelWorkspaceDeletion}><input type="hidden" name="organizationId" value={organizationId} /><button className="primary">Cancel deletion</button></form>
        : !s.deletion && (s.role !== "owner" ? <button className="danger" disabled><Icon name="trash" />Delete Organization</button>
        : <Dialog size="confirm" trigger={<><Icon name="trash" />Delete Organization</>} triggerClassName="danger" title="Delete Organization">
          <DialogForm action={requestWorkspaceDeletion} className="modal-body confirm-form">
            <input type="hidden" name="organizationId" value={organizationId} />
            <p>This action cannot be undone. This will permanently delete <strong>{s.name}</strong> {s.graceDays} day{s.graceDays === 1 ? "" : "s"} from now; you can cancel until then.</p>
            <p className="muted">Uninstall the GitHub App and disconnect other providers yourself, from each provider’s settings.</p>
            <ConfirmFooter phrase={s.name} name="confirmName" confirm="Delete this organization" />
          </DialogForm>
        </Dialog>)}
    </section>
  </>;
}
