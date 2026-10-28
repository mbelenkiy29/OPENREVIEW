import Link from "next/link";
import { repositoryDisplay } from "../../../src/provider-display";
import { assignIssue, commentOnIssue, setIssueStatus } from "../actions";
import { ScrollTable } from "../scroll-table";
import { FixPullRequestButton } from "../fix-pr-button";
import { Locked } from "../locked";
import { FindingBody } from "./findings";
import { status, priority, when, Empty } from "./shared";
import type { DashboardContext } from "../load";

const statusLabels = { open: "Open", in_progress: "In progress", resolved: "Resolved", wont_fix: "Won’t fix", false_positive: "False positive" } as const;
const prState = (state: string | undefined, merged: boolean) => merged ? "merged" : state ?? "unknown";

// Issues inbox: one ticket per problem, grouped across pull requests (convex/issues.ts).
export function IssuesSection({ ctx }: { ctx: DashboardContext }) {
  return ctx.issue ? <IssueDetail ctx={ctx} /> : <IssueList ctx={ctx} />;
}

function IssueList({ ctx }: { ctx: DashboardContext }) {
  const { data, filters, issuesPage, repoName } = ctx;
  const issues = issuesPage?.page ?? [];
  const filtered = ["repository", "status", "assignee", "severity", "category"].some((k) => filters[k]);
  return <>
    <form method="get" className="toolbar">
      {filters.team !== undefined && <input type="hidden" name="team" value={filters.team} />}
      <label>Repository<select name="repository" defaultValue={filters.repository ?? ""}><option value="">All repositories</option>{data.repositories.map((r) => <option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}</select></label>
      <label>Status<select name="status" defaultValue={filters.status ?? "active"}><option value="active">Open and in progress</option>{Object.entries(statusLabels).map(([v, label]) => <option key={v} value={v}>{label}</option>)}<option value="all">All</option></select></label>
      <label>Assignee<select name="assignee" defaultValue={filters.assignee ?? ""}><option value="">Anyone</option><option value="me">Me</option><option value="none">Unassigned</option></select></label>
      <label>Severity<select name="severity" defaultValue={filters.severity ?? ""}><option value="">All</option>{["critical", "high", "medium", "low"].map((v) => <option key={v}>{v}</option>)}</select></label>
      <label>Category<select name="category" defaultValue={filters.category ?? ""}><option value="">All</option>{["security", "correctness", "data", "compatibility", "testing", "performance", "rules"].map((v) => <option key={v}>{v}</option>)}</select></label>
      <button>Filter issues</button>
      <Link href="/dashboard/analytics/issues?category=security">Security issues</Link>
      {filtered && <Link href="/dashboard/analytics/issues">Reset filters</Link>}
    </form>
    {!issues.length ? <Empty title={filtered ? "No issues match these filters" : "No open issues"} text="Every verified finding becomes an issue. The same problem on several pull requests is one issue; fixing it, closing the pull request or marking it resolved closes it." />
      : <ScrollTable label="Issues table">
        <table>
          <thead><tr><th>#</th><th>Issue</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Latest</th><th>Last seen</th><th>Fix</th></tr></thead>
          <tbody>
            {issues.map((i) => <tr key={i._id}>
              <td className="mono">#{i.number}</td>
              <td><Link href={`/dashboard/analytics/issues/${i.number}`}>{i.title}</Link><br /><span className="muted">{repoName(i.repositoryId)} · {i.filePath}:{i.startLine}</span></td>
              <td>{priority(i)}</td>
              <td>{status(i.status)}{i.mergedAt && ["open", "in_progress"].includes(i.status) && <>{" "}<span className="badge high" title="The pull request merged while this issue was open">merged</span></>}</td>
              <td>{i.assignee ? `@${i.assignee}` : <span className="muted">Unassigned</span>}</td>
              <td><Link href={`/dashboard/pulls/${i.reviewId}`}>PR #{i.prNumber}</Link> <span className="muted">{prState(i.prState, Boolean(i.mergedAt))}</span></td>
              <td>{when(i.lastSeenAt)}</td>
              <td>{i.fixPullRequestUrl ? <a href={i.fixPullRequestUrl} target="_blank" rel="noreferrer">Fix PR</a> : <span className="muted">None</span>}</td>
            </tr>)}
          </tbody>
        </table>
      </ScrollTable>}
    {issuesPage && !issuesPage.isDone && <Link className="button" href={`/dashboard/analytics/issues?${new URLSearchParams(Object.entries({ ...filters, cursor: issuesPage.continueCursor }).filter((e): e is [string, string] => typeof e[1] === "string")).toString()}`}>Next issues</Link>}
  </>;
}

function IssueDetail({ ctx }: { ctx: DashboardContext }) {
  const { data, locked, repoName } = ctx;
  const { issue, finding, occurrences, events, members, canWrite } = ctx.issue!;
  const repo = data.repositories.find((r) => r._id === issue.repositoryId);
  return <>
    <p><Link href="/dashboard/analytics/issues">All issues</Link></p>
    <section className="finding" aria-labelledby="issue-title">
      <div className="row">
        <h2 id="issue-title"><span className="mono muted">#{issue.number}</span> {issue.title}</h2>
        <div>{priority(issue)} {status(issue.status)}{issue.mergedAt && ["open", "in_progress"].includes(issue.status) && <>{" "}<span className="badge high">merged</span></>}</div>
      </div>
      <p className="muted">{repoName(issue.repositoryId)} · {finding.filePath}:{finding.startLine} · first seen {when(issue.firstSeenAt)} · last seen {when(issue.lastSeenAt)} · {issue.assignee ? `assigned to @${issue.assignee}` : "unassigned"}</p>
      {canWrite && <div className="row">
        <form action={setIssueStatus} className="toolbar">
          <input type="hidden" name="issueId" value={issue._id} />
          <label>Status<select name="status" defaultValue={issue.status}>{Object.entries(statusLabels).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
          <label>Reason (optional)<input name="comment" maxLength={5000} /></label>
          <button>Update status</button>
        </form>
        <form action={assignIssue} className="toolbar">
          <input type="hidden" name="issueId" value={issue._id} />
          <label>Assignee<select name="assigneeId" defaultValue={issue.assigneeId ?? ""}><option value="">Unassigned</option>{members.map((m) => <option key={m.userId} value={m.userId}>@{m.login}</option>)}</select></label>
          <button>Assign</button>
        </form>
      </div>}
      {canWrite && <p className="muted">Won’t fix, false positive and resolved also apply to every open occurrence, so pull request threads and learned preferences follow.</p>}
    </section>
    <section aria-labelledby="issue-latest">
      <h2 id="issue-latest">Latest occurrence: PR #{finding.prNumber}</h2>
      <FindingBody f={finding} ctx={ctx} />
      {issue.fixPullRequestUrl && <p>Fix pull request: <a href={issue.fixPullRequestUrl} target="_blank" rel="noreferrer">{issue.fixPullRequestUrl.replace(/^https:\/\/github\.com\//, "")}</a></p>}
      {finding.canFix && repo && !repo.connectionId && <Locked feature="fix.pullRequests" locked={locked}><FixPullRequestButton findingId={finding._id} /></Locked>}
    </section>
    <section aria-labelledby="issue-occurrences">
      <h2 id="issue-occurrences">Occurrences</h2>
      <ScrollTable label="Occurrences table">
        <table>
          <thead><tr><th>Pull request</th><th>Pull request state</th><th>Finding</th><th>Found</th></tr></thead>
          <tbody>{occurrences.map((o) => <tr key={o._id}><td><Link href={`/dashboard/pulls/${o.reviewId}`}>PR #{o.prNumber}</Link></td><td>{prState(o.prState, Boolean(issue.mergedAt) && o._id === issue.latestFindingId)}</td><td>{status(o.status)}</td><td>{when(o.createdAt)}</td></tr>)}</tbody>
        </table>
      </ScrollTable>
    </section>
    <section aria-labelledby="issue-activity">
      <h2 id="issue-activity">Activity</h2>
      <ol className="issue-activity">
        {events.map((e) => <li key={e._id}><span className="muted">{when(e.createdAt)}{e.actor ? ` · @${e.actor}` : " · OpenReview"}</span><p>{e.detail}</p></li>)}
      </ol>
      {canWrite && <form action={commentOnIssue} className="form-grid">
        <input type="hidden" name="issueId" value={issue._id} />
        <label>Comment<textarea name="body" required maxLength={5000} rows={3} /></label>
        <button>Add comment</button>
      </form>}
    </section>
  </>;
}
