import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const signIn = readFileSync("app/sign-in.tsx", "utf8");
const emailForm = readFileSync("app/email-sign-in.tsx", "utf8");
const verifyPage = readFileSync("app/login/verify/page.tsx", "utf8");
const verifyRoute = readFileSync("app/api/auth/email/verify/route.ts", "utf8");
const emailRoute = readFileSync("app/api/auth/email/route.ts", "utf8");
const wizardClient = readFileSync("app/dashboard/onboarding/wizard-client.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");

test("the magic-link form is labelled Email, not work-only, and keeps the address after send", () => {
  assert.match(emailForm, /<label>Email<input type="email"/);
  assert.doesNotMatch(signIn, /Enter work email/);
  assert.match(emailForm, /sentTo \?\? ""/);
  assert.match(emailForm, /Resend link/);
  assert.match(emailForm, /cooldownMs = 60_000/);
  assert.match(emailForm, /disabled=\{submitting \|\| cooling\}/);
  assert.match(emailRoute, /authQuery\(\{ email: result, referral, to \}\)/);
});

test("opening a magic link still requires a click, now on the branded auth screen", () => {
  assert.match(verifyRoute, /\/login\/verify\?\$\{query\}/);
  assert.match(verifyRoute, /cache-control", "no-store"/);
  assert.match(verifyPage, /from "\.\.\/\.\.\/auth-chrome"/);
  assert.match(verifyPage, /AuthChrome title="Sign in to OpenReview"/);
  assert.match(verifyPage, /method="post" action="\/api\/auth\/email\/verify"/);
  assert.match(verifyPage, /name="token"/);
  assert.match(verifyPage, />Sign in</);
});

test("the workspace form reserves a status line so Creating workspace does not shift the card", () => {
  assert.match(wizardClient, /className="wizard-pending muted"/);
  assert.match(wizardClient, /pending \? label : "\\u00a0"/);
  const pending = css.slice(css.indexOf(".wizard-pending {"));
  assert.match(pending.slice(0, pending.indexOf("\n}")), /min-height: 1\.4em/);
});
