"use client";
import { useActionState } from "react";
import { openFixPullRequest } from "./actions";

// OpenReview applies its validated suggestion on a new openreview/fix-* branch and opens a pull request
// against the reviewed pull request's branch. That branch itself is never written.
export function FixPullRequestButton({ findingId }: { findingId: string }) {
  const [state, action, pending] = useActionState(openFixPullRequest, {});
  return <div className="fix-control">
    <form action={action}><input type="hidden" name="findingId" value={findingId} /><button disabled={pending}>{pending ? "Opening…" : "Open a fix PR"}</button></form>
    {state.url && <p role="status">{state.reused ? "A fix pull request already exists: " : "Opened a fix pull request: "}<a href={state.url} target="_blank" rel="noreferrer">{state.url.replace(/^https:\/\/github\.com\//, "")}</a>. Review it before merging.</p>}
    {state.note && <p role="status">{state.note}</p>}
    {state.error && <p role="alert" className="error">{state.error}</p>}
  </div>;
}
