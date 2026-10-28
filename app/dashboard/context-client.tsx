"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Dialog, DialogClose, useCloseDialog } from "../ui/dialog";
import { Icon } from "../ui/icons";
import { parseRuleFile, ruleFiles } from "../../src/rule-files";
import { requestRuleAssistant, saveRule } from "./actions";
import { bulkRules, importRuleFile } from "./actions-context";

// Greptile's Custom Context pieces: the context table (checkbox column, expandable rows, bulk bar), the
// 23px type chip, the scope and file-pattern fields, and the four-step Add Context modal.

/** Pink scale = rule, lavender folder = file/pattern context, as in Greptile's TYPE column. */
export function TypeChip({ type, label }: { type: "rule" | "file"; label?: boolean }) {
  return <span className="type-chip-row"><span className={`type-chip ${type}`} title={type === "rule" ? "Rule" : "File"}><Icon name={type === "rule" ? "scales" : "folderStar"} /></span>{label ? <span className="mono-status">{type === "rule" ? "Rule" : "File"}</span> : <span className="sr-only">{type === "rule" ? "Rule" : "File"}</span>}</span>;
}

/** A form inside a Dialog that closes it on submit (the server action redirects or revalidates behind it). */
export function DialogForm({ action, onDone, className, children }: { action: (form: FormData) => void | Promise<void>; onDone?: () => void; className?: string; children: ReactNode }) {
  const close = useCloseDialog();
  return <form action={action} className={className ?? "stack"} onSubmit={() => { close(); onDone?.(); }}>{children}</form>;
}

export type ContextRow = {
  id: string;
  name: string;
  /** Opens the details drawer (rules); the name links there too. */
  href?: string;
  badge?: string;
  cells: ReactNode[];
  /** Shown inline under the row when expanded with the chevron. */
  detail?: ReactNode;
  selectable?: boolean;
  enabled?: boolean;
  current?: boolean;
};
const interactive = "a, button, input, select, textarea, label, summary, form, dialog";

export function ContextTable({ label, columns, rows, bulk, empty }: { label: string; columns: string[]; rows: ContextRow[]; bulk?: { organizationId: string }; empty?: ReactNode }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]), [open, setOpen] = useState<string[]>([]);
  const flip = (list: string[], id: string) => list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const choosable = bulk ? rows.filter((r) => r.selectable) : [], chosen = choosable.filter((r) => selected.includes(r.id));
  const all = chosen.length > 0 && chosen.length === choosable.length, op = chosen.some((r) => r.enabled) ? "deactivate" : "activate";
  const span = columns.length + (bulk ? 1 : 0), n = chosen.length;
  const ids = <>{bulk && <input type="hidden" name="organizationId" value={bulk.organizationId} />}{chosen.map((r) => <input key={r.id} type="hidden" name="ruleId" value={r.id} />)}</>;
  return <>
    {bulk && n > 0 && <div className="bulk-bar" role="group" aria-label="Bulk actions">
      <Dialog trigger={`Delete (${n})`} triggerClassName="text-danger" title={`Delete ${n === 1 ? "this rule" : `${n} rules`}?`} size="confirm">
        <DialogForm action={bulkRules} onDone={() => setSelected([])}>
          {ids}<input type="hidden" name="op" value="delete" />
          <div className="modal-body"><p>{n === 1 ? `“${chosen[0].name}” stops` : `${n} rules stop`} applying to reviews. This can’t be undone; deactivate {n === 1 ? "it" : "them"} instead to keep {n === 1 ? "it" : "them"}.</p></div>
          <div className="modal-footer"><DialogClose>Cancel</DialogClose><button className="danger solid">Delete</button></div>
        </DialogForm>
      </Dialog>
      <form action={bulkRules} onSubmit={() => setSelected([])}>{ids}<button className="primary" name="op" value={op}>{op === "deactivate" ? "Deactivate" : "Activate"} ({n})</button></form>
    </div>}
    <div className="table-box ctx-table-box">
      <table className="ctx-table" aria-label={label}>
        <thead><tr>
          {bulk && <th className="check-col"><input type="checkbox" aria-label="Select all rules on this page" checked={all} disabled={!choosable.length} ref={(el) => { if (el) el.indeterminate = n > 0 && !all; }} onChange={() => setSelected(all ? [] : choosable.map((r) => r.id))} /></th>}
          {columns.map((c) => <th key={c} scope="col">{c}</th>)}
        </tr></thead>
        <tbody>
          {!rows.length && <tr><td colSpan={span} className="ctx-empty">{empty ?? "No results."}</td></tr>}
          {rows.map((r) => {
            const expanded = open.includes(r.id);
            return <Fragment key={r.id}>
              <tr className={r.href ? "clickable" : undefined} aria-current={r.current ? "true" : undefined} onClick={(e) => { if (r.href && !(e.target as Element).closest(interactive)) router.push(r.href, { scroll: false }); }}>
                {bulk && <td className="check-col">{r.selectable && <input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.includes(r.id)} onChange={() => setSelected((s) => flip(s, r.id))} />}</td>}
                <td className="name-col"><div className="name-cell">
                  {r.detail ? <button type="button" className="expander" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${r.name}`} onClick={() => setOpen((o) => flip(o, r.id))}><Icon name="caretRight" /></button> : <span className="expander-gap" />}
                  {r.href ? <Link href={r.href} scroll={false} className="name-link">{r.name}</Link> : <span className="name-link">{r.name}</span>}
                  {r.badge && <span className="badge tag">{r.badge}</span>}
                </div></td>
                {r.cells.map((c, i) => <td key={i}>{c}</td>)}
              </tr>
              {expanded && <tr className="ctx-detail"><td colSpan={span}>{r.detail}</td></tr>}
            </Fragment>;
          })}
        </tbody>
      </table>
    </div>
  </>;
}

type Option = { id: string; label: string; name?: string };
export type ScopeValue = { scope: string; pattern: string; globs: string[] };

/** File-pattern chips: Enter or comma adds one, Backspace removes the last; submitted comma-separated as `globs`. */
function PatternChips({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => { const v = draft.trim().replace(/,+$/, ""); if (v && !value.includes(v)) onChange([...value, v]); setDraft(""); };
  return <div className="chip-input" onClick={(e) => (e.currentTarget.querySelector("input:not([type=hidden])") as HTMLInputElement | null)?.focus()}>
    <input type="hidden" name="globs" value={[...value, draft.trim()].filter(Boolean).join(",")} />
    {value.map((g) => <span className="value-chip" key={g}>{g}<button type="button" aria-label={`Remove ${g}`} onClick={() => onChange(value.filter((x) => x !== g))}><Icon name="x" /></button></span>)}
    {!value.length && !draft && <span className="value-chip">auto</span>}
    <input id={id} value={draft} placeholder="e.g. src/**/*.tsx" maxLength={200} onChange={(e) => setDraft(e.target.value)} onBlur={add}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1)); }} />
  </div>;
}

/** Repository (workspace, team, repository pattern or one repository) and file patterns, named for saveRule. */
function ScopeFields({ id, value, set, teams, repositories }: { id: string; value: ScopeValue; set: (v: ScopeValue) => void; teams: Option[]; repositories: Option[] }) {
  return <div className="scope-grid">
    <label>Repository
      <select name="scope" value={value.scope} onChange={(e) => set({ ...value, scope: e.target.value })}>
        <option value="">All repositories</option>
        {teams.map((t) => <option key={t.id} value={"team:" + t.id}>Team: {t.label}</option>)}
        <option value="pattern">Repositories matching a pattern</option>
        {repositories.map((r) => <option key={r.id} value={"repo:" + r.id}>{r.label}</option>)}
      </select>
    </label>
    <div className="field"><label htmlFor={id + "-globs"}>File pattern</label><PatternChips id={id + "-globs"} value={value.globs} onChange={(globs) => set({ ...value, globs })} /></div>
    {value.scope === "pattern" ? <label className="wide">Repository pattern<input name="repositoryPattern" required maxLength={200} placeholder="acme/*-service" value={value.pattern} onChange={(e) => set({ ...value, pattern: e.target.value })} /></label> : <input type="hidden" name="repositoryPattern" value="" />}
  </div>;
}

/** The drawer's edit mode keeps its own scope state. */
export function ScopeEditor({ id, initial, teams, repositories }: { id: string; initial: ScopeValue; teams: Option[]; repositories: Option[] }) {
  const [value, set] = useState(initial);
  return <ScopeFields id={id} value={value} set={set} teams={teams} repositories={repositories} />;
}

/** The chips that summarize a scope ("all repos", "**\/*.py"). */
function scopeChips(v: ScopeValue, teams: Option[], repositories: Option[]) {
  const repo = v.scope.startsWith("repo:") ? repositories.find((r) => r.id === v.scope.slice(5))?.name : v.scope.startsWith("team:") ? `team: ${teams.find((t) => t.id === v.scope.slice(5))?.label ?? "team"}` : v.scope === "pattern" ? v.pattern || "pattern" : "all repos";
  return [repo ?? "repository", ...(v.globs.length ? v.globs : ["all files"])];
}

function Step({ n, label, aside, children }: { n: number; label: string; aside?: ReactNode; children?: ReactNode }) {
  return <div className="ctx-step">
    <div className="ctx-step-head"><span className="step-badge">{n}</span><span>{label}</span>{aside}</div>
    {children}
  </div>;
}

const severities = ["critical", "high", "medium", "low"];
const example = "What: Use logging instead of printing log messages\n\nWhy: We can't filter printed messages\n\nGood: logger.error(\"error message\")\n\nBad: print(\"error message\")";

// Add Context: Greptile's 487px stepper. Steps 1–3 share the first page, step 4 reviews; Rule saves through
// saveRule, File imports an AI rules file as suggestions. Optimize hands the description to the rule assistant.
export function AddContext({ organizationId, returnTo, open, teams, repositories, initialScope, busy }: { organizationId: string; returnTo: string; open: boolean; teams: Option[]; repositories: Option[]; initialScope: string; busy: boolean }) {
  return <Dialog trigger={<><Icon name="plus" />Add Context</>} triggerClassName="primary" title="Add Context" description="Define custom rules and files for OpenReview to apply." open={open}>
    <AddContextForm organizationId={organizationId} returnTo={returnTo} teams={teams} repositories={repositories} initialScope={initialScope} busy={busy} />
  </Dialog>;
}

function AddContextForm({ organizationId, returnTo, teams, repositories, initialScope, busy }: { organizationId: string; returnTo: string; teams: Option[]; repositories: Option[]; initialScope: string; busy: boolean }) {
  const close = useCloseDialog();
  const [type, setType] = useState<"rule" | "file">("rule"), [review, setReview] = useState(false);
  const [title, setTitle] = useState(""), [text, setText] = useState(""), [severity, setSeverity] = useState("medium");
  const [scope, setScope] = useState<ScopeValue>({ scope: initialScope, pattern: "", globs: [] });
  const [path, setPath] = useState<string>("AGENTS.md"), [content, setContent] = useState(""), [repository, setRepository] = useState(initialScope.startsWith("repo:") ? initialScope.slice(5) : "");
  const candidates = useMemo(() => type === "file" ? parseRuleFile(path, content) : [], [type, path, content]);
  const ready = type === "rule" ? Boolean(title.trim() && text.trim() && (scope.scope !== "pattern" || scope.pattern.trim())) : candidates.length > 0;
  const chips = type === "rule" ? [...scopeChips(scope, teams, repositories), `severity: ${severity}`] : [repository ? repositories.find((r) => r.id === repository)?.name ?? "repository" : "all repos"];
  return <form className="ctx-add stack" action={type === "rule" ? saveRule : importRuleFile} onSubmit={() => { close(); setReview(false); }}>
    <input type="hidden" name="organizationId" value={organizationId} />
    <input type="hidden" name="returnTo" value={returnTo} />
    <div className="modal-body ctx-steps" hidden={review}>
      <Step n={1} label="Choose a context type" aside={<div className="segmented" role="group" aria-label="Context type">
        {(["rule", "file"] as const).map((t) => <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}>{t === "rule" ? "Rule" : "File"}</button>)}
      </div>} />
      {type === "rule" ? <>
        <Step n={2} label="Teach OpenReview how to use your codebase">
          <div className="field-pair">
            <label>Title<input name="title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Avoid hardcoded secrets" /></label>
            <label>Severity<select name="severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>{severities.map((v) => <option key={v}>{v}</option>)}</select></label>
          </div>
          <div className="field">
            <label htmlFor="add-context-instructions">Rule Description</label>
            <div className="textarea-wrap">
              <textarea id="add-context-instructions" name="instructions" rows={9} required maxLength={10000} value={text} onChange={(e) => setText(e.target.value)} placeholder={example} />
              <input type="hidden" name="kind" value="draft" /><input type="hidden" name="description" value={text} />
              <button className="primary optimize" formAction={requestRuleAssistant} formNoValidate disabled={busy || text.trim().length < 10} title={busy ? "The rule assistant is still working on an earlier request" : "Ask the rule assistant to draft this rule"}><Icon name="magicWand" />Optimize</button>
            </div>
            <p className="hint">Optimize asks the rule assistant to draft a rule from your description; it appears in the table as a suggestion to approve.</p>
          </div>
        </Step>
        <Step n={3} label="Apply this rule to a scope">
          <span className="field-label">Scope</span>
          <ScopeFields id="add-context" value={scope} set={setScope} teams={teams} repositories={repositories} />
        </Step>
      </> : <>
        <Step n={2} label="Teach OpenReview with an AI rules file">
          <label>File<input name="path" list="rule-file-names" required maxLength={200} value={path} onChange={(e) => setPath(e.target.value)} /></label>
          <datalist id="rule-file-names">{ruleFiles.map((f) => <option key={f} value={f} />)}<option value=".cursor/rules/review.mdc" /></datalist>
          <div className="field">
            <label htmlFor="add-context-file">File contents</label>
            <textarea id="add-context-file" name="content" rows={9} required maxLength={200000} value={content} onChange={(e) => setContent(e.target.value)} placeholder={"# Conventions\n- Always validate organization membership in API routes.\n- Never log access tokens."} />
            <p className="hint">Paste the file or <label className="upload-link">upload it<input type="file" className="sr-only" accept=".md,.mdc,.txt,.cursorrules,.windsurfrules" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setContent((await f.text()).slice(0, 200000)); if (!path || path === "AGENTS.md") setPath(f.name); } }} /></label>. Directive lines about code (always, never, must, avoid…) become rules to approve.</p>
          </div>
        </Step>
        <Step n={3} label="Apply these rules to a repository">
          <label>Repository<select name="repositoryId" value={repository} onChange={(e) => setRepository(e.target.value)}><option value="">All repositories</option>{repositories.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
        </Step>
      </>}
    </div>
    {review && <div className="modal-body ctx-steps ctx-review">
      <Step n={4} label="Review and confirm" />
      <div className="field">
        <span className="field-label">{type === "rule" ? "Rule Description" : `${candidates.length} ${candidates.length === 1 ? "rule" : "rules"} found in ${path}`}</span>
        <pre className="ctx-preview">{type === "rule" ? `${title.trim()}\n\n${text.trim()}` : candidates.slice(0, 50).map((c) => `• ${c.instructions}${c.globs.length ? `  [${c.globs.join(", ")}]` : ""}`).join("\n")}</pre>
      </div>
      <div className="field"><span className="field-label">Scope</span><div className="chip-box">{chips.map((c, i) => <span key={i} className="mono-chip">{c}</span>)}</div></div>
    </div>}
    <div className="modal-footer split">
      {review ? <button key="back" type="button" onClick={() => setReview(false)}>Back</button> : <DialogClose key="cancel">Cancel</DialogClose>}
      {/* Distinct keys: a reused node would turn into the submit button before the click's default action runs. */}
      {review ? <button key="create" className="primary"><Icon name="magicWand" />{type === "rule" ? "Create Context" : `Import ${candidates.length === 1 ? "rule" : "rules"}`}</button>
        : <button key="next" type="button" className="primary" disabled={!ready} onClick={() => setReview(true)}>Next<Icon name="arrowRight" /></button>}
    </div>
  </form>;
}
