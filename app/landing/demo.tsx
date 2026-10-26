"use client";
// Interactive replicas of real dashboard screens for the landing page. They reuse the dashboard's
// markup, classes and shared components with sample content, so they look like the app and follow
// its theme, and a visitor can click through them. Nothing here calls the backend: every result is
// sample data, and slow work (reviews, chat answers, agent hand-offs) is simulated with timers.
// Markdown and the configuration previews are rendered on the server (replicas.tsx) and passed in.
import { createElement, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { DiffFiles, type DiffFile, type DiffFinding } from "../dashboard/diff-files";
import { PortalDisclosure } from "../dashboard/portal-disclosure";
import { ScrollTable } from "../dashboard/scroll-table";
import { priority, status } from "../dashboard/sections/shared";
import { reviewVerdict, verdictLabels } from "../../src/verdict";
import { ChartCard } from "../dashboard/analytics-chart";
import { Mark } from "../ui/logo";
import { Icon } from "../ui/icons";
import { PanelTabs, useIndicator } from "../dashboard/tabs";
import { priorityOf } from "../../src/priority";
import { analyticsView, answerFor, revealWords, triggerFlags, triggerKey, wordCount } from "./demo-logic";
import { agents, analytics, chat, diffFiles, diffFindings, findings, fixPrompt, fixPush, fixStatuses, history, indexed, memory, otherPulls, pull, score, sources, type Revision } from "./sample";

export type CommentPreview = { id: string; title: string; path: string; line: number; severity: string; category: string; confidence: number; outcome: string };
export type TriggerPreview = { id: string; label: string; review: boolean; reason: string };
export type SettingsPreviews = { comments: Record<string, CommentPreview[]>; triggers: Record<string, TriggerPreview[]> };

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)"), update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}
/** Runs steps after cumulative delays. Starting a new run, or unmounting, cancels pending steps. */
function useSchedule() {
  const timers = useRef<number[]>([]);
  const cancel = useCallback(() => { timers.current.forEach(clearTimeout); timers.current = []; }, []);
  useEffect(() => cancel, [cancel]);
  return useCallback((steps: [delay: number, run: () => void][]) => {
    cancel();
    let at = 0;
    for (const [delay, run] of steps) { at += delay; timers.current.push(window.setTimeout(run, at)); }
  }, [cancel]);
}

/** Plays `play` once, shortly after the window is half in view, unless the visitor prefers reduced
 *  motion. A click or key press inside the window first cancels it: the visitor is driving. */
function useAutoplay(frame: RefObject<HTMLElement | null>, play?: () => void) {
  const latest = useRef(play), enabled = Boolean(play);
  useEffect(() => { latest.current = play; });
  useEffect(() => {
    const el = frame.current;
    if (!enabled || !el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    const observer = new IntersectionObserver(([entry]) => {
      clearTimeout(timer);
      if (entry.isIntersecting) timer = window.setTimeout(() => { stop(); latest.current?.(); }, 800);
    }, { threshold: 0.5 });
    const stop = () => { clearTimeout(timer); observer.disconnect(); el.removeEventListener("pointerdown", stop); el.removeEventListener("keydown", stop); };
    observer.observe(el);
    el.addEventListener("pointerdown", stop);
    el.addEventListener("keydown", stop);
    return stop;
  }, [frame, enabled]);
}

// Headings keep the app's look but stay out of the landing page's outline.
const H = ({ level = 2, children }: { level?: 1 | 2 | 3; children: ReactNode }) => createElement(`h${level}`, { role: "presentation" }, children);

function Window({ title, label = `${title} demo`, caption, size, frame, children }: { title: string; label?: string; caption: string; size?: "tall" | "short"; frame?: RefObject<HTMLElement | null>; children: ReactNode }) {
  return <figure className="replica" ref={frame}>
    <div className="replica-bar" aria-hidden="true"><i /><i /><i /><span>{title}</span><em>Demo</em></div>
    <div className={`replica-screen${size ? ` ${size}` : ""}`} role="region" aria-label={label} tabIndex={0}>{children}</div>
    <figcaption className="sr-only">Interactive demo with sample data. {caption}</figcaption>
  </figure>;
}

// The dashboard's eight tabs (app/dashboard/routes.ts); Chat opens from the header, as in the app.
const tabs = ["Analytics", "Repositories", "Code Review Settings", "Custom Context", "Pull Requests", "Code Providers", "Integrations", "Organization Settings"] as const;
type Tab = (typeof tabs)[number] | "Chat";
const subtitles: Record<Tab, string> = {
  Analytics: "", Chat: "Ask questions about your repositories.", Repositories: "Manage connected repositories and view review metrics.",
  "Code Review Settings": "Configure how OpenReview reviews your pull requests.", "Custom Context": "Manage context for Acme",
  "Pull Requests": "Review history across your repositories.", "Code Providers": "Connect or manage your code providers.",
  Integrations: "Connect the tools OpenReview reads context from and reports to.", "Organization Settings": "Manage members, roles, and invitations.",
};
// The dashboard's chrome and page column ("shell portal"); replica-shell keeps its palette inside the window.
function Chrome({ active, onTab, children }: { active: Tab; onTab: (tab: Tab) => void; children: ReactNode }) {
  const { list, bar } = useIndicator<HTMLElement>(active === "Chat" ? undefined : active);
  return <div className="shell portal replica-shell">
    <div className="portal-top">
      <div className="portal-identity">
        <span className="brand"><Mark /></span>
        <PortalDisclosure className="scope-selector" label={<><span className="scope-name">Acme</span><span className="role-badge">Admin</span><Icon name="caretUpDown" /></>}><div className="menu org-menu"><p className="menu-label">Acme is a sample organization.</p><a className="menu-item" href="/signup"><Icon name="plus" /><span>Create your organization</span></a></div></PortalDisclosure>
        <div className="header-actions">
          <button type="button" className="header-button" aria-pressed={active === "Chat"} onClick={() => onTab("Chat")}><Icon name="chatCircle" /><span className="sr-only">Chat</span></button>
          <Link className="header-button" href="/docs" title="Docs"><Icon name="bookOpen" /><span className="sr-only">Docs</span></Link>
          <PortalDisclosure className="profile" label={<><Icon name="user" /><span className="sr-only">Account menu for @dana</span></>}><div className="menu user-menu"><a className="menu-item" href="/login">Sign in</a><a className="menu-item" href="/signup">Create an account</a></div></PortalDisclosure>
        </div>
      </div>
      <nav ref={list} className="primary-nav" aria-label="Demo sections">{tabs.map((t) => <button key={t} type="button" data-key={t} aria-current={t === active ? "page" : undefined} onClick={() => onTab(t)}>{t}</button>)}<span ref={bar} className="tab-indicator" aria-hidden="true" /></nav>
    </div>
    <div className="content page">{children}</div>
  </div>;
}
const PageHeader = ({ title, subtitle }: { title: string; subtitle?: string }) => <header className="page-header"><div><H level={1}>{title}</H>{subtitle && <p>{subtitle}</p>}</div><span className="live">Updating automatically</span></header>;
/** Greptile's segmented control, for a page's views. */
function Segmented<T extends string>({ label, views, value, onChange }: { label: string; views: [T, string][]; value: T; onChange: (v: T) => void }) {
  return <div className="segmented" role="group" aria-label={label}>{views.map(([v, text]) => <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>)}</div>;
}
const chip = (state: string) => <span className={`status-chip ${state === "completed" ? "completed" : state === "failed" ? "failed" : "pending"}`}><Icon name={state === "completed" ? "check" : state === "failed" ? "warningCircle" : "circleNotch"} />{state}</span>;

// ---------- Pull requests ----------
type Pull = { number: number; title: string; author: string; head: string; headBranch: string; reviewedAt: string; state: string; files: DiffFile[]; found: DiffFinding[]; score?: { value: number; reason: string }; steps?: string[] };
const pulls: Pull[] = [
  { ...pull, state: "completed", files: diffFiles, found: diffFindings, score },
  ...otherPulls.map((p) => ({ ...p, state: p.status, files: p.files ?? [], found: [] })),
];
type PullsView = "list" | number;

function PullTable({ open }: { open: (n: number) => void }) {
  return <ScrollTable label="Pull requests" className="table-box"><table><thead><tr><th>PR #</th><th>PR name</th><th>Repo</th><th>Branch</th><th>Status</th><th>Findings</th><th>Score</th></tr></thead><tbody>
    {pulls.map((p) => <tr key={p.number}>
      <td>#{p.number}</td>
      <td><button type="button" className="pull-link" onClick={() => open(p.number)}><span>{p.title}</span><small>@{p.author}</small></button></td>
      <td><span className="repo-cell"><Icon name="githubLogo" />{pull.repo.split("/")[1]}</span></td><td className="mono muted">{p.headBranch}</td><td>{chip(p.state)}</td><td>{p.score ? p.found.length : "—"}</td><td>{p.score ? `${p.score.value}/5` : "—"}</td>
    </tr>)}
  </tbody></table></ScrollTable>;
}

function PullDetail({ p }: { p: Pull }) {
  const verdict = p.score && reviewVerdict({ score: p.score.value, findings: p.found as unknown as Parameters<typeof reviewVerdict>[0]["findings"] });
  const verified = p.number === pull.number ? findings : [];
  const counts = (["critical", "high", "medium", "low"] as const).map((s) => [s, verified.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
  return <>
    <div className="row"><H level={2}>{pull.repo} #{p.number}</H>{status(p.state)}</div>
    <p className="muted repository-identity">{pull.provider}</p>
    {p.reviewedAt && <p className="muted">Reviewed revision {p.head} · {p.reviewedAt}</p>}
    <p>{p.title} · @{p.author}</p>
    <p className="muted">{p.headBranch} → {pull.baseBranch}</p>
    {p.steps ? <section><H level={2}>Review in progress</H><div className="chat-progress" role="status"><p className="muted">Working…</p><ol>{p.steps.map((s) => <li key={s}>{s}</li>)}</ol></div></section> : <PanelTabs key={p.number} label="Review sections" initial="code" tabs={[
      { id: "overview", label: "Overview", panel: <>
        {verdict && <section><H level={2}>Verdict</H><p><strong>{verdictLabels[verdict]}</strong> · computed from the score, unresolved findings and review coverage</p></section>}
        {p.score && <section><H level={2}>Confidence score</H><p><strong>{p.score.value}/5</strong> · confidence that the change is safe to merge</p><p>{p.score.reason}</p></section>}
      </> },
      { id: "findings", label: <>Findings{counts.map(([s, n]) => <span key={s} className={`badge ${s}`}>{priorityOf(s)} ×{n}</span>)}</>, panel: verified.length ? <section><H level={2}>Verified findings</H>{verified.map((f, i) => <VerifiedFinding key={f._id} f={f} open={i === 0} />)}</section> : <p className="muted">No verified findings in this review.</p> },
      { id: "code", label: "Code", panel: <section className="review-diff">
        <H level={2}>Changes</H>
        <p className="muted">Exact base…head comparison at {p.head.slice(0, 12)} · {p.files.length} file{p.files.length === 1 ? "" : "s"}</p>
        <DiffFiles files={p.files} findings={p.found} />
      </section> },
    ]} />}
  </>;
}

// ---------- Findings and fixes ----------
const agentName = (value: string) => agents.find(([v]) => v === value)?.[1] ?? value;
/** The dashboard's Fix button, with the bridge hand-off simulated. */
function FixControl({ label = "Fix with AI" }: { label?: string }) {
  const id = useId(), schedule = useSchedule();
  const [agent, setAgent] = useState("claude"), [preparing, setPreparing] = useState(false), [step, setStep] = useState(-1);
  const start = (e: FormEvent) => {
    e.preventDefault();
    setPreparing(true);
    setStep(-1);
    schedule([[500, () => { setPreparing(false); setStep(0); }], [900, () => setStep(1)], [900, () => setStep(2)], [1500, () => setStep(3)]]);
  };
  return <div className="fix-control">
    <form onSubmit={start}><label className="sr-only" htmlFor={id}>Coding agent</label><select id={id} value={agent} onChange={(e) => setAgent(e.target.value)}>{agents.map(([v, name]) => <option key={v} value={v}>{name}</option>)}</select><button className="primary" disabled={preparing}>{preparing ? "Preparing…" : label}</button></form>
    {step >= 0 && <p role="status">{fixStatuses[step]} <span className="muted">Simulated: in the app, {agentName(agent)} runs on your machine through the bridge. This does not mark the issue resolved.</span></p>}
  </div>;
}

type Finding = (typeof findings)[number];
/** A finding as the Findings page shows it, with the hand-off controls. */
function FindingCard({ f, full }: { f: Finding; full?: boolean }) {
  const [note, setNote] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(fixPrompt); setNote("Fix prompt copied."); }
    catch { setNote("Copy is blocked in this browser; select the prompt below instead."); }
  };
  return <section className="finding">
    <div className="row"><H level={2}>{f.title}</H><div>{priority(f)} {status("open")}</div></div>
    <p className="muted">{pull.repo} #{pull.number} · {f.filePath}:{f.startLine} · {Math.round(f.confidence * 100)}% confidence</p>
    <p><strong>Suggested fix:</strong> {f.suggestedFix}</p>
    <FixControl />
    {full && <>
      <button type="button" onClick={copy}>Copy fix prompt</button>
      <p className="agent-links">{agents.map(([v, name]) => <button key={v} type="button" className="button small" onClick={() => setNote(`Simulated: in the app, this opens ${name === "Cursor Agent" ? "Cursor" : name}.`)}>Open in {name === "Cursor Agent" ? "Cursor" : name}</button>)}<span className="muted"> Opens your agent with the prompt pre-filled; nothing runs until you send it.</span></p>
      {note && <p role="status" className="muted">{note}</p>}
      <details open><summary>Portable prompt for Codex, Claude Code, or Cursor</summary><pre>{fixPrompt}</pre></details>
    </>}
  </section>;
}

/** A quoted line shown in its file at the reviewed revision. */
function SourceView({ path, line }: { path: string; line: number }) {
  return <div className="source-view">
    <p className="muted">{path} at {pull.head.slice(0, 12)} · line {line} matches the quote</p>
    <ScrollTable label={`${path} at the reviewed revision`} className="table-scroll"><table className="diff-table"><tbody>
      {(sources[path] ?? []).map((text, i) => <tr key={i} className={i + 1 === line ? "source-quoted" : undefined}><td className="diff-num">{i + 1}</td><td><code>{text || " "}</code></td></tr>)}
    </tbody></table></ScrollTable>
  </div>;
}

function VerifiedFinding({ f, open: initial }: { f: Finding; open?: boolean }) {
  const [shown, setShown] = useState<string | null>(null);
  return <details className="verified-finding" open={initial}>
    <summary>{priority(f)} {f.title}</summary>
    <p>{f.filePath}:{f.startLine} · {Math.round(f.confidence * 100)}% confidence · Verified at this revision · Current status: open</p>
    <p>{f.description}</p>
    <p>Impact: {f.impact}</p>
    {f.evidence.map((e) => {
      const key = `${e.filePath}:${e.startLine}`;
      return <div key={key} className="evidence">
        <pre>{key}{"\n"}{e.quote}</pre>
        <button type="button" className="small" aria-expanded={shown === key} onClick={() => setShown(shown === key ? null : key)}>{shown === key ? "Hide file" : "Show in file"}</button>
        {shown === key && <SourceView path={e.filePath} line={e.startLine} />}
      </div>;
    })}
    <p>Suggested fix: {f.suggestedFix}</p>
  </details>;
}

// ---------- Chat ----------
type Message = { id: number; role: "user" | "assistant"; text: string; at: string; answer?: number; steps?: string[]; progress?: number; shown?: number; done: boolean };
type Thread = { id: number; title: string; messages: Message[] };
const sampleThreads = (): Thread[] => chat.answers.map((a, i) => ({
  id: i, title: a.question,
  messages: [{ id: i * 2, role: "user", text: a.question, at: chat.askedAt, done: true }, { id: i * 2 + 1, role: "assistant", text: a.answer, at: chat.askedAt, answer: i, done: true }],
}));

function ChatPane({ answers, autoplay }: { answers: ReactNode[]; autoplay?: { frame: RefObject<HTMLElement | null>; question: string } }) {
  const reduced = useReducedMotion(), schedule = useSchedule(), next = useRef(100);
  const [threads, setThreads] = useState(sampleThreads), [current, setCurrent] = useState<number | null>(0), [draft, setDraft] = useState("");
  const thread = threads.find((t) => t.id === current);
  const busy = threads.some((t) => t.messages.some((m) => !m.done));
  // While an answer arrives, keep the window scrolled to it; only the demo window scrolls, never the page.
  const root = useRef<HTMLDivElement>(null), follow = useRef(false);
  useEffect(() => {
    if (!follow.current) return;
    const screen = root.current?.closest(".replica-screen");
    screen?.scrollTo({ top: screen.scrollHeight });
    if (!busy) follow.current = false;
  }, [threads, busy]);
  const patch = (threadId: number, messageId: number, change: Partial<Message>) =>
    setThreads((list) => list.map((t) => t.id !== threadId ? t : { ...t, messages: t.messages.map((m) => m.id === messageId ? { ...m, ...change } : m) }));
  const ask = (question: string) => {
    const text = question.trim();
    if (busy || text.length < 2) return;
    const match = answerFor(text), index = match ? chat.answers.indexOf(match) : undefined;
    const threadId = thread?.id ?? next.current++, user = next.current++, reply = next.current++;
    const steps = match?.steps ?? ["Searching acme/shop for matching code"], body = match?.answer ?? chat.fallback;
    const messages: Message[] = [{ id: user, role: "user", text, at: "Just now", done: true }, { id: reply, role: "assistant", text: body, at: "Just now", answer: index, steps, progress: 0, shown: 0, done: false }];
    setThreads((list) => thread ? list.map((t) => t.id === threadId ? { ...t, messages: [...t.messages, ...messages] } : t) : [{ id: threadId, title: text, messages }, ...list]);
    setCurrent(threadId);
    setDraft("");
    follow.current = true;
    const words = wordCount(body), chunk = 3;
    schedule([
      ...steps.map((_, i): [number, () => void] => [550, () => patch(threadId, reply, { progress: i + 1 })]),
      ...(reduced ? [] : Array.from({ length: Math.ceil(words / chunk) }, (_, i): [number, () => void] => [i === 0 ? 400 : 45, () => patch(threadId, reply, { shown: (i + 1) * chunk })])),
      [reduced ? 400 : 120, () => patch(threadId, reply, { done: true })],
    ]);
  };
  useAutoplay(autoplay?.frame ?? root, autoplay && (() => ask(autoplay.question)));
  return <div className="chat-layout" ref={root}>
    <nav className="chat-threads" aria-label="Chat threads">
      <button type="button" className="button" onClick={() => setCurrent(null)}>New chat</button>
      <ul>{threads.map((t) => <li key={t.id}><button type="button" aria-current={t.id === current ? "page" : undefined} onClick={() => setCurrent(t.id)}>{t.title}</button></li>)}</ul>
    </nav>
    <div className="chat-main">
      {thread ? <section aria-label="Conversation">{thread.messages.map((m) => <article key={m.id} className={`chat-message ${m.role}`}>
        <p className="muted">{m.role === "user" ? "You" : "OpenReview"} · {m.at}{!m.done && <span> · <span className="badge running">running</span></span>}</p>
        {m.role === "user" ? <p className="chat-question">{m.text}</p>
          : !m.done && !m.shown ? <div className="chat-progress" role="status" aria-live="polite"><p className="muted">Working…</p><ol>{m.steps!.slice(0, Math.max(1, m.progress ?? 0)).map((s) => <li key={s}>{s}</li>)}</ol></div>
          : !m.done ? <p aria-hidden="true">{revealWords(m.text, m.shown ?? 0)}</p>
          : <div role="status" aria-live="polite">
            {m.answer === undefined ? <p>{m.text}</p> : answers[m.answer]}
            {m.answer !== undefined && <ol className="chat-citations" aria-label="Citations">{chat.answers[m.answer].citations.map((c) => <li key={c.ref}><code>{c.ref}</code><span className="muted"> @ {indexed.slice(0, 12)}</span><pre>{c.quote}</pre></li>)}</ol>}
          </div>}
      </article>)}</section>
        : <p className="muted">Ask about acme/shop. Answers are investigated with read-only code tools, and every claim cites lines at the indexed revision {indexed.slice(0, 12)}.</p>}
      <form className="form-grid chat-form" onSubmit={(e) => { e.preventDefault(); ask(draft); }}>
        <label className="wide">{thread ? "Follow-up question" : "Question"}<textarea rows={2} maxLength={400} value={draft} placeholder="Which tests cover charge()?" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(draft); } }} /></label>
        <button disabled={busy || draft.trim().length < 2}>{busy ? "Answering…" : "Ask"}</button>
      </form>
      <div className="demo-suggestions"><span className="muted">Try</span>{chat.answers.map((a) => <button key={a.question} type="button" className="small" disabled={busy} onClick={() => ask(a.question)}>{a.question}</button>)}</div>
    </div>
  </div>;
}

// ---------- Analytics ----------
const isoDays = (days: string[]) => days.map((d) => `2026-${d}`);
function AnalyticsPane() {
  const ids = useId();
  const [days, setDays] = useState(14), [repository, setRepository] = useState("all");
  const v = analyticsView(days, repository), labels = isoDays(v.days);
  const repos = Object.keys(analytics.repositories).map((r) => [r, analyticsView(days, r)] as const);
  const board = (caption: string, value: (view: ReturnType<typeof analyticsView>) => number) => <footer className="chart-board"><div className="chart-board-head"><h3 role="presentation">{caption}</h3></div><ol>{repos.map(([r, view]) => <li key={r}><Icon name="githubLogo" /><span className="chart-board-name">{r}</span><span className="chart-board-value">{value(view)}</span></li>)}</ol></footer>;
  const total = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return <>
    <div className="analytics-filters demo-filters">
      <label className="mini-select" htmlFor={`${ids}-repo`}><span className="sr-only">Repository</span><Icon name="code" /><select id={`${ids}-repo`} value={repository} onChange={(e) => setRepository(e.target.value)}><option value="all">All repositories</option>{Object.keys(analytics.repositories).map((r) => <option key={r}>{r}</option>)}</select><Icon name="caretUpDown" /></label>
      <label className="mini-select" htmlFor={`${ids}-days`}><span className="sr-only">Period</span><Icon name="calendarBlank" /><select id={`${ids}-days`} value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={14}>Last 14 days</option></select><Icon name="caretUpDown" /></label>
    </div>
    <dl className="stat-summary">{v.metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><strong>{value}</strong></dd></div>)}</dl>
    <div className="analytics-grid">
      <ChartCard icon="gitPullRequest" title="Reviews by OpenReview" labels={labels} views={[{ label: "Reviews", kind: "bar", series: [{ label: "Reviews", values: v.reviews }], yTitle: "Reviews" }]} footer={board("Top Repos by Review Count", (view) => total(view.reviews))} />
      <ChartCard icon="bug" title="Bugs caught" labels={labels} views={[{ label: "All Severity", kind: "bar", series: [{ label: "Bugs", values: v.findings }], yTitle: "Bugs caught" }]} footer={board("Repos with most bugs", (view) => total(view.findings))} />
      <ChartCard icon="check" title="Addressed" labels={labels} views={[{ label: "Addressed", kind: "line", average: true, series: [{ label: "Addressed", values: v.addressed }], yTitle: "Addressed" }]} info="Findings fixed or resolved after a review" footer={board("Top repos by addressed findings", (view) => total(view.addressed))} />
      <section className="chart-card"><header className="chart-card-head"><Icon name="warningCircle" /><h2 role="presentation">Findings by severity</h2></header><div className="chart-card-body">{v.severity.map(([sev, n]) => <div className="stat-row" key={sev}>{status(sev)}<strong>{n}</strong></div>)}</div></section>
    </div>
  </>;
}

// ---------- Repositories, providers, integrations, organization ----------
function RepositoriesPane() {
  const rows = Object.keys(analytics.repositories).map((r) => [r, analyticsView(7, r)] as const);
  return <>
    <div className="toolbar-row"><label className="search-field"><span className="sr-only">Search repositories</span><Icon name="magnifyingGlass" /><input placeholder="Search for repos by name" /></label><button type="button" className="primary">Manage Repos</button></div>
    <ScrollTable label="Repositories" className="table-box"><table><thead><tr><th>Repo</th><th>Reviews</th><th>Bugs caught</th><th>Status</th></tr></thead><tbody>
      {rows.map(([r, v]) => <tr key={r}><td><span className="repo-cell"><Icon name="githubLogo" />{r}</span></td><td>{v.reviews.reduce((a, b) => a + b, 0)} reviews</td><td>{v.findings.reduce((a, b) => a + b, 0)}</td><td>{chip("completed")}</td></tr>)}
    </tbody></table></ScrollTable>
  </>;
}
function ProvidersPane() {
  return <article className="provider-card" aria-label="GitHub Acme">
    <div className="provider-head"><span className="provider-name"><Icon name="githubLogo" /><span><strong>GitHub</strong></span></span><span className="provider-sync"><span><Icon name="clock" />Last Sync:</span><strong>2 minutes ago</strong></span></div>
    <details className="provider-foot"><summary><span>acme · Organization</span><span>{Object.keys(analytics.repositories).length} Repositories<Icon name="caretDown" /></span></summary>
      <div className="provider-more"><ul className="provider-repos">{Object.keys(analytics.repositories).map((r) => <li key={r}><Icon name="githubLogo" /><span>{r}</span></li>)}</ul></div></details>
  </article>;
}
function IntegrationsPane() {
  const [on, setOn] = useState<string[]>(["Linear"]);
  return <ScrollTable label="Integrations" className="table-box"><table><thead><tr><th>Integration</th><th>Status</th><th>Actions</th></tr></thead><tbody>
    {[["Linear", "Issues from selected teams and projects"], ["Atlassian", "Jira issues and Confluence pages linked from a pull request"], ["Notion", "Pages linked from a pull request"]].map(([name, about]) => <tr key={name}>
      <td><strong>{name}</strong><br /><span className="muted">{about}</span></td>
      <td><span className={on.includes(name) ? "status-chip completed" : "status-dot mono"}>{on.includes(name) ? <><Icon name="check" />Connected</> : "NOT CONFIGURED"}</span></td>
      <td><button type="button" className="small" onClick={() => setOn(on.includes(name) ? on.filter((x) => x !== name) : [...on, name])}>{on.includes(name) ? "Disconnect" : "Connect"}</button></td>
    </tr>)}
  </tbody></table></ScrollTable>;
}
function OrganizationPane() {
  return <ScrollTable label="People" className="table-box"><table><thead><tr><th>Email</th><th>Role</th><th>Actions</th></tr></thead><tbody>
    {[["dana@acme.dev", "Admin", "You"], ["sam@acme.dev", "Member", ""], ["lee@acme.dev", "Member", "Pending"]].map(([email, role, tag]) => <tr key={email}><td>{email} {tag && <span className="role-badge">{tag}</span>}</td><td>{role}</td><td>{tag !== "You" && <span className="muted">⋯</span>}</td></tr>)}
  </tbody></table></ScrollTable>;
}

// ---------- Custom Context ----------
function ContextPane() {
  const [view, setView] = useState<"rules" | "preferences">("rules");
  const [rules, setRules] = useState(memory.rules), [off, setOff] = useState<string[]>([]);
  return <>
    <Segmented label="Context views" value={view} onChange={setView} views={[["rules", "Custom rules"], ["preferences", "Learned preferences"]]} />
    {view === "rules" ? <ScrollTable label="Custom rules" className="table-box"><table><thead><tr><th>Rules</th><th>Scope</th><th>Status</th></tr></thead><tbody>
      {rules.map((r) => <tr key={r.id}><td><strong>{r.title}</strong><br /><span className="muted">{r.body}</span></td><td className="mono muted">{r.scope}</td>
        <td><label className="row-toggle"><span className="sr-only">{r.title} active</span><input type="checkbox" role="switch" className="toggle" checked={r.on} onChange={(e) => setRules(rules.map((x) => x.id === r.id ? { ...x, on: e.target.checked } : x))} /><span className="mono">{r.on ? "ACTIVE" : "INACTIVE"}</span></label></td></tr>)}
    </tbody></table></ScrollTable>
    : <ScrollTable label="Learned preferences" className="table-box"><table><thead><tr><th>Preference</th><th>Source</th><th>Status</th></tr></thead><tbody>
      {memory.preferences.map((pref) => <tr key={pref.id}><td>{pref.text}</td><td className="muted">{pref.source}</td>
        <td><input type="checkbox" role="switch" className="toggle" aria-label={`${pref.text} enabled`} checked={!off.includes(pref.id)} onChange={(e) => setOff(e.target.checked ? off.filter((x) => x !== pref.id) : [...off, pref.id])} /></td></tr>)}
    </tbody></table></ScrollTable>}
  </>;
}

// ---------- Settings ----------
const presets = [{ value: "1", label: "Quiet", hint: "High severity, very confident only" }, { value: "2", label: "Balanced", hint: "Medium severity and up" }, { value: "3", label: "Thorough", hint: "Everything worth a look" }];
const triggerToggles: [key: (typeof triggerFlags)[number], label: string, hint: string][] = [["automatic", "Review new pull requests", "When a pull request opens or is marked ready."], ["rereview", "Re-review new commits", "When new commits are pushed."], ["drafts", "Include drafts", "Also review draft pull requests."], ["threadReplies", "Answer replies", "Reply in OpenReview threads without an @openreview mention."]];

function SettingsPane({ previews }: { previews: SettingsPreviews }) {
  const [view, setView] = useState<"comments" | "triggers">("comments");
  return <>
    <Segmented label="Code review settings" value={view} onChange={setView} views={[["comments", "OpenReview Comments"], ["triggers", "When OpenReview Reviews"]]} />
    <SettingsView view={view} previews={previews} />
  </>;
}
function SettingsView({ view, previews }: { view: "comments" | "triggers"; previews: SettingsPreviews }) {
  const [strictness, setStrictness] = useState("2"), [on, setOn] = useState<Record<string, boolean>>({ automatic: true, rereview: true, drafts: false, threadReplies: true });
  const name = useId();
  if (view === "comments") {
    const outcomes = previews.comments[strictness] ?? [];
    return <section>
      <H level={2}>Review comments</H>
      <fieldset className="wizard-segments"><legend>How much to flag</legend>
        {presets.map((p) => <label key={p.value} className={strictness === p.value ? "active" : undefined}><input type="radio" name={name} value={p.value} checked={strictness === p.value} onChange={() => setStrictness(p.value)} /><strong>{p.label}</strong><span className="muted">{p.hint}</span></label>)}
      </fieldset>
      <p className="demo-readout" aria-live="polite">{outcomes.filter((o) => o.outcome === "posted").length} of {outcomes.length} example findings would post inline</p>
      <ul className="preview-findings">{outcomes.map((f) => <li key={f.id} data-posted={f.outcome === "posted"}>
        <span className={`badge ${f.severity}`}>{f.severity}</span><span className="preview-title">{f.title}<span className="mono muted">{f.path}:{f.line} · {f.category} · {Math.round(f.confidence * 100)}%</span></span>
        <span className={`badge ${f.outcome === "posted" ? "completed" : "queued"}`}>{f.outcome === "posted" ? "posts" : f.outcome}</span>
      </li>)}</ul>
    </section>;
  }
  const timeline = previews.triggers[triggerKey(on)] ?? [];
  return <section>
    <H level={2}>Triggers</H>
    <ul className="wizard-toggles">{triggerToggles.map(([key, label, hint]) => <li key={key} className="wizard-toggle"><label><span><strong>{label}</strong><span className="muted">{hint}</span></span>
      <input type="checkbox" role="switch" className="switch" checked={on[key]} onChange={(e) => setOn({ ...on, [key]: e.target.checked })} /></label></li>)}</ul>
    <p className="demo-readout" aria-live="polite">{timeline.filter((e) => e.review).length} of {timeline.length} example events start a review</p>
    <ol className="preview-timeline">{timeline.map((e) => <li key={e.id} data-review={e.review}><span className="preview-dot" /><span className="preview-title">{e.label}<span className="muted">{e.reason}</span></span>
      <span className={`badge ${e.review ? "completed" : "queued"}`}>{e.review ? (e.id === "reply" ? "answers" : "reviews") : "skipped"}</span></li>)}</ol>
  </section>;
}

// ---------- The hero: the whole app ----------
export function AppDemo({ answers, previews }: { answers: ReactNode[]; previews: SettingsPreviews }) {
  const [tab, setTab] = useState<Tab>("Pull Requests"), [visited, setVisited] = useState<Tab[]>(["Pull Requests"]);
  const [pullsView, setPulls] = useState<PullsView>(pull.number);
  const open = (t: Tab) => { setTab(t); setVisited((v) => v.includes(t) ? v : [...v, t]); };
  const detail = typeof pullsView === "number" ? pulls.find((p) => p.number === pullsView) : undefined;
  const panes: Record<Tab, ReactNode> = {
    "Pull Requests": detail ? <PullDetail p={detail} /> : <PullTable open={setPulls} />,
    Chat: <ChatPane answers={answers} />,
    Analytics: <AnalyticsPane />,
    Repositories: <RepositoriesPane />,
    "Code Review Settings": <SettingsPane previews={previews} />,
    "Custom Context": <ContextPane />,
    "Code Providers": <ProvidersPane />,
    Integrations: <IntegrationsPane />,
    "Organization Settings": <OrganizationPane />,
  };
  const title = tab === "Pull Requests" && detail ? `Pull Requests · ${pull.repo} #${detail.number}` : tab;
  return <Window title={title} label="Dashboard demo" size="tall" caption={`The OpenReview dashboard for a sample workspace, open at ${pull.repo} #${pull.number} on its Code tab: the reviewed diff with a P0 finding inline at the changed line. The Overview tab holds the "Needs changes" verdict and a confidence score of ${score.value} out of 5. Use the tabs to open Analytics, Repositories, Code Review Settings, Custom Context, Code Providers, Integrations and Organization Settings, and the chat button for Chat.`}>
    <Chrome active={tab} onTab={open}>
      {!(tab === "Pull Requests" && detail) && <PageHeader title={tab === "Organization Settings" ? "People" : tab} subtitle={subtitles[tab] || undefined} />}
      {(tabs as readonly Tab[]).concat("Chat").filter((t) => visited.includes(t)).map((t) => <div key={t} className="demo-pane" hidden={t !== tab}>{panes[t]}</div>)}
    </Chrome>
  </Window>;
}

// ---------- Feature demos ----------
export function EvidenceDemo() {
  return <Window title={`${pull.repo} #${pull.number} · Verified findings`} size="short" caption="Verified findings with the file and line each depends on, its impact, quoted evidence that can be shown in place in the file, and a suggested fix.">
    <div className="replica-pane portal replica-shell"><section>
      <H level={2}>Verified findings</H>
      <FixControl label="Fix All" />
      {findings.map((f, i) => <VerifiedFinding key={f._id} f={f} open={i === 0} />)}
    </section></div>
  </Window>;
}

export function SummaryDemo({ summaries }: { summaries: Record<string, ReactNode> }) {
  const schedule = useSchedule(), frame = useRef<HTMLElement>(null);
  const [revisions, setRevisions] = useState<Revision[]>(history), [selected, setSelected] = useState(history[0].sha);
  const [run, setRun] = useState<{ status: string; step: number } | null>(null);
  const reviewed = revisions.some((r) => r.sha === fixPush.sha);
  const rereview = () => {
    setRun({ status: "queued", step: 0 });
    schedule([
      [600, () => setRun({ status: "running", step: 1 })],
      ...fixPush.steps.slice(1).map((_, i): [number, () => void] => [650, () => setRun({ status: "running", step: i + 2 })]),
      [600, () => { setRun(null); setRevisions((list) => [fixPush.revision, ...list.filter((r) => r.sha !== fixPush.sha)]); setSelected(fixPush.sha); }],
    ]);
  };
  useAutoplay(frame, reviewed || run ? undefined : rereview);
  const shown = revisions.find((r) => r.sha === selected) ?? revisions[0];
  return <Window frame={frame} title={`${pull.repo} #${pull.number} · Review summary`} size="short" caption="The review summary for a pull request, with a button that re-reviews a newly pushed fix, and a history of reviews for each pushed revision.">
    <div className="replica-pane portal replica-shell">
      <section>
        <div className="row"><H level={2}>Review summary</H><button type="button" disabled={run !== null} onClick={rereview}>{run ? "Reviewing…" : "Re-review current PR"}</button></div>
        {!reviewed && !run && <p className="muted">@{pull.author} pushed {fixPush.sha.slice(0, 7)}: {fixPush.message} · not reviewed yet</p>}
        {run ? <div className="chat-progress" role="status" aria-live="polite"><p key="run" className="muted">{status(run.status)} {fixPush.sha.slice(0, 12)}</p><ol>{fixPush.steps.slice(0, run.step).map((s) => <li key={s}>{s}</li>)}</ol></div>
          : <div aria-live="polite"><p key="done" className="muted">{shown.sha.slice(0, 12)} · {shown.findings} {shown.findings === 1 ? "finding" : "findings"} · Score {shown.score}</p>{summaries[shown.sha]}</div>}
      </section>
      <section>
        <H level={2}>Review history</H>
        <ol className="timeline">{revisions.map((r) => <li key={r.sha}><button type="button" className="link-button" aria-current={r.sha === shown.sha ? "page" : undefined} onClick={() => setSelected(r.sha)}>{r.at} · {r.sha} · {r.status}</button><span>{r.findings} findings · Score {r.score}</span></li>)}</ol>
      </section>
    </div>
  </Window>;
}

export function ChatDemo({ answers }: { answers: ReactNode[] }) {
  const frame = useRef<HTMLElement>(null);
  return <Window frame={frame} title="Chat" size="short" caption="Codebase chat: pick a sample question or type one, watch the investigation steps, and read an answer whose citations quote the indexed source.">
    <div className="replica-pane portal replica-shell"><ChatPane answers={answers} autoplay={{ frame, question: chat.answers[1].question }} /></div>
  </Window>;
}

export function AgentDemo() {
  return <Window title="Analytics · Bugs Caught" size="short" caption="A finding under Analytics → Bugs Caught with controls to send it to Codex, Claude Code or Cursor Agent, copy a fix prompt, or open an agent with the prompt pre-filled.">
    <div className="replica-pane portal replica-shell"><FindingCard f={findings[0]} full /></div>
  </Window>;
}

export function AnalyticsDemo() {
  return <Window title="Analytics" caption="The analytics page with repository and period filters: pull requests, reviews, verified findings and model cost, daily review activity, findings by severity and a trend of reviews and findings per day.">
    <div className="replica-pane portal replica-shell"><AnalyticsPane /></div>
  </Window>;
}
