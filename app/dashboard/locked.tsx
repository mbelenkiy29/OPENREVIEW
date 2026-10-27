import Link from "next/link";
import type { ReactNode } from "react";
import { planCatalog, tierFor, type EntitlementKey } from "../../src/plans";

// A paid feature the workspace's plan does not include (pricing-tiers P0.4): its controls stay
// visible but disabled, with one line naming the plan that has it. Unlocked, children render as is.
export function Locked({ feature, unlocked, admin, children }: { feature: EntitlementKey; unlocked: boolean; admin: boolean; children: ReactNode }) {
  if (unlocked) return children;
  return <fieldset className="locked" disabled>
    {children}
    <p className="locked-note">Included in the {planCatalog[tierFor(feature)].name} plan. {admin ? <Link href="/dashboard/settings/billing">Upgrade in Settings → Billing</Link> : "Ask a workspace admin to upgrade."}</p>
  </fieldset>;
}
