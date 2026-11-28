// Live evaluation: review one real pull request checked out at `--dir` with the same engine
// `openreview review --local` uses, and write findings, usage and latency to `--out`.
// The checkout must contain the base and head commits. Model settings come from LLM_* variables.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseDiff } from "../src/engine/diff";
import { eligibleFile } from "../src/engine/indexer";
import { reviewChange } from "../src/engine/review";
import { configuredModel, modelFromEnvironment } from "../src/engine/model";
import { EvaluationUsage } from "../src/evaluation-usage";
import type { SourceFile } from "../src/engine/types";

const { values } = parseArgs({ options: { dir: { type: "string" }, base: { type: "string" }, head: { type: "string" }, title: { type: "string", default: "" }, description: { type: "string", default: "" }, id: { type: "string" }, out: { type: "string" }, mode: { type: "string", default: "standard" }, "max-files": { type: "string", default: "3000" } } });
const sha = /^[a-f0-9]{40}$/;
if (!values.dir || !values.id || !values.out || !sha.test(values.base ?? "") || !sha.test(values.head ?? "")) throw new Error("Usage: live-eval --dir <checkout> --base <sha> --head <sha> --id <case> --out <file>");
const mode = values.mode as "fast" | "standard" | "deep";
const run = promisify(execFile);
const git = async (...args: string[]) => (await run("git", ["-C", values.dir!, ...args], { maxBuffer: 256 * 1024 * 1024 })).stdout;

const diffText = await git("-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=5", values.base!, values.head!);
const diff = parseDiff(diffText);
// Local review indexes the whole tree up to 5,000 files; these repositories are larger, so the index
// is the changed files plus every eligible file in their package directories (parent and grandparent).
const entries = (await git("ls-tree", "-r", "-l", "-z", values.head!)).split("\0").filter(Boolean).map((entry) => {
  const [metadata, filePath] = entry.split("\t");
  const [, type, blob, size] = metadata.trim().split(/\s+/);
  return { path: filePath, type, sha: blob, size: Number(size) };
}).filter((e) => e.type === "blob" && e.size <= 200_000 && eligibleFile({ path: e.path, sha: e.sha, content: "" }));
const changed = new Set(diff.filter((f) => f.status !== "removed").map((f) => f.path));
const scopes = new Set([...changed].flatMap((p) => { const d = path.posix.dirname(p); return [d, path.posix.dirname(d)]; }).filter((d) => d && d !== "."));
const inScope = (p: string) => changed.has(p) || [...scopes].some((s) => p.startsWith(s + "/"));
const selected = [...entries.filter((e) => changed.has(e.path)), ...entries.filter((e) => !changed.has(e.path) && inScope(e.path))].slice(0, Number(values["max-files"]));
const files: SourceFile[] = [];
let bytes = 0;
for (const entry of selected) {
  const content = await git("show", `${values.head}:${entry.path}`);
  if (bytes + content.length > 15_000_000 && !changed.has(entry.path)) continue;
  bytes += content.length;
  files.push({ path: entry.path, sha: entry.sha, content });
}

const started = Date.now();
const tracked = new EvaluationUsage(modelFromEnvironment());
let report: Record<string, unknown>;
try {
  const result = await reviewChange({ repository: values.id, baseSha: values.base!, headSha: values.head!, title: values.title!, description: values.description!, diff, files, rules: [], mode }, tracked);
  report = {
    id: values.id, status: "completed", engine: result.metadata.engine, mode, model: configuredModel("review"),
    latencyMs: Date.now() - started, indexedFiles: files.length, changedFiles: diff.length, diffChars: diffText.length,
    inputTokens: result.usage.reduce((s, u) => s + u.inputTokens, 0), outputTokens: result.usage.reduce((s, u) => s + u.outputTokens, 0),
    estimatedCost: result.usage.reduce((s, u) => s + u.estimatedCost, 0), usage: result.usage,
    findings: result.findings.map((f) => ({ filePath: f.filePath, startLine: f.startLine, endLine: f.endLine, severity: f.severity, category: f.category, confidence: f.confidence, title: f.title, description: f.description, impact: f.impact, evidence: f.evidence, suggestedFix: f.suggestedFix })),
    summary: result.summary, coverageLimits: result.metadata.coverageLimits,
  };
} catch (error) {
  report = { id: values.id, status: "failed", error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started, ...(await tracked.totals()) };
  process.exitCode = 1;
}
await mkdir(path.dirname(values.out), { recursive: true });
await writeFile(values.out, JSON.stringify({ ...report, diff: diffText.length > 200_000 ? diffText.slice(0, 200_000) : diffText }, null, 2));
console.log(JSON.stringify({ id: report.id, status: report.status, findings: Array.isArray(report.findings) ? report.findings.length : null, latencyMs: report.latencyMs, estimatedCost: report.estimatedCost ?? null, error: report.error ?? null }));
