import type { Viewport } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { activeWorkspace, scopesFor, viewer } from "../load";
import { PortalNav } from "../portal";

// Phones: the bottom tab bar pads itself clear of the home indicator (safe-area insets).
export const viewport: Viewport = { viewportFit: "cover" };

// The app chrome (header, tabs, sidebar) renders once and stays mounted while the pages below it change.
// No loading.tsx or Suspense in this group: a boundary below this layout is keyed by the page and would
// flash a skeleton on every tab switch. app/dashboard/loading.tsx covers the first load.
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await viewer(), jar = await cookies(), organization = activeWorkspace(user, jar);
  if (!organization?._id) redirect("/dashboard/onboarding/workspace");
  const { teams } = await scopesFor(user.token, organization._id);
  return <div className="shell portal">
    <PortalNav login={user.user.login} role={organization.role} organizationId={organization._id} name={organization.name ?? "Workspace"}
      organizations={user.organizations.flatMap((o) => o._id ? [{ _id: o._id, name: o.name ?? "Workspace" }] : [])}
      teams={teams.map((t) => ({ _id: t._id, name: t.name }))} savedTeam={jar.get("openreview_team")?.value} />
    {children}
  </div>;
}
