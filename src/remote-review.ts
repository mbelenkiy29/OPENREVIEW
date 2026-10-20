import type { McpCall } from "./resolve-loop";
import { localReviewLimits, type LocalReviewProgress } from "./cli-review";
import type { SourceFile } from "./engine/types";

// The logged-in `openreview review`: finds this checkout's repository in the workspace, uploads the diff
// and the changed files, and waits for the server's review. The review counts against the workspace plan.
export type RemoteReview = { remote?: string; baseSha: string; headSha: string; title: string; mode?: "fast" | "standard" | "deep"; security: boolean; instructions?: string; diff: string; files: SourceFile[] };
// The workspace repository for this checkout's origin ("owner/name"), or an error that says how to connect it.
export async function findRepository(call: McpCall, remote: string | undefined) {
  const repos = await call("list_repositories", {}) as { _id: string; fullName: string }[];
  const repo = remote ? repos.find((r) => r.fullName.toLowerCase() === remote.toLowerCase()) : undefined;
  if (!repo) throw new Error(`This checkout's origin (${remote ?? "none"}) is not a repository in your OpenReview workspace. Connect it in the dashboard, or run openreview review --local.`);
  return repo;
}
export async function remoteReview(call: McpCall, input: RemoteReview, io: { stage: (name: string) => void; wait: (ms: number) => Promise<void>; timeoutMs?: number }) {
  const repo = await findRepository(call, input.remote);
  const files = input.files.filter((f) => f.content.length <= localReviewLimits.fileChars).slice(0, localReviewLimits.files);
  const fileChars = files.reduce((sum, f) => sum + f.content.length, 0);
  if (input.diff.length > localReviewLimits.diffChars || fileChars > localReviewLimits.totalFileChars)
    throw new Error("These changes are too large for a server review. Narrow --base, or run openreview review --local.");
  io.stage("uploading");
  const { reviewId } = await call("review_local_changes", { repositoryId: repo._id, baseSha: input.baseSha, headSha: input.headSha, title: input.title.slice(0, 300), ...(input.mode ? { mode: input.mode } : {}), security: input.security, ...(input.instructions ? { instructions: input.instructions } : {}), diff: input.diff, files: files.map(({ path, sha, content }) => ({ path, sha, content })) }) as { reviewId: string };
  let last = "";
  for (const deadline = Date.now() + (io.timeoutMs ?? 20 * 60_000); ;) {
    const progress = await call("get_local_review", { reviewId }) as LocalReviewProgress;
    const stage = progress.stage ?? progress.status;
    if (stage !== last) io.stage(last = stage);
    if (progress.status === "completed" && progress.result) return { repository: repo.fullName, ...progress.result };
    if (progress.status === "failed") throw new Error(progress.error ?? "The review failed");
    if (Date.now() > deadline) throw new Error(`The review is still running; it was not finished after ${Math.round((io.timeoutMs ?? 20 * 60_000) / 60_000)} minutes.`);
    await io.wait(2000);
  }
}
