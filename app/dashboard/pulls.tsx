import {repositoryDisplay,providerDisplay} from "../../src/provider-display";
import type {ProviderDisplayIdentity} from "../../src/provider-display";
import {CatalogSync,CatalogReview} from "./catalog-sync";
import {Live} from "./live";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import type { Id,Doc } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { Icon, type IconName } from "../ui/icons";
import { ago, when } from "./sections/shared";
import { priorityOf } from "../../src/priority";
import { parsePullQuery, withToken, withoutToken } from "../../src/pull-query";
import { BulkBar, CopyFix, PageSize, PullKeys, SelectAll } from "./pull-list-client";
const sizes=[10,30,50];
type BrowseArgs=Partial<{repositoryId:Id<"repositories">;page:number;pageSize:number;search:string;author:string;reviewer:string;state:string;status:string;impact:string;scoreMin:number;scoreMax:number}>;
const browse=(token:string,organizationId:Id<"organizations">,filters:Record<string,string|undefined>,args:BrowseArgs)=>backend().query(api.pulls.browse,{token,organizationId,...(filters.team?{teamId:filters.team as Id<"teams">}:{}),page:1,pageSize:20,...Object.fromEntries(Object.entries(args).filter(e=>e[1]!==undefined&&e[1]!==""))});
type Row=Awaited<ReturnType<typeof browse>>["page"][number];
// A review counts for the list only when it covers the change's current revision.
const currentReview=(pr:Row,repo?:Doc<"repositories">)=>pr.latest&&pr.latest.headSha===pr.headSha&&(!pr.latest.nativeP4||pr.latest.baseSha===pr.baseSha&&repo?.indexedSha===pr.baseSha)&&(pr.revisionKey===undefined||pr.latest.revisionKey===pr.revisionKey)?pr.latest:null;
const sep=<span className="sep" aria-hidden>·</span>;
// Greptile's square severity tags with the count beside them: [P1] ×2 [🛡] ×1.
const shield=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Security"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
export const SeverityTags=({counts}:{counts:Record<string,number>})=><span className="sev-tags">{["P0","P1","P2","P3","security"].filter(k=>counts[k]).map(k=><span key={k} className="sev-tag-group" title={`${counts[k]} ${k} finding${counts[k]===1?"":"s"}`}><span className={"sev-tag "+k}>{k==="security"?shield:k}</span><span className="sev-count">×{counts[k]}</span></span>)}</span>;
const countsOf=(r:NonNullable<Row["latest"]>)=>r.findingCounts??(r.findingCount&&r.findingSeverity?{[priorityOf(r.findingSeverity)]:r.findingCount}:{});
const finished=["completed","failed","cancelled","skipped"];
// Greptile's status chip: a 24px tile and a mono label. A running review spins until it finishes.
const chips:Record<string,[string,IconName,string]>={completed:["completed","check","Completed"],failed:["failed","x","Failed"],cancelled:["","x","Cancelled"],skipped:["","prohibit","Skipped"],queued:["pending","circleNotch","Pending"]};
export function StatusChip({pr,latest}:{pr:{latest:{status:string}|null};latest:{status:string;findingCount?:number}|null}){
 if(!latest)return <span className="status-chip" title={pr.latest?"Awaiting a review of the current revision":undefined}><Icon name={pr.latest?"clock":"circleDashed"}/>{pr.latest?"Outdated":"Not reviewed"}</span>;
 const [kind,icon,label]=chips[latest.status]??["pending","circleNotch","Reviewing"];
 // With findings the severity tags beside the chip say more than its label.
 return <span className={"status-chip "+kind} title={finished.includes(latest.status)?undefined:latest.status.replaceAll("_"," ")}><Icon name={icon}/>{latest.status==="completed"&&latest.findingCount?<span className="sr-only">{label}</span>:label}</span>;
}
const providerMark=(kind?:string):IconName=>kind?.startsWith("gitlab")?"gitlabLogo":kind?.startsWith("github")?"githubLogo":"gitBranch";
export async function PullList({token,organizationId,repositories,filters,admin,login,live}:{admin:boolean;login:string;live:boolean;token:string;organizationId:Id<"organizations">;repositories:(Doc<"repositories">&{provider:ProviderDisplayIdentity|null})[];filters:Record<string,string|undefined>}){
 // `q` holds Greptile-style tokens; the older search/author/repository params still work.
 const q=filters.q??"",parsed=parsePullQuery(q),repoName=parsed.repo?.toLowerCase();
 const tokenRepo=repoName?repositories.find(r=>r.fullName.toLowerCase()===repoName||r.fullName.toLowerCase().endsWith("/"+repoName)):undefined;
 const repositoryId=(tokenRepo?._id??filters.repository) as Id<"repositories">|undefined,state=parsed.state??(filters.state==="closed"?"closed":"open");
 const pageSize=sizes.includes(Number(filters.size))?Number(filters.size):10,page=Math.max(1,Math.floor(Number(filters.p))||1);
 // Independent reads: load the import status and the list together.
 const [catalogs,result]=await Promise.all([backend().query(api.pullCatalogs.list,{token,organizationId,...(filters.team?{teamId:filters.team as Id<"teams">}:{}),...(repositoryId?{repositoryId}:{})}),parsed.repo&&!tokenRepo?{page:[],total:0,capped:false}:browse(token,organizationId,filters,{repositoryId,page,pageSize,search:parsed.search??filters.search,author:parsed.author??filters.author,reviewer:parsed.reviewer,state,status:parsed.status,impact:parsed.impact,scoreMin:parsed.scoreMin,scoreMax:parsed.scoreMax})]);
 const link=(changes:Record<string,string|undefined>)=>{const next=new URLSearchParams(Object.entries({...filters,cursor:undefined,...changes} as Record<string,string|undefined>).filter((e):e is [string,string]=>Boolean(e[1])));return "/dashboard/pulls"+(next.size?"?"+next:"");};
 const pages=Math.max(1,Math.ceil(result.total/pageSize)),shown=[...new Set([1,page-1,page,page+1,pages])].filter(n=>n>=1&&n<=pages).sort((a,b)=>a-b);
 const suggestions:[string,string,string][]=[[withToken(q,"author",login),"author is","you"],[withToken(q,"reviewer",login),"review requested from","you"],...repositories.slice(0,2).map(r=>[withToken(q,"repo",r.fullName),"repo is",r.fullName] as [string,string,string]),[withToken(q,"status","unreviewed"),"status is","unreviewed"],[withToken(q,"impact","high"),"impact is","high"]];
 // Live: the import or a review on this page is still running (the page header covers workspace-wide work).
 const running=catalogs.some(c=>c.job&&["queued","running"].includes(c.job.status))||result.page.some(pr=>pr.latest&&!finished.includes(pr.latest.status));
 return <div className="pulls-list">
  {!live&&<Live active={running}/>}
  <div className="toolbar-row pull-toolbar">
   {/* Greptile's "click to add filters": the suggested filters open under the search box while it has focus. */}
   <form className="search-field pull-search" role="search">{filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}{filters.state&&<input type="hidden" name="state" value={filters.state}/>}{filters.size&&<input type="hidden" name="size" value={filters.size}/>}<Icon name="magnifyingGlass"/><input id="pull-search" name="q" defaultValue={q} placeholder="Search pull requests or click to add filters" aria-label="Search pull requests" autoComplete="off"/>
    <div className="filter-menu" aria-label="Suggested filters" role="group"><p className="menu-label">Suggested filters</p>{suggestions.map(([value,key,shown])=><Link key={key+shown} className="menu-item suggestion" href={link({q:value,p:undefined})}><span><span className="k">{key}</span> <span className="v">{shown}</span></span></Link>)}{q&&<Link className="menu-item muted" href={link({q:undefined,p:undefined})}><Icon name="x"/><span>Clear search and filters</span></Link>}<p className="filter-hint">Filter with <code>author:</code> <code>repo:</code> <code>status:</code> <code>impact:</code> <code>confidence:&gt;3</code></p></div>
   </form>
   <nav className="segmented state-toggle" aria-label="Pull request state">{([["open","Open","gitPullRequest"],["closed","Closed","gitMerge"]] as const).map(([value,label,icon])=><Link key={value} href={link({state:value==="open"?undefined:value,q:withoutToken(q,"state")||undefined,p:undefined})} aria-current={(state==="open"?"open":"closed")===value?"page":undefined}><Icon name={icon}/>{label}</Link>)}</nav>
   <Link className="button" href="/dashboard/analytics/findings"><Icon name="bug"/>Findings</Link>
  </div>
  <BulkBar/>
  <div className="table-box pulls-wrap"><table className="pulls-table"><thead><tr><th className="row-select"><SelectAll/></th><th className="num-col">PR #</th><th className="name-col">PR Name</th><th className="repo-col">Repo</th><th className="branch-col">Branch</th><th className="status-col">Status</th><th className="count-col"># Reviews</th><th className="updated-col">Last updated</th></tr></thead><tbody>{result.page.map(pr=>{
   const repo=repositories.find(r=>r._id===pr.repositoryId),latest=currentReview(pr,repo),risk=latest?.approvalAssessment?.risk,branch=pr.latest?.headBranch;
   // Last updated: the change or its newest review, so a rerun shows as fresh activity (as on Greptile).
   const updated=Math.max(pr.updatedAt,pr.latest?.updatedAt??0);
   const action=latest?.findingCount?<CopyFix reviewId={latest._id}/>:pr.state==="open"&&latest?.status==="completed"?<a className="text-action" href={pr.url} target="_blank" rel="noreferrer"><Icon name="gitMerge"/> Merge</a>:!latest&&pr.state==="open"&&pr.canRequest?<CatalogReview compact repositoryId={pr.repositoryId} prNumber={pr.number} revision={pr.headSha} baseRevision={pr.baseSha}/>:null;
   return <tr key={pr._id}>
    <td className="row-select"><input type="checkbox" form="bulk-pulls" name="pr" value={`${pr.repositoryId}|${pr.number}|${latest?._id??""}`} aria-label={`Select #${pr.number}`}/></td>
    <td className="num-col">#{pr.number}</td>
    <td className="name-col"><Link className="pull-link" title={`${repositoryDisplay(repo)} #${pr.number}: ${pr.title} by ${pr.author}`} href={pr.latest?"/dashboard/pulls/"+pr.latest._id:"/dashboard/pulls/pr/"+pr._id}>{pr.state==="merged"&&<span className="merged" aria-label="Merged"><Icon name="gitMerge"/></span>}{pr.state==="closed"&&<span className="closed-icon" aria-label="Closed"><Icon name="prohibit"/></span>}<span className="pull-name">{pr.title}</span>{risk&&risk!=="unknown"&&risk!=="low"&&<span className={"impact-tag "+risk}>{risk[0].toUpperCase()+risk.slice(1)} impact</span>}</Link></td>
    <td className="repo-col" title={repositoryDisplay(repo)}><span className="repo-cell"><Icon name={providerMark(repo?.provider?.kind)}/><span>{repo?.fullName.split("/").at(-1)}</span></span></td>
    <td className="branch-col" title={branch}>{branch??<span className="muted">—</span>}</td>
    <td className="status-col"><span className="status-line"><StatusChip pr={pr} latest={latest}/>{latest?.reviewScore&&<span className="score" title={latest.reviewScore.reason}>{latest.reviewScore.value}/5</span>}{latest?.status==="completed"&&latest.findingCount?<SeverityTags counts={countsOf(latest)}/>:null}</span></td>
    <td className="count-col">{pr.reviewCount}</td>
    {/* Row actions float over the row on hover or keyboard focus (Greptile rows stay 8 columns); the pull request page has them too. */}
    <td className="updated-col"><time dateTime={new Date(updated).toISOString()} title={when(updated)}>{ago(updated)}</time>{action&&<span className="row-hover-actions">{action}</span>}</td>
   </tr>;})}</tbody></table>
  {!result.page.length&&<div className="empty-state"><strong>{q?"No results.":state==="closed"?"No closed pull requests":"No open pull requests"}</strong><p>{parsed.repo&&!tokenRepo?`No connected repository matches “${parsed.repo}”.`:q?"Change the search or filters, or sync open pull requests below.":"Pull requests appear here when they are opened on a connected repository, or when you sync open pull requests below."}</p></div>}</div>
  {result.total>0&&<div className="pagination pull-pager">
   <span>{(page-1)*pageSize+1}–{Math.min(page*pageSize,result.total)} of {result.total}{result.capped?"+":""}</span>
   <nav aria-label="Pages">
    {page>1?<Link href={link({p:String(page-1)})} aria-label="Previous page"><Icon name="caretLeft"/></Link>:<span className="disabled" aria-hidden><Icon name="caretLeft"/></span>}
    {shown.map((n,i)=><span key={n} className="pager-item">{i>0&&n-shown[i-1]>1&&<span className="muted">…</span>}<Link href={link({p:String(n)})} aria-current={n===page?"page":undefined}>{n}</Link></span>)}
    {page<pages?<Link href={link({p:String(page+1)})} aria-label="Next page"><Icon name="caretRight"/></Link>:<span className="disabled" aria-hidden><Icon name="caretRight"/></span>}
   </nav>
   <PageSize value={pageSize} options={sizes}/>
  </div>}
  {result.capped&&<p className="muted">Showing the newest 1,000 matching pull requests. Narrow the search to see older ones.</p>}
  <details className="import-status"><summary><Icon name="arrowsClockwise"/><span>Open PR import status</span><Icon name="caretDown"/></summary><p className="import-note">Setup imports existing open changes without running reviews. Sync reads current metadata; provider events keep subsequent changes updated. Import covers at most 30,000 changes per repository and reports failures visibly.</p>{catalogs.map(c=><article key={c.repositoryId}><div><h3><Icon name={providerMark(repositories.find(r=>r._id===c.repositoryId)?.provider?.kind)}/>{c.fullName}</h3><p className="muted repository-identity">{providerDisplay(repositories.find(r=>r._id===c.repositoryId)?.provider??null)}</p><p className="import-state">{!c.supported?"Native Perforce review polling manages change discovery.":c.job?<><span className={"status-chip "+(c.job.status==="completed"?"completed":c.job.status==="failed"?"failed":["queued","running"].includes(c.job.status)?"pending":"")}><Icon name={c.job.status==="completed"?"check":c.job.status==="failed"?"x":["queued","running"].includes(c.job.status)?"circleNotch":"clock"}/>{c.job.status}</span> {c.job.processed} changes imported · {c.job.pages} pages</>:"Import has not run yet."}</p>{c.job?.error&&<p role="alert">{c.job.error}</p>}</div>{admin&&c.supported&&<CatalogSync repositoryId={c.repositoryId} disabled={!c.enabled||Boolean(c.job&&["queued","running"].includes(c.job.status))}/>}</article>)}{!catalogs.length&&<p className="muted import-note">No repositories in this scope.</p>}</details>
  <PullKeys hints={[["J K","navigate"],["Space","select"],["Enter","open"],["G","rerun"],["/","search"]]}/>
 </div>;
}
// Compact pull request list beside an open pull request (Greptile's detail sidebar).
export async function PullSidebar({token,organizationId,repositories,filters,currentId}:{token:string;organizationId:Id<"organizations">;repositories:Doc<"repositories">[];filters:Record<string,string|undefined>;currentId?:string}){
 const state=filters.list==="closed"?"closed":"open",parsed=parsePullQuery(filters.find??"");
 const result=await browse(token,organizationId,filters,{page:1,pageSize:30,state,search:parsed.search,author:parsed.author});
 const stateLink=(s:string)=>"?"+new URLSearchParams({...(filters.tab?{tab:filters.tab}:{}),...(filters.find?{find:filters.find}:{}),...(s==="closed"?{list:s}:{})});
 return <aside className="pull-sidebar" aria-label="Pull requests">
  <div className="sidebar-head"><Link className="back-link" href="/dashboard/pulls"><Icon name="caretLeft"/>Pull Requests</Link></div>
  <form className="search-field pull-search" role="search">{filters.tab&&<input type="hidden" name="tab" value={filters.tab}/>}{state==="closed"&&<input type="hidden" name="list" value="closed"/>}<Icon name="magnifyingGlass"/><input name="find" defaultValue={filters.find} placeholder="Search pull requests…" aria-label="Search pull requests"/></form>
  <nav className="segmented state-toggle" aria-label="Sidebar state">{([["open","Open","gitPullRequest"],["closed","Closed","gitMerge"]] as const).map(([s,label,icon])=><Link key={s} href={stateLink(s)} aria-current={state===s?"page":undefined}><Icon name={icon}/>{label}</Link>)}</nav>
  <p className="group-head"><span>Pull Requests</span><span>{result.total}{result.capped?"+":""}</span></p>
  <ol>{result.page.map(pr=>{const repo=repositories.find(r=>r._id===pr.repositoryId),latest=currentReview(pr,repo);return <li key={pr._id}><Link href={pr.latest?"/dashboard/pulls/"+pr.latest._id:"/dashboard/pulls/pr/"+pr._id} aria-current={pr._id===currentId?"page":undefined}><span className="row-title">{pr.state==="merged"&&<span className="merged" aria-label="Merged"><Icon name="gitMerge"/> </span>}<span className="num">#{pr.number}</span> {pr.title}</span><small className="meta"><StatusChip pr={pr} latest={latest}/>{sep}{pr.author}{latest?.reviewScore&&<>{sep}{latest.reviewScore.value}/5</>}{latest?.findingCount?<>{sep}{latest.findingCount} {latest.findingCount===1?"issue":"issues"}</>:null}</small></Link></li>;})}</ol>
  {!result.page.length&&<p className="muted">No pull requests.</p>}
 </aside>;
}
