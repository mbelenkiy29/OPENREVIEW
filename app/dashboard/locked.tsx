import Link from "next/link";
import type { ReactNode } from "react";
import { planCatalog, plans, upgradeNote, type Entitlement } from "../../src/plans";

// A paid setting on a lower plan stays visible but disabled (links too, via inert), with the way to upgrade.
// `locked` is billing.locked: empty with billing off, so everything renders as usual.
// `note` replaces the default upgradeNote, whose wording some features word for a finished review.
export function Locked({ feature, locked, note, className, children }: { feature: Entitlement; locked: readonly Entitlement[]; note?: string; className?: string; children?: ReactNode }) {
  if (!locked.includes(feature)) return children;
  return <div className={`locked ${className ?? ""}`}>
    <p className="muted"><span className="badge">{planCatalog[plans.find((p) => planCatalog[p].entitlements.includes(feature)) ?? "pro"].name}</span> {note ?? upgradeNote[feature]} <Link href="/dashboard/organization/billing">Open Billing</Link></p>
    {children && <fieldset disabled inert>{children}</fieldset>}
  </div>;
}
