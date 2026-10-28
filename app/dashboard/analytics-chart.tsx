"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { niceTicks, segments } from "../../src/charts";
import { Icon, type IconName } from "../ui/icons";

// Greptile's ChartCard: a header strip (icon, mono title, a view switch or an info icon), an optional
// summary, the plot, then a leaderboard. Bars stack their series; lines can show a dashed average.
// Hovering or arrowing through the plot shows a tooltip over a full-height band; a hidden table carries
// every value for screen readers.
export type ChartView = { label: string; kind: "bar" | "line"; series: { label: string; values: (number | null)[] }[]; unit?: "" | "%" | "h" | "$"; average?: boolean; yTitle: string };
const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const format = (v: number, unit = "") => unit === "$" ? `$${v.toFixed(v > 0 && v < 10 ? 2 : 0)}` : `${Number(v.toFixed(unit === "%" ? 0 : 1))}${unit}`;
const day = (label: string) => [String(Number(label.slice(8))), months[Number(label.slice(5, 7)) - 1]] as const;

export function ChartCard({ icon, title, labels = [], views = [], info, summary, footer, wide }: { icon: IconName; title: string; labels?: string[]; views?: ChartView[]; info?: string; summary?: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const [index, setIndex] = useState(0), id = useId(), view = views[index];
  return <section className={wide ? "chart-card wide" : "chart-card"} aria-labelledby={id}>
    <header className="chart-card-head">
      <Icon name={icon} /><h2 id={id}>{title}</h2>
      {views.length > 1 ? <label className="mini-select"><span className="sr-only">{title} view</span><select value={index} onChange={(e) => setIndex(Number(e.target.value))}>{views.map((v, i) => <option key={v.label} value={i}>{v.label}</option>)}</select><Icon name="caretUpDown" /></label>
        : info ? <span className="chart-info" title={info}><Icon name="info" /><span className="sr-only">{info}</span></span> : null}
    </header>
    <div className="chart-card-body">{summary}{view && <Plot key={index} title={title} labels={labels} view={view} wide={wide} />}{footer}</div>
  </section>;
}

function Plot({ title, labels, view, wide }: { title: string; labels: string[]; view: ChartView; wide?: boolean }) {
  const [active, setActive] = useState<number | null>(null), [focused, setFocused] = useState(false);
  const n = labels.length, unit = view.unit ?? "", stacked = view.kind === "bar";
  const totals = labels.map((_, i) => stacked ? view.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0) : Math.max(0, ...view.series.map((s) => s.values[i] ?? 0)));
  // Rates run 0–100%; counts keep a 0–2 axis at least (Greptile's half steps), so an empty chart still has one.
  const peak = Math.max(0, ...totals), ticks = niceTicks(unit === "%" ? Math.max(peak, 100) : peak && unit ? peak : Math.max(peak, 2)), top = ticks.at(-1)!;
  const y = (v: number) => `${(Math.max(0, v) / top) * 100}%`, x = (i: number) => `${((i + 0.5) / n) * 100}%`;
  const known = view.series[0]?.values.filter((v): v is number => v !== null) ?? [];
  const average = view.average ? known.reduce((sum, v) => sum + v, 0) / (known.length || 1) : null;
  const every = Math.ceil(n / (wide ? 16 : 8)), move = (i: number) => setActive(Math.min(n - 1, Math.max(0, i)));
  const date = (i: number) => { const [d, m] = day(labels[i]); return `${m} ${d}`; };
  const read = (i: number) => view.series.map((s) => `${s.label} ${s.values[i] === null ? "no data" : format(s.values[i]!, unit)}`).join(", ");
  const pointer = (e: PointerEvent<HTMLDivElement>) => { const r = e.currentTarget.getBoundingClientRect(); move(Math.floor(((e.clientX - r.left) / r.width) * n)); };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = ({ ArrowLeft: (active ?? n) - 1, ArrowRight: (active ?? -1) + 1, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
    if (next !== undefined) { e.preventDefault(); move(next); }
  };
  if (!n) return null;
  return <div className="chart-plot">
    <span className="chart-y-title" aria-hidden="true">{view.yTitle}</span>
    <div className="chart-y" aria-hidden="true">{ticks.map((t) => <span key={t} style={{ bottom: y(t) }}>{format(t, unit)}</span>)}</div>
    <div className="chart-area" tabIndex={0} role="group" aria-roledescription="chart" aria-label={`${title}: ${view.label}. Use the arrow keys to read each point.`}
      onPointerMove={pointer} onPointerLeave={() => !focused && setActive(null)} onKeyDown={key}
      onFocus={() => { setFocused(true); setActive((a) => a ?? n - 1); }} onBlur={() => { setFocused(false); setActive(null); }}>
      {active !== null && <i className="chart-band" style={{ left: `${(active / n) * 100}%`, width: `${100 / n}%` }} />}
      {ticks.map((t) => (average !== 0 || t > 0) && <i key={t} className="chart-gridline" style={{ bottom: y(t) }} />)}
      {stacked ? <div className="chart-bars" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>{totals.map((t, i) => <span key={i} className="chart-bar" style={{ height: y(t) }}>{view.series.map((s, si) => s.values[i] ? <i key={si} className={`s${si}`} style={{ flexGrow: s.values[i]! }} /> : null)}</span>)}</div>
        : <svg className="chart-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{view.series.map((s, si) => segments(s.values.map((v, i) => v === null ? null : `${((i + 0.5) / n) * 100},${100 - (Math.max(0, v) / top) * 100}`)).map((points, j) => <polyline key={`${si}-${j}`} className={`s${si}`} points={points} vectorEffect="non-scaling-stroke" />))}</svg>}
      {!stacked && view.series.map((s, si) => s.values.map((v, i) => v !== null && (i === active || ((s.values[i - 1] ?? null) === null && (s.values[i + 1] ?? null) === null)) ? <i key={`${si}-${i}`} className={`chart-dot s${si}`} style={{ left: x(i), bottom: y(v) }} /> : null))}
      {average !== null && <><i className="chart-average" style={{ bottom: y(average) }} /><span className="chart-average-label" style={{ bottom: y(average) }}>Average</span></>}
      {active !== null && <div className={active >= n / 2 ? "chart-tip before" : "chart-tip"} style={{ left: x(active) }} aria-hidden="true">
        <span className="chart-tip-date">{date(active)}</span>
        {view.series.map((s, si) => <span key={s.label} className="chart-tip-row"><i className={`s${si}`} />{s.label}<strong>{s.values[active] === null ? "–" : format(s.values[active]!, unit)}</strong></span>)}
      </div>}
    </div>
    <div className="chart-x" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>{labels.map((l, i) => { const [d, m] = day(l); const k = (n - 1 - i) / every; return <span key={l} className={k % 2 ? "alt" : undefined}>{Number.isInteger(k) && <><b>{d}</b><b>{m}</b></>}</span>; })}</div>
    <span className="sr-only" aria-live="polite">{focused && active !== null ? `${date(active)}: ${read(active)}` : ""}</span>
    <div className="sr-only"><table><caption>{`${title}: ${view.label}`}</caption><thead><tr><th scope="col">Date</th>{view.series.map((s) => <th key={s.label} scope="col">{s.label}</th>)}</tr></thead>
      <tbody>{labels.map((l, i) => <tr key={l}><th scope="row">{l}</th>{view.series.map((s) => <td key={s.label}>{s.values[i] === null ? "—" : format(s.values[i]!, unit)}</td>)}</tr>)}</tbody></table></div>
  </div>;
}
