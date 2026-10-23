"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../ui/icons";
import { useNav, useTeamQuery } from "./tabs";

export type NavGroup = { label: string; links: [key: string, label: string, icon: IconName][] };

const memoryGroups: NavGroup[] = [{ label: "Memory", links: [["rules", "Custom rules", "listChecks"], ["clusters", "Cross-repo context", "graph"], ["knowledge", "Knowledge Base", "bookOpen"], ["integrations", "Integrations", "puzzlePiece"], ["preferences", "Learned preferences", "lightbulb"]] }];

// Sections of Settings → Code Review (app/dashboard/sections/settings-review.tsx), in page order.
const reviewSections: [id: string, label: string, icon: IconName][] = [
  ["review-general", "General", "slidersHorizontal"],
  ["review-budgets", "Agent budgets", "coins"],
  ["review-tier", "Review tier", "stack"],
  ["review-security", "Security checks", "shieldCheck"],
  ["review-locks", "Config file locks", "lockSimple"],
  ["review-formatting", "Summary & comments", "chatCircleText"],
  ["review-categories", "Review categories", "tag"],
  ["review-conventions", "Learned conventions", "graduationCap"],
];

// The Memory and Settings sidebar. It follows the committed URL, so it appears and changes together with
// the page; only the highlight moves ahead on click.
export function Sidebar({ settings }: { settings: NavGroup[] }) {
  const pathname = usePathname(), repository = useSearchParams().has("repository"), team = useTeamQuery(), [pending, go] = useNav();
  const [search, setSearch] = useState("");
  const [, , route, page] = pathname.split("/");
  if (route !== "memory" && route !== "settings") return null;
  const current = pending ?? page ?? (route === "memory" ? "rules" : "");
  const href = (key: string) => `/dashboard/${route}/${key}${team}`;
  const query = route === "settings" ? search.trim().toLocaleLowerCase() : "";
  const groups = route === "memory" ? memoryGroups : settings;
  const visible = groups.map(group => ({ ...group, links: group.links.filter(([, label]) => `${group.label} ${label}`.toLocaleLowerCase().includes(query)) })).filter(group => group.links.length);
  const count = visible.reduce((sum, group) => sum + group.links.length, 0);
  const sections = route === "settings" && page === "review" && repository && !query;
  return <aside className="secondary-nav">
    {route === "settings" && <input type="search" aria-label="Search settings" placeholder="Search settings…" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Escape") setSearch(""); }} />}
    <nav aria-label={`${route} navigation`} className="settings-navigation">
      {visible.map(group => <section className="settings-nav-group" key={group.label} aria-label={group.label}>
        <h2>{group.label}</h2>
        <div>{group.links.map(([key, label, icon]) => <div key={key} className="nav-item">
          <Link data-key={key} href={href(key)} aria-current={current === key ? "page" : undefined} data-open={key === "review" && sections ? "" : undefined} onNavigate={(event) => { event.preventDefault(); go(key, href(key)); }}>
            <Icon name={icon} /><span>{label}</span>{key === "review" && <span className="nav-caret"><Icon name="caretRight" /></span>}
          </Link>
          {key === "review" && sections && <ReviewSections />}
        </div>)}</div>
      </section>)}
    </nav>
    {route === "settings" && <p className="settings-search-status" role="status">{query ? count ? `${count} matching settings` : "No matching settings. Try another search." : ""}</p>}
    {/* Phones: the same pages as a menu. */}
    <select className="sidebar-select" aria-label={route === "memory" ? "Memory page" : "Settings page"} value={current} onChange={(event) => go(event.target.value, href(event.target.value))}>
      {groups.map(group => <optgroup key={group.label} label={group.label}>{group.links.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</optgroup>)}
    </select>
  </aside>;
}

// Links to the sections of the Code Review page. The one you are reading is marked as you scroll.
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
  return <div className="settings-anchors">
    {reviewSections.map(([id, label, icon]) => <a key={id} href={`#${id}`} aria-current={at === id ? "location" : undefined} onClick={(event) => {
      const target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      jumping.current = true;
      setAt(id);
      target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      history.replaceState(null, "", `#${id}`);
    }}><Icon name={icon} /><span>{label}</span></a>)}
  </div>;
}
