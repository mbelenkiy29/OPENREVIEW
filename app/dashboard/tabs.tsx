"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useOptimistic, useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../ui/icons";
import { tabs } from "./routes";

// Dashboard tabs. A click marks its tab as current at once and navigates inside a transition, so the
// old page stays on screen until the new one is ready: no loading skeleton, and the indicator slides.

/** Navigates in a transition; `pending` is the clicked key until the new page commits. */
export function useNav() {
  const router = useRouter(), [pending, setPending] = useOptimistic<string | null>(null), [, start] = useTransition();
  const go = (key: string, href: string) => start(() => { setPending(key); router.push(href); });
  return [pending, go] as const;
}

/** The current `?team=` filter, carried by in-app links. */
export function useTeamQuery() {
  const team = useSearchParams().get("team");
  return team === null ? "" : `?team=${encodeURIComponent(team)}`;
}

/** Keeps `bar` under the list's `[data-key=active]` child: it slides on change and jumps on first paint and resize. */
export function useIndicator<T extends HTMLElement>(active: string | undefined) {
  const list = useRef<T>(null), bar = useRef<HTMLSpanElement>(null), current = useRef(active), placed = useRef(false);
  useLayoutEffect(() => {
    current.current = active;
    place(list.current, bar.current, active, placed.current);
    placed.current = true;
  }, [active]);
  useEffect(() => {
    // Observe the tabs, never the bar: the bar changes width while it slides.
    const observer = new ResizeObserver(() => place(list.current, bar.current, current.current, false));
    list.current?.querySelectorAll(":scope > [data-key]").forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, []);
  return { list, bar };
}
function place(list: HTMLElement | null, bar: HTMLElement | null, key: string | undefined, animate: boolean) {
  if (!list || !bar) return;
  const tab = key === undefined ? null : list.querySelector<HTMLElement>(`:scope > [data-key="${CSS.escape(key)}"]`);
  bar.hidden = !tab;
  if (!tab) return;
  // Styles go straight to the element (no React style prop), so a re-render never resets them.
  bar.style.transition = animate ? "" : "none";
  bar.style.width = `${tab.offsetWidth}px`;
  bar.style.transform = `translateX(${tab.offsetLeft}px)`;
  list.dataset.indicator = "";
  if (tab.offsetLeft < list.scrollLeft || tab.offsetLeft + tab.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = tab.offsetLeft - 16;
}

// Remembered so Personal Settings' Back returns to the page it was opened from.
let lastPage = "/dashboard/analytics";

/** Greptile's eight tabs (routes.ts). Personal Settings replaces them with its own header. */
export function PrimaryTabs() {
  const pathname = usePathname(), team = useTeamQuery(), [pending, go] = useNav();
  const tab = pathname.split("/")[2];
  useEffect(() => { if (tab !== "account") lastPage = pathname + location.search; }, [pathname, tab]);
  const active = pending ?? tab;
  const { list, bar } = useIndicator<HTMLElement>(tabs.some(([key]) => key === active) ? active : undefined);
  if (tab === "account") return null;
  return <nav ref={list} className="primary-nav" aria-label="Main navigation">
    {tabs.map(([key, label]) => {
      const href = `/dashboard/${key}${team}`;
      return <Link key={key} data-key={key} href={href} aria-current={active === key ? "page" : undefined} onNavigate={(event) => { event.preventDefault(); go(key, href); }}>{label}</Link>;
    })}
    <span ref={bar} className="tab-indicator" aria-hidden="true" />
  </nav>;
}

/** The identity row's left side: the brand and organization menu, or Personal Settings' ‹ Back. */
export function IdentityLeft({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname.split("/")[2] !== "account") return children;
  return <div className="personal-bar">
    <Link className="back-link" href={lastPage}><Icon name="caretLeft" />Back</Link>
    <span className="crumb">Personal Settings</span>
  </div>;
}

// Set by a sub-tab click so the next page's panel plays its entrance; never on a first load.
let switched = false;

/** Sub-tabs that are links: Analytics views (each its own page) and the review page's tabs (`?tab=`).
 *  The box slides to the clicked tab at once and stays there while the next page loads. */
export function SubNav({ label, items, active: current, children }: {
  label: string;
  items: [key: string, href: string, label: ReactNode, icon?: IconName][];
  active: string;
  /** The views' content; it fades in after a switch. */
  children?: ReactNode;
}) {
  const team = useTeamQuery(), [pending, go] = useNav();
  const active = pending ?? current;
  const { list, bar } = useIndicator<HTMLElement>(active);
  const [enter] = useState(() => switched);
  useEffect(() => { switched = false; }, []);
  const to = (href: string) => href.includes("?") ? href : href + team;
  const nav = <nav ref={list} className="tab-list" aria-label={label}>
    {items.map(([key, href, text, icon]) => <Link key={key} data-key={key} href={to(href)} aria-current={active === key ? "page" : undefined} onNavigate={(event) => { event.preventDefault(); if (children !== undefined) switched = true; go(key, to(href)); }}>{icon && <Icon name={icon} />}{text}</Link>)}
    <span ref={bar} className="tab-box" aria-hidden="true" />
  </nav>;
  return children === undefined ? nav : <>{nav}<div className={enter ? "tab-panel enter" : "tab-panel"}>{children}</div></>;
}

/** ARIA tabs over panels that are all rendered and hidden until selected, so switching is instant
 *  (the landing replicas). */
export function PanelTabs({ label, tabs, initial }: {
  label: string;
  tabs: { id: string; label: ReactNode; panel: ReactNode }[];
  initial?: string;
}) {
  const [selected, setSelected] = useState(() => tabs.some((t) => t.id === initial) ? initial! : tabs[0].id);
  const [moved, setMoved] = useState(false);
  const base = useId();
  const { list, bar } = useIndicator<HTMLDivElement>(selected);
  const select = (id: string, focus = false) => {
    setSelected(id);
    setMoved(true);
    if (focus) list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(id)}"]`)?.focus();
  };
  const keyDown = (event: KeyboardEvent) => {
    const index = tabs.findIndex((t) => t.id === selected), last = tabs.length - 1;
    const moves: Record<string, number> = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(tabs[next].id, true);
  };
  return <div className="panel-tabs">
    <div ref={list} role="tablist" aria-label={label} className="tab-list" onKeyDown={keyDown}>
      {tabs.map((t) => <button key={t.id} type="button" role="tab" id={`${base}${t.id}-tab`} data-key={t.id} aria-selected={t.id === selected} aria-controls={`${base}${t.id}`} tabIndex={t.id === selected ? 0 : -1} onClick={() => select(t.id)}>{t.label}</button>)}
      <span ref={bar} className="tab-box" aria-hidden="true" />
    </div>
    {tabs.map((t) => <div key={t.id} role="tabpanel" id={`${base}${t.id}`} aria-labelledby={`${base}${t.id}-tab`} tabIndex={0} hidden={t.id !== selected} className={moved ? "tab-panel enter" : "tab-panel"}>{t.panel}</div>)}
  </div>;
}
