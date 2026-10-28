import React, { Fragment } from "react";
import { priorityBadge, tagBadges } from "../../../src/priority";
// Helpers shared by the dashboard page and its section components.
export const navigation = [
  "Overview",
  "Chat",
  "Repositories",
  "Reviews",
  "Findings",
  "Issues",
  "Knowledge",
  "Rules",
  "Team",
  "Usage",
  "Settings",
];
export const when = (value: number) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }) + " UTC";
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536e6], ["month", 2592e6], ["week", 6048e5], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];
// "4 weeks ago"; pair with when() as a tooltip for the exact time.
export const ago = (value: number, now = Date.now()) => {
  const unit = units.find(([, ms]) => Math.abs(value - now) >= ms);
  return unit ? relative.format(Math.round((value - now) / unit[1]), unit[0]) : "just now";
};
const severityOf: Record<string, string> = { P0: "critical", P1: "high", P2: "medium", P3: "low" };
// Count badges ("P1 ×2", "🔒 ×1") in priority order, as in the pull request list.
export const severityCounts = (counts: Record<string, number>) =>
  ["P0", "P1", "P2", "P3", "security"].filter((key) => counts[key]).map((key, i) => (
    <Fragment key={key}>{i > 0 && " "}<span className={`badge ${severityOf[key] ?? key}`} title={`${counts[key]} ${key} finding${counts[key] === 1 ? "" : "s"}`}>{key === "security" ? "🔒" : key} ×{counts[key]}</span></Fragment>
  ));
// Priority badge (P0–P3, colored by severity) plus a Security tag for security findings.
export const priority = (f: { severity: string; category?: string }) => (
  <>
    <span className={`badge ${f.severity}`} title={`Severity: ${f.severity}`}>{priorityBadge(f.severity)}</span>
    {tagBadges(f).map((tag) => <Fragment key={tag}>{" "}<span className="badge">{tag}</span></Fragment>)}
  </>
);
export const status = (value: string) => (
  <span className={`badge ${value}`}>{value.replaceAll("_", " ")}</span>
);
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <section className="empty">
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
  );
}
