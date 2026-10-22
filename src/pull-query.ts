// Greptile-style pull request search: free text plus author:, reviewer:, repo:, status:, state:, impact: and
// confidence: tokens ("confidence:>3", "author:@alice", 'repo:"acme/api"').
export type PullQuery = { search?: string; author?: string; reviewer?: string; repo?: string; status?: string; state?: string; impact?: string; scoreMin?: number; scoreMax?: number };
const keys = ["author", "reviewer", "repo", "status", "state", "impact", "confidence"] as const;
export function parsePullQuery(input: string): PullQuery {
  const query: PullQuery = {}, words: string[] = [];
  for (const token of input.match(/[a-z]+:"[^"]*"|\S+/gi) ?? []) {
    const match = /^([a-z]+):"?([^"]*)"?$/i.exec(token), key = match?.[1].toLowerCase() as (typeof keys)[number] | undefined, value = match?.[2].trim();
    if (!key || !keys.includes(key) || !value) { words.push(token); continue; }
    if (key === "confidence") {
      const score = /^(>=|<=|>|<|=)?([0-5])$/.exec(value);
      if (!score) { words.push(token); continue; }
      const n = Number(score[2]), op = score[1] ?? "=";
      if (op.startsWith(">")) query.scoreMin = op === ">" ? n + 1 : n;
      else if (op.startsWith("<")) query.scoreMax = op === "<" ? n - 1 : n;
      else query.scoreMin = query.scoreMax = n;
    } else query[key] = key === "author" || key === "reviewer" ? value.replace(/^@/, "") : key === "repo" ? value : value.toLowerCase();
  }
  if (words.length) query.search = words.join(" ");
  return query;
}
// Adds or replaces one token, quoting values with spaces; used by the suggested filter chips.
export const withoutToken = (input: string, key: (typeof keys)[number]) =>
  (input.match(/[a-z]+:"[^"]*"|\S+/gi) ?? []).filter((t) => !t.toLowerCase().startsWith(key + ":")).join(" ");
export const withToken = (input: string, key: (typeof keys)[number], value: string) =>
  [withoutToken(input, key), `${key}:${/\s/.test(value) ? `"${value}"` : value}`].filter(Boolean).join(" ");
