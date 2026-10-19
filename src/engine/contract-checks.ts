import type { ChangedFile, SourceFile } from "./types";
import { changedLines } from "./diff";

// Documented boundaries versus the comparisons that implement them. A comment (or the pull request
// description) that says "$50 or more" while the code compares `> 50` puts the boundary value on
// the wrong side. These are hints for the correctness reviewer, never findings: the model still has
// to quote the lines and pass verification. Repository text is untrusted; only numbers and short
// phrases are extracted from it.

// Which side of the boundary the boundary value itself belongs to: "upper" means a value exactly at
// the boundary counts with the larger values ("at least 50" includes 50).
type Side = "upper" | "lower";
const number = String.raw`\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`;
const phrases: { side: Side; pattern: RegExp }[] = [
  // Suffix forms first, so "50 or more" is not also read as "more than".
  { side: "upper", pattern: new RegExp(number + String.raw`\s*(?:[a-z%$]+\s+){0,2}?(?:or more|or above|or greater|or higher|or over|or older|and up|and above)\b`, "gi") },
  { side: "lower", pattern: new RegExp(number + String.raw`\s*(?:[a-z%$]+\s+){0,2}?(?:or less|or fewer|or below|or under|or younger|and below|and under)\b`, "gi") },
  { side: "upper", pattern: new RegExp(String.raw`\b(?:at least|no less than|no fewer than|minimum of|starting at|from)\s+` + number, "gi") },
  { side: "lower", pattern: new RegExp(String.raw`\b(?:at most|up to|no more than|maximum of|not more than)\s+` + number, "gi") },
  { side: "lower", pattern: new RegExp(String.raw`\b(?:more than|greater than|above|over|exceeds?|exceeding)\s+` + number, "gi") },
  { side: "upper", pattern: new RegExp(String.raw`\b(?:less than|fewer than|below|under)\s+` + number, "gi") },
];
const value = (whole: string, fraction?: string) => Number(whole.replace(/,/g, "") + (fraction ? "." + fraction : ""));

export function documentedBoundaries(text: string) {
  const found: { value: number; side: Side; phrase: string }[] = [];
  const taken: [number, number][] = [];
  for (const { side, pattern } of phrases)
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0, end = start + match[0].length;
      if (taken.some(([a, b]) => start < b && a < end)) continue;
      taken.push([start, end]);
      found.push({ value: value(match[1], match[2]), side, phrase: match[0].replace(/\s+/g, " ").trim().slice(0, 80) });
    }
  return found;
}

// `x >= 50`, `50 < x`, `total > 50.00`; shifts (`>>`), arrows (`=>`) and generics are not comparisons.
const comparison = new RegExp(String.raw`(?<![<>=!])(>=|<=|>|<)(?![<>=])\s*(-?\d+(?:\.\d+)?)\b|\b(\d+(?:\.\d+)?)\s*(?<![<>=!])(>=|<=|>|<)(?![<>=])`, "g");
export function comparisons(line: string) {
  const found: { value: number; side: Side; text: string }[] = [];
  for (const match of line.matchAll(comparison)) {
    // Normalise to "subject op N"; a literal on the left flips the operator.
    const op = match[1] ?? ({ ">": "<", "<": ">", ">=": "<=", "<=": ">=" } as const)[match[4] as ">" | "<" | ">=" | "<="];
    const n = Number(match[2] ?? match[3]);
    // `x >= N` and `x < N` both group N with the larger values; `x > N` and `x <= N` with the smaller.
    found.push({ value: n, side: op === ">=" || op === "<" ? "upper" : "lower", text: match[0].trim() });
  }
  return found;
}

const commentLine = /^\s*(?:\/\/|\/\*+|\*(?!\/)|#|--|"""|''')/;
export type ContractCheck = { filePath: string; line: number; comparison: string; documented: string; source: "comment" | "description"; documentedLine?: number };

// For each changed file: comments within the 12 lines above a comparison against the same number, and
// the pull request title and description, where either the comment or the comparison changed.
export function contractChecks(diff: ChangedFile[], files: SourceFile[], description = ""): ContractCheck[] {
  const checks: ContractCheck[] = [];
  const stated = documentedBoundaries(description);
  for (const change of diff) {
    const source = files.find((f) => f.path === change.path)?.content;
    if (!source || !change.patch) continue;
    const changed = changedLines(change.patch);
    const lines = source.split("\n");
    for (let i = 0; i < lines.length && checks.length < 20; i++) {
      if (commentLine.test(lines[i]) || !comparisons(lines[i]).length) continue;
      for (const code of comparisons(lines[i])) {
        let match: ContractCheck | undefined;
        // The same line's trailing comment, then the comments above it.
        for (let j = i; j >= Math.max(0, i - 12) && !match; j--) {
          const text = j === i ? lines[i].match(/(?:\/\/|#\s)(.*)$/)?.[1] : commentLine.test(lines[j]) || /\/\/|#\s/.test(lines[j]) ? lines[j] : undefined;
          if (!text || (!changed.has(i + 1) && !changed.has(j + 1))) continue;
          const doc = documentedBoundaries(text).find((d) => d.value === code.value);
          if (doc && doc.side !== code.side) match = { filePath: change.path, line: i + 1, comparison: code.text, documented: doc.phrase, source: "comment", documentedLine: j + 1 };
        }
        const said = changed.has(i + 1) ? stated.find((d) => d.value === code.value && d.side !== code.side) : undefined;
        if (!match && said) match = { filePath: change.path, line: i + 1, comparison: code.text, documented: said.phrase, source: "description" };
        if (match && !checks.some((c) => c.filePath === match!.filePath && c.line === match!.line)) checks.push(match);
      }
    }
  }
  return checks;
}
