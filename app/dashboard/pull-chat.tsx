import Link from "next/link";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { askChat } from "./actions";
import { ChatMessages } from "./chat";
import { ChatContext, ChatPermissionChip } from "./pull-list-client";
import { Icon, type IconName } from "../ui/icons";

const starters: [IconName, string, string][] = [["code", "Walk me through what changed", "Walk me through what changed in this pull request, in reading order."], ["shieldCheck", "Explain the cleared risks", "Explain the risks the review considered and cleared, and why each one is not a problem."], ["magnifyingGlass", "Investigate the code", "Investigate the code this pull request touches and point out anything the review may have missed."]];
// Greptile's "Chat with PR" panel beside the pull request: this PR's threads, starter actions, answers
// with citations and suggested actions, a question box with Select context and the permission chip.
export async function PullChat({ token, organizationId, pull, repository, filters, here }: { token: string; organizationId: Id<"organizations">; pull: { _id: string; repositoryId: Id<"repositories">; headSha: string }; repository?: Doc<"repositories">; filters: Record<string, string | undefined>; here: string }) {
  const threads = (await backend().query(api.chat.threads, { token, organizationId })).filter((t) => t.pullRequestId === pull._id);
  const chosen = filters.chatThread === "new" ? undefined : threads.find((t) => t._id === filters.chatThread) ?? threads[0];
  const thread = chosen ? await backend().query(api.chat.thread, { token, threadId: chosen._id }) : null;
  const busy = thread?.messages.some((m) => m.status === "pending" || m.status === "running");
  const tab = filters.tab ? `&tab=${encodeURIComponent(filters.tab)}` : "";
  const link = (extra: string) => `${here}?chat=1${tab}${extra}`;
  const hidden = <><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="repositoryIds" value={pull.repositoryId} /><input type="hidden" name="return" value={here} /><input type="hidden" name="tab" value={filters.tab ?? ""} />{thread ? <input type="hidden" name="threadId" value={thread._id} /> : <input type="hidden" name="pullRequestId" value={pull._id} />}</>;
  return <aside className={"pull-chat" + (filters.chatWide ? " wide" : "")} aria-label="Chat with PR">
    <header className="pull-chat-head">
      <h2>Chat with PR</h2>
      <span className="pull-chat-tools">
        <details className="chat-history"><summary aria-label="Chat history" title="Chat history"><Icon name="clockCounterClockwise" /></summary><div className="menu">{threads.length ? threads.map((t) => <Link key={t._id} className="menu-item" href={link(`&chatThread=${t._id}`)} aria-current={t._id === thread?._id ? "page" : undefined}><span>{t.title}</span></Link>) : <span className="muted">No earlier chats about this pull request.</span>}</div></details>
        <Link href={link("&chatThread=new")} aria-label="New chat" title="New chat"><Icon name="plus" /></Link>
        <Link href={link(`${thread ? `&chatThread=${thread._id}` : ""}${filters.chatWide ? "" : "&chatWide=1"}`)} aria-label={filters.chatWide ? "Narrow chat" : "Expand chat"} title={filters.chatWide ? "Narrow chat" : "Expand chat"}><Icon name={filters.chatWide ? "arrowsIn" : "arrowsOut"} /></Link>
        <Link href={here + (filters.tab ? `?tab=${encodeURIComponent(filters.tab)}` : "")} aria-label="Close chat" title="Close chat (Shift+C)"><Icon name="x" /></Link>
      </span>
    </header>
    <div className="pull-chat-body">
      {!repository?.indexedSha ? <p className="muted">Chat reads the repository index. Index {repository?.fullName ?? "this repository"} in Repositories to ask about this pull request.</p>
        : thread ? <ChatMessages messages={thread.messages} threadId={thread._id} pull={pull} />
        : <div className="chat-empty">
          <span className="chat-empty-mark"><Icon name="chatCircleText" /></span>
          <h3>Go deeper into this PR</h3>
          <p className="muted">Understand a change, follow the code, or ask why a risk was cleared.</p>
          <p className="muted chat-actions-label">Actions</p>
          <div className="chat-starters">{starters.map(([icon, label, question]) => <form key={label} action={askChat}>{hidden}<input type="hidden" name="question" value={question} /><button><Icon name={icon} />{label}</button></form>)}</div>
        </div>}
    </div>
    {repository?.indexedSha && <form action={askChat} className="pull-chat-form">
      {hidden}
      <textarea name="question" required minLength={2} maxLength={4000} rows={2} placeholder="Ask anything about this PR…" aria-label="Question about this PR" />
      <span className="pull-chat-controls"><ChatContext />{thread && <ChatPermissionChip threadId={thread._id} />}<button className="send" disabled={busy} aria-label="Send question" title="Send"><Icon name={busy ? "circleNotch" : "arrowUp"} /></button></span>
    </form>}
  </aside>;
}
