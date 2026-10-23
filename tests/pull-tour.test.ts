import test from "node:test";
import assert from "node:assert/strict";
import { buildTour, groundTour } from "../src/pull-tour";
import type { ModelProvider } from "../src/engine/types";

test("tour steps keep only real changed files, each once, and collect the rest", () => {
  const steps = groundTour([
    { title: "Data model", explanation: "Adds cents to the cart type.", files: ["src/types.ts", "src/invented.ts"] },
    { title: "Totals", explanation: "Uses cents everywhere.", files: ["src/cart.ts", "src/types.ts"] },
    { title: "Nothing real", explanation: "Only made-up files here.", files: ["nope.ts"] },
  ], ["src/types.ts", "src/cart.ts", "README.md"]);
  assert.deepEqual(steps.map((s) => [s.title, s.files]), [["Data model", ["src/types.ts"]], ["Totals", ["src/cart.ts"]], ["Other changes", ["README.md"]]]);
});

test("the model sees bounded patches and its answer is grounded", async () => {
  let input: { files: { patch: string }[] } | undefined;
  const model: ModelProvider = { generate: async (request, schema) => { input = request.input as typeof input; return { value: schema.parse({ steps: [{ title: "Core", explanation: "The main change in one file.", files: ["a.ts", "ghost.ts"] }] }), usage: { task: "tour", provider: "f", model: "f", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } }; } };
  const { steps } = await buildTour(model, { title: "T", files: [{ path: "a.ts", status: "modified", patch: "x".repeat(9000) }, { path: "b.ts", status: "added", patch: "y" }] });
  assert.equal(input?.files[0].patch.length, 4000);
  assert.deepEqual(steps.map((s) => s.files), [["a.ts"], ["b.ts"]]);
});
