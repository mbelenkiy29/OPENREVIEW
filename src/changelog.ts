// CHANGELOG.md as data for the changelog page and its RSS feed. The file has one `## Month YYYY`
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
