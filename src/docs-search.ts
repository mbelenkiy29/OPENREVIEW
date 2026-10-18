// Docs search: a small index of each page's title, section, description and headings, built with
// the site and searched in the browser. No search service is involved.
export type DocsEntry = { slug: string; title: string; section: string; description: string; headings: string[] };
export type DocsResult = { entry: DocsEntry; heading?: string };

/** `##` and `###` headings of a Markdown page, ignoring fenced code blocks. */
export function docHeadings(markdown: string) {
  return [...markdown.replace(/```[\s\S]*?```/g, "").matchAll(/^#{2,3}\s+(.+?)\s*#*$/gm)].map((m) => m[1].replace(/[`*_]/g, "").trim()).filter(Boolean);
}

/**
 * Pages matching every word of the query; only when none does, pages matching some of the words.
 * A title match ranks above a heading match, which ranks above a description or section match;
 * ties keep the docs' own order.
 */
export function searchDocs(index: DocsEntry[], query: string, limit = 8): DocsResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { result: DocsResult; matched: number; score: number; order: number }[] = [];
  index.forEach((entry, order) => {
    const title = entry.title.toLowerCase(), headings = entry.headings.map((h) => h.toLowerCase()), rest = `${entry.description} ${entry.section}`.toLowerCase();
    let score = 0, matched = 0;
    for (const w of words) {
      const s = title.includes(w) ? 3 : headings.some((h) => h.includes(w)) ? 2 : rest.includes(w) ? 1 : 0;
      if (s) { score += s; matched++; }
    }
    if (!matched) return;
    if (title.startsWith(words[0])) score += 1;
    const inTitle = words.every((w) => title.includes(w));
    const at = headings.findIndex((h) => words.every((w) => h.includes(w)));
    const heading = inTitle ? undefined : entry.headings[at >= 0 ? at : headings.findIndex((h) => words.some((w) => h.includes(w)))];
    scored.push({ result: { entry, heading }, matched, score, order });
  });
  const complete = scored.filter((s) => s.matched === words.length);
  return (complete.length ? complete : scored).sort((a, b) => b.matched - a.matched || b.score - a.score || a.order - b.order).slice(0, limit).map((s) => s.result);
}
