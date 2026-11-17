import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { cliBuildAndLink, cliLinkFromCheckout, cliNpmPackage, cliNpmPublished } from "../src/cli-install";

const unpublishedInstall = [
  "npm install -g openreview-cli",
  "npx -y openreview-cli",
  "npx openreview-cli",
];
const userFacing = [
  "README.md",
  "packages/cli/README.md",
  "packages/cli/package.json",
  "docs/public/cli.md",
  "docs/public/fix-with-agents.md",
  "docs/public/quickstart.md",
  "app/dashboard/agents.tsx",
  "plugins/openreview/skills/review-local-changes/SKILL.md",
];

test("the CLI package is named openreview-cli, built by pnpm build:cli, and not marked private", () => {
  const pkg = JSON.parse(readFileSync("packages/cli/package.json", "utf8")) as {
    name: string;
    private?: boolean;
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.name, cliNpmPackage);
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.bin?.openreview, "dist/openreview.mjs");
  assert.match(pkg.scripts?.prepublishOnly ?? "", /pnpm build:cli/);
  assert.match(readFileSync("scripts/build-cli.ts", "utf8"), /packages\/cli\/dist\/openreview\.mjs/);
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).bin.openreview, "bin/openreview.mjs");
  assert.ok(existsSync("bin/openreview.mjs"));
});

test("user-facing install instructions match whether openreview-cli is on npm", () => {
  const hits: string[] = [];
  for (const file of userFacing) {
    const text = readFileSync(file, "utf8");
    for (const phrase of unpublishedInstall) {
      if (text.includes(phrase)) hits.push(`${file}: ${phrase}`);
    }
  }
  if (cliNpmPublished) {
    assert.ok(
      hits.some((h) => h.includes("npm install -g openreview-cli")),
      "after publish, README/docs should tell users npm install -g openreview-cli",
    );
  } else {
    assert.deepEqual(hits, [], "openreview-cli is not on npm; do not tell users to install it from the registry");
    const readme = readFileSync("README.md", "utf8");
    const cliDoc = readFileSync("docs/public/cli.md", "utf8");
    for (const line of cliLinkFromCheckout.split("\n")) {
      assert.ok(readme.includes(line), `README should include working command: ${line}`);
      assert.ok(cliDoc.includes(line), `docs/public/cli.md should include working command: ${line}`);
    }
    assert.ok(readme.includes(cliBuildAndLink.split("\n")[0]!), "README should mention pnpm build:cli");
    assert.match(readme, /not (yet )?on npm|not published/i);
    assert.match(cliDoc, /not (yet )?on npm|not published/i);
  }
});

test("a manual npm publish workflow exists for when NPM_TOKEN is configured", () => {
  const workflow = readFileSync(".github/workflows/publish-cli.yml", "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /pnpm build:cli/);
  assert.match(workflow, /npm publish/);
  assert.match(workflow, /secrets\.NPM_TOKEN/);
});
