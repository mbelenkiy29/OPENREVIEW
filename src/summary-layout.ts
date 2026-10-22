import {summaryLabels} from "./review-settings";

// GitHub publication layout, in the shape of Greptile's PR summary: a "Confidence Score: N/5" heading with the
// verdict and its reason, a folded Summary, the issues, the open diagram, everything else folded into one
// "More details" block, then one small footer line. The stored summary stays plain headings, which is what the
// dashboard and the other providers show.
const shown = new Set<string>([summaryLabels.findings, summaryLabels.requirements, "Outside the changed code"]);
// The review footer (see reviewFooter) and any tip after it.
const footer = /\n\n(?:Review (\d+) on this pull request · )?(Comment `[^`\n]+` to re-run it|Re-run it from the dashboard)\.([\s\S]*)$/;

// Model text outside code fences must not open or close a disclosure widget.
function escapeDisclosure(body: string) {
  let fence = "";
  return body.split("\n").map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) { fence = fence ? "" : marker; return line; }
    return fence ? line : line.replace(/<(\/?)(details|summary)/gi, "&lt;$1$2");
  }).join("\n");
}
const fold = (label: string, body: string, open = false) => `<details${open ? " open" : ""}><summary><h3>${label}</h3></summary>\n\n${escapeDisclosure(body)}\n\n</details>`;

// A stored summary is the verdict line, then "### Label" sections, then the review footer.
function parts(summary: string) {
  const tail = summary.match(footer)?.[0] ?? "";
  const [head, ...chunks] = summary.slice(0, summary.length - tail.length).split(/\n\n(?=### )/);
  return { head, tail, sections: chunks.map((chunk) => {
    const newline = chunk.indexOf("\n");
    return { chunk, label: (newline < 0 ? chunk : chunk.slice(0, newline)).slice(4).trim(), body: newline < 0 ? "" : chunk.slice(newline + 1) };
  }) };
}

// footerItems go on the footer line after the review count (commit and dashboard links).
export function disclosureLayout(summary: string, footerItems: readonly string[] = []) {
  const tail = summary.match(footer);
  const [verdictText, ...chunks] = summary.slice(0, tail?.index ?? summary.length).split(/\n\n(?=### )/);
  const verdict = verdictText.match(/^\*\*([^*\n]+)\*\*(?: · Confidence score \*\*(\d)\/5\*\*)?$/);
  let score = verdict?.[2], reason = "", overview = "", diagram = "";
  const main: string[] = [], more: string[] = [];
  for (const chunk of chunks) {
    const newline = chunk.indexOf("\n");
    const label = (newline < 0 ? chunk : chunk.slice(0, newline)).slice(4).trim();
    const body = newline < 0 ? "" : chunk.slice(newline + 1);
    const scored = label === summaryLabels.score ? body.match(/^\*\*(\d)\/5\*\* — ([\s\S]*)$/) : null;
    if (scored) { score ??= scored[1]; reason = scored[2]; }
    else if (label === summaryLabels.overview) overview = body;
    else if (label === summaryLabels.diagram) diagram = body.replace(/^```mermaid\n/, "```mermaid\n%%{init: {'theme': 'neutral'}}%%\n");
    else if (shown.has(label)) main.push(chunk);
    else more.push(chunk);
  }
  const head = (score ? `<h2>Confidence Score: ${score}/5</h2>` : "<h2>OpenReview</h2>") + "\n\n" + (verdict ? `**${verdict[1]}.**${reason ? " " + escapeDisclosure(reason) : ""}` : verdictText);
  const line = [tail?.[1] ? `Reviews (${tail[1]})` : "", ...footerItems, tail ? tail[2].replace(/ it$/, "") : "", "Reviewed by OpenReview"].filter(Boolean).join(" · ");
  return [head, overview && fold("Summary", overview), ...main, diagram && fold("Diagram", diagram, true), more.length ? fold("More details", more.join("\n\n")) : "", `<sub>${line}</sub>`].filter(Boolean).join("\n\n") + (tail?.[3] ?? "");
}

// The "compact" comment style: summary, confidence score, important files and diagram up front; every
// other section collapsed; the fix-all prompt last; a one-line footer with the reviewed commit.
const outsideLabel = "Outside the changed code";
// reviewSummary's placeholder bodies for a section with nothing recorded; compact leaves those sections out.
const nothingToReport = /^(?:No verified findings|No previously reported findings were confirmed resolved|No changed files were skipped|No changed test source identified|Unknown: no structured risk assessment|Not executed by OpenReview\.)/;
const details = (label: string, body: string, isOpen = false) => `<details${isOpen ? " open" : ""}><summary><strong>${label}</strong></summary>\n\n${escapeDisclosure(body)}\n\n</details>`;
export function compactLayout(summary: string, commit: string, links = "") {
  const { head, tail, sections } = parts(summary);
  const body = (label: string) => sections.find((s) => s.label === label)?.body;
  const front = new Set([summaryLabels.overview, summaryLabels.score, summaryLabels.affectedAreas, summaryLabels.diagram, summaryLabels.agentPrompt, outsideLabel]);
  const overview = body(summaryLabels.overview), files = body(summaryLabels.affectedAreas), diagram = body(summaryLabels.diagram), outside = body(outsideLabel), prompt = body(summaryLabels.agentPrompt);
  const score = body(summaryLabels.score)?.match(/^\*\*(\d)\/5\*\* — ([\s\S]*)$/);
  const blocks = [
    overview !== undefined ? "### OpenReview Summary\n\n" + overview : "",
    score ? `### Confidence Score: ${score[1]}/5\n\n${head.match(/^\*\*[^*]+\*\*/)?.[0] ?? head}\n\n${score[2]}` : head,
    files !== undefined ? "### Important Files Changed\n\n" + files.replace(/^\| File \| Change \|/, "| Filename | Overview |") : "",
    diagram !== undefined ? "### Sequence Diagram\n\n" + diagram : "",
    outside !== undefined ? details("Comments Outside Diff", outside, true) : "",
    ...sections.filter((s) => !front.has(s.label) && !nothingToReport.test(s.body)).map((s) => details(s.label, s.body)),
    prompt !== undefined ? `<details><summary>Prompt To Fix All With AI</summary>\n\n${escapeDisclosure(prompt)}\n\n</details>` : "",
  ].filter(Boolean);
  // "Review N on this pull request · Comment `…` to re-run it." becomes one small line; a tip after it stays.
  const [, number, rerun = "", rest = ""] = tail.match(/^\n\n(?:Review (\d+) on this pull request · )?(.*?\.)(\n[\s\S]*)?$/) ?? [];
  return blocks.join("\n\n") + links + `\n\n<sub>${number ? `Reviews (${number}): ` : ""}Last reviewed commit: ${commit}${rerun ? " · " + rerun : ""}</sub>` + rest;
}

// Each issue row links to its inline thread when the thread is known; otherwise the token is dropped.
export function threadLinks(summary: string, url: (fingerprint: string) => string | undefined) {
  return summary.replace(/ <!-- openreview-thread:([a-f0-9]+) -->/g, (_, fingerprint: string) => {
    const link = url(fingerprint);
    return link && /^https:\/\/[^\s()<>]+$/.test(link) ? ` · [thread](${link})` : "";
  });
}

// The summary block in a pull request description sits between these markers and is replaced in
// place; the author's own text around it is kept as written.
export const descriptionStart = "<!-- openreview:description-summary:start -->";
export const descriptionEnd = "<!-- openreview:description-summary:end -->";
export function withoutDescriptionSummary(body: string) {
  const start = body.indexOf(descriptionStart);
  if (start < 0) return body;
  const end = body.indexOf(descriptionEnd, start);
  const before = body.slice(0, start).replace(/\s+$/, "");
  const after = end < 0 ? "" : body.slice(end + descriptionEnd.length).replace(/^\s+/, "");
  return before && after ? before + "\n\n" + after : before || after;
}
export function withDescriptionSummary(body: string | null, block: string) {
  const base = withoutDescriptionSummary(body ?? "");
  return (base ? base + "\n\n" : "") + descriptionStart + "\n" + block + "\n" + descriptionEnd;
}
