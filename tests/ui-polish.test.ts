import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("app/globals.css", "utf8");
const layout = readFileSync("app/layout.tsx", "utf8");
const pulls = readFileSync("app/dashboard/pulls.tsx", "utf8");
const consent = readFileSync("app/oauth/consent/page.tsx", "utf8");
const dashboardError = readFileSync("app/dashboard/error.tsx", "utf8");
const portalError = readFileSync("app/dashboard/(portal)/error.tsx", "utf8");
const loading = readFileSync("app/dashboard/loading.tsx", "utf8");
const notFound = readFileSync("app/not-found.tsx", "utf8");
const design = readFileSync("DESIGN.md", "utf8");

test("keyboard users get a skip link to #main before page chrome", () => {
  assert.match(layout, /className="skip-link"[^>]*href="#main"/);
  assert.match(css, /\.skip-link\s*\{/);
  assert.match(css, /\.skip-link:focus\s*\{/);
  assert.match(readFileSync("app/page.tsx", "utf8"), /<main id="main"/);
  assert.match(readFileSync("app/docs/[[...slug]]/page.tsx", "utf8"), /<main id="main"/);
  assert.match(readFileSync("app/dashboard/(portal)/[[...section]]/page.tsx", "utf8"), /<main id="main"/);
});

test("OAuth consent and other standalone pages use the .narrow reading column", () => {
  assert.match(css, /\.welcome,\s*\n\.narrow\s*\{/);
  assert.match(consent, /className="narrow"/);
  assert.match(consent, /Authorization expired/);
  assert.match(consent, /href="\/docs\/mcp"/);
  assert.match(consent, /href="\/"/);
  assert.match(readFileSync("app/fix/[reviewId]/page.tsx", "utf8"), /className="narrow"/);
});

test("landing and welcome running-text links are underlined without relying on colour", () => {
  assert.match(css, /\.landing :where\(p, li, td, \.hero-links, \.feature-copy\) a:not\(\.button\)/);
  assert.match(css, /\.welcome :where\(p, li\) a:not\(\.button\)/);
  assert.match(css, /\.narrow :where\(p, li\) a:not\(\.button\)/);
  assert.match(design, /hero links, feature links/);
});

test("chart labels that convey data use --muted, not decorative --text-ter", () => {
  for (const selector of [".chart-y-title", ".chart-y span", ".chart-tip-date", ".chart-tip-row", ".chart-x", ".chart-board-name small"]) {
    const block = css.slice(css.indexOf(selector + " {"));
    assert.notEqual(css.indexOf(selector + " {"), -1, selector);
    const rule = block.slice(0, block.indexOf("\n}"));
    assert.match(rule, /color: var\(--muted\)/, selector);
    assert.doesNotMatch(rule, /--text-ter/, selector);
  }
});

test("the pull request table is a keyboard-scrollable ScrollTable", () => {
  assert.match(pulls, /import \{ ScrollTable \} from "\.\/scroll-table"/);
  assert.match(pulls, /<ScrollTable label="Pull requests" className="table-box pulls-wrap">/);
  assert.match(pulls, /<\/ScrollTable>/);
});

test("dashboard errors and first-load keep portal chrome instead of an unstyled onboarding block", () => {
  assert.match(dashboardError, /className="shell portal"/);
  assert.match(dashboardError, /className="portal-top"/);
  assert.doesNotMatch(dashboardError, /className="onboarding"/);
  assert.match(portalError, /Unable to load this page/);
  assert.match(portalError, /className="content"/);
  assert.match(loading, /className="shell portal"/);
  assert.match(loading, /className="portal-top"/);
  assert.match(loading, /className="content page"/);
});

test("the public 404 offers home and docs as buttons", () => {
  assert.match(notFound, /className="button primary"[^>]*href="\/"/);
  assert.match(notFound, /href="\/docs\/quickstart"/);
});

test("legal pages wrap markdown tables in ScrollTable so they scroll instead of stretching the page", () => {
  const legal = readFileSync("app/legal.tsx", "utf8");
  assert.match(legal, /ScrollTable label=\{labels\[table\+\+\] \?\? "Table"\}/);
  assert.match(legal, /<pre tabIndex=\{0\}>/);
});
