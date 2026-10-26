import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "../../ui/icons";
import { logout } from "../actions";
import { SignOutForm } from "../../telemetry-identity";
import { finishSetup } from "./actions";
import { ShortcutHint, WizardShortcuts } from "./wizard-client";
import { configureLabels, configureSteps, previousStep, stepsFor, stepTitles, type ConfigureStep, type WizardStep } from "../../../src/onboarding-steps";

/** Full-screen setup frame on Greptile's dotted canvas: the step body, then a bar with Logout and
 *  exit on the left, Back (⌘+⇧+↵) and Next (⌘+↵) centred, and where you are on the right. */
export function WizardFrame({ step, workspace, organizationId, admin, completed, billing = false, planMissing, nextLabel, nextHref, centered, children }: {
  step: WizardStep; workspace?: string; organizationId?: string; admin: boolean; completed?: boolean; billing?: boolean; planMissing?: boolean;
  nextLabel: string; nextHref?: string; centered?: boolean; children: ReactNode;
}) {
  const steps = stepsFor(billing), back = previousStep(step, billing), position = steps.indexOf(step) + 1;
  const backHref = back ? `/dashboard/onboarding/${back}` : undefined;
  return <main className="wizard" data-step={step}>
    <div className={`wizard-body${centered ? " centered" : ""}`}>{children}</div>
    <footer className="wizard-bar">
      <div className="wizard-exit">
        <SignOutForm action={logout} label="Logout" className="link" />
        {/* Until a plan is chosen the server refuses to finish setup and the dashboard leads back here, so there is no way out to offer. */}
        {organizationId && step !== "done" && !planMissing && (admin && !completed
          ? <form action={finishSetup}><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="skipped" value="true" /><button className="link">Exit setup</button></form>
          : <Link className="link" href="/dashboard/analytics">Back to dashboard</Link>)}
      </div>
      <nav className="wizard-nav" aria-label="Setup steps">
        {backHref && <Link className="button" href={backHref} aria-keyshortcuts="Meta+Shift+Enter Control+Shift+Enter">Back <ShortcutHint shift /></Link>}
        {admin || step === "workspace"
          ? <button className="primary" type="submit" form="wizard-form" aria-keyshortcuts="Meta+Enter Control+Enter">{nextLabel} <ShortcutHint /><Icon name="arrowRight" /></button>
          : nextHref && <Link className="button primary" href={nextHref}>Next <ShortcutHint /><Icon name="arrowRight" /></Link>}
      </nav>
      <p className="wizard-position">{workspace && <span className="wizard-workspace">{workspace}</span>}Step {position} of {steps.length}</p>
    </footer>
    <WizardShortcuts nextHref={admin ? undefined : nextHref} backHref={backHref} />
  </main>;
}

export function Heading({ step, children }: { step: WizardStep; children: ReactNode }) {
  return <div className="wizard-heading"><h1 tabIndex={-1} data-wizard-heading>{stepTitles[step]}</h1><p className="wizard-lede">{children}</p></div>;
}
/** Greptile's wizard tabs: a 5px bar over a mono label for each configuration step. */
export function ConfigureProgress({ step }: { step: ConfigureStep }) {
  const at = configureSteps.indexOf(step);
  return <ol className="wizard-progress" aria-label="Review configuration">
    {configureSteps.map((s, i) => <li key={s} aria-current={i === at ? "step" : undefined} data-done={i < at || undefined}>{configureLabels[s]}</li>)}
  </ol>;
}
export function ReadOnlyNote({ admin }: { admin: boolean }) {
  return admin ? null : <p className="muted" role="note">A workspace admin manages setup. You can look through each step.</p>;
}
