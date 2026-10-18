import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { securityContact, securityTxt } from "../src/security-txt";

test("security.txt has the fields RFC 9116 asks for, and expires within a year", () => {
  const now = new Date("2026-10-17T00:00:00Z");
  const text = securityTxt("https://openreview.tech", now);
  const fields = Object.fromEntries(text.trim().split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
  assert.equal(fields.Contact, `mailto:${securityContact}`);
  assert.equal(fields.Canonical, "https://openreview.tech/.well-known/security.txt");
  assert.equal(fields.Policy, "https://openreview.tech/security");
  const expires = Date.parse(fields.Expires);
  assert.ok(expires > now.getTime() && expires - now.getTime() < 365 * 86_400_000, fields.Expires);
  assert.match(fields.Expires, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test("the security contact is the same everywhere it is published", () => {
  for (const file of ["legal/security.md", "legal/privacy.md", "SECURITY.md"]) assert.ok(readFileSync(file, "utf8").includes(securityContact), file);
});

test("the security page makes no certification claims", () => {
  const page = readFileSync("legal/security.md", "utf8");
  assert.match(page, /has not had an independent security audit/);
  assert.doesNotMatch(page.replace(/does not hold SOC 2 or ISO 27001 certification/, ""), /SOC 2|ISO 27001|certified/i);
});
