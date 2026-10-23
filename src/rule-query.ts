// The Custom rules search box: free text plus `repository:` and `status:` filter tokens, as in Greptile's Memory search.
export function parseRuleQuery(q = "") {
  const out: { text: string; repository?: string; status?: "active" | "disabled" } = { text: "" };
  const words: string[] = [];
  for (const w of q.trim().split(/\s+/).filter(Boolean)) {
    const [, key, value] = w.match(/^(repository|status):(.+)$/i) ?? [];
    if (key?.toLowerCase() === "repository") out.repository = value;
    else if (key?.toLowerCase() === "status" && ["active", "disabled"].includes(value.toLowerCase())) out.status = value.toLowerCase() as "active" | "disabled";
    else words.push(w);
  }
  out.text = words.join(" ");
  return out;
}
