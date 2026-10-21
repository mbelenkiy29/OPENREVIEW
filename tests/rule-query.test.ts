import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRuleQuery } from "../src/rule-query";

test("parseRuleQuery splits filter tokens from free text", () => {
  assert.deepEqual(parseRuleQuery("repository:acme/web  status:Disabled  money cents"), { text: "money cents", repository: "acme/web", status: "disabled" });
  assert.deepEqual(parseRuleQuery("status:archived logging"), { text: "status:archived logging" }, "an unknown status stays search text");
  assert.deepEqual(parseRuleQuery(""), { text: "" });
  assert.deepEqual(parseRuleQuery(undefined), { text: "" });
});
