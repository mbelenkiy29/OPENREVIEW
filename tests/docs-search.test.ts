import test from "node:test";
import assert from "node:assert/strict";
import { docHeadings, searchDocs, type DocsEntry } from "../src/docs-search";

const index: DocsEntry[] = [
  { slug: "quickstart", title: "Quickstart", section: "Getting started", description: "Run OpenReview locally.", headings: ["Install", "Connect a webhook"] },
  { slug: "github-app", title: "GitHub App setup", section: "Getting started", description: "Permissions and webhooks.", headings: ["Repository permissions", "Webhook secret"] },
  { slug: "slack", title: "Slack and email", section: "Use", description: "Notifications.", headings: ["Slack app"] },
];

test("headings come from ## and ### lines outside code blocks", () => {
  assert.deepEqual(docHeadings("# Title\n## Install `pnpm`\n```bash\n## not a heading\n```\n### Webhook *secret* ##\n#### too deep"), ["Install pnpm", "Webhook secret"]);
});

test("a title match ranks above a heading match, and the matching heading is shown", () => {
  assert.deepEqual(searchDocs(index, "slack").map((r) => r.entry.slug), ["slack"]);
  const webhook = searchDocs(index, "webhook secret");
  assert.equal(webhook[0].entry.slug, "github-app", "matches both words");
  assert.equal(webhook[0].heading, "Webhook secret");
  assert.deepEqual(webhook.map((r) => r.entry.slug), ["github-app"], "a page matching every word hides partial matches");
  assert.deepEqual(searchDocs(index, "webhook email").map((r) => r.entry.slug), ["slack", "quickstart", "github-app"], "with no full match, partial matches are shown");
  assert.equal(searchDocs(index, "github")[0].heading, undefined, "no heading when the title matches");
});

test("empty and unmatched queries return nothing", () => {
  assert.deepEqual(searchDocs(index, "   "), []);
  assert.deepEqual(searchDocs(index, "zzz"), []);
});
