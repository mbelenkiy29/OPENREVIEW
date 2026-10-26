import { defaults, layoutSections } from "./review-settings";
import type { RepoConfig } from "./repo-config";

// Greptile configuration (`greptile.json`, `.greptile/config.json`) translated into OpenReview's repository
// config, so a team moving from Greptile keeps its files. Keys OpenReview has no repository-file
// equivalent for are listed in one warning instead of rejecting the file.
type Section = { included?: boolean; collapsible?: boolean; defaultOpen?: boolean };
const sectionKeys: Record<string, (typeof layoutSections)[number] | "score"> = { summarySection: "overview", issuesTableSection: "findings", confidenceScoreSection: "score", sequenceDiagramSection: "diagram" };
const legacySections: Record<string, "findings" | "score" | "diagram"> = { includeIssuesTable: "findings", includeConfidenceScore: "score", includeSequenceDiagram: "diagram" };
const tiers: Record<string, string> = { base: "fast", plus: "standard", apex: "deep" };
const logic = ["correctness", "security", "data", "compatibility", "testing", "performance", "rules"];
const dashboardOnly = ["labels", "disabledLabels", "includeAuthors", "excludeAuthors", "includeBranches", "excludeBranches", "includeKeywords", "ignoreKeywords", "autoReview", "triggerOnUpdates", "skipReview", "triggerOnDrafts", "statusCheck", "statusCommentsEnabled", "shouldUpdateDescription", "updateSummaryOnly", "fixWithAI", "autoApprove", "context", "patternRepositories"];

// .gitignore lines → globs relative to the config's directory; negation has no glob equivalent here.
export function gitignoreGlobs(text: string, warnings: string[], file: string) {
  const globs: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) { warnings.push(`${file}: ignorePatterns negation "${line}" is not supported; it was ignored.`); continue; }
    const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
    const glob = (anchored ? "" : "**/") + line.replace(/^\//, "").replace(/\/$/, "");
    globs.push(glob, glob.endsWith("/**") ? glob : glob + "/**");
  }
  return [...new Set(globs)].slice(0, 200);
}

export function greptileConfig(raw: unknown, file: string, warnings: string[]): { config: RepoConfig; ignore: string[] } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { warnings.push(`${file} is not a JSON object; it was ignored.`); return undefined; }
  const g = raw as Record<string, unknown>, settings: NonNullable<RepoConfig["settings"]> = {}, rules: NonNullable<RepoConfig["rules"]> = [];
  const context = (g.customContext ?? {}) as { rules?: unknown[]; files?: unknown[]; other?: { content?: unknown }[] };
  const unsupported = Object.keys(g).filter((k) => dashboardOnly.includes(k));
  if (context.files?.length) unsupported.push("customContext.files");
  // Greptile's 3 posts the fewest comments; OpenReview's 1 does.
  if (typeof g.strictness === "number" && [1, 2, 3].includes(g.strictness)) settings.strictness = 4 - g.strictness;
  if (Array.isArray(g.commentTypes)) settings.categories = [...new Set([...(g.commentTypes.includes("logic") ? logic : ["security"]), ...g.commentTypes.filter((t) => t === "style" || t === "syntax")])] as typeof settings.categories;
  if (typeof g.effort === "string") { if (tiers[g.effort]) settings.mode = tiers[g.effort] as typeof settings.mode; else unsupported.push(`effort "${g.effort}"`); }
  if (typeof g.hideFooter === "boolean") settings.hideFooter = g.hideFooter;
  const instructions = [g.instructions, ...(context.other ?? []).map((o) => o?.content)].filter((t): t is string => typeof t === "string" && !!t.trim());
  if (instructions.length) settings.instructions = instructions.join("\n\n").slice(0, 20000);
  // Sections: `included` keeps or drops one; collapsible/defaultOpen set its GitHub layout.
  const shown = new Set<string>(defaults.summarySections), layout: Record<string, string> = {};
  for (const [key, section] of Object.entries(legacySections)) if (typeof g[key] === "boolean") { if (g[key]) shown.add(section); else shown.delete(section); }
  for (const [key, section] of Object.entries(sectionKeys)) {
    const s = g[key] as Section | undefined;
    if (!s || typeof s !== "object") continue;
    if (s.included === false) shown.delete(section); else if (s.included === true) shown.add(section);
    if (section !== "score" && typeof s.collapsible === "boolean") layout[section] = !s.collapsible ? "plain" : s.defaultOpen ? "open" : "collapsed";
  }
  if (Object.keys(legacySections).some((k) => k in g) || Object.keys(sectionKeys).some((k) => k in g)) settings.summarySections = defaults.summarySections.filter((s) => shown.has(s)) as typeof settings.summarySections;
  if (Object.keys(layout).length) settings.sectionLayout = layout as typeof settings.sectionLayout;
  const greptileRules = [...(Array.isArray(g.rules) ? g.rules : []), ...(context.rules ?? [])] as { rule?: unknown; id?: unknown; scope?: unknown; severity?: unknown; enabled?: unknown }[];
  for (const [i, r] of greptileRules.entries()) {
    if (typeof r?.rule !== "string" || !r.rule.trim()) continue;
    rules.push({ id: typeof r.id === "string" && r.id ? r.id.slice(0, 100) : `greptile-${i + 1}`, instructions: r.rule.slice(0, 4000), severity: r.severity === "low" || r.severity === "high" ? r.severity : "medium", category: "rules", globs: Array.isArray(r.scope) ? r.scope.filter((s): s is string => typeof s === "string").slice(0, 50) : [], enabled: r.enabled !== false });
  }
  if (unsupported.length) warnings.push(`${file}: ${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} not read from repository files by OpenReview; set ${unsupported.length === 1 ? "it" : "them"} in the dashboard.`);
  const disabledRules = Array.isArray(g.disabledRules) ? g.disabledRules.filter((id): id is string => typeof id === "string").slice(0, 100) : undefined;
  return { config: { settings, rules, ...(disabledRules?.length ? { disabledRules } : {}) }, ignore: typeof g.ignorePatterns === "string" ? gitignoreGlobs(g.ignorePatterns, warnings, file) : [] };
}
