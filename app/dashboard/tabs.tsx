"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useOptimistic, useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../ui/icons";

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

const mainTabs: [key: string, label: string, icon: IconName, path: string][] = [
  ["analytics", "Analytics", "chartLine", "/dashboard/analytics"],
  ["chat", "Chat", "chatCircle", "/dashboard/chat"],
  ["memory", "Memory", "brain", "/dashboard/memory"],
  ["pulls", "Pull Requests", "gitPullRequest", "/dashboard/pulls"],
  // Straight to the first page: /dashboard/settings would redirect there.
  ["settings", "Settings", "gear", "/dashboard/settings/repositories"],
];

export function PrimaryTabs() {
  const pathname = usePathname(), team = useTeamQuery(), [pending, go] = useNav();
  const active = pending ?? pathname.split("/")[2];
  const { list, bar } = useIndicator<HTMLElement>(active);
  return <nav ref={list} className="primary-nav" aria-label="Main navigation">
    {mainTabs.map(([key, label, icon, path]) => {
      const href = path + team;
      return <Link key={key} data-key={key} href={href} aria-current={active === key ? "page" : undefined} onNavigate={(event) => { event.preventDefault(); go(key, href); }}>
        <Icon name={icon} />
        {/* Phones show "PRs"; the full label stays the accessible name. */}
        {key === "pulls" ? <><span className="tab-long">{label}</span><span className="tab-short" aria-hidden="true">PRs</span></> : label}
      </Link>;
    })}
    <span ref={bar} className="tab-indicator" aria-hidden="true" />
  </nav>;
}

// Set by a sub-tab click so the next page's panel plays its entrance; never on a first load.
let switched = false;

/** Sub-tabs that are links (each its own URL). The box slides while the next page loads. */
export function SubNav({ label, items, children }: { label: string; items: [path: string, label: string, icon: IconName][]; children: ReactNode }) {
  const pathname = usePathname(), team = useTeamQuery(), [pending, go] = useNav();
  const active = pending ?? pathname;
  const { list, bar } = useIndicator<HTMLElement>(active);
  const [enter] = useState(() => switched);
  useEffect(() => { switched = false; }, []);
  return <>
    <nav ref={list} className="tab-list" aria-label={label}>
      {items.map(([path, text, icon]) => <Link key={path} data-key={path} href={path + team} aria-current={active === path ? "page" : undefined} onNavigate={(event) => { event.preventDefault(); switched = true; go(path, path + team); }}><Icon name={icon} />{text}</Link>)}
      <span ref={bar} className="tab-box" aria-hidden="true" />
    </nav>
    <div className={enter ? "tab-panel enter" : "tab-panel"}>{children}</div>
  </>;
}

/** Keeps PanelTabs on the panel the URL names when Back, Forward or a link changes `?param=`; without
 *  the parameter, on the server's `fallback` for that URL. Rendered only with a `param`, so static
 *  pages (the landing replicas) never read search params. */
function UrlTab({ param, ids, fallback, select }: { param: string; ids: string; fallback?: string; select: (id: string) => void }) {
  const value = useSearchParams().get(param);
  useEffect(() => {
    const want = [value, fallback].find((id) => id && ids.split(" ").includes(id));
    if (want) select(want);
  }, [value, fallback, ids, select]);
  return null;
}

/** ARIA tabs over panels that are all rendered and hidden until selected, so switching is instant. */
export function PanelTabs({ label, tabs, initial, param }: {
  label: string;
  tabs: { id: string; label: ReactNode; panel: ReactNode }[];
  initial?: string;
  /** Query parameter that records the selected tab in the URL. */
  param?: string;
}) {
  const [selected, setSelected] = useState(() => tabs.some((t) => t.id === initial) ? initial! : tabs[0].id);
  const [moved, setMoved] = useState(false);
  const base = useId();
  const { list, bar } = useIndicator<HTMLDivElement>(selected);
  const select = (id: string, focus = false) => {
    setSelected(id);
    setMoved(true);
    if (focus) list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(id)}"]`)?.focus();
    if (!param) return;
    const url = new URL(location.href);
    url.searchParams.set(param, id);
    url.hash = "";
    history.replaceState(null, "", url);
  };
  // A link to something inside a hidden panel (a finding, the diff) opens that panel first.
  useEffect(() => {
    const reveal = () => {
      const target = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
      const panel = target?.closest<HTMLElement>("[data-tab]");
      if (!target || !panel || panel.parentElement !== list.current?.parentElement) return;
      setSelected(panel.dataset.tab!);
      requestAnimationFrame(() => target.scrollIntoView());
    };
    reveal();
    addEventListener("hashchange", reveal);
    return () => removeEventListener("hashchange", reveal);
  }, [list]);
  const keyDown = (event: KeyboardEvent) => {
    const index = tabs.findIndex((t) => t.id === selected), last = tabs.length - 1;
    const moves: Record<string, number> = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(tabs[next].id, true);
  };
  return <div className="panel-tabs">
    {param && <UrlTab param={param} ids={tabs.map((t) => t.id).join(" ")} fallback={initial} select={setSelected} />}
    <div ref={list} role="tablist" aria-label={label} className="tab-list" onKeyDown={keyDown}>
      {tabs.map((t) => <button key={t.id} type="button" role="tab" id={`${base}${t.id}-tab`} data-key={t.id} aria-selected={t.id === selected} aria-controls={`${base}${t.id}`} tabIndex={t.id === selected ? 0 : -1} onClick={() => select(t.id)}>{t.label}</button>)}
      <span ref={bar} className="tab-box" aria-hidden="true" />
    </div>
    {tabs.map((t) => <div key={t.id} role="tabpanel" id={`${base}${t.id}`} aria-labelledby={`${base}${t.id}-tab`} tabIndex={0} hidden={t.id !== selected} data-tab={t.id} className={moved ? "tab-panel enter" : "tab-panel"}>{t.panel}</div>)}
  </div>;
}
