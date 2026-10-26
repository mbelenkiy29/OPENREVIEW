"use client";
// Greptile's setting controls for Code Review Settings: a level slider, a number stepper, a tag input and a
// sticky save bar. Each submits ordinary form fields, so the server actions read the same names as before.
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useFormStatus } from "react-dom";
import { Icon } from "../ui/icons";

/** Runs `restore` after the owning form resets (Discard, or React's reset after a saved action). */
export function useFormReset(ref: RefObject<HTMLElement | null>, restore: () => void) {
  const latest = useRef(restore);
  useEffect(() => { latest.current = restore; });
  useEffect(() => {
    const form = (ref.current as HTMLInputElement | null)?.form ?? ref.current?.closest("form");
    if (!form) return;
    // The reset event fires before the fields are reset, so read them on the next task.
    const listener = () => setTimeout(() => latest.current());
    form.addEventListener("reset", listener);
    return () => form.removeEventListener("reset", listener);
  }, [ref]);
}

export type Stop = { value: string; label: string; help: string };

/** A setting row with a LOW / MEDIUM / HIGH slider over a fixed list of values; the chosen level's effect
 *  shows in a chip under the title. The value is submitted from a hidden field. */
export function LevelSlider({ id, name, title, help, stops, value }: { id: string; name: string; title: string; help?: string; stops: Stop[]; value: string }) {
  const ref = useRef<HTMLInputElement>(null), initial = Math.max(0, stops.findIndex((s) => s.value === value));
  const [at, setAt] = useState(initial);
  useFormReset(ref, () => setAt(Number(ref.current?.value ?? initial)));
  const fill = stops.length > 1 ? (at / (stops.length - 1)) * 100 : 0;
  return <div className="setting-row level-row">
    <div>
      <label htmlFor={id}>{title}</label>
      {help && <p id={id + "-help"}>{help}</p>}
      <p className="level-chip" id={id + "-chip"} aria-live="polite">{stops[at].help}</p>
    </div>
    <div className="level-slider">
      <div className="level-labels" aria-hidden="true">{stops.map((s, i) => <span key={s.value} data-on={i === at || undefined}>{s.label}</span>)}</div>
      <input ref={ref} id={id} type="range" min={0} max={stops.length - 1} step={1} defaultValue={initial} aria-valuetext={stops[at].label} aria-describedby={(help ? id + "-help " : "") + id + "-chip"} style={{ "--fill": `${fill}%` } as CSSProperties} onInput={(e) => setAt(Number(e.currentTarget.value))} />
      <input type="hidden" name={name} value={stops[at].value} />
    </div>
  </div>;
}

/** A small number box with stacked chevrons; the arrows are pointer-only (the field takes arrow keys). */
export function Stepper({ id, name, value, min, max, step = 1, describedBy }: { id: string; name: string; value: number; min?: number; max?: number; step?: number; describedBy?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const nudge = (up: boolean) => {
    const input = ref.current;
    if (!input || input.disabled) return;
    if (up) input.stepUp(); else input.stepDown();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return <span className="number-stepper">
    <input ref={ref} id={id} name={name} type="number" inputMode="decimal" min={min} max={max} step={step} defaultValue={value} aria-describedby={describedBy} />
    <span className="number-stepper-arrows">
      <button type="button" tabIndex={-1} aria-label="Increase" onClick={() => nudge(true)}><Icon name="caretUp" /></button>
      <button type="button" tabIndex={-1} aria-label="Decrease" onClick={() => nudge(false)}><Icon name="caretDown" /></button>
    </span>
  </span>;
}

/** Removable chips for a comma-separated list; the field below is the list, joined, under `name`. */
export function TagInput({ id, name, value, placeholder, describedBy }: { id: string; name: string; value: string[]; placeholder?: string; describedBy?: string }) {
  const ref = useRef<HTMLInputElement>(null), [tags, setTags] = useState(value), [draft, setDraft] = useState("");
  useFormReset(ref, () => { setTags(value); setDraft(""); });
  const update = (next: string[]) => {
    setTags(next);
    // Chip clicks fire no input event; the save bar listens for one to know the form changed.
    queueMicrotask(() => ref.current?.dispatchEvent(new Event("input", { bubbles: true })));
  };
  const commit = (text: string) => {
    const added = text.split(",").map((t) => t.trim()).filter((t) => t && !tags.includes(t));
    if (added.length) update([...tags, ...added]);
    setDraft("");
  };
  return <div className="tag-input" onClick={() => ref.current?.focus()}>
    {tags.map((tag) => <span className="tag-chip" key={tag}>
      <button type="button" aria-label={`Remove ${tag}`} onClick={(e) => { e.stopPropagation(); update(tags.filter((t) => t !== tag)); }}><Icon name="x" /></button>{tag}
    </span>)}
    <input ref={ref} id={id} value={draft} placeholder={tags.length ? undefined : placeholder} aria-describedby={describedBy} autoComplete="off"
      onChange={(e) => e.target.value.includes(",") ? commit(e.target.value) : setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(draft); }
        else if (e.key === "Backspace" && !draft && tags.length) update(tags.slice(0, -1));
      }}
      onBlur={() => draft.trim() && commit(draft)} />
    {/* A typed value not yet turned into a chip is saved too. */}
    <input type="hidden" name={name} value={[...tags, draft.trim()].filter(Boolean).join(", ")} />
  </div>;
}

/** Sticky bar at the end of the settings form: Discard resets it, Save changes submits it. Fields outside
 *  the form element that belong to it (form="…") count as changes too. It slides up once something changed;
 *  until the page is interactive it stays visible, so the form can always be saved. */
export function SaveBar({ label = "Save changes" }: { label?: string }) {
  const ref = useRef<HTMLDivElement>(null), [dirty, setDirty] = useState(false), [ready, setReady] = useState(false), { pending } = useFormStatus();
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    setReady(true);
    const changed = (event: Event) => { if ((event.target as HTMLInputElement | null)?.form === form) setDirty(true); };
    const reset = () => setDirty(false);
    document.addEventListener("input", changed);
    document.addEventListener("change", changed);
    form.addEventListener("reset", reset);
    return () => {
      document.removeEventListener("input", changed);
      document.removeEventListener("change", changed);
      form.removeEventListener("reset", reset);
    };
  }, []);
  return <div ref={ref} className="save-bar" data-dirty={dirty || undefined} data-clean={(ready && !dirty && !pending) || undefined}>
    <p role="status">{pending ? "Saving…" : dirty ? "You have unsaved changes." : "No unsaved changes."}</p>
    <button type="reset" disabled={!dirty || pending}>Discard</button>
    <button className="primary" disabled={pending}>{label}</button>
  </div>;
}
