import Link from "next/link";
import type { ReactNode } from "react";
import { upgradeNote, type Entitlement } from "../../src/plans";

// A Pro setting on a lower plan stays visible but disabled (links too, via inert), with the way to upgrade.
// `locked` is billing.locked: empty with billing off, so everything renders as usual.
export function Locked({ feature, locked, className, children }: { feature: Entitlement; locked: readonly Entitlement[]; className?: string; children?: ReactNode }) {
  if (!locked.includes(feature)) return children;
  return <div className={`locked ${className ?? ""}`}>
    <p className="muted"><span className="badge">Pro</span> {upgradeNote[feature]} <Link href="/dashboard/settings/billing">Open Billing</Link></p>
    {children && <fieldset disabled inert>{children}</fieldset>}
  </div>;
}
