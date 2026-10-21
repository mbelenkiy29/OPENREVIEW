import { priorityOf } from "./priority";

// What the chat agent is told about the pull request a thread is about. It is unverified context:
// any claim still needs cited, indexed source.
export function pullChatContext(pr: { number: number; title: string; author: string; state: string; headSha: string }, review: { summary?: string; reviewScore?: { value: number; reason: string } } | null, findings: { title: string; severity: string; filePath: string; startLine: number; description: string }[]) {
  return [
    `This thread is about pull request #${pr.number}: “${pr.title.slice(0, 300)}” by @${pr.author} (${pr.state}, head ${pr.headSha.slice(0, 12)}). The repository index is at its default branch, so the pull request's own changes may not be indexed yet.`,
    review?.reviewScore ? `OpenReview confidence score: ${review.reviewScore.value}/5 — ${review.reviewScore.reason.slice(0, 500)}` : "",
    review?.summary ? `OpenReview review summary:\n${review.summary.slice(0, 6000)}` : "OpenReview has not reviewed this pull request yet.",
    findings.length ? `Verified findings:\n${findings.slice(0, 30).map((f) => `- [${priorityOf(f.severity)}] ${f.title.slice(0, 200)} (${f.filePath}:${f.startLine}): ${f.description.slice(0, 300)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
