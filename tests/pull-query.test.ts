import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePullQuery, withToken, withoutToken } from "../src/pull-query";

test("search tokens become filters and the rest stays free text", () => {
  assert.deepEqual(parsePullQuery("retry budget author:@Alice repo:acme/api status:Completed impact:HIGH state:open"), { author: "Alice", repo: "acme/api", status: "completed", impact: "high", state: "open", search: "retry budget" });
  assert.deepEqual(parsePullQuery('repo:"acme/my api" fix'), { repo: "acme/my api", search: "fix" });
  assert.deepEqual(parsePullQuery(""), {});
});

test("confidence takes comparisons on the 0–5 score; anything else is searched as text", () => {
  assert.deepEqual(parsePullQuery("confidence:>3"), { scoreMin: 4 });
  assert.deepEqual(parsePullQuery("confidence:>=3"), { scoreMin: 3 });
  assert.deepEqual(parsePullQuery("confidence:<2"), { scoreMax: 1 });
  assert.deepEqual(parsePullQuery("confidence:5"), { scoreMin: 5, scoreMax: 5 });
  assert.deepEqual(parsePullQuery("confidence:9 owner:me author:"), { search: "confidence:9 owner:me author:" });
});

test("chips replace a token of the same key and quote values with spaces", () => {
  assert.equal(withToken("fix author:bob", "author", "alice"), "fix author:alice");
  assert.equal(withToken("", "repo", "acme/my api"), 'repo:"acme/my api"');
  assert.equal(withoutToken("fix state:open author:bob", "state"), "fix author:bob");
});
