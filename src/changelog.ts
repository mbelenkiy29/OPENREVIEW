// CHANGELOG.md as data for the changelog page, its RSS feed and the email digest. The file has one `## Month YYYY`
// heading per month and `### Area` sections of bullets under it.
import { createHash } from "node:crypto";

export type ChangelogSection = { title: string; id: string; body: string };
export type ChangelogMonth = { title: string; id: string; intro: string; sections: ChangelogSection[] };

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Months (`##`) and their sections (`###`); text before the first `###` is the month's intro. */
export function parseChangelog(markdown: string): ChangelogMonth[] {
  const months: ChangelogMonth[] = [];
  let lines: string[] = [];
  const flush = () => {
    const month = months.at(-1), text = lines.join("\n").trim();
    lines = [];
    if (!month) return;
    const section = month.sections.at(-1);
    if (section) section.body = text;
    else month.intro = text;
  };
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const month = /^## (.+)$/.exec(line), section = /^### (.+)$/.exec(line);
    if (month) { flush(); months.push({ title: month[1].trim(), id: slug(month[1]), intro: "", sections: [] }); }
    else if (section && months.length) { flush(); const m = months.at(-1)!; m.sections.push({ title: section[1].trim(), id: `${m.id}-${slug(section[1])}`, body: "" }); }
    else if (months.length) lines.push(line);
  }
  flush();
  return months;
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Markdown bullets as plain text: emphasis, code and link marks removed, one line per bullet. */
export const plainText = (markdown: string) => markdown.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").replace(/^\s*-\s+/gm, "• ").trim();

/**
 * RSS 2.0 with one item per section. An item's guid includes a hash of its text, so a section
 * that gains entries reaches feed readers as a new item, while unchanged sections stay read.
 */
export function changelogFeed(months: ChangelogMonth[], origin: string, updated: Date) {
  const items = months.flatMap((m) => m.sections.map((s) => {
    const guid = `${s.id}-${createHash("sha256").update(s.body).digest("hex").slice(0, 12)}`;
    return `    <item>
      <title>${escapeXml(`${s.title} · ${m.title}`)}</title>
      <link>${origin}/changelog#${s.id}</link>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${updated.toUTCString()}</pubDate>
      <description>${escapeXml(plainText(s.body))}</description>
    </item>`;
  }));
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>OpenReview changelog</title>
    <link>${origin}/changelog</link>
    <atom:link href="${origin}/changelog/feed.xml" rel="self" type="application/rss+xml" />
    <description>What changed in OpenReview.</description>
    <language>en</language>
    <lastBuildDate>${updated.toUTCString()}</lastBuildDate>
${items.join("\n")}
  </channel>
</rss>
`;
}

export type DigestSection = { title: string; link: string; entries: string[] };
const unescapeXml = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

/**
 * The email digest's view of the live feed: entries (one per bullet line) whose key is not in `seen`,
 * by section, and the keys of every entry in the feed, to remember once the digest is sent. A key is
 * a hash of the section link and the line, so an edited entry counts as new.
 */
export function feedDigest(feed: string, seen: ReadonlySet<string>) {
  const sections: DigestSection[] = [], keys: string[] = [];
  for (const [, item] of feed.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = (name: string) => unescapeXml(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(item)?.[1] ?? "");
    const link = field("link"), entries: string[] = [];
    for (const line of field("description").split("\n").map((l) => l.trim()).filter(Boolean)) {
      const key = createHash("sha256").update(`${link}\n${line}`).digest("hex").slice(0, 16);
      keys.push(key);
      if (!seen.has(key)) entries.push(line);
    }
    if (entries.length) sections.push({ title: field("title"), link, entries });
  }
  return { sections, keys };
}

/** A digest for a Resend broadcast, in plain text and HTML; Resend fills in the unsubscribe link. */
export function digestEmail(sections: DigestSection[], origin: string) {
  const areas = [...new Set(sections.map((s) => s.title.split(" · ")[0]))].join(", ");
  const body = sections.map((s) => `${s.title}\n${s.entries.join("\n")}\n${s.link}`).join("\n\n");
  const html = sections.map((s) => `<h3><a href="${escapeXml(s.link)}">${escapeXml(s.title)}</a></h3><p>${s.entries.map(escapeXml).join("<br>")}</p>`).join("");
  return {
    subject: `What's new in OpenReview: ${areas}`.slice(0, 200),
    text: `New in OpenReview since the last update:\n\n${body}\n\nThe full changelog: ${origin}/changelog\n\nUnsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}`,
    // Resend documents the unsubscribe placeholder for HTML, so the link is sure to be filled in here.
    html: `<p>New in OpenReview since the last update:</p>${html}<p><a href="${escapeXml(origin)}/changelog">The full changelog</a></p><p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a></p>`,
  };
}
