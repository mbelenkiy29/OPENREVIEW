import test from "node:test";
import assert from "node:assert/strict";
import { installFailurePath, linkHref, mapLimit, resumePath, setupActionMessage } from "../src/github-install";
import { safeNext } from "../src/identity";

test("the install callback resumes at itself with only GitHub's parameters, and sign-in accepts that path", () => {
  const state = "a".repeat(64);
  const path = resumePath(new URL(`https://review.example.com/api/github/callback?installation_id=123&setup_action=install&state=${state}&code=secret&x=1`));
  assert.equal(path, `/api/github/callback?installation_id=123&setup_action=install&state=${state}`);
  assert.equal(safeNext(path), path, "the OAuth detour keeps the resume path as `next`");
  assert.equal(resumePath(new URL("https://review.example.com/api/github/callback?state=<script>&installation_id=1")), "/api/github/callback?installation_id=1");
  assert.equal(resumePath(new URL("https://review.example.com/api/github/callback")), "/api/github/callback");
});

test("unfinished installs land back on the page they started from, never on a raw error", () => {
  assert.equal(installFailurePath("/dashboard/onboarding/connect", "Sign in again"), "/dashboard/onboarding/connect?error=github-install&message=Sign%20in%20again");
  assert.equal(installFailurePath("/dashboard/providers", "x"), "/dashboard/providers", "other pages show the message as a toast");
  assert.equal(installFailurePath("//evil.example", "x"), "/dashboard/repositories");
  assert.equal(installFailurePath("/dashboard/onboarding/connect", "m".repeat(500)).length < 300, true);
  assert.match(setupActionMessage("request") ?? "", /owners.*Link an existing installation/);
  assert.equal(setupActionMessage("install"), undefined);
  assert.equal(setupActionMessage(null), undefined);
  assert.equal(linkHref("org 1", "/dashboard/onboarding/connect"), "/dashboard/github-link?organization=org%201&returnTo=%2Fdashboard%2Fonboarding%2Fconnect");
  assert.equal(safeNext(linkHref("k57abc", "/dashboard/onboarding/connect")), linkHref("k57abc", "/dashboard/onboarding/connect"));
});

test("repository admin checks run at most eight at a time and stop at the first refusal", async () => {
  let active = 0, peak = 0, started = 0;
  const results = await mapLimit(Array.from({ length: 30 }, (_, i) => i), 8, async (i) => {
    active++; started++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    return i * 2;
  });
  assert.equal(peak, 8);
  assert.equal(started, 30);
  assert.deepEqual(results.slice(0, 3), [0, 2, 4]);
  started = 0;
  await assert.rejects(mapLimit(Array.from({ length: 50 }, (_, i) => i), 4, async (i) => { started++; await new Promise((r) => setTimeout(r, 1)); if (i === 2) throw new Error("not an admin"); }), /not an admin/);
  assert.ok(started < 50, `stopped early (${started} started)`);
  assert.deepEqual(await mapLimit([], 8, async () => 1), []);
});
