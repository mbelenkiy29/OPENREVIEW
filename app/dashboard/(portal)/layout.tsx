import type { Viewport } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api } from "../../../convex/_generated/api";
import { billingConfig } from "../../../src/billing";
import { backend } from "../../../src/server";
import { activeWorkspace, scopesFor, teamChoices, viewer } from "../load";
import { PortalNav } from "../portal";

// Landscape phones: the chrome pads itself clear of the notch (safe-area insets).
export const viewport: Viewport = { viewportFit: "cover" };

// The app chrome (banner, header, tabs) renders once and stays mounted while the pages below it change.
// No loading.tsx or Suspense in this group: a boundary below this layout is keyed by the page and would
// flash a skeleton on every tab switch. app/dashboard/loading.tsx covers the first load.
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await viewer(), jar = await cookies(), organization = activeWorkspace(user, jar);
  if (!organization?._id) redirect("/dashboard/onboarding/workspace");
  const [scopes, billing] = await Promise.all([
    scopesFor(user.token, organization._id),
    billingConfig().enabled ? backend().query(api.billing.status, { token: user.token, organizationId: organization._id }).catch(() => null) : null,
  ]);
  // Greptile's trial banner: the days left of a running trial that has no payment method on file.
  const trialLeft = billing?.enabled && billing.status === "trialing" ? Math.max(0, Math.ceil((billing.trialEndsAt - Date.now()) / 86400000)) : undefined;
  // Without a card the banner runs the whole trial; with one it reminds in the last 3 days that the card will be charged.
  const trialDaysLeft = trialLeft !== undefined && (!billing?.hasPaymentMethod || trialLeft <= 3) ? trialLeft : undefined;
  const trialCharge = trialDaysLeft !== undefined && billing?.enabled && billing.hasPaymentMethod ? { plan: billing.planName ?? "paid", date: new Date(billing.trialEndsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) } : undefined;
  // Every page warns from 80% of the included usage, and when reviews are blocked, not just Billing & Usage.
  const percent = billing?.enabled && billing.limit ? Math.round(((billing.used + billing.reserved) / billing.limit) * 100) : 0;
  const usage = billing?.enabled && (!billing.allowed || percent >= 80) ? { admin: billing.admin, free: billing.plan === "free", text: !billing.allowed ? billing.reason ?? "This workspace can’t run more reviews this month." : `This workspace used ${Math.min(100, percent)}% of this month’s included usage${billing.reviewsLeft !== null ? `, about ${billing.reviewsLeft} reviews left` : ""}.` } : undefined;
  return <div className="shell portal">
    <PortalNav login={user.user.login} avatar={user.user.avatar || undefined} email={user.email} role={organization.role} organizationId={organization._id} name={organization.name ?? "Workspace"}
      organizations={user.organizations.flatMap((o) => o._id ? [{ _id: o._id, name: o.name ?? "Workspace" }] : [])}
      teams={teamChoices(scopes).map((t) => ({ _id: t._id, name: t.name }))} savedTeam={jar.get("openreview_team")?.value} trialDaysLeft={trialDaysLeft} trialCharge={trialCharge} usage={usage} billingPortal={Boolean(billing?.enabled && billing.admin && billing.hasCustomer)} operator={user.operator} />
    {children}
  </div>;
}
