import {repositoryDisplay,providerDisplay} from "../../src/provider-display";
import type {ProviderDisplayIdentity} from "../../src/provider-display";
import {CatalogSync,CatalogReview} from "./catalog-sync";
import {Live} from "./live";
import Link from "next/link";
import { api } from "../../convex/_generated/api";
import type { Id,Doc } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { EmptyState } from "../ui";
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
const runningLabel:Record<string,[string,string,string]>={queued:["running","◌","Queued"],failed:["failed","✕","Failed"],cancelled:["pending","–","Cancelled"]};
const countsOf=(r:NonNullable<Row["latest"]>)=>r.findingCounts??(r.findingCount&&r.findingSeverity?{[priorityOf(r.findingSeverity)]:r.findingCount}:{});
function ReviewStatus({pr,latest}:{pr:Row;latest:ReturnType<typeof currentReview>}){
 if(!latest)return <span className="review-state"><span className="state-icon pending" aria-hidden>⚑</span>{pr.latest?"Awaiting current review":"Not reviewed"}</span>;
 return <span className="review-status-line">{latest.reviewScore&&<><span title={latest.reviewScore.reason}>{latest.reviewScore.value}/5</span>{sep}</>}{latest.status!=="completed"?(([kind,icon,label])=><span className="review-state"><span className={"state-icon "+kind} aria-hidden>{icon}</span>{label}</span>)(runningLabel[latest.status]??["running","◌","Reviewing"]):latest.findingCount?<SeverityTags counts={countsOf(latest)}/>:<span className="review-state"><span className="state-icon done" aria-hidden>✓</span>Completed</span>}</span>;
}
export async function PullList({token,organizationId,repositories,filters,admin,login}:{admin:boolean;login:string;token:string;organizationId:Id<"organizations">;repositories:(Doc<"repositories">&{provider:ProviderDisplayIdentity|null})[];filters:Record<string,string|undefined>}){
 // `q` holds Greptile-style tokens; the older search/author/repository params still work.
 const q=filters.q??"",parsed=parsePullQuery(q),repoName=parsed.repo?.toLowerCase();
 const tokenRepo=repoName?repositories.find(r=>r.fullName.toLowerCase()===repoName||r.fullName.toLowerCase().endsWith("/"+repoName)):undefined;
 const repositoryId=(tokenRepo?._id??filters.repository) as Id<"repositories">|undefined,state=parsed.state??(filters.state==="closed"?"closed":"open");
 const pageSize=sizes.includes(Number(filters.size))?Number(filters.size):10,page=Math.max(1,Math.floor(Number(filters.p))||1);
 // Independent reads: load the import status and the list together.
 const [catalogs,result]=await Promise.all([backend().query(api.pullCatalogs.list,{token,organizationId,...(filters.team?{teamId:filters.team as Id<"teams">}:{}),...(repositoryId?{repositoryId}:{})}),parsed.repo&&!tokenRepo?{page:[],total:0,capped:false}:browse(token,organizationId,filters,{repositoryId,page,pageSize,search:parsed.search??filters.search,author:parsed.author??filters.author,reviewer:parsed.reviewer,state,status:parsed.status,impact:parsed.impact,scoreMin:parsed.scoreMin,scoreMax:parsed.scoreMax})]);
 const link=(changes:Record<string,string|undefined>)=>{const next=new URLSearchParams(Object.entries({...filters,cursor:undefined,...changes} as Record<string,string|undefined>).filter((e):e is [string,string]=>Boolean(e[1])));return "/dashboard/pulls"+(next.size?"?"+next:"");};
 const pages=Math.max(1,Math.ceil(result.total/pageSize)),shown=[...new Set([1,page-1,page,page+1,pages])].filter(n=>n>=1&&n<=pages).sort((a,b)=>a-b);
 const suggestions:[string,string,string][]=[[withToken(q,"author",login),"author is","you"],[withToken(q,"reviewer",login),"review requested from","you"],...repositories.slice(0,2).map(r=>[withToken(q,"repo",r.fullName),"repo is",r.fullName] as [string,string,string]),[withToken(q,"impact","high"),"impact is","high"]];
 return <div className="pulls-list">
  <Live active={catalogs.some(c=>c.job&&["queued","running"].includes(c.job.status))}/>
  <div className="pull-toolbar">
   <form className="pull-search" role="search">{filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}{filters.state&&<input type="hidden" name="state" value={filters.state}/>}{filters.size&&<input type="hidden" name="size" value={filters.size}/>}<span className="search-icon" aria-hidden>⌕</span><input id="pull-search" name="q" defaultValue={q} placeholder="Search pull requests or filter with author: repo: status: impact: confidence:>3" aria-label="Search pull requests"/></form>
   <nav className="state-toggle" aria-label="Pull request state">{([["open","Open","⑂"],["closed","Closed","⊘"]] as const).map(([value,label,icon])=><Link key={value} href={link({state:value==="open"?undefined:value,q:withoutToken(q,"state")||undefined,p:undefined})} aria-current={(state==="open"?"open":"closed")===value?"page":undefined}><span aria-hidden>{icon}</span> {label}</Link>)}</nav>
  </div>
  <p className="suggestions"><span className="suggested">Suggested</span>{suggestions.map(([value,key,shown])=><Link key={key+shown} className="suggestion" href={link({q:value,p:undefined})}><span className="k">{key}</span> <span className="v">{shown}</span></Link>)}{q&&<Link className="suggestion clear" href={link({q:undefined,p:undefined})}>Clear</Link>}</p>
  <div className="bulk-row"><BulkBar/><Link className="button small" href="/dashboard/analytics/findings">Findings</Link></div>
  <div className="table-wrap pulls-wrap"><table className="pulls-table"><thead><tr><th className="row-select"><SelectAll/></th><th>Pull request</th><th>Review status</th><th>Actions</th></tr></thead><tbody>{result.page.map(pr=>{
   const repo=repositories.find(r=>r._id===pr.repositoryId),latest=currentReview(pr,repo),risk=latest?.approvalAssessment?.risk,title=repositoryDisplay(repo)+" #"+pr.number+": "+pr.title;
   return <tr key={pr._id}>
    <td className="row-select"><input type="checkbox" form="bulk-pulls" name="pr" value={`${pr.repositoryId}|${pr.number}|${latest?._id??""}`} aria-label={`Select #${pr.number}`}/></td>
    <td><Link className="pull-link" title={title} href={pr.latest?"/dashboard/pulls/"+pr.latest._id:"/dashboard/pulls/pr/"+pr._id}><span className="pull-title-line">{pr.state==="merged"&&<span className="merged" aria-label="Merged">⑂</span>}{pr.state==="closed"&&<span className="closed-icon" aria-label="Closed">⊘</span>}{pr.title}</span><small className="meta">#{pr.number}{sep}{repo?.fullName.split("/").at(-1)}{sep}{pr.author}{sep}<time dateTime={new Date(pr.updatedAt).toISOString()} title={when(pr.updatedAt)}>{ago(pr.updatedAt)}</time>{risk&&risk!=="unknown"&&<>{sep}{risk[0].toUpperCase()+risk.slice(1)}</>}</small></Link></td>
    <td className="review-status"><ReviewStatus pr={pr} latest={latest}/></td>
    <td className="row-actions">{latest?.findingCount?<CopyFix reviewId={latest._id}/>:pr.state==="open"&&latest?.status==="completed"?<a className="text-action" href={pr.url} target="_blank" rel="noreferrer"><span aria-hidden>⑂</span> Merge ↗</a>:!latest&&pr.state==="open"&&pr.canRequest?<CatalogReview repositoryId={pr.repositoryId} prNumber={pr.number} revision={pr.headSha} baseRevision={pr.baseSha}/>:null}</td>
   </tr>;})}</tbody></table>
  {!result.page.length&&<EmptyState title="No matching pull requests">{parsed.repo&&!tokenRepo?`No connected repository matches “${parsed.repo}”.`:"Change the search or filters, or sync open pull requests below."}</EmptyState>}</div>
  {result.total>0&&<nav className="pager" aria-label="Pages">
   <PageSize value={pageSize} options={sizes}/>
   <span className="pager-pages"><span className="muted">{(page-1)*pageSize+1}–{Math.min(page*pageSize,result.total)} of {result.total}{result.capped?"+":""}</span>
   {page>1?<Link href={link({p:String(page-1)})} aria-label="Previous page">‹</Link>:<span className="disabled" aria-hidden>‹</span>}
   {shown.map((n,i)=><span key={n} className="pager-item">{i>0&&n-shown[i-1]>1&&<span className="muted">…</span>}<Link href={link({p:String(n)})} aria-current={n===page?"page":undefined}>{n}</Link></span>)}
   {page<pages?<Link href={link({p:String(page+1)})} aria-label="Next page">›</Link>:<span className="disabled" aria-hidden>›</span>}</span>
  </nav>}
  {result.capped&&<p className="muted">Showing the newest 1,000 matching pull requests. Narrow the search to see older ones.</p>}
  <details className="import-status"><summary>Open PR import status</summary><p>Setup imports existing open changes without running reviews. Sync reads current metadata; provider events keep subsequent changes updated. Import covers at most 30,000 changes per repository and reports failures visibly.</p>{catalogs.map(c=><article key={c.repositoryId}><h3>{c.fullName}</h3><p className="muted repository-identity">{providerDisplay(repositories.find(r=>r._id===c.repositoryId)?.provider??null)}</p><p>{!c.supported?"Native Perforce review polling manages change discovery.":c.job?`${c.job.status} · ${c.job.processed} changes imported · ${c.job.pages} pages`:"Import has not run yet."}</p>{c.job?.error&&<p role="alert">{c.job.error}</p>}{admin&&c.supported&&<CatalogSync repositoryId={c.repositoryId} disabled={!c.enabled||Boolean(c.job&&["queued","running"].includes(c.job.status))}/>}</article>)}</details>
  <PullKeys hints={[["J K","navigate"],["Space","select"],["Enter","open"],["G","re-review"],["/","search"]]}/>
 </div>;
}
// Compact pull request list beside an open pull request (Greptile's detail sidebar).
export async function PullSidebar({token,organizationId,repositories,filters,currentId}:{token:string;organizationId:Id<"organizations">;repositories:Doc<"repositories">[];filters:Record<string,string|undefined>;currentId?:string}){
 const state=filters.list==="closed"?"closed":"open",parsed=parsePullQuery(filters.find??"");
 const result=await browse(token,organizationId,filters,{page:1,pageSize:30,state,search:parsed.search,author:parsed.author});
 const stateLink=(s:string)=>"?"+new URLSearchParams({...(filters.tab?{tab:filters.tab}:{}),...(filters.find?{find:filters.find}:{}),...(s==="closed"?{list:s}:{})});
 return <aside className="pull-sidebar" aria-label="Pull requests">
  <div className="sidebar-head"><Link href="/dashboard/pulls">← Pull Requests</Link></div>
  <form className="pull-search" role="search">{filters.tab&&<input type="hidden" name="tab" value={filters.tab}/>}{state==="closed"&&<input type="hidden" name="list" value="closed"/>}<span className="search-icon" aria-hidden>⌕</span><input name="find" defaultValue={filters.find} placeholder="Search pull requests…" aria-label="Search pull requests"/></form>
  <nav className="state-toggle" aria-label="Sidebar state">{([["open","Open","⑂"],["closed","Closed","⊘"]] as const).map(([s,label,icon])=><Link key={s} href={stateLink(s)} aria-current={state===s?"page":undefined}><span aria-hidden>{icon}</span> {label}</Link>)}</nav>
  <p className="group-head"><span>Pull Requests</span><span>{result.total}{result.capped?"+":""}</span></p>
  <ol>{result.page.map(pr=>{const repo=repositories.find(r=>r._id===pr.repositoryId),latest=currentReview(pr,repo);return <li key={pr._id}><Link href={pr.latest?"/dashboard/pulls/"+pr.latest._id:"/dashboard/pulls/pr/"+pr._id} aria-current={pr._id===currentId?"page":undefined}><span className="row-title">{latest&&latest.status==="completed"&&<span className={"state-icon mini "+(latest.findingCount?"pending":"done")} aria-label={latest.findingCount?"Has findings":"No findings"}>{latest.findingCount?"✕":"✓"}</span>}{pr.state==="merged"&&<span className="merged" aria-label="Merged">⑂ </span>}<span className="num">#{pr.number}</span> {pr.title}</span><small className="meta">{pr.author}{latest?.reviewScore&&<>{sep}{latest.reviewScore.value}/5</>}{latest?.findingCount?<>{sep}{latest.findingCount} {latest.findingCount===1?"issue":"issues"}</>:null}</small></Link></li>;})}</ol>
  {!result.page.length&&<p className="muted">No pull requests.</p>}
 </aside>;
}
