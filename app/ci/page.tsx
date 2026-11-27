import type { Metadata } from "next";
import Link from "next/link";
import { ciCheckEnabled } from "../../src/ci-audit-github";
import { pageSocialTitle, socialMeta } from "../../src/structured-data";
import { SiteFooter, SiteHeader, sourceRepository } from "../site-chrome";
import { CiCheck } from "./check";
import "./ci.css";

// The CI cost page: what the CI audit measures, a live check of one public repository, and what comes next.
// The check needs CI_AUDIT_GITHUB_TOKEN on the server; without it the page explains how to run the CLI instead.
export const dynamic = "force-dynamic";

const title = pageSocialTitle("CI cost audit");
const description = "See how much of your GitHub Actions bill goes to runs nobody needed: cancelled runs, runs a newer push made pointless, and the fixes each workflow is missing.";

export const metadata: Metadata = { title: "CI cost audit", description, alternates: { canonical: "/ci" }, ...socialMeta(title, description) };

const measures = [
  ["Minutes and cost per workflow", "Billable minutes rounded the way GitHub bills them, priced per runner, so you see which workflows carry the bill."],
  ["Runs cancelled part-way", "Minutes spent on runs that never finished, and so never told anyone anything."],
  ["Runs a newer push replaced", "Minutes a run kept spending after a newer commit's run had already started on the same branch."],
  ["Fixes each workflow is missing", "Whether superseded runs are cancelled, drafts skip heavy jobs, and path filters keep unrelated changes out."],
] as const;
const next = [
  ["Fix pull requests", "One pull request per repository that adds the missing fixes. You review and merge it; nothing changes in your repository silently."],
  ["Spend guard", "Daily spend by repository and workflow, alerts before a budget runs out, and a warning the moment a backup or deploy stops running."],
] as const;
const faq = [
  ["Does the check change my repository?", "No. It only reads Actions runs, jobs and workflow files through GitHub's API."],
  ["Can I check a private repository?", "Not on this page, which only reads public repositories. Run the same audit yourself with your own token: pnpm ci:audit owner/repo."],
  ["How exact are the costs?", "They are estimates at GitHub's list price per runner minute. Your plan's included minutes are not subtracted, and public repositories do not pay for standard GitHub-hosted runners."],
] as const;

export default function CiPage() {
  return <div className="landing ci-page">
    <SiteHeader />
    <main id="main">
      <section className="hero" aria-labelledby="ci-heading">
        <h1 id="ci-heading">Stop paying for CI runs nobody needs.</h1>
        <p className="lede">AI coding agents push far more often than people, and every push starts a full CI run that the next push makes pointless. The CI audit shows how much of your GitHub Actions bill goes to those runs, and what to change.</p>
        <div className="hero-actions">
          <a className="button primary large" href="#check">Check a public repository</a>
          <a className="button large" href={`${sourceRepository}/blob/main/docs/ci-audit.md`}>Run it on a private repository</a>
        </div>
      </section>

      <section id="check" className="ci-check-band" aria-labelledby="check-heading">
        <h2 id="check-heading">Check a repository</h2>
        <CiCheck enabled={ciCheckEnabled()} />
      </section>

      <section className="more" aria-labelledby="measures-heading">
        <h2 id="measures-heading">What the audit measures</h2>
        <div className="feature-grid">{measures.map(([t, body]) => <article key={t} className="feature-card"><h3>{t}</h3><p>{body}</p></article>)}</div>
      </section>

      <section className="more" aria-labelledby="next-heading">
        <h2 id="next-heading">Coming next</h2>
        <div className="feature-grid two">{next.map(([t, body]) => <article key={t} className="feature-card"><h3>{t}</h3><p>{body}</p></article>)}</div>
      </section>

      <section className="faq-band" aria-labelledby="ci-faq-heading">
        <h2 id="ci-faq-heading">Questions</h2>
        <div className="faq">{faq.map(([q, a], i) => <details key={q} open={i === 0}><summary>{q}</summary><p>{a}</p></details>)}</div>
      </section>

      <section className="cta" aria-labelledby="ci-cta-heading">
        <h2 id="ci-cta-heading">Find your wasted CI minutes<span className="cta-dot">.</span></h2>
        <div className="cta-actions">
          <a className="button primary large" href="#check">Check a repository</a>
          <Link className="button large" href="/">See OpenReview code review →</Link>
        </div>
      </section>
    </main>
    <SiteFooter />
  </div>;
}
