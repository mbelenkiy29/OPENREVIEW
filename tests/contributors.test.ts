import assert from "node:assert/strict";
import { test } from "node:test";
import { contributorKey, isBotAuthor } from "../src/contributors";

test("a linked author is one key on every provider; unlinked accounts are one each", () => {
  assert.equal(contributorKey({ provider: "github", login: "Ada", userId: "u1" }), "user:u1");
  assert.equal(contributorKey({ provider: "gitlab", connectionId: "c1", login: "ada.l", userId: "u1" }), "user:u1");
  assert.notEqual(contributorKey({ provider: "github", login: "ada" }), contributorKey({ provider: "gitlab", connectionId: "c1", login: "ada" }));
});
test("logins are case-insensitive and a missing author has no key", () => {
  assert.equal(contributorKey({ provider: "github", login: "Ada" }), "github:github:ada");
  assert.equal(contributorKey({ provider: "github", login: " ADA " }), contributorKey({ provider: "github", login: "ada" }));
  for (const login of [undefined, null, "", "  "]) assert.equal(contributorKey({ provider: "github", login }), null);
});
test("bots and the contract's non-billable authors never count", () => {
  for (const login of ["dependabot[bot]", "renovate[bot]", "Some-App[BOT]", "project_123_bot", "project_123_bot_4ffca233d8298ea1", "group_9_bot_ab12"]) assert.equal(isBotAuthor(login), true, login);
  for (const login of ["ada", "robot", "project_bot", "botanist"]) assert.equal(isBotAuthor(login), false, login);
  assert.equal(isBotAuthor("Release-Bot", ["release-bot"]), true);
  assert.equal(isBotAuthor("ada", ["release-bot"]), false);
});
