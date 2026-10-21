"use client";
import { useActionState, useEffect, useState } from "react";
import { bulkFixPrompt, bulkReview, pullAction } from "./actions";

const selected = () => [...document.querySelectorAll<HTMLInputElement>('input[form="bulk-pulls"]:checked')];
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

// "N selected" bar for the pull request checkboxes (they join this form through form="bulk-pulls").
export function BulkBar() {
  const [count, setCount] = useState(0);
  const [state, action, pending] = useActionState(bulkReview, {});
  const [copied, setCopied] = useState("");
  useEffect(() => {
    const update = () => setCount(selected().length);
    document.addEventListener("change", update);
    return () => document.removeEventListener("change", update);
  }, []);
  return (
    <form id="bulk-pulls" className="bulk-bar" action={action} onSubmit={(e) => { if (!confirm(`Re-review ${count} pull ${count === 1 ? "request" : "requests"}? Each review uses model credits.`)) e.preventDefault(); }}>
      <span aria-live="polite">{count} selected</span>
      <button type="submit" className="small" disabled={!count || pending}>{pending ? "Starting reviews…" : "Re-review"}</button>
      <button type="button" className="small" disabled={!count} onClick={async () => {
        const ids = selected().map((box) => box.value.split("|")[2]).filter(Boolean);
        try { const prompt = await bulkFixPrompt(ids); if (!prompt) return setCopied("No fixable findings in the selection"); await navigator.clipboard.writeText(prompt); setCopied("Fix prompts copied"); }
        catch { setCopied("Copy failed"); }
      }}>Copy fix prompts</button>
      {copied && <span role="status" className="muted">{copied}</span>}
      {state.error && <span role="alert">{state.error}</span>}
      {state.saved && <span role="status">{state.saved}</span>}
    </form>
  );
}

// J/K move, Enter opens, Space selects, ⌘A selects all, G re-reviews the selection, / searches.
export function PullKeys() {
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
        document.querySelector<HTMLFormElement>("#bulk-pulls")?.requestSubmit();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <p className="key-hints" aria-label="Keyboard shortcuts">
      <kbd>J</kbd> <kbd>K</kbd> navigate · <kbd>Space</kbd> select · <kbd>Enter</kbd> open · <kbd>G</kbd> re-review · <kbd>/</kbd> search
    </p>
  );
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
      const step = key === "j" || key === "l" ? 1 : key === "k" || key === "h" ? -1 : 0;
      if (!step) return document.querySelector<HTMLElement>(`.pull-actions [data-key="${key}"]:not(:disabled)`)?.click();
      const links = [...document.querySelectorAll<HTMLAnchorElement>(key === "j" || key === "k" ? ".pull-sidebar ol a" : ".tabs a")];
      links[links.findIndex((a) => a.getAttribute("aria-current") === "page") + step]?.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return <button type="button" className="small sidebar-toggle" aria-label="Toggle pull request list (⌘B)" onClick={() => toggle(document.querySelector(".pull-detail"))}>☰</button>;
}
function toggle(root: HTMLElement | null) {
  const closed = root?.toggleAttribute("data-collapsed");
  try { localStorage.setItem("openreview:pull-sidebar", closed ? "closed" : "open"); } catch { /* not remembered */ }
}

// Merge, review, close, draft and branch actions on an open pull request, sent as the developer.
// Keys: M merge, A approve, X request changes, C close, O reopen, D draft/ready, U update branch.
export function PullActions({ pullRequestId, head, state, draft }: { pullRequestId: string; head: string; state: string; draft?: boolean }) {
  const [result, action, pending] = useActionState(pullAction, {});
  const ask = (message: string) => (e: React.MouseEvent) => { if (!confirm(message)) e.preventDefault(); };
  return (
    <form className="pull-actions" action={action}>
      <input type="hidden" name="pullRequestId" value={pullRequestId} />
      <input type="hidden" name="head" value={head} />
      {state === "open" ? <>
        <span className="merge-group">
          <button name="action" value="merge" className="primary small" data-key="m" disabled={pending || draft} onClick={ask("Merge this pull request on GitHub as you?")}>Merge</button>
          <select name="method" aria-label="Merge method" defaultValue="squash"><option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase</option></select>
        </span>
        <details>
          <summary data-key="x">Review…</summary>
          <textarea name="body" rows={3} aria-label="Review comment" placeholder="Leave a comment (required to request changes)" />
          <span className="row">
            <button name="action" value="approve" className="small" data-key="a" disabled={pending}>Approve</button>
            <button name="action" value="request_changes" className="small" disabled={pending}>Request changes</button>
            <button name="action" value="comment" className="small" disabled={pending}>Comment</button>
          </span>
        </details>
        <button name="action" value={draft ? "ready" : "draft"} className="small" data-key="d" disabled={pending}>{draft ? "Ready for review" : "Convert to draft"}</button>
        <button name="action" value="update_branch" className="small" data-key="u" disabled={pending}>Update branch</button>
        <button name="action" value="close" className="small" data-key="c" disabled={pending} onClick={ask("Close this pull request on GitHub?")}>Close</button>
      </> : state === "closed" && <button name="action" value="reopen" className="small" data-key="o" disabled={pending}>Reopen</button>}
      {pending && <span role="status" className="muted">Working…</span>}
      {result.error && <span role="alert">{result.error}</span>}
      {result.saved && <span role="status">{result.saved}</span>}
    </form>
  );
}
