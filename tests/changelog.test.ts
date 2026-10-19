import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { changelogFeed, parseChangelog, plainText } from "../src/changelog";

const sample = `# Changelog\n\nIntro ignored.\n\n## October 2026\n\nA month note.\n\n### Site\n- A **bold** entry with \`code\` & <tags>.\n\n### Billing\n- [Promo codes](/docs/billing).\n`;

test("months and their sections are parsed with stable ids", () => {
  const [month] = parseChangelog(sample);
  assert.equal(month.title, "October 2026");
  assert.equal(month.intro, "A month note.");
  assert.deepEqual(month.sections.map((s) => s.id), ["october-2026-site", "october-2026-billing"]);
  assert.equal(month.sections[1].body, "- [Promo codes](/docs/billing).");
});

test("the RSS feed has one item per section, escaped, and a new guid only when a section changes", () => {
  const updated = new Date("2026-10-17T00:00:00Z");
  const feed = changelogFeed(parseChangelog(sample), "https://openreview.tech", updated);
  assert.equal(feed.match(/<item>/g)?.length, 2);
  assert.match(feed, /<link>https:\/\/openreview\.tech\/changelog#october-2026-site<\/link>/);
  assert.match(feed, /&amp; &lt;tags&gt;/);
  assert.doesNotMatch(feed, /<tags>/);
  const guids = (xml: string) => [...xml.matchAll(/<guid[^>]*>([^<]+)</g)].map((m) => m[1]);
  const changed = changelogFeed(parseChangelog(sample.replace("Promo codes", "Promotion codes")), "https://openreview.tech", updated);
  assert.equal(guids(changed)[0], guids(feed)[0], "unchanged section keeps its guid");
  assert.notEqual(guids(changed)[1], guids(feed)[1], "changed section gets a new guid");
  assert.equal(plainText("- A **bold** [link](/x) with `code`"), "• A bold link with code");
});

test("CHANGELOG.md is dated by month, with no Unreleased heading", () => {
  const months = parseChangelog(readFileSync("CHANGELOG.md", "utf8"));
  assert.ok(months.length > 0 && months.every((m) => /^[A-Z][a-z]+ \d{4}$/.test(m.title)), months.map((m) => m.title).join(", "));
  assert.ok(months.every((m) => m.sections.length > 0));
});
