import { test } from "node:test";
import assert from "node:assert/strict";
import { autoTier, isTierLabel, labelTier, resolveTier, reviewCommand, wantsReview } from "../src/review-tier";
import { defaults } from "../src/review-settings";
import { applyRepoConfig } from "../src/repo-config";

const file = (path: string, lines: number, text = "x = 1") => ({ path, status: "modified", patch: Array.from({ length: lines }, () => `+${text}`).join("\n") });

test("auto picks the tier from size and the riskiest file; generated, lock and docs files don't add size", () => {
  assert.equal(autoTier([]), "fast");
  assert.equal(autoTier([file("src/a.ts", 10)]), "fast");
  assert.equal(autoTier([file("src/a.ts", 120)]), "standard");
  assert.equal(autoTier([file("src/api.ts", 10, "export const x = 1")]), "standard", "an exported API is not fast even when small");
  assert.equal(autoTier([file("src/auth.ts", 250, "const token = read()")]), "deep", "security-sensitive and 200+ lines");
  assert.equal(autoTier([file("src/auth.ts", 100, "const token = read()")]), "standard", "risky but small");
  assert.equal(autoTier([file("src/a.ts", 600), file("src/b.ts", 600)]), "deep", "1,000+ lines");
  assert.equal(autoTier([file("package-lock.json", 5000), file("README.md", 400), file("src/a.ts", 5)]), "fast");
});

test("auto counts as no tier: comments, labels and folders replace it, and the admin cap still applies", () => {
  const big = [file("src/a.ts", 1200)];
  assert.deepEqual(resolveTier({ configured: "auto", diff: big }), { mode: "deep", source: "auto", capped: false, requested: "deep" });
  assert.deepEqual(resolveTier({ configured: "auto", diff: big, requested: { mode: "fast", source: "label" } }), { mode: "fast", source: "label", capped: false, requested: "fast" });
  assert.deepEqual(resolveTier({ configured: "auto", diff: big, cap: "standard" }), { mode: "standard", source: "auto", capped: true, requested: "deep" });
  const level = (directory: string, mode: "fast" | "auto") => ({ directory, settings: { mode }, sources: [] });
  const dashboard = { mode: "auto", lockedKeys: [] as string[] };
  assert.equal(applyRepoConfig(dashboard, { settings: {}, directories: [], levels: [level("docs", "fast")] }, ["docs/a.md"]).settings.mode, "fast", "a folder's explicit tier replaces auto");
  assert.equal(applyRepoConfig({ ...dashboard, mode: "standard" }, { settings: {}, directories: [], levels: [level("docs", "auto")] }, ["docs/a.md"]).settings.mode, "standard", "a folder's auto never lowers an explicit tier");
});

test("@openreview review commands carry an optional tier or the security focus", () => {
  assert.deepEqual(reviewCommand("@openreview review"), {});
  assert.deepEqual(reviewCommand("@openreview review again please"), {});
  assert.deepEqual(reviewCommand("@openreview review security"), { category: "security" });
  assert.deepEqual(reviewCommand("@OpenReview Review DEEP"), { mode: "deep" });
  assert.deepEqual(reviewCommand("Could you run @openreview review fast on this?"), { mode: "fast" });
  assert.deepEqual(reviewCommand("@openreview review standard"), { mode: "standard" });
  assert.deepEqual(reviewCommand("@openreview review deeply"), {}, "only whole words select a tier");
  assert.equal(reviewCommand("review deep"), null);
  assert.equal(reviewCommand("@openreview explain this"), null);
});

test("openreview:<tier> labels select a tier; the highest of several wins; other labels are ignored", () => {
  assert.equal(labelTier(["bug", "openreview:deep"]), "deep");
  assert.equal(labelTier(["OpenReview:Fast"]), "fast");
  assert.equal(labelTier(["openreview:fast", "openreview:deep", "openreview:standard"]), "deep");
  assert.equal(labelTier(["openreview", "openreview:huge", "needs-review"]), undefined);
  assert.ok(isTierLabel(" openreview:standard ") && !isTierLabel("openreview:"));
});

test("precedence: comment over label over configured tier, raising only; the admin cap applies last", () => {
  assert.deepEqual(resolveTier({ configured: "standard" }), { mode: "standard", source: "settings", capped: false, requested: "standard" });
  assert.deepEqual(resolveTier({ configured: "standard", requested: { mode: "deep", source: "label" } }), { mode: "deep", source: "label", capped: false, requested: "deep" });
  // A request never lowers the configured tier.
  assert.deepEqual(resolveTier({ configured: "deep", requested: { mode: "fast", source: "comment" } }), { mode: "deep", source: "settings", capped: false, requested: "deep" });
  assert.equal(resolveTier({ configured: "standard", requested: { mode: "standard", source: "label" } }).source, "settings");
  // Caps: a workspace limit of standard stops deep from comments, labels and folders alike.
  assert.deepEqual(resolveTier({ configured: "standard", requested: { mode: "deep", source: "comment" }, cap: "standard" }), { mode: "standard", source: "comment", capped: true, requested: "deep" });
  assert.deepEqual(resolveTier({ configured: "deep", cap: "standard" }), { mode: "standard", source: "settings", capped: true, requested: "deep" });
  assert.deepEqual(resolveTier({ configured: "deep", requested: { mode: "deep", source: "label" }, cap: "fast" }).mode, "fast");
  assert.equal(resolveTier({ configured: "fast", cap: "standard" }).capped, false);
  assert.equal(defaults.maxReviewTier, "deep", "no cap by default");
});

test("a bare mention asks for a review; a mention with a question does not", () => {
  for (const body of ["@openreview", " @OpenReview! ", "@openreview review", "@openreview review deep", "thanks @openreview review again"]) assert.equal(wantsReview(body), true, body);
  for (const body of ["@openreview why is this cached?", "@openreview fix this", "@openreviewer", "cc @openreview, see above"]) assert.equal(wantsReview(body), false, body);
});
