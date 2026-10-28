"use client";
import { useActionState } from "react";
import { openFixPullRequest } from "./actions";
import { useFixStatus } from "./fix-button";

const final = ["opened", "failed"], unavailable = "Unable to read the fix status. Check the pull request on GitHub for a new openreview/fix-* pull request.";
// OpenReview's fix agent edits the code on a new openreview/fix-* branch and opens a pull request against the
// reviewed pull request's branch. That branch itself is never written.
export function FixPullRequestButton({ findingId, allowance }: { findingId: string; allowance?: string }) {
  const [state, action, pending] = useActionState(openFixPullRequest, {});
  const run = useFixStatus(state.requestId, final, unavailable);
  const working = Boolean(state.requestId) && !final.includes(run.status) && run.status !== "unavailable";
  return <div className="fix-control">
    <form action={action}><input type="hidden" name="findingId" value={findingId} /><button className="primary" disabled={pending || working}>{pending ? "Starting…" : working ? "Fixing…" : "Fix with OpenReview"}</button></form>
    {allowance && <p className="muted">{allowance}</p>}
    {state.requestId && run.status === "opened" && <p role="status">Opened a fix pull request: <a href={run.pullRequestUrl} target="_blank" rel="noreferrer">{run.pullRequestUrl?.replace(/^https:\/\/github\.com\//, "")}</a>. No tests were run, so review it before merging.</p>}
    {working && <p role="status">{run.status === "running" ? "OpenReview’s fix agent is reading and editing the code. This usually takes a few minutes." : "Queued."}</p>}
    {state.requestId && (run.status === "failed" || run.status === "unavailable") && <p role="alert" className="error">{run.error}</p>}
    {state.error && <p role="alert" className="error">{state.error}</p>}
  </div>;
}
