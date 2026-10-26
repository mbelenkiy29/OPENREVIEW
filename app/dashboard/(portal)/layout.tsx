import type { Viewport } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api } from "../../../convex/_generated/api";
import { billingConfig } from "../../../src/billing";
import { backend } from "../../../src/server";
import { activeWorkspace, scopesFor, viewer } from "../load";
import { PortalNav } from "../portal";

// Landscape phones: the chrome pads itself clear of the notch (safe-area insets).
export const viewport: Viewport = { viewportFit: "cover" };

// The app chrome (banner, header, tabs) renders once and stays mounted while the pages below it change.
// No loading.tsx or Suspense in this group: a boundary below this layout is keyed by the page and would
// flash a skeleton on every tab switch. app/dashboard/loading.tsx covers the first load.
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await viewer(), jar = await cookies(), organization = activeWorkspace(user, jar);
  if (!organization?._id) redirect("/dashboard/onboarding/workspace");
  const [{ teams }, billing] = await Promise.all([
    scopesFor(user.token, organization._id),
    billingConfig().enabled ? backend().query(api.billing.status, { token: user.token, organizationId: organization._id }).catch(() => null) : null,
  ]);
  // Greptile's trial banner: the days left of a running trial.
  const trialDaysLeft = billing?.enabled && billing.status === "trialing" ? Math.max(0, Math.ceil((billing.trialEndsAt - Date.now()) / 86400000)) : undefined;
  return <div className="shell portal">
    <PortalNav login={user.user.login} avatar={user.user.avatar || undefined} email={user.email} role={organization.role} organizationId={organization._id} name={organization.name ?? "Workspace"}
      organizations={user.organizations.flatMap((o) => o._id ? [{ _id: o._id, name: o.name ?? "Workspace" }] : [])}
      teams={teams.map((t) => ({ _id: t._id, name: t.name }))} savedTeam={jar.get("openreview_team")?.value} trialDaysLeft={trialDaysLeft} billingPortal={Boolean(billing?.enabled && billing.admin && billing.hasCustomer)} operator={user.operator} />
    {children}
  </div>;
}
