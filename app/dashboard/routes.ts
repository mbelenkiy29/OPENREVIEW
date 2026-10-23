// The dashboard's information architecture: Greptile's eight tabs as captured on Mobbin, the pages under
// each, and the internal section each page renders. The loader and the section views stay keyed by the
// internal sections (settings/*, memory/*), so a page's URL is decided here and nowhere else.
// Plain data: imported by server code, client navigation and next.config.ts redirects.

export type Page = {
  /** Path under /dashboard/<tab>; "" is the tab's own page. */
  path: string;
  /** The section array the loader and views use. */
  internal: string[];
  /** Sub-navigation label (settings-style tabs) or view label. */
  label: string;
  title: string;
  subtitle?: string;
};

export const tabs: [key: string, label: string][] = [
  ["analytics", "Analytics"],
  ["repositories", "Repositories"],
  ["code-review", "Code Review Settings"],
  ["context", "Custom Context"],
  ["pulls", "Pull Requests"],
  ["providers", "Code Providers"],
  ["integrations", "Integrations"],
  ["organization", "Organization Settings"],
];

export const pages: Record<string, Page[]> = {
  repositories: [
    { path: "", internal: ["settings", "repositories"], label: "Repositories", title: "Repositories", subtitle: "Manage connected repositories and view review metrics." },
    { path: "knowledge", internal: ["memory", "knowledge"], label: "Knowledge Base", title: "Knowledge Base", subtitle: "Browse what OpenReview learned from each repository." },
  ],
  "code-review": [
    { path: "", internal: ["settings", "review"], label: "Review settings", title: "Code Review Settings", subtitle: "Configure how OpenReview reviews your pull requests." },
    { path: "model", internal: ["settings", "model"], label: "AI Model", title: "AI Model", subtitle: "Choose the model OpenReview reviews, chats and fixes with." },
    { path: "automation", internal: ["settings", "automation"], label: "Runtime & Approval", title: "Runtime & Approval", subtitle: "Control where agents run and which actions need approval." },
  ],
  context: [
    { path: "", internal: ["memory", "rules"], label: "Custom rules", title: "Custom Context" },
    { path: "learned", internal: ["memory", "preferences"], label: "Learned preferences", title: "Custom Context" },
    { path: "cross-repo", internal: ["memory", "clusters"], label: "Cross-repo context", title: "Custom Context" },
  ],
  providers: [
    { path: "", internal: ["settings", "providers"], label: "Code Providers", title: "Code Providers", subtitle: "Connect or manage your code providers." },
  ],
  integrations: [
    { path: "", internal: ["memory", "integrations"], label: "Integrations", title: "Integrations", subtitle: "Connect the tools OpenReview reads context from and reports to." },
  ],
  organization: [
    { path: "", internal: ["settings", "organization"], label: "Organization", title: "Organization Settings", subtitle: "Manage your organization's configuration and preferences." },
    { path: "people", internal: ["settings", "people"], label: "People", title: "People", subtitle: "Manage members, roles, and invitations." },
    { path: "teams", internal: ["settings", "teams"], label: "Teams", title: "Teams", subtitle: "Group repositories and members, and set the defaults each team inherits." },
    { path: "billing", internal: ["settings", "billing"], label: "Billing & Usage", title: "Billing", subtitle: "Manage your subscription, payment methods, and invoices." },
    { path: "api-keys", internal: ["settings", "keys"], label: "API Keys", title: "API Keys", subtitle: "Create and manage API keys for programmatic access." },
    { path: "notifications", internal: ["settings", "notifications"], label: "Notifications", title: "Notifications", subtitle: "Choose where OpenReview sends review updates." },
    { path: "audit", internal: ["settings", "audit"], label: "Audit Log", title: "Audit Log", subtitle: "Who changed what in this organization." },
  ],
  // Personal Settings, from the account menu: its own header (‹ Back) and no tab bar.
  account: [
    { path: "", internal: ["settings", "account"], label: "Account Settings", title: "Personal Settings", subtitle: "Manage your profile, preferences, and integrations." },
    { path: "review", internal: ["settings", "agents"], label: "Review Settings", title: "Personal Settings", subtitle: "Manage your profile, preferences, and integrations." },
    { path: "referrals", internal: ["settings", "referrals"], label: "Referrals", title: "Personal Settings", subtitle: "Manage your profile, preferences, and integrations." },
  ],
};

/** The page for a URL's sections (after /dashboard), if it is one of the tabs above. */
export function pageFor(section: string[]): (Page & { tab: string }) | undefined {
  const [tab, path = "", ...rest] = section;
  if (rest.length) return undefined;
  const page = pages[tab]?.find((p) => p.path === path);
  return page && { ...page, tab };
}

/** The public URL of an internal section, e.g. ["settings", "keys"] → /dashboard/organization/api-keys. */
export function hrefFor(internal: string[]): string {
  for (const [tab, list] of Object.entries(pages)) {
    const page = list.find((p) => p.internal.join("/") === internal.join("/"));
    if (page) return `/dashboard/${tab}${page.path ? "/" + page.path : ""}`;
  }
  return `/dashboard/${internal.join("/")}`;
}

/** Old URLs that moved, for next.config.ts. Query strings carry over. */
export const movedPaths: [from: string, to: string][] = [
  ...Object.values(pages).flat().map((p): [string, string] => [`/dashboard/${p.internal.join("/")}`, hrefFor(p.internal)]),
  // Merged pages: Usage joined Billing, Data & deletion joined Organization.
  ["/dashboard/settings/usage", "/dashboard/organization/billing"],
  ["/dashboard/settings/data", "/dashboard/organization"],
  ["/dashboard/memory", "/dashboard/context"],
  ["/dashboard/settings", "/dashboard/organization"],
];
