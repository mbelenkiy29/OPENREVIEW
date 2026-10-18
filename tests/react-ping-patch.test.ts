import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// patches/next@15.5.27.patch: in production React, a streamed RSC row that arrived while the render
// yielded resolves its then() synchronously, so its ping lands in the render phase. Unpatched, a pass
// already suspended with delay drops that ping and the transition never commits (react#37805): guided
// setup stayed on "Starting indexing…". The patch backports React 19.3, which records the ping; Next 16.4
// bundles that fix, so the patch can go with the upgrade.
const next = dirname(createRequire(import.meta.url).resolve("next/package.json"));
const builds = ["react-dom", "react-dom-experimental"].flatMap((channel) =>
  ["react-dom-client.production.js", "react-dom-profiling.profiling.js"].map((file) => join(next, "dist/compiled", channel, "cjs", file)));

test("Next's bundled React keeps a ping that arrives during render", () => {
  for (const file of builds) {
    const source = readFileSync(file, "utf8");
    const start = source.indexOf("function pingSuspendedRoot(");
    assert.ok(start >= 0, `${file} has no pingSuspendedRoot`);
    const body = source.slice(start, source.indexOf("\nfunction ", start + 1));
    assert.doesNotMatch(body, /&&\s*prepareFreshStack\(root, 0\)/, `${file} drops render-phase pings; re-apply the patch for this Next version`);
    assert.equal(body.split("workInProgressRootPingedLanes |= pingedLanes").length - 1, 2, `${file} should record the ping in both branches`);
  }
});
