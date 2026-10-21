import test from "node:test";
import assert from "node:assert/strict";
import { pullChatReturn, runsWithoutAsking, withSelectedContext } from "../src/pull-chat";

test("chat permissions: ask waits, routine runs comments only, full runs everything, and allowed kinds stick", () => {
  assert.equal(runsWithoutAsking("ask", [], "comment"), false);
  assert.equal(runsWithoutAsking("routine", [], "comment"), true);
  assert.equal(runsWithoutAsking("routine", [], "merge"), false);
  assert.equal(runsWithoutAsking("full", [], "merge"), true);
  assert.equal(runsWithoutAsking("ask", ["comment"], "comment"), true);
});

test("the chat form only returns to a pull request page, and selected context stays within the question limit", () => {
  assert.equal(pullChatReturn("/dashboard/pulls/vn7bn5ymdmz7jtjxmgqmyry1f18gpn91"), "/dashboard/pulls/vn7bn5ymdmz7jtjxmgqmyry1f18gpn91");
  assert.equal(pullChatReturn("/dashboard/pulls/pr/ss76wyb740axydchn2rwhjx20h8gpcmy"), "/dashboard/pulls/pr/ss76wyb740axydchn2rwhjx20h8gpcmy");
  for (const bad of ["https://evil.example/dashboard/pulls/abc", "//evil.example", "/dashboard/pulls/x?y=1", "/dashboard/settings"]) assert.equal(pullChatReturn(bad), null);
  assert.equal(withSelectedContext("Why?", ""), "Why?");
  assert.equal(withSelectedContext("Why?", "logger.info(request)"), "Why?\n\nSelected context:\nlogger.info(request)");
  assert.equal(withSelectedContext("Why?", "x".repeat(5000)).length, 4000);
});
