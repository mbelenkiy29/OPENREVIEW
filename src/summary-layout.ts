import {summaryLabels} from "./review-settings";

// Publication layout for hosts that render HTML disclosure widgets (GitHub). The stored summary stays
// plain headings, which is what the dashboard and the other providers show. Here the confidence reason
// moves under the verdict line, the overview and issues come next, then the open diagram, then the
// collapsed details (the coding-agent prompt first), so a reader sees the verdict and issues first.
const collapsed = new Set<string>([summaryLabels.affectedAreas, summaryLabels.agentPrompt, summaryLabels.risk, summaryLabels.resolved, summaryLabels.skipped, summaryLabels.testSource, "Test execution", "Coverage"]);
const open = new Set<string>([summaryLabels.diagram]);
// The review footer (see reviewFooter) and any tip after it stay outside the collapsed sections.
const footer = /\n\n(?:Review \d+ on this pull request · )?(?:Comment `[^`\n]+` to re-run it|Re-run it from the dashboard)\.[\s\S]*$/;

// Model text outside code fences must not open or close a disclosure widget.
function escapeDisclosure(body: string) {
  let fence = "";
  return body.split("\n").map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) { fence = fence ? "" : marker; return line; }
    return fence ? line : line.replace(/<(\/?)(details|summary)/gi, "&lt;$1$2");
  }).join("\n");
}

// A stored summary is the verdict line, then "### Label" sections, then the review footer.
function parts(summary: string) {
  const tail = summary.match(footer)?.[0] ?? "";
  const [head, ...chunks] = summary.slice(0, summary.length - tail.length).split(/\n\n(?=### )/);
  return { head, tail, sections: chunks.map((chunk) => {
    const newline = chunk.indexOf("\n");
    return { chunk, label: (newline < 0 ? chunk : chunk.slice(0, newline)).slice(4).trim(), body: newline < 0 ? "" : chunk.slice(newline + 1) };
  }) };
}

export function disclosureLayout(summary: string) {
  const { head: verdict, tail, sections } = parts(summary);
  let head = verdict;
  const blocks: string[] = [], shown: string[] = [], folded: string[] = [];
  for (const { chunk, label, body } of sections) {
    if (label === summaryLabels.score) {
      // "**N/5** — reason": the score is already on the verdict line, so only the reason moves up.
      const reason = body.replace(/^\*\*\d\/5\*\* — /, "");
      if (/Confidence score \*\*\d\/5\*\*/.test(head) && reason !== body) head += "\n\n" + reason;
      else blocks.push(chunk);
      continue;
    }
    const widget = `<details${open.has(label) ? " open" : ""}><summary><strong>${label}</strong></summary>\n\n${escapeDisclosure(body)}\n\n</details>`;
    if (open.has(label)) shown.push(widget);
    else if (label === summaryLabels.agentPrompt) folded.unshift(widget);
    else if (collapsed.has(label)) folded.push(widget);
    else blocks.push(chunk);
  }
  return [head, ...blocks, ...shown, ...folded].join("\n\n") + tail;
}

// The "compact" comment style: summary, confidence score, important files and diagram up front; every
// other section collapsed; the fix-all prompt last; a one-line footer with the reviewed commit.
const outsideLabel = "Outside the changed code";
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
    ...sections.filter((s) => !front.has(s.label)).map((s) => details(s.label, s.body)),
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
