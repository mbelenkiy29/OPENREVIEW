"use client";
import { useActionState, useEffect, useState } from "react";
import { bulkFixPrompt, bulkReview } from "./actions";

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
