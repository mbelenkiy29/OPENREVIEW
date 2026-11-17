import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "./ui/logo";

// The right panel: a pull request under review. Diff lines scroll past while a scan band reads them;
// where it finds a problem the line's gutter lights the logo's ember dot and a finding card slides in.
// [indent, width %, kind] per line; kind marks added or removed lines.
const diff: [number, number, ("add" | "del")?][] = [[0, 44], [1, 62], [1, 38, "del"], [1, 56, "add"], [0, 0], [0, 50], [1, 70], [2, 46, "add"], [2, 58, "add"], [1, 30], [0, 0], [0, 64], [1, 52, "add"], [1, 40], [0, 22]];
// [line index, priority, title]: lines the scan reaches at about 20%, 55% and 85% of its pass.
const findings: [number, string, string][] = [[3, "P1", "Workspace membership is not checked before the read"], [8, "P2", "The retry loop never awaits its promise"], [12, "P3", "One query runs per repository in this loop"]];

/** Decorative and CSS-only; reduced motion shows the finished review. */
function AuthArt() {
  return <aside className="auth-art" aria-hidden="true">
    <div className="auth-diff">
      <div className="auth-diff-head"><i /><i /><i /><code>src/routes/workspace.ts</code></div>
      <div className="auth-diff-body">
        <span className="auth-scan" />
        {diff.map(([indent, width, kind], i) => <div key={i} className={`auth-line${kind ? " " + kind : ""}`} style={{ ["--indent" as string]: indent, ["--w" as string]: `${width}%` }}><b>{i + 41}</b><i /></div>)}
        {findings.map(([line, priority, title], i) => <div key={line} className={`auth-finding f${i}`} style={{ ["--line" as string]: line, ["--n" as string]: i }}><span className="auth-dot" /><div><strong>{priority}</strong><p>{title}</p></div></div>)}
      </div>
    </div>
    <p>Reviews that read<br />the whole repository</p>
  </aside>;
}

/** Shared login/signup chrome: brand, the form column, and the review drawing. */
export function AuthChrome({ title, children }: { title: string; children: ReactNode }) {
  return <div className="auth">
    <main id="main" className="auth-panel">
      <div className="auth-card">
        <Link className="auth-logo" href="/" aria-label="OpenReview home"><Mark /></Link>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
    <AuthArt />
  </div>;
}
