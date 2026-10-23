import fs from "node:fs/promises";
import path from "node:path";
import { Fragment } from "react";
import type { Metadata } from "next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseChangelog } from "../../src/changelog";
import { emailOnWeb } from "../../src/email";
import { SiteFooter, SiteHeader } from "../site-chrome";
import { ChangelogEmail } from "./email-form";

export const metadata: Metadata = { title: "Changelog", description: "What changed in OpenReview.", alternates: { canonical: "/changelog", types: { "application/rss+xml": "/changelog/feed.xml" } } };

// Each month and section heading has an id, so the RSS feed and other pages can link to it.
export default async function Changelog() {
  const months = parseChangelog(await fs.readFile(path.join(process.cwd(), "CHANGELOG.md"), "utf8"));
  const md = (text: string) => <Markdown remarkPlugins={[remarkGfm]} skipHtml>{text}</Markdown>;
  // The Resend key lives on Convex; the segment ID is set on both, like EMAIL_SIGN_IN, so the page knows.
  const email = emailOnWeb() && Boolean(process.env.RESEND_CHANGELOG_SEGMENT_ID);
  return <div className="docs-layout single">
    <SiteHeader current="changelog" />
    <main className="docs-content review-markdown">
      <h1>Changelog</h1>
      <p>Follow along with the <a href="/changelog/feed.xml">RSS feed</a>{email && ", or get the new entries by email at most once a week"}.</p>
      {email && <ChangelogEmail />}
      {months.map((m) => <Fragment key={m.id}>
        <h2 id={m.id}>{m.title}</h2>
        {m.intro && md(m.intro)}
        {m.sections.map((s) => <Fragment key={s.id}><h3 id={s.id}>{s.title}</h3>{md(s.body)}</Fragment>)}
      </Fragment>)}
    </main>
    <SiteFooter />
  </div>;
}
