import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Github, checkConclusion } from "../src/github";
import { blockingFindings, checkOutcome } from "../src/check-run";

const medium = { severity: "medium" as const, title: "Totals become dollars", filePath: "price.ts", startLine: 2, fingerprint: "c".repeat(64) };
const low = { severity: "low" as const, title: "Comment restates the helper", filePath: "src/total.ts", startLine: 1, fingerprint: "low1" };
const critical = { severity: "critical" as const, title: "Auth is skipped", filePath: "src/auth.ts", startLine: 4, fingerprint: "crit1" };

test("check run conclusions: success by default, failure at or above the configured severity", () => {
  const findings = [{ severity: "medium" as const }, { severity: "low" as const }];
  assert.equal(checkConclusion(findings, undefined), "success");
  assert.equal(checkConclusion(findings, "off"), "success");
  assert.equal(checkConclusion(findings, "high"), "success");
  assert.equal(checkConclusion(findings, "medium"), "failure");
  assert.equal(checkConclusion(findings, "low"), "failure");
  assert.equal(checkConclusion([{ severity: "critical" }], "critical"), "failure");
  assert.equal(checkConclusion([], "low"), "success");
  assert.equal(checkConclusion(findings, "bogus"), "success");
  assert.deepEqual(blockingFindings(findings, "high"), []);
  assert.deepEqual(blockingFindings(findings, "medium").map((f) => f.severity), ["medium"]);
  assert.deepEqual(blockingFindings(findings, "off"), []);
});

test("checkOutcome maps each severity threshold, incomplete reviews, and comment links", () => {
  const findings = [medium, low];
  const comments = [{ fingerprint: medium.fingerprint, url: "https://github.com/o/r/pull/1#discussion_r10" }];
  const off = checkOutcome({ findings, score: 4, files: 3, posted: 1 });
  assert.equal(off.conclusion, "success", "off never fails on findings; a completed review succeeds");
  assert.equal(off.title, "Reviewed 3 files · 2 findings");
  assert.match(off.summary, /Minimum blocking severity is off/);
  assert.match(off.summary, /- 🟡 P2 Totals become dollars \(`price\.ts:2`\)/);

  const linked = checkOutcome({ findings, score: 4, files: 3, posted: 1, failureSeverity: "medium", comments });
  assert.equal(linked.conclusion, "failure");
  assert.equal(linked.title, "1 verified finding at or above medium severity");
  assert.match(linked.summary, /Blocking findings \(medium or above\):/);
  assert.match(linked.summary, /\[`price\.ts:2`\]\(https:\/\/github\.com\/o\/r\/pull\/1#discussion_r10\)/);
  assert.doesNotMatch(linked.summary, /Comment restates the helper/);

  assert.equal(checkOutcome({ findings, score: 5, files: 1, posted: 1, failureSeverity: "high" }).conclusion, "success");
  assert.equal(checkOutcome({ findings: [critical], score: 5, files: 1, posted: 1, failureSeverity: "critical" }).conclusion, "failure");
  assert.equal(checkOutcome({ findings: [], score: 5, files: 2, posted: 0, failureSeverity: "low" }).conclusion, "success");
  assert.match(checkOutcome({ findings: [], score: 5, files: 2, posted: 0, failureSeverity: "high" }).summary, /No findings at or above \*\*high\*\* severity/);

  const incomplete = checkOutcome({ findings: [], score: 5, files: 2, posted: 0, verdict: "incomplete" });
  assert.equal(incomplete.conclusion, "action_required", "incomplete reviews never report success");
  assert.equal(incomplete.title, "Review incomplete");
  assert.match(incomplete.summary, /^\*\*Review incomplete\*\*/);
  assert.doesNotMatch(incomplete.summary, /5\/5/);
  assert.match(incomplete.summary, /did not cover every changed file/);

  assert.equal(checkOutcome({ findings: [], score: 5, files: 2, posted: 0, verdict: "incomplete", failureSeverity: "high" }).conclusion, "action_required");
  assert.equal(checkOutcome({ findings: [medium], score: 5, files: 1, posted: 1, verdict: "incomplete", failureSeverity: "medium" }).conclusion, "failure", "blocking findings still fail an incomplete review");
  assert.equal(checkOutcome({ findings: [], files: 1, posted: 0, minimumScore: 4 }).conclusion, "action_required", "no score recorded is an incomplete verdict, not success");
  assert.equal(checkOutcome({ findings: [], score: 5, files: 2, posted: 0, verdict: "incomplete", minimumScore: 4 }).conclusion, "action_required", "an incomplete 5/5 does not pass a score gate");
});

test("check runs are created in progress and completed only with checks:write; without it nothing is sent and a warning is logged", async (t) => {
  t.mock.method(console, "log", () => {});
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => { warnings.push(String(message)); });
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit = {}) => {
    requests.push({ method: options.method ?? "GET", path: new URL(url).pathname, body: options.body ? JSON.parse(String(options.body)) : {} });
    return Response.json({ id: 77 });
  });
  const writer = new Github("fixture", undefined, undefined, { checks: "write", contents: "read", pull_requests: "write", issues: "read" });
  assert.equal(await writer.startCheckRun("o/r", "a".repeat(40), "review-1", "https://app.example.com/dashboard/pulls/review-1"), 77);
  await writer.completeCheckRun("o/r", 77, { conclusion: "failure", title: "2 verified findings", summary: "- **high** Totals become dollars", detailsUrl: "https://app.example.com/dashboard/pulls/review-1" });
  assert.deepEqual(requests.map((r) => [r.method, r.path]), [["POST", "/repos/o/r/check-runs"], ["PATCH", "/repos/o/r/check-runs/77"]]);
  assert.deepEqual([requests[0].body.name, requests[0].body.status, requests[0].body.head_sha, requests[0].body.external_id], ["OpenReview", "in_progress", "a".repeat(40), "review-1"]);
  assert.deepEqual([requests[1].body.status, requests[1].body.conclusion, (requests[1].body.output as { title: string }).title], ["completed", "failure", "2 verified findings"]);
  assert.equal(warnings.length, 0);
  requests.length = 0;
  const reader = new Github("fixture", undefined, undefined, { checks: "read", contents: "read", pull_requests: "write", issues: "read" });
  assert.equal(await reader.startCheckRun("o/r", "a".repeat(40), "review-1"), null);
  await reader.completeCheckRun("o/r", 77, { conclusion: "neutral", title: "x", summary: "y" });
  assert.equal(requests.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /review\.check_run_skipped/);
  assert.match(warnings[0], /Checks: write/);
});

test("installations keep their required-permission validation and expose granted permissions", async (t) => {
  t.mock.method(console, "log", () => {});
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  let permissions: Record<string, string> = { contents: "read", pull_requests: "write", issues: "read", checks: "read" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ token: "installation-token", permissions }));
  const config = { appId: "1", privateKey, base: "https://api.github.com" };
  assert.equal((await Github.installation(5, config)).permissions?.checks, "read", "checks:read installs still work");
  permissions = { ...permissions, checks: "write" };
  assert.equal((await Github.installation(5, config)).permissions?.checks, "write");
  permissions = { contents: "read", pull_requests: "write", issues: "read" };
  await assert.rejects(Github.installation(5, config), /checks:read/, "existing validation is unchanged");
});
