import { ButtonLink, EmptyState } from "../../ui";

// Rendered inside the portal layout, so the header and tabs stay visible.
export default function DashboardNotFound() {
  return <main className="content"><EmptyState title="Not found" action={<ButtonLink href="/dashboard" tone="primary">Back to the dashboard</ButtonLink>}>This page, repository or review does not exist, or you no longer have access to it.</EmptyState></main>;
}
