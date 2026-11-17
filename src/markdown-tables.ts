// Unique accessible names for Markdown tables: the nearest heading, numbered when a heading
// has more than one table. Used by docs and legal pages wrapping tables in ScrollTable.

const strip = (heading: string) => heading
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/[*_`]/g, "")
  .trim();

/** One label per Markdown table, in document order, skipping fenced code. */
export function markdownTableLabels(source: string): string[] {
  const labels: string[] = [];
  const seen = new Map<string, number>();
  let heading = "Table";
  const text = source.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const title = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (title) {
      heading = strip(title[2]) || "Table";
      continue;
    }
    if (/^\s*\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const n = (seen.get(heading) ?? 0) + 1;
      seen.set(heading, n);
      labels.push(n === 1 ? heading : `${heading} (${n})`);
    }
  }
  return labels;
}
