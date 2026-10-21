import {repositoryDisplay,providerDisplay} from "../../src/provider-display";
import type {ProviderDisplayIdentity} from "../../src/provider-display";
import {CatalogSync,CatalogReview} from "./catalog-sync";
import {Live} from "./live";
import Link from "next/link";
import {ScrollTable} from "./scroll-table";
import { api } from "../../convex/_generated/api";
import type { Id,Doc } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { EmptyState } from "../ui";
import { ago, when, status, priority, severityCounts } from "./sections/shared";
import { parsePullQuery, withToken, withoutToken } from "../../src/pull-query";
import { BulkBar, PullKeys } from "./pull-list-client";
const sizes=[10,30,50];
export async function PullList({token,organizationId,repositories,filters,admin,login}:{admin:boolean;login:string;token:string;organizationId:Id<"organizations">;repositories:(Doc<"repositories">&{provider:ProviderDisplayIdentity|null})[];filters:Record<string,string|undefined>}){
 // `q` holds Greptile-style tokens; the older search/author/repository params still work.
 const q=filters.q??"",parsed=parsePullQuery(q),repoName=parsed.repo?.toLowerCase();
 const tokenRepo=repoName?repositories.find(r=>r.fullName.toLowerCase()===repoName||r.fullName.toLowerCase().endsWith("/"+repoName)):undefined;
 const repositoryId=(tokenRepo?._id??filters.repository) as Id<"repositories">|undefined,state=parsed.state??filters.state??"";
 const pageSize=sizes.includes(Number(filters.size))?Number(filters.size):30,page=Math.max(1,Math.floor(Number(filters.p))||1);
 const team=filters.team?{teamId:filters.team as Id<"teams">}:{};
 const catalogs=await backend().query(api.pullCatalogs.list,{token,organizationId,...team,...(repositoryId?{repositoryId}:{})});
 const result=parsed.repo&&!tokenRepo?{page:[],total:0,capped:false}:await backend().query(api.pulls.browse,{token,organizationId,...team,...(repositoryId?{repositoryId}:{}),page,pageSize,search:parsed.search??filters.search??undefined,author:parsed.author??filters.author??undefined,state:state||undefined,status:parsed.status,impact:parsed.impact,scoreMin:parsed.scoreMin,scoreMax:parsed.scoreMax});
 const link=(changes:Record<string,string|undefined>)=>{const next=new URLSearchParams(Object.entries({...filters,cursor:undefined,...changes} as Record<string,string|undefined>).filter((e):e is [string,string]=>Boolean(e[1])));return "/dashboard/pulls"+(next.size?"?"+next:"");};
 const pages=Math.max(1,Math.ceil(result.total/pageSize)),shown=[...new Set([1,page-1,page,page+1,pages])].filter(n=>n>=1&&n<=pages).sort((a,b)=>a-b);
 const suggestions:[string,string][]=[[withToken(q,"author",login),`author is ${login}`],[withToken(q,"impact","high"),"impact is high"],[withToken(q,"confidence","<3"),"confidence below 3"],[withToken(q,"status","unreviewed"),"not reviewed"],...repositories.slice(0,3).map(r=>[withToken(q,"repo",r.fullName),`repo is ${r.fullName}`] as [string,string])];
 return <>
  <Live active={catalogs.some(c=>c.job&&["queued","running"].includes(c.job.status))}/>
  <details><summary>Open PR import status</summary><p>Setup imports existing open changes without running reviews. Sync reads current metadata; provider events keep subsequent changes updated. Import covers at most 30,000 changes per repository and reports failures visibly.</p>{catalogs.map(c=><article key={c.repositoryId}><h3>{c.fullName}</h3><p className="muted repository-identity">{providerDisplay(repositories.find(r=>r._id===c.repositoryId)?.provider??null)}</p><p>{!c.supported?"Native Perforce review polling manages change discovery.":c.job?`${c.job.status} · ${c.job.processed} changes imported · ${c.job.pages} pages`:"Import has not run yet."}</p>{c.job?.error&&<p role="alert">{c.job.error}</p>}{admin&&c.supported&&<CatalogSync repositoryId={c.repositoryId} disabled={!c.enabled||Boolean(c.job&&["queued","running"].includes(c.job.status))}/>}</article>)}</details>
  <div className="pull-toolbar">
   <form className="pull-search" role="search">{filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}{filters.state&&<input type="hidden" name="state" value={filters.state}/>}{filters.size&&<input type="hidden" name="size" value={filters.size}/>}<input id="pull-search" name="q" defaultValue={q} placeholder="Search pull requests, or filter with author: repo: status: impact: confidence:>3" aria-label="Search pull requests"/></form>
   <nav className="segmented" aria-label="Pull request state">{([["open","Open"],["closed","Closed"],["merged","Merged"],["","All"]] as const).map(([value,label])=><Link key={label} href={link({state:value||undefined,q:withoutToken(q,"state")||undefined,p:undefined})} aria-current={state===value?"page":undefined}>{label}</Link>)}</nav>
  </div>
  <p className="suggestions"><span className="muted">Suggested</span>{suggestions.map(([value,label])=><Link key={label} className="chip" href={link({q:value,p:undefined})}>{label}</Link>)}{q&&<Link href={link({q:undefined,p:undefined})}>Clear</Link>}</p>
  <BulkBar/>
  <ScrollTable label="Pull requests table"><table className="pulls-table"><thead><tr><th><span className="sr-only">Select</span></th><th>Pull request</th><th>Review status</th><th>Actions</th></tr></thead><tbody>{result.page.map(pr=>{
   const repo=repositories.find(r=>r._id===pr.repositoryId),current=Boolean(pr.latest&&pr.latest.headSha===pr.headSha&&(!pr.latest.nativeP4||pr.latest.baseSha===pr.baseSha&&repo?.indexedSha===pr.baseSha)&&(pr.revisionKey===undefined||pr.latest.revisionKey===pr.revisionKey)),latest=current?pr.latest:null,risk=latest?.approvalAssessment?.risk;
   const meta=<small className="meta">#{pr.number} · {repo?.fullName} · @{pr.author} · <time dateTime={new Date(pr.updatedAt).toISOString()} title={when(pr.updatedAt)}>{ago(pr.updatedAt)}</time>{risk&&risk!=="unknown"&&<> · <span className={"impact "+risk}>{risk[0].toUpperCase()+risk.slice(1)}</span></>}</small>,title=repositoryDisplay(repo)+" #"+pr.number+": "+pr.title;
   return <tr key={pr._id}>
    <td className="row-select"><input type="checkbox" form="bulk-pulls" name="pr" value={`${pr.repositoryId}|${pr.number}|${latest?._id??""}`} aria-label={`Select #${pr.number}`}/></td>
    <td>{pr.latest?<Link className="pull-link" title={title} href={"/dashboard/pulls/"+pr.latest._id}><span>{pr.state==="merged"&&<span className="merged" aria-label="Merged">⑂ </span>}{pr.title}</span>{meta}</Link>:<a className="pull-link" title={title} href={pr.url}><span>{pr.title}</span>{meta}</a>}</td>
    <td className="review-status">{!latest?<span className={"badge "+(pr.latest?"queued":"cancelled")}>{pr.latest?"Awaiting current review":"Not reviewed"}</span>:<>{latest.reviewScore&&<strong title={latest.reviewScore.reason}>{latest.reviewScore.value}/5</strong>}{latest.reviewScore&&" · "}{latest.status!=="completed"?status(latest.status):latest.findingCount?(latest.findingCounts?severityCounts(latest.findingCounts):<>{priority({severity:latest.findingSeverity??"low"})} ×{latest.findingCount}</>):<span className="badge completed">✓ Completed</span>}</>}</td>
    <td className="row-actions"><div>{latest&&latest.findingCount?<Link className="button small" href={"/fix/"+latest._id}>Fix</Link>:null}{pr.state==="open"&&<a className="button small" href={pr.url} target="_blank" rel="noreferrer">Merge ↗</a>}{!current&&pr.state==="open"&&pr.canRequest&&<CatalogReview repositoryId={pr.repositoryId} prNumber={pr.number} revision={pr.headSha} baseRevision={pr.baseSha}/>}</div></td>
   </tr>;})}</tbody></table></ScrollTable>
  {!result.page.length&&<EmptyState title="No matching pull requests">{parsed.repo&&!tokenRepo?`No connected repository matches “${parsed.repo}”.`:"Change the search or filters, or sync open pull requests from the import status above."}</EmptyState>}
  {result.total>0&&<nav className="pager" aria-label="Pages">
   <span className="muted">Rows</span>{sizes.map(n=><Link key={n} href={link({size:String(n),p:undefined})} aria-current={n===pageSize?"page":undefined}>{n}</Link>)}
   <span className="muted">{(page-1)*pageSize+1}–{Math.min(page*pageSize,result.total)} of {result.total}{result.capped?"+":""}</span>
   {page>1&&<Link href={link({p:String(page-1)})} aria-label="Previous page">‹</Link>}
   {shown.map((n,i)=><span key={n}>{i>0&&n-shown[i-1]>1&&"… "}<Link href={link({p:String(n)})} aria-current={n===page?"page":undefined}>{n}</Link></span>)}
   {page<pages&&<Link href={link({p:String(page+1)})} aria-label="Next page">›</Link>}
  </nav>}
  {result.capped&&<p className="muted">Showing the newest 1,000 matching pull requests. Narrow the search to see older ones.</p>}
  <PullKeys/>
 </>;
}
