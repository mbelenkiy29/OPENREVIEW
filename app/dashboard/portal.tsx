import {repositoryDisplay} from "../../src/provider-display";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Id, Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { backend } from "../../src/server";
import { SettingsNavigation } from "./settings-navigation";
import { PortalDisclosure } from "./portal-disclosure";
import { UserJotButton } from "../userjot";
import { userJotConfig } from "../../src/userjot";
import {ThemePicker} from "../theme";
import { Mark } from "../ui/logo";
import {analyticsPeriod, chartBuckets, periodPresets, presetPeriod} from "../../src/analytics-period";
import { BarList, LineChart } from "../ui/charts";
import { setMinutesPerFinding } from "./actions";
import { referralConfig } from "../../src/referrals";
import { historyFloor, type Entitlement } from "../../src/plans";
import { Locked } from "./locked";

// Read per request: Referrals appears only while the referral program is on (unknown keys 404).
const settingsGroups = () => [
  { label: "Repositories", links: [["repositories", "Add/Remove Repos"], ["providers", "Code Providers"]] },
  { label: "Agent Config", links: [["review", "Code Review"], ["model", "AI Model"], ["agents", "Personal agents"], ["automation", "Runtime & Approval"]] },
  { label: "Admin", links: [["teams", "Teams & Inheritance"], ["people", "People"], ["usage", "Usage"], ["billing", "Billing"], ["notifications", "Notifications"], ["data", "Data & deletion"]] },
  { label: "Developer", links: [["keys", "API Keys"], ["audit", "Audit Log"]] },
  { label: "Personal", links: [["account", "Account & sessions"], ...(referralConfig().enabled ? [["referrals", "Referrals"]] : [])] },
];
export const settingsNavigation = () => settingsGroups().flatMap(group => group.links);

// 16px stroke icons for the main tabs, drawn in the Lucide style.
const tabIcons: Record<string, ReactNode> = {
  analytics: <path d="M3 3v18h18M7 14l4-4 4 4 5-5" />,
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  memory: <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />,
  pulls: <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
};
const memoryIcons: Record<string, ReactNode> = {
  rules: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />,
  clusters: <><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M7 6h10M6 8l5 8M18 8l-5 8" /></>,
  knowledge: tabIcons.memory,
  integrations: <path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4" />,
  preferences: <path d="M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.8-5-3.6-5 3.6 1.9-5.8L4 8.8h6.1z" />,
};
export function PortalNav({ organization, role, login, route, section, team,scopeSelector,children }: { organization: string; role?: string; login: string; route: string; section?: string; team?:string;scopeSelector:ReactNode;children: ReactNode }) {
  const href=(path:string)=>path+(team!==undefined?"?team="+encodeURIComponent(team):"");
  const feedback = Boolean(userJotConfig());
  const secondary = route === "memory" ? [["rules", "Custom rules"], ["clusters", "Cross-repo context"], ["knowledge", "Knowledge Base"], ["integrations", "Integrations"], ["preferences", "Learned preferences"]] : route === "settings" ? settingsNavigation() : route === "pulls" ? [["", "All Pull Requests"], ["findings", "Findings"]] : [];
  return <><div className="portal-top"><div className="portal-identity"><Link className="brand" href={href("/dashboard/analytics")}><Mark /> OpenReview</Link><PortalDisclosure className="scope-selector" label={organization}><div className="scope-menu">{scopeSelector}</div></PortalDisclosure>{role&&<span className="role-badge">{role[0].toUpperCase()+role.slice(1)}</span>}<PortalDisclosure className="profile" label={`@${login}`}><div className="profile-menu"><ThemePicker/>{children}<Link href="/dashboard/onboarding">Workspace setup</Link><Link href="/dashboard/settings/agents">Personal settings</Link>{referralConfig().enabled && <Link href="/dashboard/settings/referrals">Refer someone</Link>}{feedback && <div className="profile-feedback"><UserJotButton className="link-button">Request a feature</UserJotButton><UserJotButton className="link-button">Report a bug</UserJotButton><Link href="/feedback/roadmap">Roadmap</Link></div>}</div></PortalDisclosure></div><nav className="primary-nav" aria-label="Main navigation">{[["analytics", "Analytics"], ["chat", "Chat"], ["memory", "Memory"], ["pulls", "Pull Requests"], ["settings", "Settings"]].map(([key,label]) => <Link key={key} href={href(`/dashboard/${key}`)} aria-current={route === key ? "page" : undefined}><svg className="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{tabIcons[key]}</svg>{label}</Link>)}</nav></div>{secondary.length > 0 && <aside className="secondary-nav">{route === "settings" ? <SettingsNavigation groups={settingsGroups()} section={section} team={team} /> : <nav aria-label={`${route} navigation`}>{route === "memory" && <p className="nav-group-title">Memory</p>}{secondary.map(([key,label]) => <Link key={key} href={href(`/dashboard/${route}${key ? `/${key}` : ""}`)} aria-current={(section ?? (route === "memory" ? "rules" : "")) === key ? "page" : undefined}>{memoryIcons[key]&&route==="memory"&&<svg className="tab-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{memoryIcons[key]}</svg>}{label}</Link>)}</nav>}</aside>}</>;
}
const hours=(ms:number|null)=>ms===null?"—":`${(ms/3600000).toFixed(1)} h`;
// Laid out like Greptile's Analytics tab: filters, four cards, then six charts each paired with a leaderboard; our cost and impact numbers follow.
export async function AnalyticsView({token,organizationId,repositories,filters,locked}: {token:string;organizationId:Id<"organizations">;repositories:Doc<"repositories">[];filters:Record<string,string|undefined>;locked:readonly Entitlement[]}) {
  const now = new Date(), start = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString().slice(0,10);
  // Links that carry only dates (older bookmarks, the Findings page) mean a custom period.
  const preset = filters.period ?? (filters.since || filters.until ? "custom" : "month"), range = presetPeriod(preset, now.getTime());
  const since = range?.since ?? filters.since ?? start, until = range?.until ?? filters.until ?? now.toISOString().slice(0,10);
  const period=analyticsPeriod(since,until),floor=locked.includes("analytics.history")?new Date(historyFloor(Date.now())).toISOString().slice(0,10):undefined;
  const accessible=!filters.repository||repositories.some(r=>r._id===filters.repository);
  const scope = {...(filters.team ? {team:filters.team}:{}),...(filters.repository ? {repository:filters.repository}:{}),...(filters.author ? {author:filters.author}:{})};
  const query = new URLSearchParams({since,until,...scope});
  const form=<form className="filter-bar analytics-filters">{filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}<label><span className="sr-only">Time period</span><select name="period" defaultValue={preset}>{periodPresets.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label><span className="sr-only">From</span><input type="date" name="since" defaultValue={since} min={floor} required /></label><label><span className="sr-only">Through</span><input type="date" name="until" defaultValue={until} required /></label><label><span className="sr-only">Repository</span><select name="repository" defaultValue={filters.repository ?? ""}><option value="">All repositories</option>{repositories.map(r=><option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}</select></label><label><span className="sr-only">Author</span><input name="author" defaultValue={filters.author} placeholder="All authors" /></label><button>Apply</button>{!("error" in period)&&accessible&&!(floor&&since<floor)?<a className="button primary" href={`/api/analytics?${query}`}>Export CSV</a>:<button type="button" disabled>Export CSV</button>}</form>;
  const problem=(message:string)=><>{form}<section role="alert"><h2>Analytics unavailable</h2><p>{message}</p><p>Correct the filters and choose Apply to retry.</p></section></>;
  if("error" in period)return problem(period.error);
  if(!accessible)return problem("Select a repository accessible in the current workspace and team.");
  if(floor&&since<floor)return <>{form}<section><h2>Older analytics</h2><Locked feature="analytics.history" locked={locked}/><p>Choose a From date on or after {floor}.</p></section></>;
  const args={token,organizationId,...period,...(filters.repository?{repositoryId:filters.repository as Id<"repositories">}:{}),...(filters.author?{author:filters.author}:{}),...(filters.team?{teamId:filters.team as Id<"teams">}:{})};
  const [loaded,rolled]=await Promise.allSettled([backend().query(api.analytics.report,args),backend().query(api.analytics.trends,args)]);
  if(loaded.status==="rejected")return problem("Could not load the selected analytics. Choose a smaller period or check repository and team access, then retry.");
  const report=loaded.value,t=rolled.status==="fulfilled"?rolled.value:null;
  const days:string[]=[];
  for(let at=period.since;at<=period.until&&days.length<367;at+=86400000)days.push(new Date(at).toISOString().slice(0,10));
  // Every chart shares the buckets: days, or weeks past 90 days.
  const buckets=chartBuckets(days),unit=buckets.length<days.length?"week":"day",labels=buckets.map(b=>b.label.slice(5)),byDate=new Map(report.daily.map(d=>[d.date,d])),mergeByDate=new Map(report.mergeTime.daily.map(d=>[d.date,d])),trendDays=new Map((t?.days??[]).map(d=>[d.day,d]));
  const sum=(value:(day:string)=>number)=>buckets.map(b=>b.days.reduce((n,d)=>n+value(d),0)),tsum=(key:"findings"|"addressed"|"useful"|"notUseful"|"commitAddressed"|"ignored")=>sum(d=>trendDays.get(d)?.[key]??0);
  const cumulativeRate=(part:number[],whole:number[])=>{let p=0,w=0;return part.map((x,i)=>{p+=x;w+=whole[i];return w?Math.round(p/w*100):null;});};
  const fixed=tsum("commitAddressed"),ignored=tsum("ignored"),rate=cumulativeRate(tsum("addressed"),tsum("findings")),fixRate=cumulativeRate(fixed,fixed.map((x,i)=>x+ignored[i]));
  // Merge time per bucket is weighted by merged PRs, not an average of daily averages.
  const mergeHours=buckets.map(b=>{let ms=0,n=0;for(const d of b.days){const m=mergeByDate.get(d);if(m){ms+=m.meanMs*m.count;n+=m.count;}}return n?Math.round(ms/n/360000)/10:null;});
  const repos=t?.byRepository??[],top=(value:(r:(typeof repos)[number])=>number)=>repos.filter(r=>value(r)>0).sort((p,q)=>value(q)-value(p)).slice(0,10);
  const unavailable=<section role="alert"><h2>Trends unavailable</h2><p>Daily trends could not be loaded for these filters.</p></section>;
  const tiles:[string,ReactNode,string?][]=[["Total PRs",report.totalPRs],["Total Reviews",report.totalReviews],["Avg merge time",hours(report.mergeTime.meanMs),report.mergeTime.count?`median ${hours(report.mergeTime.medianMs)} · ${report.mergeTime.count} merged`:"Recorded for PRs merged from now on"],["Bugs caught",report.findings,`across ${report.bugRepositories} ${report.bugRepositories===1?"repository":"repositories"}`]];
  const impact:[string,ReactNode][]=[["Model cost",`$${report.cost.toFixed(2)}`],["Model tokens",report.tokens.toLocaleString()],["Average review duration",report.averageDuration===null?"—":`${Math.round(report.averageDuration/1000)}s`],["Comment usefulness",report.usefulness===null?"Awaiting feedback":`${Math.round(report.usefulness*100)}%`],["Comment reactions",`👍 ${report.reactions.up} · 👎 ${report.reactions.down}`],...(t?[["Estimated time saved",`${t.hoursSaved} h`],["Fixed before merge",t.fixRate===null?"—":`${Math.round(t.fixRate*100)}%`]] as [string,ReactNode][]:[])];
  return <>{form}
    <div className="metrics">{tiles.map(([label,value,detail])=><div key={label}><span>{label}</span><strong>{value}</strong>{detail&&<small className="muted">{detail}</small>}</div>)}</div>
    <div className="analytics-grid">
      <section><LineChart title={`Reviews per ${unit}`} labels={labels} series={[{label:"Reviews",values:sum(d=>byDate.get(d)?.reviews??0)}]}/>{t&&<BarList title="Top repositories by review count" items={top(r=>r.reviews).map(r=>({label:r.label,value:r.reviews}))}/>}</section>
      <section><LineChart title={`Bugs caught by severity per ${unit}`} labels={labels} series={(["critical","high","medium","low"] as const).map(s=>({label:s,values:sum(d=>byDate.get(d)?.[s]??0)}))}/>{t&&<BarList title="Repositories with the most bugs" items={top(r=>r.findings).map(r=>({label:r.label,value:r.findings,detail:`${r.high} critical or high`}))}/>}<p><Link href={`/dashboard/pulls/findings?${new URLSearchParams({since,until,...scope})}`}>View all bugs →</Link></p></section>
      <section><LineChart title="Average time to merge (hours)" labels={labels} series={[{label:"Mean hours",values:mergeHours}]} format={v=>`${v} h`}/>{report.mergeTime.count?<BarList title="Slowest repositories to merge" items={report.mergeTime.byRepository.map(r=>({label:r.repository,value:Math.round(r.meanMs/360000)/10,detail:`${r.count} merged`}))} format={v=>`${v} h`}/>:<p className="muted">Merge time runs from when OpenReview first sees a pull request to its merge, recorded for pull requests merged from now on.</p>}</section>
      <section><BarList title="Top contributors (PRs reviewed)" items={report.contributors.map(c=>({label:"@"+c.author,value:c.prs,detail:c.repositories.join(", ")}))}/></section>
      {t?<section><LineChart title="Addressed rate (cumulative %)" labels={labels} series={[{label:"Addressed %",values:rate}]} format={v=>`${v}%`}/><BarList title="Top repositories by addressed rate" items={top(r=>r.findings?r.addressed/r.findings:0).map(r=>({label:r.label,value:Math.round(r.addressed/r.findings*100),detail:`${r.addressed} of ${r.findings}`}))} format={v=>`${v}%`}/></section>:unavailable}
      {t?<section><LineChart title={`Comment ratings per ${unit}`} labels={labels} series={[{label:"Helpful",values:tsum("useful")},{label:"Not helpful",values:tsum("notUseful")}]}/><h3>Most upvoted comments</h3>{report.topComments.length?<ol>{report.topComments.map(c=><li key={c.findingId}><Link href={`/dashboard/pulls/${c.reviewId}`}>{c.title}</Link> <span className="muted">{c.repository} #{c.prNumber} · 👍 {c.upvotes}</span></li>)}</ol>:<p className="muted">No upvoted comments in this period.</p>}</section>:null}
    </div>
    <section className="trends" aria-labelledby="impact-heading">
      <h2 id="impact-heading">Cost &amp; impact</h2>
      <div className="metrics">{impact.map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      {t&&<>
        <p className="muted">Time saved = addressed findings × {t.minutesPerFinding} minutes per finding. “Fixed before merge” counts findings a later commit fixed against findings merged while still open with no feedback. Reactions come from provider comments (GitHub polled hourly and on close; GitLab via emoji webhooks). Trends come from a daily rollup refreshed hourly{t.updatedAt?`, last updated ${new Date(t.updatedAt).toLocaleString("en-US",{timeZone:"UTC",dateStyle:"medium",timeStyle:"short"})} UTC`:""}.</p>
        <div className="analytics-grid"><section><LineChart title="Fixed by a follow-up commit vs merged unaddressed" labels={labels} series={[{label:"Fixed by commit",values:fixed},{label:"Merged unaddressed",values:ignored},{label:"Fixed before merge %",values:fixRate}]}/></section></div>
        <form action={setMinutesPerFinding} className="filter-bar"><input type="hidden" name="organizationId" value={organizationId}/><label>Minutes saved per addressed finding<input type="number" name="minutes" min={1} max={480} defaultValue={t.minutesPerFinding} required/></label><button>Update estimate</button></form>
      </>}
    </section>
  </>;
}
