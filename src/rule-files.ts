// Existing AI-assistant rule files (CLAUDE.md, AGENTS.md, Cursor/Windsurf/Copilot/Gemini rules) imported
// as candidate review rules. Only directive statements about code become candidates; agent workflow
// (commits, branches, chatting), code blocks and persona text are dropped. Every candidate is still
// untrusted text: the server guards it again and stores it as a suggestion that an admin approves.
// Whole-file agent guidelines (SKILL.md plus the same convention files) are selected separately:
// frontmatter is stripped, name/description become the title, and a token budget caps what the review sees.

import { packProblem } from "./guidance-packs";

export const ruleFiles = ["CLAUDE.md", "AGENTS.md", ".cursorrules", ".github/copilot-instructions.md", "GEMINI.md", ".windsurfrules"] as const;
export const cursorRulesDirectory = ".cursor/rules";
export const skillFilePattern = /^\.(claude|cursor|agents|github)\/skills\/[^/]+\/SKILL\.md$/i;
export const agentGuidelineLimits = { maxFiles: 20, maxFileBytes: 16_000, maxTokens: 8_000 } as const;
export type RuleFileSystem = { read(path: string): Promise<string | null>; list(directory: string): Promise<string[]> };
export type ImportedRule = { title: string; instructions: string; globs: string[]; source: { path: string; line: number } };
export type AgentGuideline = { path: string; title: string; instructions: string; globs: string[]; truncated: boolean };

export async function discoverRuleFiles(fs: RuleFileSystem, limit = 30): Promise<{ path: string; content: string }[]> {
  const found: { path: string; content: string }[] = [];
  const add = async (path: string) => {
    const content = await fs.read(path).catch(() => null);
    if (content !== null && content.length <= 200_000) found.push({ path, content });
  };
  for (const path of ruleFiles) await add(path);
  const cursor = (await fs.list(cursorRulesDirectory).catch(() => [])).filter((name) => /^[\w.\- ]+\.(mdc|md)$/i.test(name)).sort().slice(0, limit);
  for (const name of cursor) await add(`${cursorRulesDirectory}/${name}`);
  return found.slice(0, limit);
}

// Paths at the repository root that reviews treat as whole-file guidelines, in priority order:
// convention files, then Cursor rules, then SKILL.md under the documented agent skill folders.
export function discoverAgentGuidelinePaths(paths: string[]): string[] {
  const present = new Set(paths);
  const root = ruleFiles.filter((path) => present.has(path));
  const cursor = paths.filter((path) => /^\.cursor\/rules\/[\w.\- ]+\.(mdc|md)$/i.test(path)).sort();
  const skills = paths.filter((path) => skillFilePattern.test(path)).sort();
  return [...root, ...cursor, ...skills];
}

const directive = /\b(always|never|must|should|avoid|prefer|do not|don't|ensure|require|requires|keep|use|only)\b/i;
// Instructions about the agent's own workflow rather than the code under review.
const workflow = /\b(commit|commits|committing|push|pushing|branch|branches|terminal|shell|ask the user|respond|reply|answer|chat|conversation|this file|these instructions|you are|as an ai|the assistant|run `|run the)\b/i;
const strip = (text: string) => text.replace(/\*\*|__|(?<!\w)[*_](?!\s)|(?<!\s)[*_](?!\w)/g, "").replace(/\s+/g, " ").trim();
const frontmatterGlobs = (frontmatter: string) => {
  const line = /^globs:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? "";
  const list = line.startsWith("[") ? [...line.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : line.split(",").map((g) => g.trim().replace(/^["']|["']$/g, ""));
  return list.filter((g) => g && g.length <= 200 && !g.startsWith("/") && !g.split("/").includes("..")).slice(0, 20);
};
const frontmatterFields = (frontmatter: string) => Object.fromEntries(frontmatter.split("\n").map((line) => /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1].toLowerCase(), m[2].trim().replace(/^["']|["']$/g, "")]));
const guidelineTitle = (path: string, fields: Record<string, string>, heading: string) => {
  const name = fields.name?.trim() || fields.title?.trim() || "";
  const description = fields.description?.trim() || "";
  const skill = /^\.(?:claude|cursor|agents|github)\/skills\/([^/]+)\/SKILL\.md$/i.exec(path);
  const title = name && description ? `${name}: ${description}` : name || description || heading || skill?.[1] || path;
  return (title.length >= 3 ? title : path).slice(0, 120);
};

// One SKILL.md or convention file as a single review guideline: strip YAML frontmatter, drop fenced
// code, agent-workflow lines and anything that fails the guidance-pack guard, then title from name/description.
export function parseGuideline(path: string, content: string): { title: string; instructions: string; globs: string[]; truncated: boolean } | undefined {
  let lines = content.replace(/\r\n/g, "\n").split("\n"), fields: Record<string, string> = {}, globs: string[] = [];
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      const frontmatter = lines.slice(1, end).join("\n");
      fields = frontmatterFields(frontmatter);
      globs = frontmatterGlobs(frontmatter);
      lines = lines.slice(end + 1);
    }
  }
  const kept: string[] = [];
  let heading = "", fenced = false;
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(raw);
    if (h && !heading) heading = strip(h[1]);
    if (raw.trim() && (packProblem(raw) || workflow.test(raw))) continue;
    kept.push(raw);
  }
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length < 20) return undefined;
  const title = guidelineTitle(path, fields, heading);
  const combined = `${title}: ${body}`;
  return { title, instructions: combined.slice(0, 4000), globs, truncated: combined.length > 4000 };
}

export function selectAgentGuidelines(files: { path: string; content: string; truncated?: boolean }[], limits: { maxFiles: number; maxFileBytes: number; maxTokens: number } = agentGuidelineLimits): { included: AgentGuideline[]; skipped: { path: string; reason: string }[] } {
  const included: AgentGuideline[] = [], skipped: { path: string; reason: string }[] = [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  let tokens = 0;
  for (const path of discoverAgentGuidelinePaths(files.map((file) => file.path))) {
    const file = byPath.get(path);
    if (!file) continue;
    if (included.length >= limits.maxFiles) { skipped.push({ path, reason: `beyond the ${limits.maxFiles}-file cap` }); continue; }
    let content = file.content, truncated = !!file.truncated;
    if (content.length > limits.maxFileBytes) { content = content.slice(0, limits.maxFileBytes); truncated = true; }
    const parsed = parseGuideline(path, content);
    if (!parsed) { skipped.push({ path, reason: "no usable review guidance" }); continue; }
    const problem = packProblem(parsed.instructions);
    if (problem) { skipped.push({ path, reason: problem }); continue; }
    let instructions = parsed.instructions;
    const cost = Math.ceil(instructions.length / 4);
    if (tokens + cost > limits.maxTokens) {
      const room = Math.max(0, (limits.maxTokens - tokens) * 4);
      if (room < 40) { skipped.push({ path, reason: `would exceed the ${limits.maxTokens}-token budget` }); continue; }
      instructions = instructions.slice(0, room - 1) + "…";
      truncated = true;
    }
    tokens += Math.ceil(instructions.length / 4);
    included.push({ path, title: parsed.title, instructions, globs: parsed.globs, truncated: truncated || parsed.truncated });
  }
  return { included, skipped };
}

export function parseRuleFile(path: string, content: string): ImportedRule[] {
  let lines = content.replace(/\r\n/g, "\n").split("\n"), offset = 0, globs: string[] = [];
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) { globs = frontmatterGlobs(lines.slice(1, end).join("\n")); offset = end + 1; lines = lines.slice(end + 1); }
  }
  const items: { text: string; line: number; heading: string }[] = [];
  let heading = "", fenced = false, bullets = 0;
  for (const [i, raw] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(raw);
    if (h) { heading = strip(h[1]); continue; }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (bullet) bullets++;
    const text = strip(bullet ? bullet[1] : raw);
    if (text) items.push({ text, line: i + 1 + offset, heading: bullet ? heading : "\u0000" + heading });
  }
  // Bulleted files: bullets only. Plain files (often .cursorrules): every sentence-like line.
  const candidates = items.filter((item) => bullets ? !item.heading.startsWith("\u0000") : true).map((item) => ({ ...item, heading: item.heading.replace(/^\u0000/, "") }));
  const out: ImportedRule[] = [];
  for (const c of candidates) {
    if (c.text.length < 20 || c.text.length > 500 || !directive.test(c.text) || workflow.test(c.text)) continue;
    const words = c.text.replace(/[.:;]+$/, "").split(" ");
    const short = words.slice(0, 8).join(" ") + (words.length > 8 ? "…" : "");
    const title = (c.heading && c.heading.length <= 40 ? `${c.heading}: ${short}` : short).slice(0, 120);
    out.push({ title, instructions: c.text, globs, source: { path, line: c.line } });
  }
  return out;
}

// Rule wording compared without case or punctuation, to spot the same rule from two sources.
export const ruleText = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Candidates from every discovered file, deduplicated by wording, capped for one import request.
export function importCandidates(files: { path: string; content: string }[], limit = 50): ImportedRule[] {
  const seen = new Set<string>();
  const out: ImportedRule[] = [];
  for (const file of files) for (const rule of parseRuleFile(file.path, file.content)) {
    const key = ruleText(rule.instructions);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out.slice(0, limit);
}
