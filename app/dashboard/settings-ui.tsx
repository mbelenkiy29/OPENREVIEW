// Greptile's settings anatomy, shared by Code Review Settings, AI Model and Runtime & Approval (server and
// client components alike): an icon + display heading + subtitle above a card of setting rows.
import type { ReactNode } from "react";
import { Icon, type IconName } from "../ui/icons";

export function SettingsHeading({ icon, title, sub, link, id }: { icon: IconName; title: string; sub: ReactNode; link?: ReactNode; id?: string }) {
  return <div className="section-heading"><div><h2 id={id}><Icon name={icon} />{title}</h2><p>{sub}</p></div>{link}</div>;
}
/** One setting: its title (the control's label) and help on the left, the control on the right. */
export function Row({ id, title, help, className, children }: { id?: string; title: ReactNode; help?: ReactNode; className?: string; children: ReactNode }) {
  return <div className={"setting-row" + (className ? " " + className : "")}><div>{id ? <label htmlFor={id}>{title}</label> : <span className="setting-title">{title}</span>}{help && <p id={id ? id + "-help" : undefined}>{help}</p>}</div>{children}</div>;
}
/** A checkbox drawn as a switch; `help` says whether the row has a description to point at. */
export function Switch({ id, name, on, form, value, help = true }: { id: string; name: string; on: boolean; form?: string; value?: string; help?: boolean }) {
  return <input id={id} name={name} value={value} type="checkbox" role="switch" defaultChecked={on} aria-describedby={help ? id + "-help" : undefined} form={form} />;
}
