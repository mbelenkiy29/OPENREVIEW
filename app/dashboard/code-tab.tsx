import Link from "next/link";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { parsePatch } from "../../src/diff-view";
import { DiffFiles, type DiffFinding } from "./diff-files";
import { ReviewedToggle } from "./pull-list-client";
import { generateTour } from "./actions";

// Code tab: Tour or full diff. The full diff steps through one file at a time ("File 2 of 40") beside
// a file tree with +/− counts, findings and the developer's own "Reviewed" marks.
export async function CodeTab({ token, review, findings, filters }: { token: string; review: Doc<"reviews">; findings: DiffFinding[]; filters: Record<string, string | undefined> }) {
  if (!["completed", "failed", "cancelled"].includes(review.status)) return <p className="muted">The reviewed diff is available when the review finishes.</p>;
  let diff;
  try { diff = await backend().action(api.reviewDiff.load, { token, reviewId: review._id }); }
  catch { return <p role="alert">The diff could not be loaded from the provider. Check the repository connection and try again.</p>; }
  if (diff.source === "unavailable") return <p role="status">{diff.reason}</p>;
  const reviewed = new Set(await backend().query(api.fileReviews.list, { token, reviewId: review._id }));
  const href = (changes: Record<string, string | undefined>) => "?" + new URLSearchParams(Object.entries({ tab: "code", view: filters.view, file: filters.file, step: filters.step, ...changes }).filter((e): e is [string, string] => Boolean(e[1])));
  const tour = filters.view === "tour", files = diff.files;
  const stats = (patch: string) => parsePatch(patch).flatMap((h) => h.lines).reduce((n, l) => ({ add: n.add + (l.kind === "add" ? 1 : 0), del: n.del + (l.kind === "del" ? 1 : 0) }), { add: 0, del: 0 });
  const index = Math.min(files.length - 1, Math.max(0, Number(filters.file) || 0)), all = filters.file === "all";
  const steps = review.tour?.steps ?? [], step = Math.min(steps.length - 1, Math.max(0, Number(filters.step) || 0));
  return <section aria-label="Code" className="code-tab review-diff">
    <nav className="segmented" aria-label="Code view"><Link href={href({ view: "tour", file: undefined })} aria-current={tour ? "page" : undefined}>Tour</Link><Link href={href({ view: undefined, step: undefined })} aria-current={tour ? undefined : "page"}>Full diff</Link></nav>
    <p className="muted">{diff.source === "compare" ? "Exact base…head comparison" : "Pull request diff"} at {diff.revision.slice(0, 12)} · {files.length} files{diff.omitted ? ` (${diff.omitted} more not shown)` : ""} · {reviewed.size} of {files.length} reviewed</p>
    {tour ? (steps.length ? <>
      <p className="stepper"><span>Step {step + 1} of {steps.length}</span><progress value={step + 1} max={steps.length} />{step > 0 && <Link href={href({ step: String(step - 1) })} aria-label="Previous step">←</Link>}{step < steps.length - 1 && <Link href={href({ step: String(step + 1) })} aria-label="Next step">→</Link>}</p>
      <h3>{steps[step].title}</h3><p>{steps[step].explanation}</p>
      <DiffFiles files={files.filter((f) => steps[step].files.includes(f.path))} findings={findings} />
    </> : <form action={generateTour}><input type="hidden" name="reviewId" value={review._id} /><p>A tour groups the changed files into steps in reading order, with a short explanation of each. It is generated once for this review and uses one model call.</p><button>Generate tour</button></form>) : <div className="code-layout">
      <ol className="file-tree" aria-label="Changed files">{files.map((f, i) => { const s = stats(f.patch), n = findings.filter((x) => x.filePath === f.path).length; return <li key={f.path}><ReviewedToggle reviewId={review._id} path={f.path} reviewed={reviewed.has(f.path)} /><Link href={href({ file: String(i) })} aria-current={!all && i === index ? "page" : undefined} title={f.path}>{f.path.split("/").at(-1)}</Link><small className="diffstat"><span className="add">+{s.add}</span> <span className="del">−{s.del}</span>{n ? <> · {n}⚑</> : null}</small></li>; })}</ol>
      <div>
        <p className="stepper">{all ? <span>All {files.length} files</span> : <><span>File {index + 1} of {files.length}</span><progress value={index + 1} max={files.length} />{index > 0 && <Link href={href({ file: String(index - 1) })} aria-label="Previous file">←</Link>}{index < files.length - 1 && <Link href={href({ file: String(index + 1) })} aria-label="Next file">→</Link>}</>}<Link href={href({ file: all ? undefined : "all" })}>{all ? "One file at a time" : "Show all files"}</Link></p>
        <DiffFiles files={all ? files : files.slice(index, index + 1)} findings={findings} open />
      </div>
    </div>}
  </section>;
}
