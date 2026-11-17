import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("app/globals.css", "utf8");
const consent = readFileSync("app/consent.tsx", "utf8");

test("the cookie banner reports its painted height as --consent-h", () => {
  assert.match(consent, /ResizeObserver/);
  assert.match(consent, /--consent-h/);
  assert.match(css, /padding-bottom: calc\(var\(--consent-h, 8rem\) \+ 12px\)/);
});

test("on auth and onboarding pages the cookie banner is in document flow so it cannot cover GitLab, Terms or Logout", () => {
  assert.match(css, /body:has\(\.auth, \.wizard\) \.consent \{/);
  const auth = css.slice(css.indexOf("body:has(.auth, .wizard) .consent {"));
  assert.match(auth.slice(0, auth.indexOf("\n}")), /position: static/);
  assert.match(css, /body:has\(\.auth, \.wizard\):has\(\.consent\) \{\n\s*padding-bottom: 0;/);
  assert.doesNotMatch(css, /body:has\(\.consent\) \.auth-panel/);
});

test("docs and legal markdown tables wrap so comparison columns fit at 1280px", () => {
  assert.match(css, /\.docs-content \.table-scroll table,\n\.docs-content \.table-scroll :is\(th, td\) \{\n\s*white-space: normal;/);
  assert.match(css, /@media \(min-width: 960px\) \{\n\s*\.docs-content \.table-scroll table \{\n\s*table-layout: fixed;/);
});

test("narrow public tables keep a thin visible scrollbar when they still overflow", () => {
  const mobile = css.slice(css.indexOf("@media (max-width: 959px)"));
  assert.match(mobile, /\.docs-content \.table-scroll \{\n\s*scrollbar-width: thin;/);
  assert.match(mobile, /\.docs-content \.table-scroll::-webkit-scrollbar \{\n\s*display: block;/);
});
