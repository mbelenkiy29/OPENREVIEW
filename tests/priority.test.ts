import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { findingTags, priorityBadge, priorityOf, findingCounts } from "../src/priority";
import { findingComment, reviewSummary } from "../src/review-summary";
import { emailReview, slackReviewText, type ReviewNotice } from "../src/notifications";
import { priority, severityCounts, ago } from "../app/dashboard/sections/shared";
import type { Finding } from "../src/engine/types";

const finding = (severity: Finding["severity"], category: Finding["category"], title: string): Finding => ({
  title, description: "Concrete defect description.", severity, confidence: 0.95, category, filePath: "src/auth.ts", startLine: 3, endLine: 3,
  evidence: [{ filePath: "src/auth.ts", startLine: 3, quote: "x" }], impact: "Impact text.", suggestedFix: "Fix text.", symbol: "s", fingerprint: title, agent: category, commitSha: "a".repeat(40),
});

test("severities map to P0–P3 with text and emoji only; security findings get a separate tag", () => {
  assert.deepEqual(["critical", "high", "medium", "low"].map(priorityOf), ["P0", "P1", "P2", "P3"]);
  assert.deepEqual(["critical", "high", "medium", "low"].map(priorityBadge), ["🔴 P0", "🟠 P1", "🟡 P2", "🔵 P3"]);
  assert.equal(priorityOf("unknown"), "P3");
  assert.deepEqual(findingTags({ category: "security" }), ["security"]);
  assert.deepEqual(findingTags({ category: "correctness" }), []);
  assert.deepEqual(findingTags({}), []);
});

test("inline comments lead with the priority badge and a bold title, then the Security tag (Greptile's shape)", () => {
  const security = finding("high", "security", "Deleted accounts stay authorized");
  for (const style of ["detailed", "concise"]) assert.match(findingComment(security, style), /^🟠 P1 \*\*Deleted accounts stay authorized\*\* · 🔒 Security\n\n/);
  assert.match(findingComment(finding("medium", "correctness", "Rounding drops a cent")), /^🟡 P2 \*\*Rounding drops a cent\*\*\n\n/);
  assert.doesNotMatch(findingComment(security), /% confidence|\*\*Impact:\*\*|Evidence:/, "confidence, impact label and evidence stay on the dashboard");
  assert.doesNotMatch(findingComment(security), /<img|https?:\/\/[^\s)]*\.(?:svg|png)/, "no hosted badge images");
});

test("the summary findings table shows priority, severity and the Security tag", () => {
  const summary = reviewSummary({ overview: "o", files: [], findings: [finding("medium", "correctness", "Rounding drops a cent"), finding("critical", "security", "Token leaks to logs")], resolved: [], score: undefined, assessment: undefined, runtimeEvidence: undefined, coverageLimits: [], contextCount: 0, candidates: 2, suppressed: 0 }, ["findings"]);
  assert.match(summary, /### Issues\n\| Priority \| Location \| Issue \|\n\| --- \| --- \| --- \|\n\| 🔴 \*\*P0\*\* · critical \| `src\/auth.ts:3` \| Token leaks to logs · 🔒 Security \|\n\| 🟡 \*\*P2\*\* · medium \| `src\/auth.ts:3` \| Rounding drops a cent \|/);
});

test("Slack and email notifications carry the priority and Security tag; untrusted text stays escaped", () => {
  const notice: ReviewNotice = { repository: "acme/shop", prNumber: 7, headSha: "a".repeat(40), findings: [{ title: "Token <leaks>", severity: "critical", category: "security", filePath: "src/log.ts", startLine: 4 }, { title: "Typo", severity: "low", filePath: "README.md", startLine: 1 }] };
  const slack = slackReviewText("review.completed", notice);
  assert.match(slack, /• 🔴 P0 · 🔒 Security · Token &lt;leaks&gt; — `src\/log.ts:4`/);
  assert.match(slack, /• 🔵 P3 · Typo — `README.md:1`/);
  const email = emailReview("review.completed", notice).text;
  assert.match(email, /- \[P0 critical, Security\] Token <leaks> \(src\/log.ts:4\)/);
  assert.match(email, /- \[P3 low\] Typo \(README.md:1\)/);
  // Older notices without a category still render (no tag).
  assert.match(slackReviewText("finding.high", { ...notice, findings: [{ title: "Old", severity: "high", filePath: "a.ts", startLine: 1 }] }), /• 🟠 P1 · Old/);
});

test("the dashboard renders a priority badge colored by severity, with a Security tag", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, priority({ severity: "critical", category: "security" })));
  assert.equal(html, '<span class="badge critical" title="Severity: critical">🔴 P0</span> <span class="badge">🔒 Security</span>');
  assert.equal(renderToStaticMarkup(createElement(Fragment, null, priority({ severity: "low" }))), '<span class="badge low" title="Severity: low">🔵 P3</span>');
});

test("finding counts group by priority and add a security count", () => {
  assert.deepEqual(findingCounts([{ severity: "high" }, { severity: "high", category: "security" }, { severity: "medium" }]), { P1: 2, security: 1, P2: 1 });
  assert.deepEqual(findingCounts([]), {});
  const html = renderToStaticMarkup(createElement(Fragment, null, severityCounts({ P2: 1, P0: 1, security: 1 })));
  assert.equal(html, '<span class="badge critical" title="1 P0 finding">P0 ×1</span> <span class="badge medium" title="1 P2 finding">P2 ×1</span> <span class="badge security" title="1 security finding">🔒 ×1</span>');
});

test("relative times read like a person would say them", () => {
  const now = Date.UTC(2026, 9, 21);
  assert.equal(ago(now - 28 * 864e5, now), "4 weeks ago");
  assert.equal(ago(now - 3 * 36e5, now), "3 hours ago");
  assert.equal(ago(now - 864e5, now), "yesterday");
  assert.equal(ago(now - 5000, now), "just now");
});
