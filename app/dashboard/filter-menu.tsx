import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "../ui/icons";
import { PortalDisclosure } from "./portal-disclosure";

// Greptile's FilterSelect: an outline trigger (icon, current value, chevron) opening a menu whose options
// are links, so a choice applies at once and stays in the URL. Callers key it by the current URL so it
// closes after navigating (the disclosure only closes itself when the path changes).
export function FilterMenu({ icon, title, value, options, children, fit }: {
  icon: IconName; title: string; value: string; fit?: boolean; children?: ReactNode;
  options: { label: string; href: string; current: boolean; hint?: string }[];
}) {
  return <PortalDisclosure className={fit ? "filter-select fit" : "filter-select"} label={<><Icon name={icon} /><span className="sr-only">{title}: </span><span className="filter-value">{value}</span><Icon name="caretDown" /></>}>
    <div className="menu filter-menu">
      <p className="menu-label">{title}</p>
      {options.map((o) => <Link key={o.href} className="menu-item" href={o.href} title={o.hint} aria-current={o.current ? "true" : undefined}><span>{o.label}</span>{o.current && <Icon name="check" />}</Link>)}
      {children}
    </div>
  </PortalDisclosure>;
}
// Query string for a page's filters with some replaced; undefined drops a key, "" keeps an explicit "all".
export function filterHref(path: string, current: Record<string, string | undefined>, patch: Record<string, string | undefined> = {}) {
  const query = new URLSearchParams(Object.entries({ ...current, ...patch }).filter((e): e is [string, string] => e[1] !== undefined));
  return query.size ? `${path}?${query}` : path;
}
export function HiddenFilters({ current, omit }: { current: Record<string, string | undefined>; omit: string[] }) {
  return Object.entries(current).filter(([k, v]) => v !== undefined && !omit.includes(k)).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);
}
