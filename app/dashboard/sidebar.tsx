"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useNav, useTeamQuery } from "./tabs";

// Sections of Code Review Settings (app/dashboard/sections/settings-review.tsx), in page order. Greptile's
// sub-nav on that tab is a list of the page's sections; the one you are reading is marked as you scroll.
export const reviewSections: [id: string, label: string][] = [
  ["review-general", "When OpenReview Reviews"],
  ["review-formatting", "PR Summaries"],
  ["review-instructions", "Custom Instructions"],
  ["review-categories", "OpenReview Comments"],
  ["review-checks", "Status Checks"],
  ["review-tier", "Review Tier"],
  ["review-budgets", "Agent Budgets"],
  ["review-agents", "Coding Agents"],
  ["review-locks", "Config File"],
  ["review-conventions", "Learned Conventions"],
  ["review-retrieval", "Semantic Retrieval"],
];

/** The sub-navigation of a settings-style tab (Code Review, Organization, Personal Settings): a list
 *  on a hairline rail beside the page. Below 600px it becomes a select. */
export function SettingsNav({ label, tab, items, current, sections }: {
  label: string;
  tab: string;
  items: { path: string; label: string }[];
  current: string;
  /** In-page sections, listed in place of the current page's own item. */
  sections?: boolean;
}) {
  const team = useTeamQuery(), [pending, go] = useNav();
  const active = pending ?? current;
  const href = (path: string) => `/dashboard/${tab}${path ? "/" + path : ""}${team}`;
  return <aside className="subnav">
    <nav aria-label={label}>
      {items.map((item) => sections && item.path === current
        ? <ReviewSections key={item.path} />
        : <Link key={item.path} data-key={item.path} href={href(item.path)} aria-current={active === item.path ? "page" : undefined} onNavigate={(event) => { event.preventDefault(); go(item.path, href(item.path)); }}>{item.label}</Link>)}
    </nav>
    <select className="subnav-select" aria-label={label} value={active} onChange={(event) => go(event.target.value, href(event.target.value))}>
      {items.map((item) => <option key={item.path} value={item.path}>{item.label}</option>)}
    </select>
  </aside>;
}

function ReviewSections() {
  const [at, setAt] = useState(reviewSections[0][0]);
  // After a click the chosen section stays marked until the reader scrolls (a section near the bottom
  // may never reach the header); the smooth scroll itself fires no wheel, touch, key or pointer events.
  const jumping = useRef(false);
  useEffect(() => {
    const release = () => { jumping.current = false; };
    const update = () => {
      if (jumping.current) return;
      // The last section whose top has passed under the header; at the bottom of the page, the last one.
      const line = (document.querySelector(".portal-top")?.getBoundingClientRect().bottom ?? 0) + 24;
      const end = scrollY > 0 && innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      let current = reviewSections[0][0];
      for (const [id] of reviewSections) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && (top <= line || end)) current = id;
      }
      setAt(current);
    };
    const intents = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    update();
    addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update);
    intents.forEach((type) => addEventListener(type, release, { passive: true }));
    return () => {
      removeEventListener("scroll", update);
      removeEventListener("resize", update);
      intents.forEach((type) => removeEventListener(type, release));
    };
  }, []);
  return <>{reviewSections.map(([id, label]) => <a key={id} href={`#${id}`} aria-current={at === id ? "location" : undefined} onClick={(event) => {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    jumping.current = true;
    setAt(id);
    target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    history.replaceState(null, "", `#${id}`);
  }}>{label}</a>)}</>;
}
