import { test } from "node:test";
import assert from "node:assert/strict";
import { filterValue, groupPatch, highestRole, paging, userInput, userPatch } from "../src/scim";

test("SCIM filters: only attribute eq \"value\" is read", () => {
  assert.equal(filterValue(undefined, "userName"), undefined);
  assert.equal(filterValue('userName eq "Ada@Example.com"', "userName"), "Ada@Example.com");
  assert.equal(filterValue('USERNAME EQ "a\\"b"', "userName"), 'a"b');
  for (const f of ['userName co "ada"', 'displayName eq "x"', 'userName eq "a" or userName eq "b"']) assert.equal(filterValue(f, "userName"), null, f);
  assert.deepEqual([paging(null, null), paging("0", "5000"), paging("3", "0")], [{ startIndex: 1, count: 100 }, { startIndex: 1, count: 200 }, { startIndex: 3, count: 0 }]);
});
test("SCIM users: userName is an email, unknown attributes are ignored, and Entra's string booleans are read", () => {
  assert.deepEqual(userInput({ schemas: ["x"], userName: " Ada@Example.com ", name: { givenName: "Ada", familyName: "L" }, active: "False", title: "ignored", "urn:custom": { a: 1 } }), { userName: "ada@example.com", externalId: undefined, displayName: "Ada L", active: false });
  assert.equal(userInput({ userName: "not-an-email" }).userName, undefined);
  assert.deepEqual(userPatch({ Operations: [{ op: "Replace", path: "active", value: "False" }] }), { active: false });
  assert.deepEqual(userPatch({ Operations: [{ op: "replace", value: { active: true, displayName: "Ada", nickName: "x" } }, { op: "remove", path: "active" }] }), { active: true, displayName: "Ada" });
});
test("SCIM groups: members are added, removed by path or value, or replaced; the highest mapped role wins", () => {
  assert.deepEqual(groupPatch({ Operations: [{ op: "add", path: "members", value: [{ value: "u1" }, { value: "u2" }] }, { op: "remove", path: 'members[value eq "u3"]' }, { op: "remove", path: "members", value: [{ value: "u4" }] }] }), { add: ["u1", "u2"], remove: ["u3", "u4"] });
  assert.deepEqual(groupPatch({ Operations: [{ op: "replace", value: { displayName: "Admins", members: [{ value: "u1" }] } }] }), { displayName: "Admins", add: [], remove: [], replace: ["u1"] });
  assert.deepEqual(groupPatch({ Operations: [{ op: "remove", path: "members" }] }).replace, []);
  assert.deepEqual([highestRole(["viewer", "admin"]), highestRole(["viewer", "member"]), highestRole([])], ["admin", "member", null]);
});
