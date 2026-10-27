import { repositoryDisplay } from "../../src/provider-display";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend, current } from "../../src/server";
import { referralConfig } from "../../src/referrals";
import { knowledgeView } from "../../src/knowledge-view";
import { navigation } from "./sections/shared";
import { needsSetup } from "../../src/onboarding-steps";
import { parseRuleQuery } from "../../src/rule-query";
import { pageFor } from "./routes";

// The workspace chosen in the workspace menu (cookie), else the first membership.
export function activeWorkspace<T extends { _id?: string }>(user: { organizations: T[] }, jar: { get(name: string): { value: string } | undefined }) {
  return user.organizations.find((o) => o._id === jar.get("openreview_workspace")?.value) ?? user.organizations[0];
}

// Read once per server render: the portal layout (app chrome) and the page both need them.
export const viewer = cache(() => current());
export const scopesFor = cache((token: string, organizationId: Id<"organizations">) => backend().query(api.scopes.list, { token, organizationId }));

// Data for the dashboard page: authorization, redirects and every section's queries.
export async function loadDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ section?: string[] }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { section: path = [] } = await params,
    user = await viewer(),
    jar = await cookies();
  const organization = activeWorkspace(user, jar);
  if (!organization?._id) redirect("/dashboard/onboarding/workspace");
  const filters = await searchParams;
  // Tab URLs (routes.ts) render internal sections; everything below is keyed by those.
  const page = pageFor(path), section = page?.internal ?? path;
  // A new workspace on a billing deployment chooses a plan before anything else (Billing, Account and
  // the personal Referrals settings stay reachable); the server enforces the same rule.
  if (organization.planMissing && !(section[0] === "settings" && ["billing", "account", "referrals"].includes(section[1] ?? ""))) redirect("/dashboard/onboarding/plan");
  // Admins of a workspace still in guided setup land there; deep links are never redirected.
  if (!section[0] && needsSetup(organization) && ["owner", "admin"].includes(organization.role)) redirect("/dashboard/onboarding");
  const aliases: Record<string, string[]> = { overview: ["analytics"], reviews: ["pulls"], findings: ["analytics", "findings"], knowledge: ["repositories", "knowledge"], rules: ["context"], team: ["organization", "people"], usage: ["organization", "billing"] };
  if (!section[0] || aliases[section[0]]) {
    const parts = aliases[section[0] ?? "overview"];
    const suffix = section.slice(1);
    const query = new URLSearchParams(Object.entries(filters).filter((e): e is [string,string] => e[1] !== undefined));
    redirect(`/dashboard/${[...parts, ...suffix].join("/")}${query.size ? `?${query}` : ""}`);
  }
  const route = section[0];
  // Settings and Memory pages are reached only through their tab URLs (next.config.ts redirects the old ones).
  if ((route === "settings" || route === "memory") && !page) notFound();
  // Referrals exists only while the referral program is on.
  if (route === "settings" && section[1] === "referrals" && !referralConfig().enabled) notFound();
  // Findings live under Analytics → Bugs Caught; /dashboard/pulls/findings redirects there (next.config.ts).
  const view = route === "analytics" ? section[1] === "findings" ? "findings" : "overview" : route === "pulls" ? "reviews" : route === "memory" ? section[1] === "knowledge" ? "knowledge" : "rules" : route === "settings" ? ({ repositories: "repositories", people: "team", usage: "usage" }[section[1] ?? ""] ?? "settings") : route;
  const reviewDetailId = route === "pulls" && section[1] !== "findings" && section[1] !== "pr" ? section[1] : undefined;
  const pullDetailId = route === "pulls" && section[1] === "pr" ? section[2] : undefined;
  const requestedRepository = filters.repository;
  if (!navigation.some((n) => n.toLowerCase() === view)) notFound();
  const scopes=await scopesFor(user.token,organization._id);
  const savedTeam=jar.get("openreview_team")?.value;
  const selectedTeam=scopes.teams.find(t=>t._id===(filters.team??savedTeam));
  if(filters.team&&!selectedTeam)notFound();
  if(selectedTeam)filters.team=selectedTeam._id;
  const ruleView=view==="rules"&&!["clusters","integrations","preferences"].includes(section[1]??"");
  const isAdmin = ["owner", "admin"].includes(organization.role);
  const keysPage = route === "settings" && section[1] === "keys";
  // Independent reads run together; each check below still runs before the queries it guards.
  const [data, findingsPage, ruleAssistant, ruleUsage, pendingInvitations, detail, apiKeys, devinConfigured, mcpConnections, modelKey, locked, joinRequests] = await Promise.all([
    backend().query(api.dashboard.overview, {
      token: user.token,
      organizationId: organization._id,
      ...(selectedTeam?{teamId:selectedTeam._id}:{}),
    }),
    view === "findings"
      ? backend().query(api.findings.list, {
          token: user.token,
          organizationId: organization._id,
          cursor: filters.cursor,
          ...(selectedTeam?{teamId:selectedTeam._id}:{}),
          ...(filters.repository
            ? { repositoryId: filters.repository as Id<"repositories"> }
            : {}),
          severity: filters.severity || undefined,
          category: filters.category || undefined,
          status: filters.status || undefined,
          author: filters.author || undefined,
          usefulness: filters.usefulness || undefined,
          since:
            filters.since && Number.isFinite(Date.parse(filters.since))
              ? Date.parse(filters.since)
              : undefined,
          until:
            filters.until && Number.isFinite(Date.parse(filters.until))
              ? Date.parse(filters.until) + 86400000 - 1
              : undefined,
        })
      : null,
    ruleView && isAdmin ? backend().query(api.ruleAssistant.page, { token: user.token, organizationId: organization._id }) : null,
    ruleView&&filters.rule?backend().query(api.dashboard.ruleUsage,{token:user.token,organizationId:organization._id,ruleId:filters.rule as Id<"customRules">,...(selectedTeam?{teamId:selectedTeam._id}:{})}).catch(()=>[]):[],
    view === "team" && isAdmin
      ? backend().query(api.users.invitations,{token:user.token,organizationId:organization._id}) : [],
    view === "reviews" && reviewDetailId
      ? backend().query(api.reviews.detail, {
          token: user.token,
          reviewId: reviewDetailId as Id<"reviews">,
          historyCursor: filters.historyCursor,
        })
      : null,
    keysPage && isAdmin
      ? backend().query(api.apiKeys.list, {
          token: user.token,
          organizationId: organization._id,
        })
      : [],
    // Devin handoff appears only for viewers who saved their own key.
    view === "findings" ? backend().query(api.personalCredentials.status, { token: user.token }).then((s) => s.devin.configured) : false,
    // MCP clients connected with OAuth: your own (admins see everyone's in the workspace).
    keysPage ? backend().query(api.oauth.connections, { token: user.token, organizationId: organization._id }) : [],
    // The workspace's own model key: provider and model only, the key itself never leaves the backend.
    keysPage && isAdmin ? backend().query(api.modelKeys.status, { token: user.token, organizationId: organization._id }) : null,
    // Pro features this plan lacks: their settings render inside <Locked> (none with billing off).
    backend().query(api.billing.locked, { token: user.token, organizationId: organization._id }),
    // "Join a team" requests this user can answer (org admins: all; team admins: their teams).
    backend().query(api.joinRequests.pending, { token: user.token, organizationId: organization._id }),
  ]);
  const visibleFindings = findingsPage?.page ?? data.findings.map(f=>({...f,canFix:false}));
  const repoName = (id: string) =>
    data.repositories.find((r) => r._id === id)?.fullName ?? id;
  const repoLabel = (id: string) => repositoryDisplay(data.repositories.find(r => r._id === id));
  if((ruleView || view === "knowledge" || (route === "settings" && section[1] === "review")) && requestedRepository && !data.repositories.some(r=>r._id===requestedRepository))notFound();
  // The search box's repository: token names a repository; one that matches nothing shows no rules.
  const ruleQuery=parseRuleQuery(filters.q),queryRepository=!ruleQuery.repository?undefined:data.repositories.find(r=>[r.fullName,repositoryDisplay(r)].some(n=>n.toLowerCase()===ruleQuery.repository!.toLowerCase()));
  const ruleRepository=ruleQuery.repository?queryRepository?._id:requestedRepository;
  let active =
    data.repositories.some(
      (r) =>
        ["queued","indexing"].includes(r.indexStatus) ||
        ["queued", "generating"].includes(r.knowledgeStatus ?? ""),
    ) ||
    data.reviews.some(
      (r) => !["completed", "failed", "cancelled", "skipped"].includes(r.status),
    );
  if(detail&&!['completed','failed','cancelled','skipped'].includes(detail.review.status))active=true;
  const [rulesPage, pull, diagnostics, personalAgent, knowledgeState, repoSettings] = await Promise.all([
    !ruleView?null:ruleQuery.repository&&!queryRepository?{page:[],isDone:true,continueCursor:""}:backend().query(api.dashboard.rulesPage,{token:user.token,organizationId:organization._id,
      ...(selectedTeam?{teamId:selectedTeam._id}:{}),...(ruleRepository?{repositoryId:ruleRepository as Id<"repositories">}:{}),cursor:filters.cursor,
      ...(ruleQuery.text?{search:ruleQuery.text}:{}),...(ruleQuery.status?{status:ruleQuery.status}:{})}),
    // The pull request row behind a review (size, draft, reviewers), or an unreviewed pull request opened by id.
    detail ? backend().query(api.pulls.get, { token: user.token, repositoryId: detail.review.repositoryId, number: detail.review.prNumber })
      : pullDetailId ? backend().query(api.pulls.get, { token: user.token, pullRequestId: pullDetailId as Id<"pullRequests"> }).catch(() => null) : null,
    detail?.review.resultStorageId?backend().action(api.jobs.diagnostics,{token:user.token,reviewId:detail.review._id}):null,
    // Fix buttons (review detail and Findings) start the viewer's own agent.
    view === "findings" || detail ? backend().query(api.bridge.personal,{token:user.token,organizationId:detail?.review.organizationId??organization._id}).then((p) => p.agent) : undefined,
    knowledgeView(view === "knowledge" ? data.repositories : [],
      { team: filters.team, repository: requestedRepository, q: filters.q },
      (r, search) => backend().query(api.dashboard.knowledge, {
        token: user.token, repositoryId: r._id, search,
      })),
    // Code Review Settings shows a repository's settings; without ?repository= it is the first one.
    route === "settings" && section[1] === "review" && (requestedRepository ?? data.repositories[0])
      ? backend().query(api.settings.repository, {
          token: user.token,
          repositoryId: (requestedRepository ?? data.repositories[0]._id) as Id<"repositories">,
        })
      : null,
  ]);
  if (pullDetailId && !pull) notFound();
  if (pullDetailId && pull?.latest) redirect(`/dashboard/pulls/${pull.latest._id}`);
  const visibleRules=rulesPage?.page??[];
  const knowledge = knowledgeState.results;
  const [checks, semantic, conventions] = await Promise.all([
    // Live CI for the open pull request (GitHub and GitHub Enterprise); a provider error just hides the panel.
    pull ? backend().action(api.pullInsights.checks, { token: user.token, pullRequestId: pull._id }).catch(() => null) : null,
    repoSettings ? backend().query(api.embeddings.status, { token: user.token, repositoryId: repoSettings.repo._id }) : null,
    repoSettings ? backend().query(api.conventions.list, { token: user.token, repositoryId: repoSettings.repo._id }) : [],
  ]);
  // Narrowed above: a dashboard always has a workspace.
  const workspace = organization as typeof organization & { _id: Id<"organizations"> };
  return { kind: "dashboard" as const, page, active, aliases, apiKeys, locked, devinConfigured, mcpConnections, modelKey, conventions, data, detail, diagnostics, pull, checks, filters, findingsPage, isAdmin, jar, joinRequests, knowledge, knowledgeState, organization: workspace, pendingInvitations, personalAgent, repoLabel, repoName, repoSettings, requestedRepository, reviewDetailId, route, ruleAssistant, ruleUsage, ruleView, rulesPage, savedTeam, scopes, section, selectedTeam, semantic, user, view, visibleFindings, visibleRules };
}
export type DashboardContext = Extract<Awaited<ReturnType<typeof loadDashboard>>, { kind: "dashboard" }>;
