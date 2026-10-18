import test from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { comparisons, contractChecks, documentedBoundaries } from "../src/engine/contract-checks";
import { reviewChange } from "../src/engine/review";
import type { ModelProvider, ModelRequest } from "../src/engine/types";

// A changed file whose every line is added, as in a new file.
const added = (path: string, content: string) => ({
  diff: [{ path, status: "added", patch: `@@ -0,0 +1,${content.split("\n").length} @@\n` + content.split("\n").map((l) => "+" + l).join("\n") }],
  files: [{ path, content, sha: "b" }],
});
const shipping = (comparison: string) => `import { cartTotal, type Item } from "./cart";

/** Orders of $50.00 or more ship free; anything smaller pays a flat $5.99. Returns dollars. */
export function shippingCost(items: Item[]): number {
  return ${comparison};
}`;

test("the missed shipping boundary: '$50.00 or more' compared with '> 50' is flagged; '>= 50' is not", () => {
  const wrong = added("src/shipping.ts", shipping("cartTotal(items) > 50 ? 0 : 5.99"));
  assert.deepEqual(contractChecks(wrong.diff, wrong.files), [{ filePath: "src/shipping.ts", line: 5, comparison: "> 50", documented: "$50.00 or more", source: "comment", documentedLine: 3 }]);
  const right = added("src/shipping.ts", shipping("cartTotal(items) >= 50 ? 0 : 5.99"));
  assert.deepEqual(contractChecks(right.diff, right.files), []);
  // The same boundary written the other way round: below 50 pays, so 50 itself ships free.
  const negated = added("src/shipping.ts", shipping("cartTotal(items) < 50 ? 5.99 : 0"));
  assert.deepEqual(contractChecks(negated.diff, negated.files), []);
  const flipped = added("src/shipping.ts", shipping("50 < cartTotal(items) ? 0 : 5.99"));
  assert.equal(contractChecks(flipped.diff, flipped.files)[0]?.comparison, "50 <");
});

test("each documented boundary kind is checked against the comparison direction", () => {
  const cases: [string, string, boolean][] = [
    ["// Retries at most 3 times", "if (attempt < 3) retry();", true],
    ["// Retries at most 3 times", "if (attempt <= 3) retry();", false],
    ["// Only lists with more than 10 items are paginated", "if (items.length >= 10) paginate();", true],
    ["// Only lists with more than 10 items are paginated", "if (items.length > 10) paginate();", false],
    ["# Visitors under 18 need consent", "if age <= 18: require_consent()", true],
    ["# Visitors under 18 need consent", "if age < 18: require_consent()", false],
    ["// Members 65 or older get the senior rate", "if (age > 65) senior();", true],
    ["// Keep up to 100 entries", "while (cache.size < 100) add();", true],
    ["// Discounts apply from 1,000 units", "if (units > 1000) discount();", true],
  ];
  for (const [comment, code, flagged] of cases) {
    const f = added("src/rules.ts", comment + "\n" + code);
    assert.equal(contractChecks(f.diff, f.files).length > 0, flagged, comment + " / " + code);
  }
});

test("the pull request description is a contract for changed comparisons without a comment", () => {
  const f = added("src/shipping.ts", "export const shippingCost = (total: number) => (total > 50 ? 0 : 5.99);");
  assert.deepEqual(contractChecks(f.diff, f.files, "Adds free shipping from $50."), [{ filePath: "src/shipping.ts", line: 1, comparison: "> 50", documented: "from $50", source: "description" }]);
  assert.deepEqual(contractChecks(f.diff, f.files, "Adds free shipping over $50."), []);
});

test("unchanged code, other numbers, trailing comments and non-comparisons", () => {
  const content = "/** At least 5 seats. */\nexport const ok = (n: number) => n > 5;";
  // Neither line changed: an old contradiction is not this change's to report.
  const unchanged = { diff: [{ path: "src/a.ts", status: "modified", patch: "@@ -1,2 +1,3 @@\n /** At least 5 seats. */\n export const ok = (n: number) => n > 5;\n+export const other = 1;" }], files: [{ path: "src/a.ts", content: content + "\nexport const other = 1;", sha: "b" }] };
  assert.deepEqual(contractChecks(unchanged.diff, unchanged.files), []);
  const cents = added("src/b.ts", "// $50 or more ships free\nconst free = totalCents > 5000;");
  assert.deepEqual(contractChecks(cents.diff, cents.files), [], "a different number is not this boundary");
  const trailing = added("src/c.ts", "const free = total > 50; // free from $50");
  assert.equal(contractChecks(trailing.diff, trailing.files)[0]?.documented, "from $50");
  assert.deepEqual(comparisons("const f = (x) => 50; const y = a >> 2; const z = a << 3;"), []);
  assert.deepEqual(comparisons("if (x >= 50 && y <= 3)").map((c) => [c.text, c.side]), [[">= 50", "upper"], ["<= 3", "lower"]]);
  assert.deepEqual(documentedBoundaries("Orders of $50.00 or more, but no more than 3 items").map((d) => [d.value, d.side]), [[50, "upper"], [3, "lower"]]);
});

test("the correctness specialist receives the contract checks; other specialists and clean changes do not", async () => {
  const requests: ModelRequest[] = [];
  const model: ModelProvider = {
    async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
      requests.push(request);
      const value = request.task.startsWith("review:") ? { findings: [] } : request.task === "diagram" ? { diagram: null } : { summary: "Adds free shipping from fifty dollars.", reviewScore: { value: 4, reason: "No verified findings in the reviewed change." } };
      return { value: schema.parse(value), usage: { task: request.task, provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 1, latencyMs: 0, estimatedCost: 0, cached: false } };
    },
  };
  const run = async (comparison: string) => {
    requests.length = 0;
    const f = added("src/shipping.ts", shipping(comparison));
    await reviewChange({ repository: "acme/shop", baseSha: "a".repeat(40), headSha: "b".repeat(40), title: "Shipping", description: "Free shipping from $50.\nCI: []", rules: [], mode: "fast", files: f.files, diff: f.diff }, model);
    return Object.fromEntries(requests.filter((r) => r.task.startsWith("review:")).map((r) => [r.task, (r.input as { assignment: { focus: string; contractChecks?: unknown[] } }).assignment]));
  };
  const flagged = await run("cartTotal(items) > 50 ? 0 : 5.99");
  assert.deepEqual(flagged["review:correctness"].contractChecks, [{ filePath: "src/shipping.ts", line: 5, comparison: "> 50", documented: "$50.00 or more", source: "comment", documentedLine: 3 }]);
  assert.match(flagged["review:correctness"].focus, /inclusive versus exclusive boundaries[\s\S]*assignment\.contractChecks lists/);
  for (const [task, assignment] of Object.entries(flagged)) if (task !== "review:correctness") assert.equal(assignment.contractChecks, undefined, task);
  const clean = await run("cartTotal(items) >= 50 ? 0 : 5.99");
  assert.equal(clean["review:correctness"].contractChecks, undefined);
  assert.doesNotMatch(clean["review:correctness"].focus, /contractChecks/);
});

test("an invented ruleId no longer discards a correctness finding; rules findings still need a real rule", async () => {
  const f = added("src/shipping.ts", shipping("cartTotal(items) > 50 ? 0 : 5.99"));
  const candidate = (category: string) => ({ title: "Orders of exactly $50 still pay shipping", description: "The comment says $50.00 or more ships free, but the comparison is exclusive, so exactly 50 pays shipping.", severity: "medium", confidence: 0.95, category, filePath: "src/shipping.ts", startLine: 5, endLine: 5, evidence: [{ filePath: "src/shipping.ts", startLine: 3, quote: "/** Orders of $50.00 or more ship free; anything smaller pays a flat $5.99. Returns dollars. */" }, { filePath: "src/shipping.ts", startLine: 5, quote: "  return cartTotal(items) > 50 ? 0 : 5.99;" }], impact: "A $50.00 order is charged $5.99 shipping.", suggestedFix: "Compare with >= 50.", symbol: "shippingCost", ruleId: "contract-boundary-inclusive" });
  const run = async (category: "correctness" | "rules") => {
    const model: ModelProvider = {
      async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
        const value = request.task === `review:${category}` ? { findings: [candidate(category)] } : request.task.startsWith("review:") ? { findings: [] } : request.task === "verify" ? { decisions: [{ index: 0, publish: true, confidence: 0.95, reason: "Line 3 documents an inclusive $50 threshold and line 5 compares exclusively." }] } : request.task === "diagram" ? { diagram: null } : request.task === "resolution" ? { resolved: [] } : { summary: "Adds free shipping from fifty dollars.", reviewScore: { value: 3, reason: "One boundary defect needs a fix before merging." } };
        return { value: schema.parse(value), usage: { task: request.task, provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 1, latencyMs: 0, estimatedCost: 0, cached: false } };
      },
    };
    return reviewChange({ repository: "acme/shop", baseSha: "a".repeat(40), headSha: "b".repeat(40), title: "Shipping", description: "", rules: [{ id: "rule-money", instructions: "Money amounts are integer cents.", severity: "medium", category: "rules", globs: ["src/**"], enabled: true }], mode: "fast", files: f.files, diff: f.diff, settings: { categories: [category] } as never }, model);
  };
  const kept = await run("correctness");
  assert.deepEqual(kept.findings.map((x) => [x.title, x.ruleId]), [["Orders of exactly $50 still pay shipping", undefined]]);
  const rule = await run("rules");
  assert.deepEqual(rule.findings, []);
  assert.deepEqual((rule.metadata.suppressions ?? []).map((s) => s.reason), ["Unknown or inapplicable rule"]);
});
