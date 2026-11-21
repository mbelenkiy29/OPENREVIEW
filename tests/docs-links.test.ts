import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { comparePages, compareSlugs } from "../src/compare-pages";
import { docPages, resolveDocLink } from "../src/docs-manifest";
import { markdownTableLabels } from "../src/markdown-tables";

const markdown = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? markdown(path.join(dir, e.name)) : e.name.endsWith(".md") ? [path.join(dir, e.name)] : []);
// Markdown links outside fenced code blocks.
const links = (file: string) => readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "").matchAll(/\]\(([^)\s]+)\)/g);

test("every relative link in the README and docs points to an existing file", () => {
  const broken: string[] = [];
  for (const file of ["README.md", "CHANGELOG.md", ...markdown("docs")]) for (const [, href] of links(file)) {
    const target = href.split("#")[0];
    if (!target || /^[a-z]+:/i.test(target) || target.startsWith("/")) continue;
    if (!existsSync(path.join(path.dirname(file), target))) broken.push(`${file} → ${href}`);
  }
  assert.deepEqual(broken, []);
});

test("internal QA logs live under docs/internal and are not published", () => {
  assert.deepEqual(readdirSync("docs").filter((f) => f.endsWith("-acceptance.md")), []);
  assert.ok(readdirSync("docs/internal").length > 0);
  assert.ok(docPages.every((d) => !d.file.startsWith("internal/")));
});

test("the published docs manifest is complete and its cross-links resolve to published pages", () => {
  assert.equal(new Set(docPages.map((d) => d.slug)).size, docPages.length);
  for (const required of ["quickstart", "github-app", "configuration", "rules", "api", "mcp", "cli", "self-hosting", "gitlab", "bitbucket-cloud", "bitbucket-data-center", "gitea", "perforce"]) assert.ok(docPages.some((d) => d.slug === required), required);
  assert.ok(existsSync("docs/AUDIT.md"));
  for (const page of docPages) {
    assert.ok(existsSync(path.join("docs", page.file)), page.file);
    for (const [, href] of links(path.join("docs", page.file))) {
      const resolved = resolveDocLink(page.file, href);
      // New public pages may only link to other published pages, external sites or anchors.
      if (page.file.startsWith("public/")) assert.notEqual(resolved.kind, "text", `${page.file} → ${href}`);
    }
  }
  assert.deepEqual(resolveDocLink("public/quickstart.md", "../repo-config.md#locks"), { kind: "doc", url: "/docs/configuration#locks" });
  assert.deepEqual(resolveDocLink("gitlab.md", "internal/x-acceptance.md"), { kind: "text" });
  assert.deepEqual(resolveDocLink("gitlab.md", "https://docs.gitlab.com"), { kind: "external", url: "https://docs.gitlab.com" });
  assert.deepEqual(resolveDocLink("CHANGELOG.md", "docs/public/fix-with-agents.md"), { kind: "doc", url: "/docs/fix-with-agents" });
});

test("each docs and legal table is labelled from the nearest heading, uniquely on the page", () => {
  assert.deepEqual(markdownTableLabels("# Page\n\n## Plans\n\n| Feature | Free |\n| --- | --- |\n| Price | $0 |\n\n## Usage\n\n| Event | When |\n| --- | --- |\n| a | b |\n\n| Event | Notes |\n| --- | --- |\n| c | d |\n"), ["Plans", "Usage", "Usage (2)"]);
  for (const page of docPages) {
    const labels = markdownTableLabels(readFileSync(path.join("docs", page.file), "utf8"));
    assert.equal(new Set(labels).size, labels.length, `${page.file}: ${labels.join(", ")}`);
  }
  for (const file of ["privacy", "terms", "security"]) {
    const labels = markdownTableLabels(readFileSync(path.join("legal", `${file}.md`), "utf8"));
    assert.equal(new Set(labels).size, labels.length, file);
  }
  for (const slug of compareSlugs) {
    const file = comparePages[slug].file;
    const labels = markdownTableLabels(readFileSync(file, "utf8"));
    assert.equal(new Set(labels).size, labels.length, file);
  }
  assert.match(readFileSync("app/legal.tsx", "utf8"), /ScrollTable/);
  assert.match(readFileSync("app/docs/[[...slug]]/page.tsx", "utf8"), /markdownTableLabels/);
  assert.match(readFileSync("docs/billing.md", "utf8"), /^\| Feature \| Free \| Starter \| Pro \|$/m);
});
