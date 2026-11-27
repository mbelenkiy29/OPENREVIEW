import { cookies } from "next/headers";
import Link from "next/link";
import { billingConfig } from "../src/billing";
import { sessionCookie, sessionJwtValid } from "../src/session-token";
import { userJotConfig } from "../src/userjot";
import { CookieSettings } from "./consent";
import { ThemePicker } from "./theme";
import { BoardNavLinks } from "./userjot";
import { Icon } from "./ui/icons";
import { Mark } from "./ui/logo";

/** The public source repository, linked from the site header, footer and self-hosting section. */
export const sourceRepository = "https://github.com/mbelenkiy29/OPENREVIEW";

// Public-site header and footer shared by the landing page, docs, changelog and feedback board. On
// the landing page links are in-page anchors; elsewhere they point back to the landing sections.
function SiteNavLinks({ home = false, current }: { home?: boolean; current?: "docs" | "changelog" | "pricing" }) {
  const base = home ? "" : "/";
  const pricing = billingConfig().enabled, feedback = Boolean(userJotConfig());
  return <>
    <Link href={`${base}#features`}>Features</Link>
    <Link href={`${base}#how`}>How it works</Link>
    {pricing && <Link href="/pricing" aria-current={current === "pricing" ? "page" : undefined}>Pricing</Link>}
    <Link href="/docs/quickstart" aria-current={current === "docs" ? "page" : undefined}>Docs</Link>
    <Link href="/changelog" aria-current={current === "changelog" ? "page" : undefined}>Changelog</Link>
    {feedback && <BoardNavLinks />}
    <a href={sourceRepository}>GitHub</a>
  </>;
}

export const accountCta = (signedIn: boolean) => signedIn
  ? { href: "/dashboard" as const, label: "Dashboard" as const }
  : { href: "/login" as const, label: "Sign in" as const };

export async function SiteHeader({ home = false, current }: { home?: boolean; current?: "docs" | "changelog" | "pricing" }) {
  const { href, label } = accountCta(await sessionJwtValid((await cookies()).get(sessionCookie)?.value));
  return <header className="site-header">
    <Link className="brand" href="/"><Mark /> OpenReview</Link>
    <nav className="site-nav" aria-label="Site"><SiteNavLinks home={home} current={current} /></nav>
    <div className="site-actions">
      <details className="site-menu">
        <summary><Icon name="list" /> <span>Menu</span></summary>
        <nav className="site-menu-panel" aria-label="Site">
          <SiteNavLinks home={home} current={current} />
          <Link href={href}>{label}</Link>
        </nav>
      </details>
      <Link className="site-account" href={href}>{label}</Link>
      <Link className="button primary small" href="/signup">Get started</Link>
    </div>
    {/* How far down the landing page the visitor is; app/landing/motion.tsx draws it. */}
    {home && <span className="scroll-progress" aria-hidden="true" />}
  </header>;
}

const columns: [string, [string, string][]][] = [
  ["Docs", [["/docs/quickstart", "Quickstart"], ["/docs/reviews", "How reviews work"], ["/docs/configuration", "Configuration"], ["/docs/self-hosting", "Self-hosting"]]],
  ["Developers", [["/docs/api", "Public API"], ["/docs/mcp", "MCP"], ["/docs/cli", "CLI"], ["/docs/openapi.yaml", "OpenAPI spec"]]],
  ["Integrations", [["/docs/github-app", "GitHub App"], ["/docs/notifications", "Slack and email"], ["/docs/linear", "Linear"], ["/docs/atlassian", "Jira and Confluence"]]],
  ["Compare", [["/compare/greptile", "vs Greptile"], ["/compare/coderabbit", "vs CodeRabbit"]]],
];

export function SiteFooter() {
  const pricing = billingConfig().enabled, feedback = Boolean(userJotConfig());
  return <footer className="site-footer">
    <div className="footer-grid">
      <div>
        <Link className="brand" href="/"><Mark /> OpenReview</Link>
        <span className="muted">Repository-aware pull request reviews.</span>
      </div>
      <nav aria-label="Product">
        <h2>Product</h2>
        <Link href="/#features">Features</Link>
        <Link href="/#how">How it works</Link>
        {pricing && <Link href="/pricing">Pricing</Link>}
        <Link href="/ci">CI cost audit</Link>
        <Link href="/changelog">Changelog</Link>
        {feedback && <><Link href="/feedback/roadmap">Roadmap</Link><Link href="/feedback">Feedback</Link></>}
      </nav>
      {columns.map(([title, links]) => <nav key={title} aria-label={title}>
        <h2>{title}</h2>
        {links.map(([href, label]) => href.endsWith(".yaml") ? <a key={href} href={href}>{label}</a> : <Link key={href} href={href}>{label}</Link>)}
      </nav>)}
    </div>
    <div className="footer-base">
      <span>OpenReview · <a href={`${sourceRepository}/blob/main/LICENSE`}>MIT licensed</a> · <a href={sourceRepository}>Source on GitHub</a> · <Link href="/security">Security</Link> · <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link><CookieSettings /></span>
      <ThemePicker />
    </div>
  </footer>;
}
