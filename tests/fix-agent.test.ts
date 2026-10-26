import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryToolbox } from "../src/engine/agent";
import { fixAgentTools, maxFixFiles, runFixAgent } from "../src/engine/fix-agent";
import type { ModelProvider, ToolCall, ToolRequest, ToolTurn } from "../src/engine/types";

const head = "c".repeat(40);
const usage = { task: "fix", provider: "fixture", model: "fixture", inputTokens: 100, outputTokens: 10, latencyMs: 0, estimatedCost: 0, cached: false };
const files = [
  { path: "src/total.ts", sha: head, content: "export function total(cents: number, qty: number) {\n  return (cents * qty) / 100;\n}\n" },
  { path: "src/dup.ts", sha: head, content: "x();\nx();\n" },
  { path: ".github/workflows/ci.yml", sha: head, content: "on: push\n" },
  ...Array.from({ length: maxFixFiles + 1 }, (_, i) => ({ path: `src/f${i}.ts`, sha: head, content: `export const v${i} = 1;\n` })),
];
// Each turn yields scripted tool calls; tool results of the previous turn are kept for assertions.
class Scripted implements ModelProvider {
  results: { id: string; content: string; isError?: boolean }[][] = [];
  constructor(private turns: (ToolCall[] | null)[]) {}
  async runTools(request: ToolRequest): Promise<ToolTurn> {
    const last = request.messages.at(-1);
    if (last?.role === "tool") this.results.push(last.results);
    const calls = this.turns.shift() ?? [];
    return { content: calls?.length ? "" : "Done.", toolCalls: calls ?? [], stopReason: calls?.length ? "tool_use" : "end_turn", usage, message: { role: "assistant", content: "", toolCalls: calls ?? [] } };
  }
  async generate(): Promise<never> { throw new Error("not used"); }
}
const call = (name: string, input: unknown, id = name): ToolCall => ({ id, name, input });
const run = (model: Scripted, budget?: Parameters<typeof runFixAgent>[0]["budget"]) => runFixAgent({ model, tools: memoryToolbox(files, head), opening: "Fix the finding.", budget });

test("fix agent applies a unique edit, reads it back and finishes with the edits", async () => {
  const model = new Scripted([
    [call("edit_file", { path: "src/total.ts", oldText: "  return (cents * qty) / 100;", newText: "  return cents * qty; // $& stays literal" })],
    [call("read_file", { path: "src/total.ts" })],
    [call("finish", { summary: "Keep totals in cents." })],
  ]);
  const result = await run(model);
  assert.equal(result.finished, true);
  assert.equal(result.summary, "Keep totals in cents.");
  assert.deepEqual(result.edits, [{ path: "src/total.ts", content: "export function total(cents: number, qty: number) {\n  return cents * qty; // $& stays literal\n}\n" }]);
  assert.match(model.results[1][0].content, /return cents \* qty; \/\/ \$& stays literal/);
  assert.deepEqual(fixAgentTools.map((t) => t.name).sort(), ["edit_file", "find_definition", "find_references", "finish", "get_related_files", "list_directory", "read_file", "search_code"]);
});

test("fix agent rejects ambiguous, missing, workflow and secret edits", async () => {
  const model = new Scripted([
    [
      call("edit_file", { path: "src/dup.ts", oldText: "x();", newText: "y();" }, "dup"),
      call("edit_file", { path: "src/total.ts", oldText: "nope", newText: "y" }, "missing"),
      call("edit_file", { path: ".github/workflows/ci.yml", oldText: "on: push", newText: "on: pull_request" }, "workflow"),
      call("edit_file", { path: "src/total.ts", oldText: "  return (cents * qty) / 100;", newText: '  const key = "ghp_' + "a".repeat(36) + '";' }, "secret"),
      call("edit_file", { path: "src/absent.ts", oldText: "a", newText: "b" }, "absent"),
    ],
    [call("finish", { summary: "Nothing safe to change." })],
  ]);
  const result = await run(model);
  const [dup, missing, workflow, secret, absent] = model.results[0];
  assert.match(dup.content, /matches 2 places/);
  assert.match(missing.content, /not found in the file's current text/);
  assert.match(workflow.content, /Workflow files cannot be edited/);
  assert.match(secret.content, /looks like it contains a secret/);
  assert.match(absent.content, /File not found/);
  assert.ok([dup, missing, workflow, secret, absent].every((r) => r.isError));
  assert.deepEqual(result.edits, []);
});

test("fix agent caps changed files, drops reverted edits and stops on budget", async () => {
  const edits = Array.from({ length: maxFixFiles + 1 }, (_, i) => call("edit_file", { path: `src/f${i}.ts`, oldText: `v${i} = 1`, newText: `v${i} = 2` }, `e${i}`));
  const revert = call("edit_file", { path: "src/f0.ts", oldText: "v0 = 2", newText: "v0 = 1" }, "revert");
  const model = new Scripted([edits, [revert], [call("finish", { summary: "Bumped." })]]);
  const result = await run(model, { toolCalls: 100, tokens: 1e9, wallMs: 60_000, turns: 10 });
  assert.match(model.results[0][maxFixFiles].content, new RegExp(`at most ${maxFixFiles} files`));
  assert.equal(result.edits.length, maxFixFiles - 1);
  assert.ok(!result.edits.some((e) => e.path === "src/f0.ts"));

  const looping = new Scripted(Array.from({ length: 5 }, () => [call("read_file", { path: "src/total.ts" })]));
  const stopped = await run(looping, { toolCalls: 100, tokens: 1e9, wallMs: 60_000, turns: 2 });
  assert.equal(stopped.finished, false);
  assert.equal(stopped.stopReason, "turn budget exhausted");
});
