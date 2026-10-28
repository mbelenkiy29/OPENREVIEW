"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { autoRuns, routineActions, type ChatPermission } from "../../src/pull-chat";
import { useRouter } from "next/navigation";
import { bulkFixPrompt, bulkReview, markFileReviewed, pullAction } from "./actions";
import { Icon } from "../ui/icons";
import { Dialog, DialogClose, useCloseDialog } from "../ui/dialog";

const rowBoxes = () => [...document.querySelectorAll<HTMLInputElement>('input[form="bulk-pulls"]')];
const selected = () => rowBoxes().filter((box) => box.checked);
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

// Greptile's bulk bar: it appears above the table while rows are selected (the checkboxes join this form
// through form="bulk-pulls"), with a dark "Rerun (N)". Reruns clear the selection; results show as a toast.
export function BulkBar() {
  const [count, setCount] = useState(0);
  const [state, action, pending] = useActionState(bulkReview, {});
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    const update = () => setCount(selected().length);
    document.addEventListener("change", update);
    return () => document.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (state.saved) { selected().forEach((box) => { box.checked = false; }); document.dispatchEvent(new Event("change")); }
    if (state.saved || state.error) setNote({ text: (state.saved ?? state.error)!, error: !state.saved });
  }, [state]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 5000); return () => clearTimeout(t); }, [note]);
  const noun = `pull ${count === 1 ? "request" : "requests"}`;
  return <>
    <form id="bulk-pulls" className="bulk-bar" action={action} hidden={!count}>
      <span className="bulk-count" aria-live="polite">{count} selected</span>
      <button type="button" className="ghost" onClick={async () => {
        const ids = selected().map((box) => box.value.split("|")[2]).filter(Boolean);
        try { const prompt = await bulkFixPrompt(ids); if (!prompt) return setNote({ text: "No fixable findings in the selection" }); await navigator.clipboard.writeText(prompt); setNote({ text: "Fix prompts copied" }); }
        catch { setNote({ text: "Copy failed", error: true }); }
      }}><Icon name="copy" />Copy fix prompts</button>
      <Dialog size="confirm" triggerClassName="primary rerun" trigger={pending ? "Starting reviews…" : `Rerun (${count})`} title={`Rerun ${count} ${noun}?`}>
        <div className="modal-body"><p>OpenReview reviews the current revision of each selected {noun} again. Each review uses model credits.</p></div>
        <div className="modal-footer"><DialogClose>Cancel</DialogClose><RerunButton /></div>
      </Dialog>
    </form>
    {note && <div className={`toast ${note.error ? "error" : "success"}`} role={note.error ? "alert" : "status"}><span>{note.text}</span><button type="button" className="ghost small" aria-label="Dismiss" onClick={() => setNote(null)}><Icon name="x" /></button></div>}
  </>;
}
// Submits the bulk form from the confirm dialog (rendered into <body>, so it names the form).
function RerunButton() {
  const close = useCloseDialog();
  return <button type="submit" form="bulk-pulls" className="primary" onClick={close}>Rerun</button>;
}

// J/K move, Enter opens, Space selects, ⌘A selects all, G re-reviews the selection, / searches.
export function PullKeys({ hints }: { hints: [string, string][] }) {
  useEffect(() => {
    let focused = -1;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.altKey) return;
      const rows = [...document.querySelectorAll<HTMLTableRowElement>(".pulls-table tbody tr")];
      const row = rows[focused];
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "a") {
        e.preventDefault();
        const boxes = rows.map((r) => r.querySelector<HTMLInputElement>('input[type="checkbox"]')).filter((b): b is HTMLInputElement => !!b);
        const all = boxes.every((b) => b.checked);
        boxes.forEach((b) => { b.checked = !all; });
        document.dispatchEvent(new Event("change"));
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      if (key === "/") { e.preventDefault(); document.querySelector<HTMLInputElement>("#pull-search")?.focus(); return; }
      if (key === "j" || key === "k") {
        e.preventDefault();
        focused = Math.max(0, Math.min(rows.length - 1, focused + (key === "j" ? 1 : -1)));
        rows.forEach((r, i) => r.toggleAttribute("data-focused", i === focused));
        rows[focused]?.scrollIntoView({ block: "nearest" });
      } else if (key === "enter" && row) row.querySelector<HTMLAnchorElement>(".pull-link")?.click();
      else if (key === " " && row) { e.preventDefault(); row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click(); }
      else if (key === "g") {
        if (!selected().length && row) row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
        if (selected().length) document.querySelector<HTMLButtonElement>('#bulk-pulls [aria-haspopup="dialog"]')?.click();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return <KeyFooter hints={hints} />;
}

const allShortcuts: [string, string][] = [["J K", "next / previous"], ["Enter", "open"], ["Space", "select"], ["⌘ A", "select all"], ["G", "re-review"], ["/", "search"], ["H L", "switch tabs"], ["⌘ B", "sidebar"], ["M", "merge"], ["A", "approve"], ["X", "request changes"], ["C", "close"], ["O", "reopen"], ["D", "draft / ready"], ["U", "update branch"], ["F", "fix"], ["⇧ C", "chat with PR"], ["⇧ S", "select chat context"]];
// Greptile's pinned "Keyboard Shortcuts" bar: the keys for this page, "View all", and a dismiss button.
function KeyFooter({ hints }: { hints: [string, string][] }) {
  const [hidden, setHidden] = useState(false), [all, setAll] = useState(false);
  useEffect(() => { try { setHidden(localStorage.getItem("openreview:key-footer") === "hidden"); } catch { /* storage blocked: show it */ } }, []);
  if (hidden) return null;
  const keys = (k: string) => k.split(" ").map((x) => <kbd key={x}>{x}</kbd>);
  return (
    <footer className="key-footer" aria-label="Keyboard shortcuts">
      {all && <div className="key-panel" role="dialog" aria-label="All keyboard shortcuts">{allShortcuts.map(([k, label]) => <span key={label}>{keys(k)} {label}</span>)}</div>}
      <span className="key-title">Keyboard Shortcuts</span>
      {hints.map(([k, label]) => <span key={label} className="key-hint">{keys(k)} {label}</span>)}
      <button type="button" className="link-button" onClick={() => setAll(!all)} aria-expanded={all}>View all</button>
      <button type="button" className="key-close" aria-label="Hide keyboard shortcuts" onClick={() => { setHidden(true); try { localStorage.setItem("openreview:key-footer", "hidden"); } catch { /* not remembered */ } }}><Icon name="x" /></button>
    </footer>
  );
}

// Header checkbox that selects or clears every row on the page (⌘A does the same); it shows all, some or none.
export function SelectAll() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const sync = () => { const on = selected().length, all = rowBoxes().length; if (ref.current) { ref.current.checked = on > 0 && on === all; ref.current.indeterminate = on > 0 && on < all; } };
    document.addEventListener("change", sync);
    return () => document.removeEventListener("change", sync);
  }, []);
  return <input ref={ref} type="checkbox" aria-label="Select all pull requests on this page" onChange={(e) => { const on = e.currentTarget.checked; rowBoxes().forEach((b) => { b.checked = on; }); document.dispatchEvent(new Event("change")); }} />;
}

// Copies the fix prompt for one review's findings (the list's "Copy Fix" action).
export function CopyFix({ reviewId }: { reviewId: string }) {
  const [label, setLabel] = useState("Copy Fix");
  return <button type="button" className="text-action" onClick={async () => {
    try { const prompt = await bulkFixPrompt([reviewId]); if (!prompt) return setLabel("Nothing to fix"); await navigator.clipboard.writeText(prompt); setLabel("Copied"); }
    catch { setLabel("Copy failed"); }
  }}><Icon name={label === "Copied" ? "check" : "copy"} /> {label}</button>;
}

// Rows-per-page box at the left of the pager.
export function PageSize({ value, options }: { value: number; options: number[] }) {
  const router = useRouter();
  return <select className="page-size" aria-label="Rows per page" value={value} onChange={(e) => { const url = new URL(location.href); url.searchParams.set("size", e.currentTarget.value); url.searchParams.delete("p"); router.push(url.pathname + url.search); }}>{options.map((n) => <option key={n} value={n}>{n}</option>)}</select>;
}

// On an open pull request: ⌘B collapses the sidebar (remembered in this browser), J/K open the next or
// previous pull request in it, H/L switch tabs, and action keys press the matching PullActions button.
export function SidebarKeys() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".pull-detail");
    try { if (localStorage.getItem("openreview:pull-sidebar") === "closed") root?.setAttribute("data-collapsed", ""); } catch { /* storage blocked: start open */ }
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.altKey) return;
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "b") { e.preventDefault(); toggle(root); return; }
      if (e.metaKey || e.ctrlKey) return;
      if (key === "/") { e.preventDefault(); document.querySelector<HTMLInputElement>(".pull-sidebar input[name=find]")?.focus(); return; }
      if (key === "f") return document.querySelector<HTMLElement>(".status-card .fix-control button:not(:disabled)")?.click();
      if (e.shiftKey && key === "c") return document.querySelector<HTMLElement>("[data-chat-toggle]")?.click();
      if (e.shiftKey && key === "s") return document.querySelector<HTMLElement>("[data-chat-context]")?.click();
      const step = key === "j" || key === "l" ? 1 : key === "k" || key === "h" ? -1 : 0;
      if (!step) return document.querySelector<HTMLElement>(`.pull-actions [data-key="${key}"]:not(:disabled)`)?.click();
      const links = [...document.querySelectorAll<HTMLAnchorElement>(key === "j" || key === "k" ? ".pull-sidebar ol a" : ".tabs a")];
      links[links.findIndex((a) => a.getAttribute("aria-current") === "page") + step]?.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return <>
    <button type="button" className="sidebar-toggle" aria-label="Toggle pull request list (⌘B)" title="Toggle sidebar (⌘B)" onClick={() => toggle(document.querySelector(".pull-detail"))}><Icon name="sidebarSimple" /></button>
    <KeyFooter hints={[["J K", "switch PR"], ["H L", "switch tabs"], ["⇧ C", "chat"], ["M", "merge"], ["F", "fix"], ["/", "search"], ["⌘ B", "sidebar"]]} />
  </>;
}
function toggle(root: HTMLElement | null) {
  const closed = root?.toggleAttribute("data-collapsed");
  try { localStorage.setItem("openreview:pull-sidebar", closed ? "closed" : "open"); } catch { /* not remembered */ }
}

// Merge, review, close, draft and branch actions on an open pull request, sent as the developer:
// Greptile's Merge button with a ▾ menu for the rest.
// Keys: M merge, A approve, X request changes, C close, O reopen, D draft/ready, U update branch.
export function PullActions({ pullRequestId, head, state, draft }: { pullRequestId: string; head: string; state: string; draft?: boolean }) {
  const [result, action, pending] = useActionState(pullAction, {});
  const ask = (message: string) => (e: React.MouseEvent) => { if (!confirm(message)) e.preventDefault(); };
  return (
    <form className="pull-actions" action={action}>
      <input type="hidden" name="pullRequestId" value={pullRequestId} />
      <input type="hidden" name="head" value={head} />
      {state === "open" ? <span className="merge-group">
        <button name="action" value="merge" data-key="m" className="primary" disabled={pending || draft} title={draft ? "Draft pull requests cannot be merged" : "Merge (M)"} onClick={ask("Merge this pull request on GitHub as you?")}><Icon name="gitMerge" /> Merge <kbd>M</kbd></button>
        <details className="action-menu">
          <summary aria-label="More pull request actions" data-key="x"><Icon name="caretDown" /></summary>
          <div className="menu">
            <label>Merge method<select name="method" defaultValue="squash"><option value="squash">Squash and merge</option><option value="merge">Create a merge commit</option><option value="rebase">Rebase and merge</option></select></label>
            <textarea name="body" rows={3} aria-label="Review comment" placeholder="Comment (required to request changes)" />
            <hr />
            <button name="action" value="approve" data-key="a" className="menu-item" disabled={pending} onClick={ask("Approve this pull request on GitHub as you?")}><span>Approve</span> <kbd>A</kbd></button>
            <button name="action" value="request_changes" className="menu-item" disabled={pending}><span>Request changes</span> <kbd>X</kbd></button>
            <button name="action" value="comment" className="menu-item" disabled={pending}><span>Comment</span></button>
            <button name="action" value={draft ? "ready" : "draft"} data-key="d" className="menu-item" disabled={pending} onClick={ask(draft ? "Mark this pull request ready for review on GitHub?" : "Convert this pull request to a draft on GitHub?")}><span>{draft ? "Ready for review" : "Convert to draft"}</span> <kbd>D</kbd></button>
            <button name="action" value="update_branch" data-key="u" className="menu-item" disabled={pending} onClick={ask("Update this branch with its base branch on GitHub?")}><span>Update branch</span> <kbd>U</kbd></button>
            <hr />
            <button name="action" value="close" data-key="c" className="menu-item danger" disabled={pending} onClick={ask("Close this pull request on GitHub?")}><span>Close pull request</span> <kbd>C</kbd></button>
          </div>
        </details>
      </span> : state === "closed" && <button name="action" value="reopen" data-key="o" disabled={pending}>Reopen <kbd>O</kbd></button>}
      {pending && <span role="status" className="muted">Working…</span>}
      {result.error && <span role="alert">{result.error}</span>}
      {result.saved && <span role="status">{result.saved}</span>}
    </form>
  );
}

// Reply to and resolve a review thread on GitHub as the developer.
export function ThreadActions({ pullRequestId, threadId, replyTo, resolved }: { pullRequestId: string; threadId: string; replyTo?: number; resolved: boolean }) {
  const [result, action, pending] = useActionState(pullAction, {});
  return (
    <form className="thread-actions" action={action}>
      <input type="hidden" name="pullRequestId" value={pullRequestId} />
      <input type="hidden" name="threadId" value={threadId} />
      {replyTo !== undefined && <><input type="hidden" name="commentId" value={replyTo} /><textarea name="body" rows={2} aria-label="Reply" placeholder="Reply…" /><button name="action" value="reply" className="small" disabled={pending}>Reply</button></>}
      <button name="action" value={resolved ? "unresolve" : "resolve"} className="small" disabled={pending}>{resolved ? "Unresolve conversation" : "Resolve conversation"}</button>
      {result.error && <span role="alert">{result.error}</span>}
      {result.saved && <span role="status">{result.saved}</span>}
    </form>
  );
}

// The developer's own "Reviewed" mark on a changed file (cleared by a new head).
export function ReviewedToggle({ reviewId, path, reviewed }: { reviewId: string; path: string; reviewed: boolean }) {
  const [checked, setChecked] = useState(reviewed);
  return <input type="checkbox" checked={checked} aria-label={`Reviewed ${path}`} title="Reviewed" onChange={async (e) => { const next = e.currentTarget.checked; setChecked(next); try { await markFileReviewed(reviewId, path, next); } catch { setChecked(!next); } }} />;
}

const proposalLabels: Record<string, string> = { approve: "Approve the pull request", request_changes: "Request changes", comment: "Post a comment", merge: "Merge (squash)", close: "Close the pull request", reopen: "Reopen the pull request", ready: "Mark ready for review", update_branch: "Update the branch" };
// Per-chat permission state (Greptile's shield chip), kept in this browser only.
const store = (key: string) => ({ get: () => { try { return localStorage.getItem(key); } catch { return null; } }, set: (value: string) => { try { localStorage.setItem(key, value); } catch { /* not remembered */ } } });
const permissionOf = (threadId: string) => ({ mode: (store(`openreview:chat-perm:${threadId}`).get() ?? "ask") as ChatPermission, allowed: JSON.parse(store(`openreview:chat-allow:${threadId}`).get() ?? "[]") as string[], since: Number(store(`openreview:chat-perm-at:${threadId}`).get() ?? Infinity) });
const raised = (threadId: string) => { store(`openreview:chat-perm-at:${threadId}`).set(String(Date.now())); window.dispatchEvent(new Event("openreview:chat-permission")); };
// A pull request action the chat agent suggested, pinned to the head it was suggested at. It waits for
// Approve unless it is the newest suggestion and came after this chat's permission was raised to allow it.
export function ProposedAction({ pullRequestId, proposal, threadId, messageId, createdAt, newest }: { pullRequestId: string; proposal: { action: string; reason: string; body?: string; head?: string }; threadId: string; messageId: string; createdAt: number; newest: boolean }) {
  const [result, action, pending] = useActionState(pullAction, {});
  const cancel = store(`openreview:chat-cancel:${messageId}`);
  const [dismissed, setDismissed] = useState(false);
  const form = useRef<HTMLFormElement>(null), auto = useRef(false), ran = store(`openreview:chat-ran:${messageId}`);
  useEffect(() => {
    setDismissed(Boolean(store(`openreview:chat-cancel:${messageId}`).get()));
    const check = () => { if (!store(`openreview:chat-ran:${messageId}`).get() && autoRuns(permissionOf(threadId), { action: proposal.action, createdAt, newest, cancelled: Boolean(store(`openreview:chat-cancel:${messageId}`).get()) })) { auto.current = true; form.current?.requestSubmit(); } };
    check();
    window.addEventListener("openreview:chat-permission", check);
    return () => window.removeEventListener("openreview:chat-permission", check);
  }, [threadId, proposal.action, messageId, createdAt, newest]);
  if (dismissed) return null;
  return (
    <form ref={form} className="proposal" action={action} onSubmit={(e) => { if (ran.get() || (!auto.current && !confirm(`${proposalLabels[proposal.action] ?? proposal.action} on GitHub as you?`))) { e.preventDefault(); return; } ran.set("1"); }}>
      <input type="hidden" name="pullRequestId" value={pullRequestId} />
      <input type="hidden" name="action" value={proposal.action} />
      <input type="hidden" name="head" value={proposal.head ?? ""} />
      <input type="hidden" name="method" value="squash" />
      {proposal.body && <input type="hidden" name="body" value={proposal.body} />}
      <p><strong>Suggested action:</strong> {proposalLabels[proposal.action] ?? proposal.action} · <span className="muted">{proposal.reason}</span></p>
      {proposal.body && <blockquote>{proposal.body}</blockquote>}
      {!result.saved && !ran.get() && <span className="row">
        <button className="small primary" disabled={pending}>Approve</button>
        {routineActions.includes(proposal.action) && <button type="button" className="small" disabled={pending} onClick={() => { const p = permissionOf(threadId); store(`openreview:chat-allow:${threadId}`).set(JSON.stringify([...new Set([...p.allowed, proposal.action])])); raised(threadId); auto.current = true; form.current?.requestSubmit(); }}>Allow for this chat</button>}
        <button type="button" className="small" onClick={() => { cancel.set("1"); setDismissed(true); }}>Cancel</button>
      </span>}
      {pending && <span role="status" className="muted">Running…</span>}
      {result.error && <span role="alert">{result.error}</span>}
      {result.saved && <span role="status">{result.saved}</span>}
    </form>
  );
}

const permissionLabels: Record<ChatPermission, string> = { ask: "Ask every time", routine: "Allow routine actions", full: "Full access mode" };
// The shield chip beside Send: how this chat's suggested actions run. New chats start at "Ask every time".
export function ChatPermissionChip({ threadId }: { threadId: string }) {
  const [mode, setMode] = useState<ChatPermission>("ask");
  useEffect(() => setMode(permissionOf(threadId).mode), [threadId]);
  return <label className="permission-chip" title="Actions this chat may run without asking"><Icon name="shieldCheck" /><span className="sr-only">Chat permissions</span>
    <select value={mode} onChange={(e) => { const next = e.currentTarget.value as ChatPermission; if (next === "full" && !confirm("Full access lets this chat run every suggested action, including merges and closing, without asking. Continue?")) return; setMode(next); store(`openreview:chat-perm:${threadId}`).set(next); raised(threadId); }}>
      {(Object.keys(permissionLabels) as ChatPermission[]).map((k) => <option key={k} value={k}>{permissionLabels[k]}</option>)}
    </select>
  </label>;
}

const selectable = ".finding-card, .ov-section, .diff-file, .snippet, .pr-info-box, .checks li, .discussion .timeline li";
// "Select context": click findings, sections, files or checks, or drag across text, on the pull request
// page; a blue outline marks each pick and the text goes with the question. Esc or Done ends it.
export function ChatContext() {
  const [on, setOn] = useState(false), [picks, setPicks] = useState<string[]>([]);
  useEffect(() => {
    document.body.toggleAttribute("data-chat-select", on);
    if (!on) return () => document.body.removeAttribute("data-chat-select");
    const main = document.querySelector(".pull-main");
    const click = (e: MouseEvent) => {
      const el = (e.target as Element).closest<HTMLElement>(selectable);
      if (!el || !main?.contains(el) || window.getSelection()?.toString()) return;
      e.preventDefault(); e.stopPropagation();
      const text = el.innerText.trim().slice(0, 600);
      const picked = el.toggleAttribute("data-chat-selected");
      setPicks((list) => picked ? [...list, text] : list.filter((t) => t !== text));
    };
    const drag = () => { const sel = window.getSelection(), text = sel?.toString().trim(); if (text && sel?.anchorNode && main?.contains(sel.anchorNode)) { setPicks((list) => [...list, text.slice(0, 600)]); sel.removeAllRanges(); } };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOn(false); };
    document.addEventListener("click", click, true); document.addEventListener("mouseup", drag); document.addEventListener("keydown", key);
    return () => { document.body.removeAttribute("data-chat-select"); document.removeEventListener("click", click, true); document.removeEventListener("mouseup", drag); document.removeEventListener("keydown", key); };
  }, [on]);
  // Picks only live until the question is sent (the page reloads with the answer).
  useEffect(() => () => document.querySelectorAll("[data-chat-selected]").forEach((el) => el.removeAttribute("data-chat-selected")), []);
  const clear = () => { setPicks([]); setOn(false); document.querySelectorAll("[data-chat-selected]").forEach((el) => el.removeAttribute("data-chat-selected")); };
  return <>
    <input type="hidden" name="context" value={picks.map((t) => "> " + t.replaceAll("\n", "\n> ")).join("\n\n").slice(0, 2500)} />
    <button type="button" className={"icon-button" + (on ? " active" : "")} data-chat-context aria-pressed={on} title="Select context (Shift+S)" aria-label="Select context" onClick={() => setOn(!on)}><Icon name="crosshairSimple" /></button>
    {(on || picks.length > 0) && <span className="context-state">{picks.length} selected{on && <button type="button" className="link-button" onClick={() => setOn(false)}>Done</button>}{picks.length > 0 && <button type="button" className="link-button" onClick={clear}>Clear</button>}</span>}
  </>;
}
