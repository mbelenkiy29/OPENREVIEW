import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const dockerfile = readFileSync("Dockerfile", "utf8");
const readme = readFileSync("README.md", "utf8");

test("CI installs Node 24, then lints, typechecks, tests and builds", () => {
  assert.match(ci, /node-version:\s*24/);
  assert.match(ci, /pnpm lint/);
  assert.match(ci, /pnpm typecheck/);
  assert.match(ci, /pnpm test/);
  assert.match(ci, /pnpm build/);
});

test("issue templates exist for bugs and features, and security reports stay off the public tracker", () => {
  assert.ok(existsSync(".github/ISSUE_TEMPLATE/bug.yml"));
  assert.ok(existsSync(".github/ISSUE_TEMPLATE/feature.yml"));
  const config = readFileSync(".github/ISSUE_TEMPLATE/config.yml", "utf8");
  assert.match(config, /blank_issues_enabled:\s*false/);
  assert.match(config, /SECURITY\.md/);
  assert.match(readFileSync(".github/ISSUE_TEMPLATE/bug.yml", "utf8"), /openreview-cli/);
});

test("contributing docs name Node 24, the Docker Node 26 image, and that the CLI is unpublished", () => {
  assert.match(contributing, /Node\.js 24/);
  assert.match(contributing, /not published yet/);
  assert.match(contributing, /npm link/);
  assert.match(dockerfile, /Node 26 satisfies package\.json engines/);
  assert.match(dockerfile, /FROM node:26-bookworm-slim/);
  assert.match(readme, /Docker image is Node 26/);
  assert.match(readme, /lint, typecheck, test, and build/);
});
