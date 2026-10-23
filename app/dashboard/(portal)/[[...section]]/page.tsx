import { OrganizationSettings } from "../../data-controls";
import { Live } from "../../live";
import { ProvidersPanel, ProvidersAction } from "../../providers";
import { IntegrationsPanel } from "../../integrations";
import { PreferencesPanel } from "../../preferences";
import { ClustersPanel } from "../../clusters";
import { ChatPanel } from "../../chat";
import { NotificationsPanel } from "../../notifications";
import { BillingPanel } from "../../billing";
import { ModelPanel } from "../../model-panel";
import { AccountPanel } from "../../account";
import { ReferralsPanel } from "../../referrals";
import { ScopePanel, AuditPanel } from "../../scopes";
import { AgentSettings } from "../../agents";
import Link from "next/link";
import { needsSetup } from "../../../../src/onboarding-steps";
import { RuntimeSettings } from "../../runtime";
import { AnalyticsView } from "../../analytics-view";
import { SettingsNav } from "../../sidebar";
import { pages } from "../../routes";
import { Icon } from "../../../ui/icons";
import { referralConfig } from "../../../../src/referrals";
import { WorkspaceInvitations } from "../../invitations";
import { RepositoriesSection } from "../../sections/repositories";
import { ReviewsSection } from "../../sections/reviews";
import { FindingsSection } from "../../sections/findings";
import { RulesSection } from "../../sections/rules";
import { TeamSection } from "../../sections/team";
import { KnowledgeSection } from "../../sections/knowledge";
import { UsageSection } from "../../sections/usage";
import { ReviewSettingsSection, ReviewSettingsActions } from "../../sections/settings-review";
import { ApiKeysSection } from "../../sections/api-keys";
import { navigation } from "../../sections/shared";
import { loadDashboard } from "../../load";

// Settings-style tabs: a sub-navigation beside the page (Greptile's settings layout).
const subnavTabs: Record<string, string> = { "code-review": "Code Review Settings", organization: "Organization Settings", account: "Personal Settings" };

export default async function Dashboard(props: {
  params: Promise<{ section?: string[] }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await loadDashboard(props);
  const { active, data, filters, isAdmin, organization, page, route, savedTeam, section, selectedTeam, user, view } = ctx;
  const title = page?.title ?? (view === "findings" ? "Bugs Caught" : view === "overview" ? "Analytics" : view === "reviews" ? "Pull Requests" : route === "chat" ? "Chat" : navigation.find((n) => n.toLowerCase() === view));
  const subtitle = page?.tab === "context" ? `Manage context for ${organization.name ?? "this organization"}` : page?.subtitle ?? (view === "findings" ? "Every finding OpenReview raised, with its priority and status." : route === "chat" ? "Ask questions about your repositories." : view === "reviews" ? "Review history across your repositories." : undefined);
  const notices = <>
    <WorkspaceInvitations invitations={user.invitations}/>
    {savedTeam&&!selectedTeam&&filters.team===undefined&&<p role="status">Your previously selected team is no longer accessible. Showing all accessible repositories; use the organization menu to select a team.</p>}
  </>;
  const content = <>
    {view !== "overview" && notices}
    {/* Analytics renders its own header: Greptile puts the filters on the title row. */}
    {view === "overview" && <AnalyticsView token={user.token} organizationId={organization._id} repositories={data.repositories} teams={ctx.scopes.teams} filters={filters} locked={ctx.locked} live={<Live active={active} />}>
      {notices}
      {needsSetup(organization) && <section className="setup-banner" aria-label="Workspace setup"><p><strong>Setup isn’t finished.</strong> {organization.onboarding?.reviewsPaused ? "Automatic reviews are paused until you choose when reviews run." : "Finish connecting repositories and choosing review behavior."}</p>{isAdmin ? <Link className="button primary small" href="/dashboard/onboarding">Resume setup</Link> : <p className="muted">A workspace admin is completing setup.</p>}</section>}
    </AnalyticsView>}
    {view === "findings" && <FindingsSection ctx={ctx} />}
    {view === "repositories" && <RepositoriesSection ctx={ctx} />}
    {view === "reviews" && <ReviewsSection ctx={ctx} />}
    {view === "rules" && !["clusters","integrations","preferences"].includes(section[1] ?? "") && <RulesSection ctx={ctx} />}
    {view === "team" && <TeamSection ctx={ctx} />}
    {view === "knowledge" && <KnowledgeSection ctx={ctx} />}
    {route === "settings" && section[1] === "agents" && <AgentSettings token={user.token} organizationId={organization._id} />}
    {route === "settings" && section[1] === "automation" && (isAdmin?<RuntimeSettings token={user.token} organizationId={organization._id}/>:<p>Workspace admin access required.</p>)}
    {route === "settings" && section[1] === "account" && <AccountPanel token={user.token}/>}
    {route === "settings" && section[1] === "referrals" && <ReferralsPanel token={user.token} payouts={filters.payouts}/>}
    {route === "settings" && section[1] === "organization" && <OrganizationSettings token={user.token} organizationId={organization._id} admin={isAdmin} locked={ctx.locked}/>}
    {route === "settings" && section[1] === "model" && <ModelPanel token={user.token} organizationId={organization._id} admin={isAdmin}/>}
    {route === "settings" && section[1] === "billing" && <BillingPanel token={user.token} organizationId={organization._id} filters={filters}/>}
    {route === "settings" && section[1] === "billing" && <UsageSection ctx={ctx} />}
    {route === "settings" && section[1] === "notifications" && <NotificationsPanel token={user.token} organizationId={organization._id} repositories={data.repositories} filters={filters}/>}
    {route === "chat" && <ChatPanel token={user.token} organizationId={organization._id} repositories={data.repositories} filters={filters}/>}
    {route === "memory" && section[1] === "preferences" && <PreferencesPanel token={user.token} organizationId={organization._id} repositories={data.repositories} admin={isAdmin} filters={filters}/>}
    {route === "memory" && section[1] === "integrations" && <IntegrationsPanel token={user.token} organizationId={organization._id} admin={isAdmin} locked={ctx.locked} repositories={data.repositories} selected={filters.integration} error={filters.error} saved={filters.saved} />}
    {route === "memory" && section[1] === "clusters" && <ClustersPanel token={user.token} organizationId={organization._id} admin={isAdmin} />}
    {route === "settings" && section[1] === "teams" && <ScopePanel token={user.token} organizationId={organization._id} admin={isAdmin} />}
    {route === "settings" && section[1] === "audit" && (isAdmin ? <AuditPanel token={user.token} organizationId={organization._id} cursor={filters.activityCursor} locked={ctx.locked} /> : <p>Workspace admin access required.</p>)}
    {route === "settings" && section[1] === "providers" && (isAdmin ? <ProvidersPanel token={user.token} organizationId={organization._id} connectionId={filters.connection} projectId={filters.project} after={filters.after} inspect={filters.inspect} /> : <p>Workspace admin access required.</p>)}
    {route === "settings" && section[1] === "review" && <ReviewSettingsSection ctx={ctx} />}
    {route === "settings" && section[1] === "keys" && <ApiKeysSection ctx={ctx} />}
  </>;
  const subnav = page && subnavTabs[page.tab];
  return (
    <>
      {/* Next scrolls a new page to the top only when its first element is off-screen. This marker sits at
          the document top, so a page opened after a short scroll starts at the top, not under the header. */}
      <span className="page-top" aria-hidden="true" />
      <main className={view === "reviews" ? (ctx.detail || ctx.pull ? "content pull-detail-page" : "content page pulls-page") : "content page"}>
        {/* An open pull request keeps its chrome-free split layout; Live still refreshes running reviews. */}
        {view === "reviews" && (ctx.detail || ctx.pull) ? <><h1 className="sr-only">Pull Requests</h1><div className="pulls-live"><Live active={active} /></div></> : view === "overview" ? null : <header className="page-header">
          <div>
            {view === "findings" && <Link className="back-link" href="/dashboard/analytics"><Icon name="caretLeft" />Analytics</Link>}
            {view === "knowledge" && <Link className="back-link" href="/dashboard/repositories"><Icon name="caretLeft" />Repositories</Link>}
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {route === "settings" && section[1] === "review" && <ReviewSettingsActions ctx={ctx} />}
          {view === "repositories" && data.repositories.length > 0 && <Link className="button" href="/dashboard/repositories/knowledge"><Icon name="bookOpen" />Knowledge Base</Link>}
          {route === "settings" && section[1] === "providers" && isAdmin && <ProvidersAction token={user.token} organizationId={organization._id} />}
          <Live active={active} />
        </header>}
        {page?.tab === "context" && <nav className="segmented" aria-label="Context views">{pages.context.map((p) => <Link key={p.path} href={`/dashboard/context${p.path ? "/" + p.path : ""}`} aria-current={p.path === page.path ? "page" : undefined}>{p.label}</Link>)}</nav>}
        {subnav ? <div className="settings-layout">
          <SettingsNav label={subnav} tab={page.tab} current={page.path} sections={page.tab === "code-review" && page.path === "" && Boolean(ctx.repoSettings)}
            items={pages[page.tab].filter((p) => p.path !== "referrals" || referralConfig().enabled).map((p) => ({ path: p.path, label: p.label }))} />
          <div className="settings-body">{content}</div>
        </div> : content}
      </main>
    </>
  );
}
