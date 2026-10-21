import Link from "next/link";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { repositoryDisplay } from "../../src/provider-display";
import { ReviewMarkdown } from "./markdown";
import { ChatStream } from "./chat-stream";
import { askChat, deleteChatThread } from "./actions";
import { ProposedAction } from "./pull-list-client";

// Codebase chat: private threads over indexed repositories; answers cite file:line at the indexed revision.
export async function ChatPanel({ token, organizationId, repositories, filters }: { token: string; organizationId: Id<"organizations">; repositories: Doc<"repositories">[]; filters: Record<string, string | undefined> }) {
  const threads = await backend().query(api.chat.threads, { token, organizationId });
  const threadId = threads.find((t) => t._id === filters.thread)?._id;
  const thread = threadId ? await backend().query(api.chat.thread, { token, threadId }) : null;
  const indexed = repositories.filter((r) => r.indexedSha);
  const selected = new Set<string>(thread?.repositoryIds ?? (filters.repository ? [filters.repository] : indexed.slice(0, 1).map((r) => r._id)));
  const busy = thread?.messages.some((m) => m.status === "pending" || m.status === "running");
  // Chat with PR: a new thread from a pull request page, or an existing thread about one.
  const pullId = thread ? thread.pullRequestId : filters.pull;
  const pull = pullId ? await backend().query(api.pulls.get, { token, pullRequestId: pullId as Id<"pullRequests"> }).catch(() => null) : null;
  const name = (id: string) => repositories.find((r) => r._id === id);
  return <div className="chat-layout">
    <nav className="chat-threads" aria-label="Chat threads">
      <Link className="button" href="/dashboard/chat">New chat</Link>
      {threads.length === 0 ? <p className="muted">No conversations yet.</p> : <ul>{threads.map((t) => <li key={t._id}><Link href={`/dashboard/chat?thread=${t._id}`} aria-current={t._id === threadId ? "page" : undefined}>{t.title}{t.origin === "api" && <span className="muted"> · API</span>}</Link></li>)}</ul>}
    </nav>
    <div className="chat-main">
      {pull && <section className="status-card" aria-label="Pull request"><span>About <strong>#{pull.number} {pull.title}</strong></span><div className="actions"><Link className="button small" href={pull.latest ? `/dashboard/pulls/${pull.latest._id}` : `/dashboard/pulls/pr/${pull._id}`}>Back to the pull request</Link></div></section>}
      {pull && !thread && indexed.some((r) => r._id === pull.repositoryId) && <form action={askChat} className="chat-suggestions"><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="pullRequestId" value={pull._id} /><input type="hidden" name="repositoryIds" value={pull.repositoryId} />{["Walk me through what changed", "Explain the findings and which ones matter most", "What edge cases should I test for this change?"].map((q) => <button key={q} name="question" value={q} className="small">{q}</button>)}</form>}
      <p className="muted">Ask questions about up to five indexed repositories. Answers are investigated with read-only code tools, and every claim cites lines at the repository&apos;s indexed revision. Threads are visible only to you.</p>
      {thread && <section aria-label="Conversation">
        {thread.messages.map((m) => <article key={m._id} className={`chat-message ${m.role}`}>
          <p className="muted">{m.role === "user" ? "You" : "OpenReview"} · {new Date(m.createdAt).toLocaleString()}{m.role === "assistant" && m.status !== "completed" && <> · <span className={`badge ${m.status}`}>{m.status}</span></>}</p>
          {m.role === "user" ? <p className="chat-question">{m.content}</p> : m.status === "completed" ? <>
            <ReviewMarkdown>{m.content}</ReviewMarkdown>
            {m.citations.length > 0 && <ol className="chat-citations" aria-label="Citations">{m.citations.map((c, i) => <li key={i} id={`cite-${m._id}-${i + 1}`}>
              {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer">{c.repository}:{c.filePath}:{c.startLine}{c.endLine > c.startLine ? `–${c.endLine}` : ""}</a> : <code>{c.repository}:{c.filePath}:{c.startLine}{c.endLine > c.startLine ? `–${c.endLine}` : ""}</code>}
              <span className="muted"> @ {c.revision.slice(0, 12)}</span>
              <pre>{c.quote}</pre>
            </li>)}</ol>}
            {m.proposal && pull && <ProposedAction pullRequestId={pull._id} head={pull.headSha} proposal={m.proposal} />}
            {m.limits.map((l) => <p key={l} className="muted">{l}</p>)}
          </> : m.status === "failed" ? <p role="alert">{m.error ?? "The answer failed."} {m.limits.join(" ")}</p> : <ChatStream messageId={m._id} initial={m.events.map((e) => ({ kind: e.kind, text: e.text }))} />}
        </article>)}
      </section>}
      {indexed.length === 0 ? <section><h2>No indexed repositories</h2><p>Enable and index a repository in Settings → Repositories to chat about its code.</p></section> :
        <form action={askChat} className="form-grid chat-form">
          <input type="hidden" name="organizationId" value={organizationId} />
          {thread && <input type="hidden" name="threadId" value={thread._id} />}
          {pull && !thread && <input type="hidden" name="pullRequestId" value={pull._id} />}
          <fieldset className="wide"><legend>Repositories (up to 5)</legend>{indexed.map((r) => <label className="check" key={r._id}><input type="checkbox" name="repositoryIds" value={r._id} defaultChecked={selected.has(r._id)} /> {repositoryDisplay(r)} <span className="muted">@ {r.indexedSha!.slice(0, 12)}</span></label>)}</fieldset>
          <label className="wide">{thread ? "Follow-up question" : "Question"}<textarea name="question" required minLength={2} maxLength={4000} rows={3} placeholder="Where is the checkout total computed, and which callers depend on it?" /></label>
          <button disabled={busy}>{busy ? "Answering…" : "Ask"}</button>
        </form>}
      {thread && <form action={deleteChatThread}><input type="hidden" name="threadId" value={thread._id} /><button className="danger">Delete this conversation</button></form>}
      {thread && thread.repositoryIds.length > 0 && <p className="muted">Repositories in this thread: {thread.repositoryIds.map((id) => { const r = name(id); return r ? repositoryDisplay(r) : "unavailable"; }).join(", ")}</p>}
    </div>
  </div>;
}
