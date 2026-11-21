import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const notifications = readFileSync("app/dashboard/notifications.tsx", "utf8");
const notificationsDoc = readFileSync("docs/notifications.md", "utf8");
const selfHostDoc = readFileSync("docs/public/self-hosting.md", "utf8");
const billing = readFileSync("app/dashboard/billing.tsx", "utf8");
const portal = readFileSync("app/dashboard/portal.tsx", "utf8");
const integrations = readFileSync("app/dashboard/integrations.tsx", "utf8");
const rules = readFileSync("app/dashboard/sections/rules.tsx", "utf8");
const context = readFileSync("app/dashboard/context-client.tsx", "utf8");
const chart = readFileSync("app/dashboard/analytics-chart.tsx", "utf8");
const plan = readFileSync("app/dashboard/onboarding/[step]/page.tsx", "utf8");

test("notifications do not name Slack operator env vars in the customer UI", () => {
  assert.match(notifications, /Slack isn&apos;t configured on this deployment/);
  assert.match(notifications, /href="\/docs\/notifications"/);
  assert.doesNotMatch(notifications, /SLACK_CLIENT_ID|SLACK_CLIENT_SECRET|SLACK_SIGNING_SECRET|slack-app-manifest/);
});

const operatorEnv = [
  "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET",
  "RESEND_API_KEY", "EMAIL_FROM", "OPENREVIEW_OFFLINE",
  "LINEAR_CLIENT_ID", "ATLASSIAN_CLIENT_ID", "ATLASSIAN_CLIENT_SECRET",
  "NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET",
];
const customerCopy = (source: string) => source.replace(/process\.env\.\w+/g, "");

test("email and integration setup do not name operator env vars in customer copy", () => {
  assert.match(notifications, /Email isn&apos;t configured on this deployment/);
  assert.match(integrations, /Linear isn&apos;t configured on this deployment/);
  assert.match(integrations, /Notion isn&apos;t configured on this deployment/);
  assert.match(integrations, /Atlassian isn&apos;t configured on this deployment/);
  assert.match(integrations, /href="\/docs\/linear"/);
  assert.match(integrations, /href="\/docs\/notion"/);
  assert.match(integrations, /href="\/docs\/atlassian"/);
  for (const name of operatorEnv) {
    assert.doesNotMatch(customerCopy(notifications), new RegExp(name));
    assert.doesNotMatch(customerCopy(integrations), new RegExp(name));
  }
});

test("self-host docs list Slack env var names only", () => {
  for (const name of ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"]) {
    assert.match(notificationsDoc, new RegExp("`" + name + "`"));
    assert.match(selfHostDoc, new RegExp("`" + name + "`"));
    assert.doesNotMatch(notificationsDoc, new RegExp(name + "\\s*="));
    assert.doesNotMatch(selfHostDoc, new RegExp(name + "\\s*="));
  }
});

test("self-host docs list email and integration env var names only", () => {
  for (const name of ["RESEND_API_KEY", "EMAIL_FROM"]) {
    assert.match(notificationsDoc, new RegExp("`" + name + "`"));
    assert.match(selfHostDoc, new RegExp("`" + name + "`"));
    assert.doesNotMatch(notificationsDoc, new RegExp(name + "\\s*="));
    assert.doesNotMatch(selfHostDoc, new RegExp(name + "\\s*="));
  }
  for (const name of ["LINEAR_CLIENT_ID", "ATLASSIAN_CLIENT_ID", "ATLASSIAN_CLIENT_SECRET", "NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"]) {
    assert.match(selfHostDoc, new RegExp("`" + name + "`"));
    assert.doesNotMatch(selfHostDoc, new RegExp(name + "\\s*="));
  }
});

test("an active trial asks for a card as optional, with a secondary control", () => {
  assert.match(billing, /Your trial runs until \{day\(s\.trialEndsAt\)\}\. Add a card anytime to keep reviewing after it ends/);
  assert.match(billing, /<button>Add a card<\/button>/);
  assert.doesNotMatch(billing, /Add a card to keep reviewing/);
  assert.match(portal, /button small optional/);
  assert.match(portal, /Add a card anytime to keep reviewing after it ends/);
  assert.match(plan, /\$\{billing\.trialDays\}-day free trial/);
  assert.match(plan, /Day \$\{Math\.min\(billing\.trialDays, Math\.max\(1, elapsed \+ 1\)\)\} of \$\{billing\.trialDays\}/);
});

test("integrations use one status label for providers that are not connected", () => {
  assert.match(integrations, /<span className="status-dot mono-status">Not configured<\/span>/);
  assert.doesNotMatch(integrations, /Setup required/);
});

test("empty custom context is a page-level empty state with a primary action, not a header-only table", () => {
  assert.match(context, /ctx-empty-page/);
  assert.match(context, /!rows\.length \? <div className="ctx-empty-page"/);
  assert.match(rules, /No custom rules yet/);
  assert.match(rules, /<div className="actions"><AddContext/);
});

test("all-zero count charts render an empty label instead of a 0.5–2 axis", () => {
  assert.match(chart, /empty \? <p className="chart-empty">/);
  assert.match(chart, /No reviews yet/);
  assert.match(chart, /niceTicks\([\s\S]*, 4, counts\)/);
});
