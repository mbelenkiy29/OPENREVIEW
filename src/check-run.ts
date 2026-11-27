import type {Finding} from "./engine/types";
import {priorityBadge} from "./priority";
import {publishedReviewScore,reviewVerdict,verdictLabels,type Verdict} from "./verdict";

export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "action_required";
const order = ["critical", "high", "medium", "low"];
export const isBlockingSeverity = (threshold: string | undefined): threshold is (typeof order)[number] =>
  !!threshold && order.includes(threshold);
// Findings at or above the configured minimum blocking severity. "off" (the default) and unknown
// values block nothing: a completed review still reports success so the check can be required.
export function blockingFindings<T extends Pick<Finding, "severity">>(findings: T[], threshold: string | undefined): T[] {
  if (!isBlockingSeverity(threshold)) return [];
  return findings.filter((f) => order.indexOf(f.severity) <= order.indexOf(threshold));
}
// Check-run conclusion from findings alone: failure when any finding reaches the threshold,
// otherwise success. Completeness is applied in checkOutcome, not here.
export function checkConclusion(findings: Pick<Finding, "severity">[], threshold: string | undefined): Exclude<CheckConclusion, "neutral" | "cancelled" | "action_required"> {
  return blockingFindings(findings, threshold).length ? "failure" : "success";
}

const plural = (n: number, word: string) => n + " " + word + (n === 1 ? "" : "s");
type ListedFinding = Pick<Finding, "severity" | "title" | "filePath" | "startLine"> & { fingerprint?: string };
const findingLine = (f: ListedFinding, comments?: { fingerprint: string; url?: string }[]) => {
  const url = f.fingerprint ? comments?.find((c) => c.fingerprint === f.fingerprint)?.url : undefined;
  const loc = `\`${f.filePath}:${f.startLine}\``;
  return `- ${priorityBadge(f.severity)} ${f.title} (${url ? `[${loc}](${url})` : loc})`;
};
const listFindings = (findings: ListedFinding[], comments?: { fingerprint: string; url?: string }[]) => [
  ...findings.slice(0, 10).map((f) => findingLine(f, comments)),
  ...(findings.length > 10 ? [`- ${findings.length - 10} more on the review page.`] : []),
];
// The finished check: what was reviewed, the verdict, and why it failed when a configured gate
// (a severity, or a minimum confidence score) was not met. A score gate never fails an incomplete
// review that recorded no score. Incomplete and failed reviews never conclude success: GitHub
// treats `neutral` as passing a required check, so those cases use `action_required`.
export function checkOutcome(a: { findings: ListedFinding[]; score?: number; files: number; posted: number; failureSeverity?: string; minimumScore?: number; verdict?: Verdict; comments?: { fingerprint: string; url?: string }[] }): { conclusion: CheckConclusion; title: string; summary: string } {
  const blocking = blockingFindings(a.findings, a.failureSeverity);
  const bySeverity = checkConclusion(a.findings, a.failureSeverity);
  const gate = a.minimumScore && a.minimumScore > 0 ? a.minimumScore : 0;
  const verdictKey = a.verdict ?? reviewVerdict({ score: a.score, findings: a.findings });
  const score = publishedReviewScore(verdictKey, a.score === undefined ? undefined : { value: a.score })?.value;
  const byScore: CheckConclusion = !gate || score === undefined ? "neutral" : score < gate ? "failure" : "success";
  const gated = bySeverity === "failure" || byScore === "failure";
  const conclusion: CheckConclusion = gated ? "failure" : verdictKey === "incomplete" ? "action_required" : "success";
  const verdict = verdictLabels[verdictKey];
  const reviewed = `Reviewed ${plural(a.files, "file")} · ${a.findings.length ? plural(a.findings.length, "finding") : "no findings"}`;
  const title = verdictKey === "incomplete" ? "Review incomplete" : byScore === "failure" ? `Confidence ${score}/5 is below the required ${gate}/5` : bySeverity === "failure" ? `${plural(blocking.length, "verified finding")} at or above ${a.failureSeverity} severity` : reviewed;
  const listed = isBlockingSeverity(a.failureSeverity) ? blocking : a.findings;
  const lines = [
    `**${verdict}**${score === undefined ? "" : ` · Confidence score **${score}/5**`}`,
    "",
    `${reviewed}; ${plural(a.posted, "new inline comment")} posted.`,
    ...(isBlockingSeverity(a.failureSeverity)
      ? listed.length
        ? ["", `Blocking findings (${a.failureSeverity} or above):`, ...listFindings(listed, a.comments)]
        : ["", `No findings at or above **${a.failureSeverity}** severity.`]
      : a.findings.length
        ? ["", "Minimum blocking severity is off; this check does not fail on findings.", "", ...listFindings(a.findings, a.comments)]
        : ["", "OpenReview found no verified issues in this revision."]),
    ...(byScore === "failure" ? ["", `The review itself completed. This check fails because the workspace requires a confidence score of at least ${gate}/5 before merging.`] : []),
    ...(gate && score === undefined ? ["", `No confidence score was recorded, so the required ${gate}/5 was not checked.`] : []),
    ...(verdictKey === "incomplete" && !gated ? ["", "This check does not pass because the review did not cover every changed file."] : []),
  ];
  return { conclusion, title, summary: lines.join("\n") };
}
// Reviews stopped because a newer commit arrived (or the pull request closed) end neutral, not failed.
export const supersededCheck = (message: string) => /Review cancelled|Review is obsolete/.test(message);
// Posted once on a pull request whose review the workspace's plan blocked. Plan details (limits,
// trial dates) stay on the billing page; anyone who can read the pull request sees this text.
export function billingNoticeBody(appUrl: string | undefined) {
  let link = "";
  try { const url = appUrl ? new URL("/dashboard/organization/billing", appUrl) : undefined; if (url?.protocol === "https:") link = ` in [Organization Settings → Billing & Usage](${url.href})`; } catch {}
  return `OpenReview did not review this pull request because the workspace's plan does not cover more reviews right now. A workspace admin can check the plan${link}. Reviews start again automatically on the next push once the plan allows them, or comment \`@openreview review\`.`;
}
