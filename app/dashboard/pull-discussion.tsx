import Link from "next/link";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { ReviewMarkdown } from "./markdown";
import { ThreadActions } from "./pull-list-client";
import { ago, when } from "./sections/shared";

// The pull request's conversation on GitHub: comments, reviews and review threads, with Greptile's
// filters (bots, resolved, collapse). Replies and resolving go to GitHub as the developer.
export async function PullDiscussion({ token, pullRequestId, filters, canAct }: { token: string; pullRequestId: Id<"pullRequests">; filters: Record<string, string | undefined>; canAct: boolean }) {
  let items;
  try { items = await backend().action(api.pullInsights.discussion, { token, pullRequestId }); }
  catch { return <p role="alert">The conversation could not be loaded from the provider. Check the repository connection and try again.</p>; }
  if (!items) return <p className="muted">The conversation is shown for GitHub repositories; open the pull request on its provider to read it.</p>;
  const bots = filters.bots !== "0", resolved = filters.resolved !== "0", collapsed = filters.collapse === "1";
  const toggle = (key: string, value: string | undefined) => "?" + new URLSearchParams(Object.entries({ ...filters, tab: "discussion", [key]: value } as Record<string, string | undefined>).filter((e): e is [string, string] => Boolean(e[1])));
  const shown = items.filter((i) => (bots || !i.bot) && (resolved || i.kind !== "thread" || !i.resolved));
  const time = (at: string) => <time dateTime={at} title={when(Date.parse(at))}>{ago(Date.parse(at))}</time>;
  return <section aria-label="Discussion" className="discussion">
    <nav className="segmented" aria-label="Discussion filters">
      <Link href={toggle("bots", bots ? "0" : undefined)} aria-current={bots ? undefined : "page"}>Exclude bots</Link>
      <Link href={toggle("resolved", resolved ? "0" : undefined)} aria-current={resolved ? undefined : "page"}>Hide resolved</Link>
      <Link href={toggle("collapse", collapsed ? undefined : "1")} aria-current={collapsed ? "page" : undefined}>Collapse all</Link>
    </nav>
    {!shown.length && <p className="muted">No comments{items.length ? " match these filters" : " yet"}.</p>}
    <ol className="timeline">{shown.map((item, i) => <li key={i}>
      <details open={!collapsed && !(item.kind === "thread" && item.resolved)}>
        <summary><span className="avatar-letter" aria-hidden>{item.author[0]?.toUpperCase()}</span><strong>@{item.author}</strong>{item.bot && <span className="badge">bot</span>} {item.kind === "review" ? <>{item.state.toLowerCase().replaceAll("_", " ")}</> : item.kind === "thread" ? <>on <code>{item.path}{item.line ? ":" + item.line : ""}</code>{item.resolved && <span className="badge resolved">resolved</span>}</> : "commented"} · {time(item.createdAt)} · <a href={item.url} target="_blank" rel="noreferrer">GitHub ↗</a></summary>
        {item.kind === "thread" ? <>
          {item.comments.map((c, j) => <div key={j} className="thread-comment"><p className="muted">@{c.author} · {time(c.createdAt)}</p><ReviewMarkdown>{c.body}</ReviewMarkdown></div>)}
          {canAct && <ThreadActions pullRequestId={pullRequestId} threadId={item.threadId} replyTo={item.replyTo} resolved={item.resolved} />}
        </> : item.body.trim() && <ReviewMarkdown>{item.body}</ReviewMarkdown>}
      </details>
    </li>)}</ol>
  </section>;
}
