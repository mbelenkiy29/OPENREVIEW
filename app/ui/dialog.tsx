"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

// Greptile's modal: a square white box on a white wash, opened by its trigger button. A native <dialog>
// (showModal) traps focus, closes on Escape and returns focus to the trigger. It renders into <body>, so
// a trigger inside a menu can close its menu without closing the dialog.

const CloseContext = createContext<() => void>(() => {});
/** Closes the enclosing Dialog, e.g. from a form's onSubmit or a Cancel button. */
export const useCloseDialog = () => useContext(CloseContext);

export function Dialog({ trigger, triggerClassName, triggerLabel, title, description, size = "standard", open: openOnMount = false, onClose, children }: {
  /** The trigger button's content. */
  trigger: ReactNode;
  triggerClassName?: string;
  /** Accessible name for an icon-only trigger. */
  triggerLabel?: string;
  title: ReactNode;
  description?: ReactNode;
  /** confirm 426px, standard 487px, wide 609px. */
  size?: "confirm" | "standard" | "wide";
  /** Open on first render (dialogs driven by the URL). */
  open?: boolean;
  /** Runs on every close: the X, Escape, the backdrop or useCloseDialog. */
  onClose?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null), id = useId(), [body, setBody] = useState<HTMLElement | null>(null);
  useEffect(() => setBody(document.body), []);
  useEffect(() => { if (body && openOnMount && !ref.current?.open) ref.current?.showModal(); }, [body, openOnMount]);
  const close = () => ref.current?.close();
  return <>
    <button type="button" className={triggerClassName} aria-label={triggerLabel} aria-haspopup="dialog" onClick={() => ref.current?.showModal()}>{trigger}</button>
    {body && createPortal(
      // A click on the dialog itself (not its content) is a click on the backdrop.
      <dialog ref={ref} className={`modal ${size}`} aria-labelledby={`${id}-title`} onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
        <div className="modal-box">
          {size !== "confirm" && <header className="modal-header">
            <div><h2 id={`${id}-title`}>{title}</h2>{description && <p>{description}</p>}</div>
            <button type="button" className="modal-close" aria-label="Close" onClick={close}><Icon name="x" /></button>
          </header>}
          {size === "confirm" && <h2 id={`${id}-title`} className="modal-title">{title}</h2>}
          <CloseContext.Provider value={close}>{children}</CloseContext.Provider>
        </div>
      </dialog>, body)}
  </>;
}

/** A button that closes the enclosing Dialog. */
export function DialogClose({ children, className = "outline" }: { children: ReactNode; className?: string }) {
  const close = useCloseDialog();
  return <button type="button" className={className} onClick={close}>{children}</button>;
}

/** Disables its button until the typed value matches `phrase` (Greptile's type-to-confirm). */
export function ConfirmPhrase({ phrase, name = "confirm", children }: { phrase: string; name?: string; children: (matches: boolean) => ReactNode }) {
  const [value, setValue] = useState("");
  return <>
    <label className="confirm-phrase">Please type: <strong>{phrase}</strong><input name={name} value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" spellCheck={false} required /></label>
    {children(value === phrase)}
  </>;
}
