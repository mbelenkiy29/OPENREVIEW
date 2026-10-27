import { repositoryDisplay } from "../../src/provider-display";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend, current } from "../../src/server";
import { settingsNavigation } from "./portal";
import { knowledgeView } from "../../src/knowledge-view";
import { navigation } from "./sections/shared";
import { needsSetup } from "../../src/onboarding-steps";
import { billingConfig } from "../../src/billing";
import type { EntitlementKey } from "../../src/plans";

// The workspace chosen in the workspace menu (cookie), else the first membership.
export function activeWorkspace<T extends { _id?: string }>(user: { organizations: T[] }, jar: { get(name: string): { value: string } | undefined }) {
  return user.organizations.find((o) => o._id === jar.get("openreview_workspace")?.value) ?? user.organizations[0];
}

// Data for the dashboard page: authorization, redirects and every section's queries.
export async function loadDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ section?: string[] }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { section = [] } = await params,
    user = await current(),
    jar = await cookies();
  const organization = activeWorkspace(user, jar);
  if (!organization?._id) redirect("/dashboard/onboarding/workspace");
  const filters = await searchParams;
  // A new workspace on a billing deployment chooses a plan before anything else (Billing, Account and
  // the personal Referrals settings stay reachable); the server enforces the same rule.
  if (billingConfig().enabled && organization.planRequired && !organization.planSelectedAt && !(section[0] === "settings" && ["billing", "account", "referrals"].includes(section[1] ?? ""))) redirect("/dashboard/onboarding/plan");
  // Admins of a workspace still in guided setup land there; deep links are never redirected.
  if (!section[0] && needsSetup(organization) && ["owner", "admin"].includes(organization.role)) redirect("/dashboard/onboarding");
  const aliases: Record<string, string[]> = { overview: ["analytics"], repositories: ["settings", "repositories"], reviews: ["pulls"], findings: ["pulls", "findings"], issues: ["pulls", "issues"], knowledge: ["memory", "knowledge"], rules: ["memory", "rules"], team: ["settings", "people"], usage: ["settings", "usage"] };
  if (!section[0] || aliases[section[0]]) {
    const parts = aliases[section[0] ?? "overview"];
    const suffix = section.slice(1);
    const query = new URLSearchParams(Object.entries(filters).filter((e): e is [string,string] => e[1] !== undefined));
    redirect(`/dashboard/${[...parts, ...suffix].join("/")}${query.size ? `?${query}` : ""}`);
  }
  const route = section[0];
  if(route === "settings" && !section[1]) {
    const query = new URLSearchParams(Object.entries(filters).filter((e): e is [string,string] => e[1] !== undefined));
    redirect(`/dashboard/settings/${filters.repository ? "review" : "repositories"}${query.size ? "?"+query : ""}`);
  }
  if(route === "settings" && !settingsNavigation().some(([key])=>key === section[1]))notFound();
  const view = route === "analytics" ? "overview" : route === "pulls" ? section[1] === "findings" ? "findings" : section[1] === "issues" ? "issues" : "reviews" : route === "memory" ? section[1] === "knowledge" ? "knowledge" : "rules" : route === "settings" ? ({ repositories: "repositories", people: "team", usage: "usage" }[section[1] ?? ""] ?? "settings") : route;
  const reviewDetailId = route === "pulls" && !["findings", "issues"].includes(section[1] ?? "") ? section[1] : undefined;
  const requestedRepository = filters.repository;
  if (!navigation.some((n) => n.toLowerCase() === view)) notFound();
  const scopes=await backend().query(api.scopes.list,{token:user.token,organizationId:organization._id});
  const savedTeam=jar.get("openreview_team")?.value;
  const selectedTeam=scopes.teams.find(t=>t._id===(filters.team??savedTeam));
  if(filters.team&&!selectedTeam)notFound();
  if(selectedTeam)filters.team=selectedTeam._id;
  const data = await backend().query(api.dashboard.overview, {
    token: user.token,
    organizationId: organization._id,
    ...(selectedTeam?{teamId:selectedTeam._id}:{}),
  });
  const findingsPage =
    view === "findings"
      ? await backend().query(api.findings.list, {
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
        })
      : null;
  // Issues inbox (/dashboard/pulls/issues) and one issue (/dashboard/pulls/issues/<number>).
  const issueNumber = view === "issues" && section[2] ? Number(section[2]) : undefined;
  if (issueNumber !== undefined && !(Number.isInteger(issueNumber) && issueNumber > 0)) notFound();
  const issuesPage = view === "issues" && issueNumber === undefined ? await backend().query(api.issues.list, {
    token: user.token, organizationId: organization._id, cursor: filters.cursor,
    ...(selectedTeam ? { teamId: selectedTeam._id } : {}),
    ...(filters.repository ? { repositoryId: filters.repository as Id<"repositories"> } : {}),
    status: filters.status || undefined, assignee: filters.assignee || undefined, severity: filters.severity || undefined, category: filters.category || undefined,
  }) : null;
  const issue = issueNumber !== undefined ? await backend().query(api.issues.get, { token: user.token, organizationId: organization._id, number: issueNumber }).catch(() => notFound()) : null;
  const visibleFindings = findingsPage?.page ?? data.findings.map(f=>({...f,canFix:false}));
  const ruleView=view==="rules"&&!["clusters","integrations","preferences"].includes(section[1]??"");
  if(ruleView&&requestedRepository&&!data.repositories.some(r=>r._id===requestedRepository))notFound();
  const rulesPage=ruleView?await backend().query(api.dashboard.rulesPage,{token:user.token,organizationId:organization._id,
    ...(selectedTeam?{teamId:selectedTeam._id}:{}),...(requestedRepository?{repositoryId:requestedRepository as Id<"repositories">}:{}),cursor:filters.cursor}):null;
  const visibleRules=rulesPage?.page??data.rules;
  const repoName = (id: string) =>
    data.repositories.find((r) => r._id === id)?.fullName ?? id;
  const repoLabel = (id: string) => repositoryDisplay(data.repositories.find(r => r._id === id));
  const isAdmin = ["owner", "admin"].includes(organization.role);
  // Paid features this workspace has (null: billing is off, everything is granted).
  const entitlements = billingConfig().enabled ? await backend().query(api.billing.entitlements, { token: user.token, organizationId: organization._id }) : null;
  const unlocked = (key: EntitlementKey) => !entitlements || entitlements.includes(key);
  const ruleAssistant = ruleView && isAdmin ? await backend().query(api.ruleAssistant.page, { token: user.token, organizationId: organization._id }) : null;
  const pendingInvitations = view === "team" && isAdmin
    ? await backend().query(api.users.invitations,{token:user.token,organizationId:organization._id}) : [];
  let active =
    data.repositories.some(
      (r) =>
        ["queued","indexing"].includes(r.indexStatus) ||
        ["queued", "generating"].includes(r.knowledgeStatus ?? ""),
    ) ||
    data.reviews.some(
      (r) => !["completed", "failed", "cancelled"].includes(r.status),
    );
  let detail = null;
  if (view === "reviews" && reviewDetailId)
    detail = await backend().query(api.reviews.detail, {
      token: user.token,
      reviewId: reviewDetailId as Id<"reviews">,
      historyCursor: filters.historyCursor,
    });
  if(detail&&!['completed','failed','cancelled'].includes(detail.review.status))active=true;
  const diagnostics=detail?.review.resultStorageId?await backend().action(api.jobs.diagnostics,{token:user.token,reviewId:detail.review._id}):null;
  const personalAgent=(await backend().query(api.bridge.personal,{token:user.token,organizationId:detail?.review.organizationId??organization._id})).agent;
  if(view === "knowledge" && requestedRepository && !data.repositories.some(r=>r._id===requestedRepository))notFound();
  const knowledgeState = await knowledgeView(view === "knowledge" ? data.repositories : [],
    { team: filters.team, repository: requestedRepository, q: filters.q },
    (r, search) => backend().query(api.dashboard.knowledge, {
      token: user.token, repositoryId: r._id, search,
    }));
  const knowledge = knowledgeState.results;
  const apiKeys =
    route === "settings" && section[1] === "keys" && isAdmin
      ? await backend().query(api.apiKeys.list, {
          token: user.token,
          organizationId: organization._id,
        })
      : [];
  // Devin handoff appears only for viewers who saved their own key.
  const devinConfigured = route === "pulls" ? (await backend().query(api.personalCredentials.status, { token: user.token })).devin.configured : false;
  // MCP clients connected with OAuth: your own (admins see everyone's in the workspace).
  const mcpConnections = route === "settings" && section[1] === "keys" ? await backend().query(api.oauth.connections, { token: user.token, organizationId: organization._id }) : [];
  // The workspace's own model key: provider and model only, the key itself never leaves the backend.
  const modelKey = route === "settings" && section[1] === "keys" && isAdmin ? await backend().query(api.modelKeys.status, { token: user.token, organizationId: organization._id }) : null;
  if(route === "settings" && section[1] === "review" && requestedRepository && !data.repositories.some(r=>r._id===requestedRepository))notFound();
  const repoSettings =
    route === "settings" && section[1] === "review" && requestedRepository
      ? await backend().query(api.settings.repository, {
          token: user.token,
          repositoryId: requestedRepository as Id<"repositories">,
        })
      : null;
  const semantic = repoSettings ? await backend().query(api.embeddings.status, { token: user.token, repositoryId: repoSettings.repo._id }) : null;
  const conventions = repoSettings ? await backend().query(api.conventions.list, { token: user.token, repositoryId: repoSettings.repo._id }) : [];
  // Narrowed above: a dashboard always has a workspace.
  const workspace = organization as typeof organization & { _id: Id<"organizations"> };
  return { kind: "dashboard" as const, active, aliases, apiKeys, devinConfigured, mcpConnections, modelKey, conventions, data, detail, diagnostics, filters, findingsPage, issue, issuesPage, isAdmin, unlocked, jar, knowledge, knowledgeState, organization: workspace, pendingInvitations, personalAgent, repoLabel, repoName, repoSettings, requestedRepository, reviewDetailId, route, ruleAssistant, ruleView, rulesPage, savedTeam, scopes, section, selectedTeam, semantic, user, view, visibleFindings, visibleRules };
}
export type DashboardContext = Extract<Awaited<ReturnType<typeof loadDashboard>>, { kind: "dashboard" }>;
