import Link from "next/link";
import { redirect } from "next/navigation";
import { api } from "../../../../convex/_generated/api";
import { backend } from "../../../../src/server";
import { emailOnWeb } from "../../../../src/email";
import { checkoutTrialEnd, usdText } from "../../../../src/billing";
import { entitlements } from "../../../../src/plans";
import { referralConfig, referralDisclosure, referralFact } from "../../../../src/referrals";
import { installHref, linkHref } from "../../../../src/github-install";
import { providerDisplay, providerShort } from "../../../../src/provider-display";
import { nextStep, resolveStep, type ConfigureStep } from "../../../../src/onboarding-steps";
import { Live } from "../../live";
import { applyReferralCode, reindex } from "../../actions";
import { WorkspaceInvitations } from "../../invitations";
import { JoinTeams } from "../../account";
import { advanceSetup, checkoutFromSetup, createSetupWorkspace, finishSetup, inviteFromSetup, saveSetupStep, selectAndIndex } from "../actions";
import { IndexGraph, Stage, TeamArt, TrialArt } from "../art";
import { Mark } from "../../../ui/logo";
import { CommentsStep, SummaryStep, ToolsStep, TriggersStep } from "../configure";
import { loadSetup } from "../setup";
import { ConfigureProgress, Heading, ReadOnlyNote, WizardFrame } from "../wizard";
import { ConnectStep, InviteForm, StepForm } from "../wizard-client";

const ledes: Record<ConfigureStep, string> = {
  summary: "Each review posts one summary comment and edits it in place as the pull request changes. Choose what it includes.",
  comments: "Inline comments are reserved for verified findings. Decide how much reaches the pull request.",
  triggers: "Choose which pull request events start a review. Anyone can still ask with “@openreview review”.",
  tools: "Hand findings to a coding agent and decide what OpenReview may do beyond commenting.",
};

export default async function SetupStep({ params, searchParams }: { params: Promise<{ step: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ step: requested }, query] = await Promise.all([params, searchParams]);
  const { user, organization, status, billing, state } = await loadSetup();
  const step = resolveStep(requested, state);
  // The plan chosen on the pricing page survives sign-up and workspace creation, and picks the plan step's main action.
  const intent = query.intent === "starter" || query.intent === "pro" ? query.intent : undefined;
  if (step !== requested) redirect(`/dashboard/onboarding/${step}${intent ? `?intent=${intent}` : ""}`);

  // The plan step counts only while a workspace still has to choose.
  if (step === "workspace" || !organization || !status) return <WizardFrame step="workspace" admin nextLabel="Create workspace" centered>
    <div className="wizard-panel wizard-card">
      <span className="wizard-logo"><Mark /></span>
      <Heading step="workspace">A workspace holds your repositories, review settings, history and team. You can rename it later.</Heading>
      <StepForm action={createSetupWorkspace} pendingLabel="Creating workspace…">
        <label>Workspace name<input name="name" required maxLength={100} autoFocus placeholder="Acme engineering" /></label>
        {intent && <input type="hidden" name="intent" value={intent} />}
      </StepForm>
      <WorkspaceInvitations invitations={user.invitations} />
      <JoinTeams token={user.token} next="/dashboard/onboarding" onlyFound />
    </div>
  </WizardFrame>;

  const admin = status.admin, organizationId = organization._id, next = nextStep(step, state.billing);
  const frame = { workspace: organization.name, organizationId, admin, billing: state.billing && (step === "plan" || Boolean(state.planMissing)), planMissing: state.billing && state.planMissing, nextHref: next ? `/dashboard/onboarding/${next}` : "/dashboard/analytics" };
  const selected = status.repositories.filter((r) => r.selected);

  if (step === "connect") {
    const accounts = [...status.connections.github.map((g) => ({ label: g.account, kind: "GitHub" })), ...status.connections.providers.map((p) => ({ label: p.name, kind: p.kind }))];
    const repositories = status.repositories.map((r) => ({ _id: r._id, fullName: r.fullName, provider: providerShort(r.provider), detail: providerDisplay(r.provider), selected: r.selected, setupError: r.setupError, status: r.indexStatus }));
    const githubHref = process.env.GITHUB_APP_SLUG && process.env.GITHUB_CLIENT_ID ? installHref(organizationId, "/dashboard/onboarding/connect") : undefined;
    const error = query.error === "github-install" ? `The GitHub App installation didn’t finish: ${query.message ?? "please try again"}.` : undefined;
    return <WizardFrame step="connect" {...frame} nextLabel="Start indexing">
      <ConnectStep action={selectAndIndex} organizationId={organizationId} repositories={repositories} accounts={accounts} githubHref={githubHref} linkHref={githubHref ? linkHref(organizationId, "/dashboard/onboarding/connect") : undefined} providersHref="/dashboard/providers" admin={admin} error={error}
        heading={<><Heading step="connect">Link the provider that hosts your code, then pick the repositories OpenReview should learn and review.</Heading><ReadOnlyNote admin={admin} /></>} />
    </WizardFrame>;
  }

  if (step === "indexing") {
    const processed = selected.reduce((n, r) => n + (r.job?.processed ?? 0), 0), total = selected.reduce((n, r) => n + (r.job?.total ?? 0), 0), ready = selected.filter((r) => r.ready).length;
    const active = selected.some((r) => ["queued", "indexing"].includes(r.indexStatus) || ["queued", "generating"].includes(r.knowledgeStatus ?? ""));
    return <WizardFrame step="indexing" {...frame} nextLabel="Continue">
      <div className="wizard-panel">
        <Heading step="indexing">OpenReview reads each repository and maps its files, symbols and references, so a review can follow a change into the code it touches. Keep going while this runs.</Heading>
        <ReadOnlyNote admin={admin} />
        {status.onboarding?.reviewsPaused && <p className="setup-note">Automatic reviews are paused until you choose when reviews run, two steps ahead.</p>}
        <div className="table-wrap"><table className="wizard-table"><thead><tr><th>Repository</th><th>Status</th><th>Files</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
          {selected.map((r) => <tr key={r._id}>
            <td title={providerDisplay(r.provider)}><span className="mono">{r.fullName}</span><br /><span className="muted">{providerShort(r.provider)}</span></td>
            <td><span className={`badge ${r.ready ? "ready" : r.indexStatus}`}>{r.ready ? "ready" : r.indexStatus.replaceAll("_", " ")}</span></td>
            <td className="mono">{r.job ? `${r.job.processed} / ${r.job.total}` : "—"}</td>
            <td>{r.indexStatus === "failed" && !r.nativeIndex && admin && <form action={reindex}><input type="hidden" name="repositoryId" value={r._id} /><button className="small">Retry</button></form>}</td>
          </tr>)}
        </tbody></table></div>
        {selected.some((r) => r.error || r.job?.error) && <p role="alert" className="wizard-error">{selected.map((r) => r.error ?? r.job?.error).filter(Boolean)[0]}</p>}
        <StepForm action={advanceSetup} disabled={!admin}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="step" value="indexing" /></StepForm>
        <Live active={active} />
      </div>
      <Stage caption={`indexed ${processed} / ${total} files · ${ready} of ${selected.length} ${selected.length === 1 ? "repository" : "repositories"} ready`} fig={selected[0] && <>Fig.1 codegraph for <span>{selected[0].fullName}</span></>}>
        <IndexGraph samples={status.graph} processed={processed} total={total} complete={selected.length > 0 && ready === selected.length} />
      </Stage>
    </WizardFrame>;
  }

  if (step === "summary" || step === "comments" || step === "triggers" || step === "tools") {
    const props = { action: saveSetupStep, organizationId, defaults: status.defaults, admin, progress: <ConfigureProgress step={step} />, heading: <><Heading step={step}>{ledes[step]}</Heading><ReadOnlyNote admin={admin} /></> };
    return <WizardFrame step={step} {...frame} nextLabel={step === "tools" ? "Save and continue" : "Next"}>
      {step === "summary" ? <SummaryStep {...props} /> : step === "comments" ? <CommentsStep {...props} /> : step === "triggers" ? <TriggersStep {...props} /> : <ToolsStep {...props} locked={billing?.enabled ? entitlements.filter((key) => !billing.entitlements.includes(key)) : []} agent={organization.defaultAgent} handoff={organization.defaultHandoff} cloudAgent={organization.defaultCloudAgent} />}
    </WizardFrame>;
  }

  if (step === "team") {
    const pending = admin ? await backend().query(api.users.invitations, { token: user.token, organizationId }) : [];
    return <WizardFrame step="team" {...frame} nextLabel="Continue">
      <div className="wizard-panel">
        <Heading step="team">Invite teammates by GitHub username. They accept from their own dashboard after signing in, and you can change roles later.</Heading>
        <ReadOnlyNote admin={admin} />
        <div className="wizard-invite-card">
          <InviteForm action={inviteFromSetup} organizationId={organizationId} workspace={organization.name ?? "Your workspace"} disabled={!admin} />
          {pending.length > 0 && <ul className="wizard-invites" aria-label="Pending invitations">{pending.map((i) => <li key={i._id}><span className="mono">@{i.githubLogin}</span><span className="muted">expires {new Date(i.expiresAt).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" })}</span><span className="wizard-role">{i.role}</span></li>)}</ul>}
        </div>
        {emailOnWeb() && <p className="muted">Email invitations are in Organization Settings → People.</p>}
        <StepForm action={advanceSetup} disabled={!admin}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="step" value="team" /></StepForm>
      </div>
      <Stage caption={`${pending.length} ${pending.length === 1 ? "teammate" : "teammates"} invited`}><TeamArt invited={pending.length} /></Stage>
    </WizardFrame>;
  }

  if (step === "plan" && billing?.enabled) {
    // A new workspace must choose Starter or Pro through Stripe Checkout with a card (any remaining trial carries
    // over), and setup continues once Stripe confirms it. A workspace that keeps Free can just continue.
    const required = billing.planRequired && !billing.planSelected;
    const now = Date.now(), paid = billing.plan === "starter" || billing.plan === "pro", free = billing.freePlan && !paid, confirming = query.checkout === "success" && !paid;
    const carries = Boolean(checkoutTrialEnd(billing.trialEndsAt, now)), trialLeft = Math.ceil((billing.trialEndsAt - now) / 86400000);
    const elapsed = billing.trialStarted ? Math.max(0, Math.min(billing.trialDays, Math.floor((now - billing.trialEndsAt) / 86400000) + billing.trialDays)) : 0;
    const percent = Math.min(100, Math.round((billing.used / Math.max(1, billing.limit ?? 1)) * 100));
    // On Free, Continue is the main action and both plans keep their own button.
    const primary = free ? undefined : intent ?? "pro", primaryName = primary === "starter" ? "Starter" : "Pro";
    const cards = [
      { plan: "starter", name: "Starter", price: process.env.BILLING_SEAT_PRICE_LABEL ?? "Per seat, billed monthly", points: [`${usdText(billing.usagePerSeatMicros)} of model usage per seat each month, pooled`, `${billing.starterFixesPerSeat} OpenReview agent fixes per seat each month`, "Your own model key", "Optional extra usage up to a cap you set", "Owners, admins and members are seats; viewers are free"] },
      { plan: "pro", name: "Pro", price: process.env.BILLING_PRO_PRICE_LABEL ?? "Per seat, billed monthly", points: [`${usdText(billing.proUsagePerSeatMicros)} of model usage per seat each month, pooled`, `${billing.proFixesPerSeat} OpenReview agent fixes per seat each month`, "Deep reviews with the agentic engines", "Generated reproduction tests", "Requirements from Linear, Jira and Notion", "SSO, audit log and API keys"] },
    ] as const;
    return <WizardFrame step="plan" {...frame} nextLabel={paid || free ? "Continue" : confirming ? "Waiting for Stripe…" : carries ? `Start ${trialLeft}-day ${primaryName} trial` : `Choose ${primaryName}`}>
      <div className="wizard-panel">
        <Heading step="plan">{paid ? `Your workspace is on the ${billing.planName} plan. Seats follow your team, so there is nothing else to set up.`
          : free ? "Your workspace is on the Free plan. Starter and Pro add usage per seat, agent fixes and more; upgrade here or anytime in Organization Settings → Billing & Usage."
          : `Choose a plan. ${carries ? `Starter and Pro come with ${trialLeft} days free: add a card now and nothing is charged until the trial ends.` : "Starter and Pro are billed per seat each month."} Change plans anytime in Organization Settings → Billing & Usage.`}</Heading>
        <ReadOnlyNote admin={admin} />
        {confirming && <p role="status" className="setup-note">Payment method saved. Your subscription appears here as soon as Stripe confirms it.</p>}
        {query.checkout === "cancelled" && <p role="status" className="setup-note">Checkout was cancelled; nothing was charged.</p>}
        {query.billing === "error" && <p role="alert" className="wizard-error">Stripe Checkout could not be opened. Try again.</p>}
        {required && !confirming && admin && <p className="muted">Repositories, indexing and reviews start after you choose a plan.</p>}
        <div className="wizard-plans">
          {cards.map((card) => <article key={card.plan} className="wizard-plan" aria-labelledby={`plan-${card.plan}`}>
            <header><h2 id={`plan-${card.plan}`}>{card.name}</h2><p className="price">{card.price}</p></header>
            <ul>{card.points.map((point) => <li key={point}>{point}</li>)}</ul>
            {billing.plan === card.plan && (paid || billing.planSelected) && <p><span className="badge active">Current plan</span></p>}
            {admin && !paid && !confirming && <form id={card.plan === primary ? "wizard-form" : undefined} action={checkoutFromSetup}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="plan" value={card.plan} />{card.plan !== primary && <button>Choose {card.name}</button>}</form>}
          </article>)}
        </div>
        <dl className="facts">
          <dt>Seats</dt><dd>{billing.activeSeats} active</dd>
          {billing.referral?.discount && <><dt>Referral</dt><dd>{referralFact(billing.referral, referralConfig().discountLabel)}</dd></>}
        </dl>
        {/* Checkout ends the window for adding a code, so a referred workspace without the link adds it here. */}
        {admin && !confirming && billing.referral?.canApply && <><form action={applyReferralCode} className="form-grid"><input type="hidden" name="organizationId" value={organizationId} /><label>Referral code<input name="code" defaultValue={query.referral ?? ""} required maxLength={64} autoComplete="off" spellCheck={false} /></label><button>Apply code</button></form><p className="muted">{referralDisclosure(null)}</p></>}
        {admin && (paid || free || (confirming && !required)) && <StepForm action={advanceSetup}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="step" value="plan" /></StepForm>}
        <Live active={confirming} />
      </div>
      <Stage caption={paid ? `${billing.plan} plan · ${billing.activeSeats} ${billing.activeSeats === 1 ? "seat" : "seats"}`
        : carries ? `${trialLeft}-day trial on Starter or Pro` : free ? `free plan · ${percent}% of this month's usage used` : "Starter or Pro · billed per seat"}>
        <TrialArt days={billing.trialDays} elapsed={elapsed} subscribed={paid || confirming} />
      </Stage>
    </WizardFrame>;
  }

  // done
  const d = status.defaults, ready = selected.filter((r) => r.ready).length;
  return <WizardFrame step="done" {...frame} nextLabel="Go to dashboard" centered>
    <div className="wizard-panel wizard-card">
      <Heading step="done">OpenReview is ready to review. Open a pull request in a selected repository, or ask for a review on an existing one.</Heading>
      <Stage caption="setup complete · reviews follow your settings"><IndexGraph samples={status.graph} processed={1} total={1} complete /></Stage>
      <dl className="wizard-recap">
        <div><dt>Repositories</dt><dd>{selected.length} selected · {ready} indexed</dd></div>
        <div><dt>Reviews</dt><dd>{d.automatic ? "Automatic on new pull requests" : "On request or trigger label"}{d.rereview ? ", re-reviewed on new commits" : ""}</dd></div>
        <div><dt>Flagging</dt><dd>{["Custom thresholds", "Quiet", "Balanced", "Thorough"][d.strictness ?? 0]} · up to {d.maxComments} inline comments</dd></div>
        <div><dt>Summary</dt><dd>{(d.summarySections ?? []).filter((s) => s !== "tips").length} sections · {d.commentStyle} comments</dd></div>
        {billing?.enabled && <div><dt>Plan</dt><dd>{billing.planName}</dd></div>}
      </dl>
      <p className="row"><Link className="button" href="/dashboard/pulls">Review existing pull requests</Link><Link className="button" href="/dashboard/code-review">Fine-tune per repository</Link></p>
      {admin
        ? <form id="wizard-form" action={finishSetup}><input type="hidden" name="organizationId" value={organizationId} /></form>
        : <ReadOnlyNote admin={admin} />}
    </div>
  </WizardFrame>;
}
