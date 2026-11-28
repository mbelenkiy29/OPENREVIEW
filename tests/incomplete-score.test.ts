import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { checkOutcome } from "../src/check-run";
import { capReviewScore, reviewChange } from "../src/engine/review";
import { compactLayout, disclosureLayout } from "../src/summary-layout";
import { reviewSummary } from "../src/review-summary";
import { incompleteScoreLabel, verdictLine } from "../src/verdict";
import type { Finding, ModelProvider, ModelRequest, ReviewInput } from "../src/engine/types";

const low: Finding = {
  symbol: "note", title: "Comment restates the helper name", description: "The new comment only repeats the function name.",
  severity: "low", confidence: 0.8, category: "correctness", filePath: "src/total.ts", startLine: 1, endLine: 1,
  evidence: [{ filePath: "src/total.ts", startLine: 1, quote: "export function total() {" }],
  impact: "Readers get no new information.", suggestedFix: "Describe the units the helper returns.",
  fingerprint: "low1", agent: "correctness", commitSha: "a".repeat(40),
};
const base = {
  overview: "The patch update from Next.js 16.4.3 to 16.4.6 synchronizes the lockfile.",
  files: [{ path: "package.json", status: "modified" as const, patch: "@@ -1 +1 @@\n-a\n+b" }, { path: "pnpm-lock.yaml", status: "modified" as const, patch: "@@ -1 +1 @@\n-a\n+b" }],
  resolved: [] as Finding[],
  score: { value: 5, reason: "No defects were found in the reviewed files." },
  assessment: { risk: "low" as const, confidence: 0.4, reason: "Manifest and lockfile versions stay aligned." },
  runtimeEvidence: undefined, contextCount: 0, candidates: 0, suppressed: 0,
};
const unavailable = "Some changed source files were unavailable or excluded";
const queued = "CI checks were still queued at review time";

test("(a) a complete review keeps its numeric confidence score", () => {
  const summary = reviewSummary({ ...base, findings: [], coverageLimits: [] });
  assert.match(summary, /^\*\*Ready to merge\*\* · Confidence score \*\*5\/5\*\*/);
  assert.match(summary, /### Confidence score\n\*\*5\/5\*\* — No defects were found in the reviewed files\./);
  const layout = disclosureLayout(summary);
  assert.match(layout, /^<h2>Confidence Score: 5\/5<\/h2>\n\n\*\*Ready to merge\.\*\*/);
  assert.equal(verdictLine("ready", { value: 5 }), "**Ready to merge** · Confidence score **5/5**");
  assert.deepEqual(capReviewScore(base.score, []), base.score);
});

test("(b) incomplete review with zero findings, matching #155, shows no 5/5 and names the reason", () => {
  const summary = reviewSummary({
    ...base, findings: [], incomplete: true,
    coverageLimits: [unavailable, queued],
  });
  assert.match(summary, /^\*\*Review incomplete\*\*\n/);
  assert.doesNotMatch(summary, /5\/5/);
  assert.match(summary, new RegExp("### Confidence score\\n" + incompleteScoreLabel.replace(/[()]/g, "\\$&") + " — " + unavailable));
  assert.match(summary, new RegExp(queued));
  assert.match(summary, /### Coverage\n[\s\S]*- Some changed source files were unavailable or excluded/);
  assert.match(summary, /Not executed by OpenReview/);
  const layout = disclosureLayout(summary);
  assert.match(layout, new RegExp("^<h2>Confidence Score: " + incompleteScoreLabel.replace(/[()]/g, "\\$&") + "</h2>"));
  assert.match(layout, /\*\*Review incomplete\.\*\* Some changed source files were unavailable or excluded/);
  assert.doesNotMatch(layout, /5\/5/);
  // Renderer guard: a stored summary that still carries the leaked 5/5 is unpublished.
  const leaked = "**Review incomplete** · Confidence score **5/5**\n\n### Overview\nLockfile bump.\n\n### Confidence score\n**5/5** — No defects were found in the reviewed files.\n\n### Coverage\n2 changed files.\n\n- " + unavailable;
  const guarded = disclosureLayout(leaked);
  assert.match(guarded, new RegExp("^<h2>Confidence Score: " + incompleteScoreLabel.replace(/[()]/g, "\\$&") + "</h2>"));
  assert.doesNotMatch(guarded, /5\/5/);
  assert.match(guarded, /unavailable or excluded/);
  const compact = compactLayout(leaked, "`abc`");
  assert.match(compact, new RegExp("### Confidence Score: " + incompleteScoreLabel.replace(/[()]/g, "\\$&")));
  assert.doesNotMatch(compact, /5\/5/);
  assert.equal(capReviewScore(base.score, [], true), undefined);
});

test("(c) an incomplete review with findings still lists them and shows no full score", () => {
  const summary = reviewSummary({
    ...base, findings: [low], incomplete: true,
    coverageLimits: [unavailable],
  });
  assert.match(summary, /^\*\*Review incomplete\*\*\n/);
  assert.doesNotMatch(summary, /5\/5|4\/5/);
  assert.match(summary, /n\/a \(review incomplete\) — Some changed source files were unavailable or excluded/);
  assert.match(summary, /Comment restates the helper name/);
  const layout = disclosureLayout(summary);
  assert.match(layout, /Confidence Score: n\/a \(review incomplete\)/);
  assert.match(layout, /Comment restates the helper name/);
  assert.doesNotMatch(layout, /[45]\/5/);
  assert.equal(capReviewScore(base.score, [{ severity: "low" }], true), undefined);
  // Medium+ findings keep a finding-capped score because they force a non-incomplete verdict.
  assert.equal(capReviewScore(base.score, [{ severity: "high" }], true)?.value, 2);
});

class CleanModel implements ModelProvider {
  async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    const value = request.task.startsWith("review:") ? { findings: [] }
      : request.task === "verify" ? { decisions: [] }
      : request.task === "diagram" ? { diagram: null }
      : { summary: "The patch updates Next.js and its lockfile from 16.4.3 to 16.4.6.", reviewScore: { value: 5, reason: "No defects were found in the reviewed files." } };
    return { value: schema.parse(value), usage: { task: request.task, provider: "fixture", model: "deterministic", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
  }
}

test("the engine drops a model-returned 5/5 when changed sources were unavailable", async () => {
  const input: ReviewInput = {
    repository: "acme/app", baseSha: "base", headSha: "head", title: "Bump next", description: "",
    files: [],
    diff: [
      { path: "package.json", status: "modified", patch: "@@ -1 +1 @@\n-\"next\": \"16.4.3\"\n+\"next\": \"16.4.6\"" },
      { path: "pnpm-lock.yaml", status: "modified", patch: "@@ -1 +1 @@\n-16.4.3\n+16.4.6" },
    ],
    rules: [], mode: "standard", settings: { categories: ["correctness"] },
  };
  const result = await reviewChange(input, new CleanModel());
  assert.equal(result.metadata.coverageIncomplete, true);
  assert.equal(result.metadata.reviewScore, undefined);
  assert.equal(result.metadata.verdict, "incomplete");
  assert.ok(result.metadata.coverageLimits?.includes("package.json was unavailable: Source could not be fetched"));
  assert.ok(!result.metadata.coverageLimits?.includes("Some changed source files were unavailable or excluded"));
  assert.ok(!result.metadata.coverageLimits?.some((l) => /pnpm-lock/.test(l)));
  assert.doesNotMatch(result.summary, /5\/5/);
  assert.match(result.summary, /^\*\*Review incomplete\*\*/);
  assert.match(result.summary, /n\/a \(review incomplete\)/);
  assert.match(result.summary, /package\.json was unavailable: Source could not be fetched/);
  assert.match(result.summary, /pnpm-lock\.yaml/);
  const layout = disclosureLayout(result.summary);
  assert.match(layout, /Confidence Score: n\/a \(review incomplete\)/);
  assert.doesNotMatch(layout, /5\/5/);
});

test("(a) a lockfile-only PR with package.json plus pnpm-lock.yaml passes the check", async () => {
  const input: ReviewInput = {
    repository: "acme/app", baseSha: "base", headSha: "head", title: "Bump next", description: "",
    files: [{ path: "package.json", sha: "p", content: '{\n  "dependencies": { "next": "16.4.6" }\n}' }],
    diff: [
      { path: "package.json", status: "modified", patch: "@@ -1 +1 @@\n-\"next\": \"16.4.3\"\n+\"next\": \"16.4.6\"" },
      { path: "pnpm-lock.yaml", status: "modified", patch: "@@ -1 +1 @@\n-16.4.3\n+16.4.6" },
    ],
    rules: [], mode: "standard", settings: { categories: ["correctness"] },
  };
  const result = await reviewChange(input, new CleanModel());
  assert.equal(result.metadata.coverageIncomplete, false);
  assert.equal(result.metadata.verdict, "ready");
  assert.equal(result.metadata.reviewScore?.value, 5);
  assert.deepEqual(result.metadata.skippedFiles, [{ path: "pnpm-lock.yaml", reason: "Lockfile excluded from source review" }]);
  assert.ok(!result.metadata.coverageLimits?.includes("Some changed source files were unavailable or excluded"));
  assert.ok(!result.metadata.coverageLimits?.some((l) => l.includes("was unavailable")));
  assert.match(result.summary, /^\*\*Ready to merge\*\*/);
  assert.match(result.summary, /`pnpm-lock\.yaml` · Lockfile excluded from source review/);
  const check = checkOutcome({ findings: result.findings, score: result.metadata.reviewScore?.value, files: input.diff.length, posted: 0, verdict: result.metadata.verdict });
  assert.equal(check.conclusion, "success");
  assert.doesNotMatch(check.summary, /did not cover every changed file/);
});

test("(b) a real source file that could not be fetched still fails the check", async () => {
  const input: ReviewInput = {
    repository: "acme/app", baseSha: "base", headSha: "head", title: "Fix totals", description: "",
    files: [],
    diff: [{ path: "src/total.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }],
    rules: [], mode: "standard", settings: { categories: ["correctness"] },
  };
  const result = await reviewChange(input, new CleanModel());
  assert.equal(result.metadata.coverageIncomplete, true);
  assert.equal(result.metadata.verdict, "incomplete");
  assert.ok(result.metadata.coverageLimits?.includes("src/total.ts was unavailable: Source could not be fetched"));
  assert.ok(!result.metadata.coverageLimits?.includes("Some changed source files were unavailable or excluded"));
  assert.match(result.summary, /src\/total\.ts was unavailable: Source could not be fetched/);
  const check = checkOutcome({ findings: result.findings, score: result.metadata.reviewScore?.value, files: 1, posted: 0, verdict: result.metadata.verdict });
  assert.equal(check.conclusion, "action_required");
  assert.equal(check.title, "Review incomplete");
});

test("a lockfile dropped to fit the review budget does not fail the check", async () => {
  const input: ReviewInput = {
    repository: "acme/app", baseSha: "base", headSha: "head", title: "Bump next", description: "",
    files: [{ path: "package.json", sha: "p", content: '{\n  "dependencies": { "next": "16.4.6" }\n}' }],
    diff: [
      { path: "package.json", status: "modified", patch: "@@ -1 +1 @@\n-\"next\": \"16.4.3\"\n+\"next\": \"16.4.6\"" },
      { path: "pnpm-lock.yaml", status: "modified", patch: "@@ -1 +1 @@\n+" + "x".repeat(320_000) },
    ],
    rules: [], mode: "standard", settings: { categories: ["correctness"] },
  };
  const result = await reviewChange(input, new CleanModel());
  assert.ok(result.metadata.skippedFiles?.some((f) => f.path === "pnpm-lock.yaml" && /budget|Lockfile/.test(f.reason)));
  assert.equal(result.metadata.coverageIncomplete, false);
  assert.equal(result.metadata.verdict, "ready");
  assert.ok(!result.metadata.coverageLimits?.some((l) => l.includes("was unavailable") || l.includes("were not reviewed")));
  const check = checkOutcome({ findings: result.findings, score: result.metadata.reviewScore?.value, files: input.diff.length, posted: 0, verdict: result.metadata.verdict });
  assert.equal(check.conclusion, "success");
});

test("a real source file dropped to fit the review budget still fails the check", async () => {
  const big = "+" + "x".repeat(200_000);
  const input: ReviewInput = {
    repository: "acme/app", baseSha: "base", headSha: "head", title: "Docs and migration", description: "",
    files: [
      { path: "src/db/migration.sql", sha: "m", content: "DELETE FROM users;" },
      { path: "README.md", sha: "r", content: "docs" },
    ],
    diff: [
      { path: "src/db/migration.sql", status: "modified", patch: "@@ -1 +1 @@\n+DELETE FROM users;" + big },
      { path: "README.md", status: "modified", patch: "@@ -1 +1 @@\n" + big },
    ],
    rules: [], mode: "standard", settings: { categories: ["correctness"] },
  };
  const result = await reviewChange(input, new CleanModel());
  assert.ok(result.metadata.skippedFiles?.some((f) => f.path === "README.md" && f.reason.includes("budget")));
  assert.equal(result.metadata.coverageIncomplete, true);
  assert.equal(result.metadata.verdict, "incomplete");
  const check = checkOutcome({ findings: result.findings, score: result.metadata.reviewScore?.value, files: 2, posted: 0, verdict: result.metadata.verdict });
  assert.equal(check.conclusion, "action_required");
});

test("a PR that adds a .gitignore entry hiding its own new .ts file stays incomplete", async () => {
  const input: ReviewInput = {
    repository: "acme/app", baseSha: "base", headSha: "head", title: "Hide payload", description: "",
    gitignore: "",
    files: [
      { path: ".gitignore", sha: "g", content: "payload.ts\n" },
      { path: "payload.ts", sha: "p", content: "export const exploit = true;\n" },
    ],
    diff: [
      { path: ".gitignore", status: "added", patch: "@@ -0,0 +1 @@\n+payload.ts\n" },
      { path: "payload.ts", status: "added", patch: "@@ -0,0 +1 @@\n+export const exploit = true;\n" },
    ],
    rules: [], mode: "standard", settings: { categories: ["correctness"] },
  };
  const result = await reviewChange(input, new CleanModel());
  assert.equal(result.metadata.coverageIncomplete, true);
  assert.equal(result.metadata.verdict, "incomplete");
  assert.ok(result.metadata.skippedFiles?.some((s) => s.path === "payload.ts"));
  assert.ok(!result.metadata.skippedFiles?.some((s) => s.path === "payload.ts" && s.reason === "Excluded by .gitignore"));
  const check = checkOutcome({ findings: result.findings, score: result.metadata.reviewScore?.value, files: input.diff.length, posted: 0, verdict: result.metadata.verdict });
  assert.equal(check.conclusion, "action_required");
});

test("a .ts file with a NUL byte stays incomplete", async () => {
  const input: ReviewInput = {
    repository: "acme/app", baseSha: "base", headSha: "head", title: "Binary source", description: "",
    files: [{ path: "src/app.ts", sha: "a", content: "export const x = 1;\0" }],
    diff: [{ path: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@\n-export const x = 0;\n+export const x = 1;\n" }],
    rules: [], mode: "standard", settings: { categories: ["correctness"] },
  };
  const result = await reviewChange(input, new CleanModel());
  assert.equal(result.metadata.coverageIncomplete, true);
  assert.deepEqual(result.metadata.skippedFiles, [{ path: "src/app.ts", reason: "Binary content" }]);
  const check = checkOutcome({ findings: result.findings, score: result.metadata.reviewScore?.value, files: 1, posted: 0, verdict: result.metadata.verdict });
  assert.equal(check.conclusion, "action_required");
});

test("a new file under vendor/ or build/ stays incomplete", async () => {
  for (const path of ["vendor/lib.ts", "build/out.ts"]) {
    const input: ReviewInput = {
      repository: "acme/app", baseSha: "base", headSha: "head", title: "Vendored", description: "",
      files: [{ path, sha: "v", content: "export const x = 1;\n" }],
      diff: [{ path, status: "added", patch: "@@ -0,0 +1 @@\n+export const x = 1;\n" }],
      rules: [], mode: "standard", settings: { categories: ["correctness"] },
    };
    const result = await reviewChange(input, new CleanModel());
    assert.equal(result.metadata.coverageIncomplete, true, path);
    assert.deepEqual(result.metadata.skippedFiles, [{ path, reason: "Generated or vendored path" }], path);
    const check = checkOutcome({ findings: result.findings, score: result.metadata.reviewScore?.value, files: 1, posted: 0, verdict: result.metadata.verdict });
    assert.equal(check.conclusion, "action_required", path);
  }
});

test("a new .env file stays incomplete", async () => {
  const input: ReviewInput = {
    repository: "acme/app", baseSha: "base", headSha: "head", title: "Secrets", description: "",
    files: [{ path: ".env", sha: "e", content: "SECRET=1\n" }],
    diff: [{ path: ".env", status: "added", patch: "@@ -0,0 +1 @@\n+SECRET=1\n" }],
    rules: [], mode: "standard", settings: { categories: ["correctness"] },
  };
  const result = await reviewChange(input, new CleanModel());
  assert.equal(result.metadata.coverageIncomplete, true);
  assert.deepEqual(result.metadata.skippedFiles, [{ path: ".env", reason: "Secret-looking path" }]);
  const check = checkOutcome({ findings: result.findings, score: result.metadata.reviewScore?.value, files: 1, posted: 0, verdict: result.metadata.verdict });
  assert.equal(check.conclusion, "action_required");
});

test("(c) truncated agent guideline files do not fail the check", async () => {
  const input: ReviewInput = {
    repository: "acme/app", baseSha: "base", headSha: "head", title: "Bump node", description: "",
    files: [{ path: "Dockerfile", sha: "d", content: "FROM node:26-bookworm-slim\n" }],
    diff: [{ path: "Dockerfile", status: "modified", patch: "@@ -1 +1 @@\n-FROM node:24-bookworm-slim\n+FROM node:26-bookworm-slim" }],
    coverageLimits: [
      "Agent guideline file .claude/skills/gsap-core/SKILL.md was truncated to fit the size and 8000-token budget.",
      "Agent guideline file .claude/skills/gsap-react/SKILL.md was truncated to fit the size and 8000-token budget.",
    ],
    rules: [], mode: "standard", settings: { categories: ["correctness"] },
  };
  const result = await reviewChange(input, new CleanModel());
  assert.equal(result.metadata.coverageIncomplete, false);
  assert.equal(result.metadata.verdict, "ready");
  assert.ok(result.metadata.coverageLimits?.some((l) => l.includes("truncated to fit the size and 8000-token budget")));
  const check = checkOutcome({ findings: result.findings, score: result.metadata.reviewScore?.value, files: 1, posted: 0, verdict: result.metadata.verdict });
  assert.equal(check.conclusion, "success");
  assert.doesNotMatch(check.summary, /did not cover every changed file/);
});
