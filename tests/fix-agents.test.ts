import test from "node:test";
import assert from "node:assert/strict";
import { defaultLocalAgent, isLocalAgent, localAgentLabels, localAgents, resolveLocalAgent } from "../src/fix-agents";

test("one default local agent everywhere: the personal choice, then the workspace, then Claude Code", () => {
  assert.equal(defaultLocalAgent, "claude");
  assert.equal(resolveLocalAgent(undefined, undefined), "claude");
  assert.equal(resolveLocalAgent(undefined, "codex"), "codex");
  assert.equal(resolveLocalAgent("cursor", "codex"), "cursor");
  assert.equal(resolveLocalAgent("devin", "nope"), "claude", "unknown stored values never reach the bridge");
  assert.deepEqual([...localAgents].sort(), ["claude", "codex", "cursor"]);
  for (const agent of localAgents) assert.ok(localAgentLabels[agent]);
  assert.equal(isLocalAgent("copilot"), false);
});
