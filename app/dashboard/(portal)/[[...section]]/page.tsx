import { DataControls } from "../../data-controls";
import { SsoSettings } from "../../sso-settings";
import { Live } from "../../live";
import { ProvidersPanel } from "../../providers";
import { IntegrationsPanel } from "../../integrations";
import { PreferencesPanel } from "../../preferences";
import { ChatPanel } from "../../chat";
import { NotificationsPanel } from "../../notifications";
import { BillingPanel } from "../../billing";
import { ModelPanel } from "../../model-panel";
import { AccountPanel } from "../../account";
import { ReferralsPanel } from "../../referrals";
import { EmailInvitations } from "../../email-invitations";
import { ScopePanel, AuditPanel } from "../../scopes";
import { AgentSettings } from "../../agents";
import Link from "next/link";
import { needsSetup } from "../../../../src/onboarding-steps";
import { RuntimeSettings } from "../../runtime";
import { AnalyticsView, settingsNavigation } from "../../portal";
import { SubNav } from "../../tabs";
import { WorkspaceInvitations } from "../../invitations";
import { RepositoriesSection } from "../../sections/repositories";
import { ReviewsSection } from "../../sections/reviews";
import { FindingsSection } from "../../sections/findings";
import { RulesSection } from "../../sections/rules";
import { TeamSection } from "../../sections/team";
import { KnowledgeSection } from "../../sections/knowledge";
import { UsageSection } from "../../sections/usage";
import { ReviewSettingsSection } from "../../sections/settings-review";
import { navigation } from "../../sections/shared";
import { loadDashboard } from "../../load";

export default async function Dashboard(props: {
  params: Promise<{ section?: string[] }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await loadDashboard(props);
  const { active, data, filters, isAdmin, organization, route, savedTeam, section, selectedTeam, user, view } = ctx;
  return (
    <>
      {/* Next scrolls a new page to the top only when its first element is off-screen. This marker sits at
          the document top, so a page opened after a short scroll starts at the top, not under the header. */}
      <span className="page-top" aria-hidden="true" />
      <main className={view === "reviews" ? (ctx.detail || ctx.pull ? "content pull-detail-page" : "content pulls-page") : "content"}>
        {/* The Pull Requests tab follows Greptile's chrome-free layout; Live still refreshes running reviews. */}
        {view === "reviews" ? <><h1 className="sr-only">Pull Requests</h1><div className="pulls-live"><Live active={active} /></div></> : <header>
          <div>
            <h1>{view === "overview" || view === "findings" ? "Analytics" : route === "memory" ? ({clusters:"Cross-repository context",preferences:"Learned preferences",integrations:"Integrations",rules:"Custom rules",knowledge:"Knowledge Base"}[section[1]??"rules"]??"Memory") : route === "settings" ? settingsNavigation().find(([key])=>key===section[1])?.[1] : navigation.find((n) => n.toLowerCase() === view)}</h1>
          </div>
          <Live active={active} />
        </header>}
        <WorkspaceInvitations invitations={user.invitations}/>
        {savedTeam&&!selectedTeam&&filters.team===undefined&&<p role="status">Your previously selected team is no longer accessible. Showing all accessible repositories; use the workspace menu to select a team.</p>}
        {(view === "overview" || view === "findings") && <SubNav label="Analytics views" active={view === "findings" ? "bugs" : "reviews"} items={[["reviews", "/dashboard/analytics", "PR Reviews", "chartBar"], ["bugs", "/dashboard/analytics/findings", "Bugs Caught", "bug"]]}>
          {view === "overview" ? <>
            {needsSetup(organization) && <section className="setup-banner" aria-label="Workspace setup"><p><strong>Setup isn’t finished.</strong> {organization.onboarding?.reviewsPaused ? "Automatic reviews are paused until you choose when reviews run." : "Finish connecting repositories and choosing review behavior."}</p>{isAdmin ? <Link className="button primary small" href="/dashboard/onboarding">Resume setup</Link> : <p className="muted">A workspace admin is completing setup.</p>}</section>}
            <AnalyticsView token={user.token} organizationId={organization._id} repositories={data.repositories} filters={filters} locked={ctx.locked} />
          </> : <FindingsSection ctx={ctx} />}
        </SubNav>}
        {view === "repositories" && <RepositoriesSection ctx={ctx} />}
        {view === "reviews" && <ReviewsSection ctx={ctx} />}
        {view === "rules" && !["clusters","integrations","preferences"].includes(section[1] ?? "") && <RulesSection ctx={ctx} />}
        {view === "team" && <TeamSection ctx={ctx} />}
        {view === "knowledge" && <KnowledgeSection ctx={ctx} />}
        {view === "usage" && <UsageSection ctx={ctx} />}
        {route === "settings" && section[1] === "agents" && <AgentSettings token={user.token} organizationId={organization._id} />}
        {route === "settings" && section[1] === "automation" && (isAdmin?<RuntimeSettings token={user.token} organizationId={organization._id}/>:<p>Workspace admin access required.</p>)}
        {route === "settings" && section[1] === "account" && <AccountPanel token={user.token}/>}
        {route === "settings" && section[1] === "referrals" && <ReferralsPanel token={user.token} payouts={filters.payouts}/>}
        {route === "settings" && section[1] === "people" && isAdmin && <EmailInvitations token={user.token} organizationId={organization._id} status={filters.emailInvite}/>}
        {route === "settings" && section[1] === "people" && isAdmin && <SsoSettings token={user.token} organizationId={organization._id} locked={ctx.locked}/>}
        {route === "settings" && section[1] === "data" && <DataControls token={user.token} organizationId={organization._id}/>}
        {route === "settings" && section[1] === "model" && <ModelPanel token={user.token} organizationId={organization._id} admin={isAdmin}/>}
        {route === "settings" && section[1] === "billing" && <BillingPanel token={user.token} organizationId={organization._id} filters={filters}/>}
        {route === "settings" && section[1] === "notifications" && <NotificationsPanel token={user.token} organizationId={organization._id} repositories={data.repositories} filters={filters}/>}
        {route === "chat" && <ChatPanel token={user.token} organizationId={organization._id} repositories={data.repositories} filters={filters}/>}
        {route === "memory" && section[1] === "preferences" && <PreferencesPanel token={user.token} organizationId={organization._id} repositories={data.repositories} admin={isAdmin} filters={filters}/>}
        {route === "memory" && section[1] === "integrations" && <IntegrationsPanel token={user.token} organizationId={organization._id} admin={isAdmin} locked={ctx.locked} repositories={data.repositories} selected={filters.integration} error={filters.error} saved={filters.saved} />}
        {route === "memory" && section[1] === "clusters" && <ScopePanel token={user.token} organizationId={organization._id} admin={isAdmin} clusters />}
        {route === "settings" && section[1] === "teams" && <ScopePanel token={user.token} organizationId={organization._id} admin={isAdmin} />}
        {route === "settings" && section[1] === "audit" && (isAdmin ? <AuditPanel token={user.token} organizationId={organization._id} cursor={filters.activityCursor} locked={ctx.locked} /> : <p>Workspace admin access required.</p>)}
        {route === "settings" && section[1] === "providers" && (isAdmin ? <ProvidersPanel token={user.token} organizationId={organization._id} connectionId={filters.connection} projectId={filters.project} after={filters.after} inspect={filters.inspect} /> : <p>Workspace admin access required.</p>)}
        {route === "settings" && ["review","keys"].includes(section[1]) && <ReviewSettingsSection ctx={ctx} />}
      </main>
    </>
  );
}
