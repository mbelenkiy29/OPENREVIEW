import { z } from "zod";
import { tiers } from "./review-tier";
import type { Finding } from "./engine/types";

// A logged-in `openreview review` sends its committed changes for a server-side review: the unified diff
// against the merge base and the changed files' contents at HEAD. The server takes the rest of the
// context from the repository's index. uploadBytes keeps the request under Vercel's 4.5 MB body limit.
export const localReviewLimits = { diffChars: 1_000_000, files: 300, fileChars: 200_000, totalFileChars: 2_000_000, uploadBytes: 4_000_000 };
const sha = z.string().regex(/^[a-f0-9]{40}$/, "Use a full commit SHA");
export const localReviewFields = z.object({
  repositoryId: z.string().regex(/^[A-Za-z0-9]{20,64}$/, "Use an OpenReview repository ID"),
  baseSha: sha,
  headSha: sha,
  title: z.string().max(300).default(""),
  mode: z.enum(tiers).optional(),
  security: z.boolean().default(false),
  diff: z.string().min(1).max(localReviewLimits.diffChars),
  files: z.array(z.object({ path: z.string().min(1).max(500), sha: z.string().max(64), content: z.string().max(localReviewLimits.fileChars) })).max(localReviewLimits.files),
});
export const localReviewRequest = localReviewFields.superRefine((value, ctx) => {
  if (value.files.reduce((sum, f) => sum + f.content.length, 0) > localReviewLimits.totalFileChars)
    ctx.addIssue({ code: "custom", path: ["files"], message: `Changed files exceed ${localReviewLimits.totalFileChars.toLocaleString("en-US")} characters; review with --local` });
});
export type LocalReviewRequest = z.infer<typeof localReviewRequest>;

export type LocalReviewProgress = { id: string; status: "queued" | "running" | "completed" | "failed"; stage: string | null; error: string | null; result: { summary: string; findings: Finding[] } | null };

// Stored on the review row, which Convex caps at 1 MiB: findings past the cap are dropped and counted.
export function shapeLocalResult(result: { summary: string; findings: Finding[] }, maxChars = 900_000) {
  const findings = [...result.findings];
  let dropped = 0;
  for (;;) {
    const summary = dropped ? `${result.summary}\n\n${dropped} more finding${dropped === 1 ? "" : "s"} did not fit in the response.` : result.summary;
    const text = JSON.stringify({ summary, findings });
    if (text.length <= maxChars || !findings.length) return text;
    findings.pop();
    dropped++;
  }
}
