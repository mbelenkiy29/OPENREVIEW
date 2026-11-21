import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CompareTable } from "../app/compare/table";
import { comparePages, compareSlugs } from "../src/compare-pages";

const render = (source: string) => renderToStaticMarkup(createElement(Markdown, {
  remarkPlugins: [remarkGfm],
  skipHtml: true,
  disallowedElements: ["img"],
  components: {
    table: ({ children }: { children?: ReactNode }) => createElement(CompareTable, null, children),
  },
}, source));

test("compare tables stamp column headers onto body cells as data-label", () => {
  const html = render("| | OpenReview | Greptile |\n| --- | --- | --- |\n| Positioning | A | B |\n| License | MIT | Closed |\n");
  assert.match(html, /<table class="compare-table">/);
  const thead = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
  assert.match(thead, /<th>OpenReview<\/th>/);
  assert.match(thead, /<th>Greptile<\/th>/);
  assert.doesNotMatch(thead, /data-label/);
  assert.match(html, /<td data-label="">Positioning<\/td>/);
  assert.match(html, /<td data-label="OpenReview">A<\/td>/);
  assert.match(html, /<td data-label="Greptile">B<\/td>/);
  assert.equal((html.match(/data-label="OpenReview"/g) ?? []).length, 2);
  assert.equal((html.match(/data-label="Greptile"/g) ?? []).length, 2);
});

test("hosted compare markdown tables get OpenReview and competitor data-labels", () => {
  for (const slug of compareSlugs) {
    const page = comparePages[slug];
    const html = render(readFileSync(page.file, "utf8"));
    assert.match(html, /<table class="compare-table">/);
    assert.match(html, /<td data-label="">Positioning<\/td>/);
    assert.match(html, /data-label="OpenReview"/);
    assert.match(html, new RegExp(`data-label="${page.competitor}"`));
    const rows = (html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr>/g) ?? []).length;
    assert.equal((html.match(/data-label="OpenReview"/g) ?? []).length, rows, slug);
    assert.equal((html.match(new RegExp(`data-label="${page.competitor}"`, "g")) ?? []).length, rows, slug);
  }
});

test("compare table rendering still skips HTML and images", () => {
  const html = render("| | OpenReview |\n| --- | --- |\n| X | <script>alert(1)</script> ![Tracker](https://evil.example/pixel) |\n");
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /evil\.example/);
  assert.match(html, /data-label="OpenReview"/);
});

test("compare pages keep allowlisted markdown rendering and stack cards only at 640px", () => {
  const page = readFileSync("app/compare/[slug]/page.tsx", "utf8");
  assert.match(page, /export const dynamicParams = false/);
  assert.match(page, /skipHtml disallowedElements=\{\["img"\]\}/);
  assert.match(page, /className="docs-layout single compare-page"/);
  assert.match(page, /<CompareTable>\{children\}<\/CompareTable>/);
  const css = readFileSync("app/compare/compare.css", "utf8");
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /content: attr\(data-label\) ": "/);
  assert.match(css, /\.compare-page \.compare-table thead/);
  assert.doesNotMatch(css, /@media \(max-width: 1280px\)/);
});
