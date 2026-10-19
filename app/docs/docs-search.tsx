"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { searchDocs, type DocsEntry } from "../../src/docs-search";

/** A search box above the docs navigation. While there is a query, results replace the navigation. */
export function DocsSearch({ index, children }: { index: DocsEntry[]; children: ReactNode }) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null), router = useRouter(), id = useId();
  const results = useMemo(() => searchDocs(index, query), [index, query]);
  // "/" focuses the search box from anywhere on the page, unless the visitor is typing.
  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", focus);
    return () => document.removeEventListener("keydown", focus);
  }, []);
  const searching = query.trim().length > 0;
  return <>
    <div className="docs-search" role="search">
      <label className="sr-only" htmlFor={id}>Search the docs</label>
      <input ref={input} id={id} type="search" value={query} placeholder="Search docs" aria-keyshortcuts="/" autoComplete="off"
        aria-controls={`${id}-results`} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setQuery("");
          if (e.key === "Enter" && results[0]) { e.preventDefault(); setQuery(""); router.push(`/docs/${results[0].entry.slug}`); }
        }} />
      <kbd aria-hidden="true">/</kbd>
    </div>
    <p className="sr-only" role="status">{searching ? `${results.length} matching page${results.length === 1 ? "" : "s"}` : ""}</p>
    {searching ? <div id={`${id}-results`}>
      <h2>{results.length ? "Results" : "No matching pages"}</h2>
      <ul>{results.map(({ entry, heading }) => <li key={entry.slug}><Link href={`/docs/${entry.slug}`} onClick={() => setQuery("")}>{entry.title}{heading && <small>{heading}</small>}</Link></li>)}</ul>
    </div> : children}
  </>;
}
