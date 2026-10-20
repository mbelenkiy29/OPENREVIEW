#!/usr/bin/env node
import { loadEnvFile } from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseDiff } from "./engine/diff";
import { eligibleFile } from "./engine/indexer";
import { reviewChange } from "./engine/review";
import { modelFromEnvironment } from "./engine/model";
import { applyRepoConfig, loadRepoConfig } from "./repo-config";
import type { ChangedFile, Finding, Rule, SourceFile } from "./engine/types";
import { runtimeEvidenceSchema } from "./engine/types";
import { findingTags, priorityOf, tagLabels } from "./priority";
import { validateRuntime } from "../scripts/sandbox";
import { memoryToolbox } from "./engine/agent";
import { cacheDirectory, localAgentState, stateFile } from "./local-review-state";
import { inlineReport } from "./inline-output";
import { findRepository, remoteReview } from "./remote-review";
import { reviewStatusExit } from "./cli-review";
import { repositoryFromRemote } from "./onboard";
import { accessToken, browserSignIn, defaultServer, logout, readLogin, replaceLogin, serverUrl, type SavedLogin } from "./cli-auth";
import { playBanner, stageReporter } from "./cli-animation";

try {
  loadEnvFile(".env.local");
} catch {
  /* Explicit environment configuration works without a file. */
}
const execute = promisify(execFile);
async function git(...args: string[]) {
  return (await execute("git", args, { maxBuffer: 8 * 1024 * 1024 })).stdout;
}
const version = process.env.OPENREVIEW_CLI_VERSION ?? "dev";
const apiKeyLogin = z.object({ url: z.string().url(), apiKey: z.string().min(16) });
// OPENREVIEW_API_KEY (CI) wins over the saved login, so a key never has to be written to disk or argv.
async function currentLogin(): Promise<SavedLogin | null> {
  const apiKey = process.env.OPENREVIEW_API_KEY;
  return apiKey ? apiKeyLogin.parse({ url: serverUrl(process.env.OPENREVIEW_URL ?? defaultServer), apiKey }) : readLogin();
}
// The key from stdin when piped, else a prompt that does not echo it.
async function readSecret(prompt: string) {
  if (!process.stdin.isTTY) { let text = ""; for await (const chunk of process.stdin) text += chunk; return text.trim(); }
  const { Writable } = await import("node:stream");
  process.stderr.write(prompt);
  const terminal = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: new Writable({ write: (_chunk, _encoding, done) => done() }), terminal: true });
  try { return (await terminal.question("")).trim(); } finally { terminal.close(); process.stderr.write("\n"); }
}
async function signedIn(hint = "Run openreview login."): Promise<SavedLogin> {
  const login = await currentLogin();
  if (!login) throw new Error(`Not signed in. ${hint}`);
  return login;
}
async function mcp(login: SavedLogin) {
  const { mcpCaller } = await import("./resolve-cli");
  return mcpCaller(login.url, () => accessToken(login));
}
async function main() {
  if (process.argv[2] === "bridge") { await (await import("./bridge")).bridgeMain(process.argv.slice(3)); return; }
  if (process.argv[2] === "p4") { await (await import("./perforce-depot")).p4IndexMain(process.argv.slice(3)); return; }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string", default: "main" },
      json: { type: "boolean" },
      agent: { type: "boolean" },
      security: { type: "boolean" },
      "runtime-evidence": { type: "string" },
      image: { type: "string" },
      command: { type: "string" },
      timeout: { type: "string", default: "120" },
      mode: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      "api-key": { type: "boolean" },
      instructions: { type: "string" },
      help: { type: "boolean" },
      yes: { type: "boolean" },
      workspace: { type: "string" },
      "create-workspace": { type: "string" },
      repositories: { type: "string" },
      "no-rules": { type: "boolean" },
      engine: { type: "string" },
      resume: { type: "boolean" },
      inline: { type: "boolean" },
      pr: { type: "string" },
      max: { type: "string", default: "3" },
      push: { type: "boolean" },
      "fix-agent": { type: "string", default: "claude" },
      local: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    await playBanner({ version, details: ["AI code review for your commits and pull requests"] });
    console.log(
      "OpenReview\n\nopenreview login [--url https://review.example.com]   sign in through your browser\nopenreview login --api-key [--url <server>]   sign in with an API key read from a prompt or stdin (or set OPENREVIEW_API_KEY in CI)\nopenreview logout\nopenreview onboard [--url <server> --api-key] [--repositories all|owner/name,...] [--no-rules] [--workspace <name>] [--yes --json]\nopenreview review [--base main] [--json | --agent | --inline] [--security] [--mode fast|standard|deep] [--instructions <text>]\nopenreview review status --pr <number> [--json]   exit 0 reviewed, 1 none, 2 bad usage, 3 running, 4 failed, 5 cancelled\nopenreview review --local [--engine pipeline|agentic] [--resume]\nopenreview status (alias: whoami)\nopenreview resolve --pr <number> [--max 3] [--push] [--fix-agent claude|codex]\nopenreview p4 index --help\nopenreview runtime --image <image@sha256:digest> --command <test-command> [--timeout 120]\n\nSigned in, review runs on your OpenReview workspace with its model, rules and plan. With --local, or when signed out, it runs on this machine with LLM_PROVIDER, LLM_MODEL and LLM_API_KEY (or a configured compatible endpoint).",
    );
    return;
  }
  if (command === "login") {
    if (values.token) process.stderr.write("Warning: --token puts the key in your shell history and process list. Use openreview login --api-key (prompt or stdin) or OPENREVIEW_API_KEY.\n");
    const apiKey = values.token ?? (values["api-key"] ? await readSecret("API key: ") : undefined);
    if (apiKey !== undefined) {
      const config = apiKeyLogin.parse({ url: serverUrl(values.url ?? process.env.OPENREVIEW_URL ?? defaultServer), apiKey });
      const response = await fetch(new URL("/api/repositories", config.url), { headers: { authorization: `Bearer ${config.apiKey}` } });
      if (!response.ok) throw new Error(`Login failed: HTTP ${response.status}. Generate an API key in dashboard Settings.`);
      await replaceLogin(config);
      console.log("Authenticated. Configuration saved with owner-only permissions.");
      return;
    }
    const login = await browserSignIn(values.url ?? process.env.OPENREVIEW_URL ?? defaultServer, { print: (line) => console.error(line) });
    await replaceLogin(login);
    if (process.stdout.isTTY) await playBanner({ details: [`Signed in to ${login.url}`, "Run openreview review before you push."] }, { size: "compact" });
    else console.log(`Signed in to ${login.url}.`);
    return;
  }
  if (command === "logout") {
    const login = await logout();
    console.log(login ? `Signed out of ${login.url}.` : "Not signed in.");
    return;
  }
  if (command === "onboard") {
    // Uses the saved login, or --url/--token (validated and saved like `openreview login`).
    // Onboarding uses the admin REST API, so it needs an admin API key rather than a browser sign-in.
    let config;
    if (values.url || values.token || values["api-key"]) {
      config = apiKeyLogin.parse({ url: values.url ? serverUrl(values.url) : values.url, apiKey: values.token ?? (values["api-key"] ? await readSecret("Admin API key: ") : undefined) });
      await replaceLogin(config);
    } else {
      const saved = await currentLogin();
      if (!saved || !("apiKey" in saved)) throw new Error("Onboarding needs an admin API key. Run openreview onboard --url <server> --api-key, or set OPENREVIEW_API_KEY (create the key in dashboard Settings → API keys).");
      config = saved;
    }
    const { onboard, httpApi } = await import("./onboard");
    const root = (await git("rev-parse", "--show-toplevel").catch(() => process.cwd())).trim() || process.cwd();
    const remote = (await git("-C", root, "remote", "get-url", "origin").catch(() => "")).trim() || undefined;
    const { readdir } = await import("node:fs/promises");
    const inside = (relative: string) => { const full = path.resolve(root, relative); if (full !== root && !full.startsWith(root + path.sep)) throw new Error("outside repository"); return full; };
    const files = { read: (relative: string) => readFile(inside(relative), "utf8").catch(() => null), list: (relative: string) => readdir(inside(relative)).catch(() => [] as string[]) };
    const readline = values.yes ? undefined : (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    try {
      const summary = await onboard(httpApi(config.url, config.apiKey), { ask: (q) => readline ? readline.question(q) : Promise.reject(new Error("No prompts in --yes mode")), print: (line) => console.log(line) }, files, { yes: Boolean(values.yes), json: Boolean(values.json), workspace: values.workspace, createWorkspace: values["create-workspace"], repositories: values.repositories, rules: !values["no-rules"], remote });
      if (values.json) console.log(JSON.stringify(summary, null, 2));
      if (summary.stopped || summary.repositories.failed.length) process.exitCode = 1;
    } finally { readline?.close(); }
    return;
  }
  if (command === "resolve") {
    // Fix open findings on a pull request with a local coding agent until a re-review is clean.
    const login = await signedIn("Run openreview login, or openreview login --token with a write-scoped key.");
    const prNumber = Number(values.pr);
    if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error("Pass --pr <number>");
    const maxIterations = Number(values.max);
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10) throw new Error("--max must be between 1 and 10");
    const agent = z.enum(["claude", "codex"]).parse(values["fix-agent"]);
    const root = (await git("rev-parse", "--show-toplevel")).trim();
    const { repositoryFromRemote } = await import("./onboard");
    const { runResolveLoop } = await import("./resolve-loop");
    const { fixCommand, fixInstructions, localGit } = await import("./resolve-cli");
    const local = localGit(root);
    if (!(await local.clean())) throw new Error("Commit or stash your changes first; the loop commits only the agent's fixes.");
    const remote = repositoryFromRemote((await git("remote", "get-url", "origin").catch(() => "")).trim());
    const remoteTools = await mcp(login);
    try {
      const repos = await remoteTools.call("list_repositories", {}) as { _id: string; fullName: string }[];
      const repo = repos.find((r) => remote && r.fullName.toLowerCase() === remote.toLowerCase());
      if (!repo) throw new Error(`This checkout's origin (${remote ?? "unknown"}) is not a repository visible to your API key.`);
      const readline = process.stdin.isTTY ? (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout }) : undefined;
      try {
        const result = await runResolveLoop(remoteTools.call, local, {
          repositoryId: repo._id, prNumber, maxIterations,
          push: values.push ? "always" : readline ? "ask" : "never",
          ask: async (q) => /^y(es)?$/i.test((await readline!.question(`${q} [y/N] `)).trim()),
          fix: async (findings) => { const { file, args } = fixCommand(agent, fixInstructions(repo.fullName, prNumber, findings)); await promisify(execFile)(file, args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }); },
          wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          log: (line) => console.log(line),
        });
        const messages: Record<string, string> = { clean: "No open findings remain.", "max-iterations": `Stopped after ${result.iterations} rounds with ${result.remaining} open findings.`, "no-changes": "The agent made no changes; stopping.", "push-required": "Committed locally. Push the branch (or rerun with --push), then run openreview resolve again.", "push-declined": "Committed locally and not pushed.", "review-timeout": "The re-review did not finish in time; check the pull request.", "review-failed": "The re-review failed; check the pull request." };
        console.log(messages[result.outcome] + (result.commits.length ? ` Commits: ${result.commits.map((c) => c.slice(0, 7)).join(", ")}.` : ""));
        if (result.outcome !== "clean") process.exitCode = 1;
      } finally { readline?.close(); }
    } finally { await remoteTools.close(); }
    return;
  }
  if (command === "runtime") {
    const evidence = await validateRuntime(
      values.image ?? "",
      values.command ?? "",
      Number(values.timeout),
    );
    console.log(JSON.stringify(evidence, null, 2));
    if (evidence.exitCode !== 0) process.exitCode = 1;
    return;
  }
  if (command === "status" || command === "whoami") {
    const login = await signedIn("Local review also works with LLM environment variables: openreview review --local.");
    const remoteTools = await mcp(login);
    try {
      console.error(`Signed in to ${login.url} with ${"apiKey" in login ? "an API key" : "your browser sign-in"}.`);
      console.log(JSON.stringify(await remoteTools.call("list_repositories", {}), null, 2));
    } finally { await remoteTools.close(); }
    return;
  }
  if (command !== "review") throw new Error(`Unknown command: ${command}`);
  if (positionals[1] === "status") {
    const prNumber = Number(values.pr);
    if (!Number.isInteger(prNumber) || prNumber < 1) { console.error("OpenReview: Pass --pr <number>"); process.exitCode = 2; return; }
    const login = await currentLogin();
    if (!login) { console.error("OpenReview: Not signed in. Run openreview login."); process.exitCode = 1; return; }
    const remoteTools = await mcp(login);
    try {
      const repo = await findRepository(remoteTools.call, repositoryFromRemote((await git("remote", "get-url", "origin").catch(() => "")).trim()));
      const status = await remoteTools.call("get_review_status", { repositoryId: repo._id, prNumber }) as { repository: string; review: { status: string; verdict: string | null; coversCurrentHead: boolean | null; headSha: string } | null; unresolved: number };
      process.exitCode = reviewStatusExit(status.review);
      const r = status.review;
      console.log(values.json ? JSON.stringify(status, null, 2) : `${status.repository}#${prNumber}: ` + (r ? [r.status, r.verdict, r.coversCurrentHead === false ? `reviewed ${r.headSha.slice(0, 7)}, not the current head` : "", `${status.unresolved} open finding${status.unresolved === 1 ? "" : "s"}`].filter(Boolean).join(" · ") : "no review yet"));
    } finally { await remoteTools.close(); }
    return;
  }
  if (positionals.length > 1) throw new Error(`Unknown review command: ${positionals[1]}`);
  const root = (await git("rev-parse", "--show-toplevel")).trim();
  const baseRef = values.base!;
  if (baseRef.startsWith("-") || !/^[a-zA-Z0-9_./-]+$/.test(baseRef))
    throw new Error("Invalid base reference");
  const baseSha = (await git("merge-base", baseRef, "HEAD")).trim(),
    headSha = (await git("rev-parse", "HEAD")).trim();
  const diffText = await git("-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=5", baseSha, headSha);
  const diff = parseDiff(diffText);
  if (!diff.length) {
    console.log(
      values.json || values.agent
        ? JSON.stringify({
            summary: "No committed changes against base.",
            findings: [],
            usage: [],
          })
        : "No committed changes against base.",
    );
    return;
  }
  if ([values.json, values.agent, values.inline].filter(Boolean).length > 1) throw new Error("Choose one output format: --json, --agent or --inline");
  const mode = values.mode === undefined ? undefined : z.enum(["fast", "standard", "deep"]).parse(values.mode);
  const title = (await git("log", "-1", "--format=%s")).trim();
  const entries = (await git("ls-tree", "-r", "-l", "-z", "HEAD"))
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [metadata, filePath] = entry.split("\t");
      const [, type, sha, size] = metadata.trim().split(/\s+/);
      return { path: filePath, type, sha, size: Number(size) };
    })
    .filter(
      (e) =>
        e.type === "blob" &&
        e.size <= 200000 &&
        eligibleFile({ path: e.path, sha: e.sha, content: "" }),
    );
  const progress = values.json || values.agent ? undefined : stageReporter();
  const login = values.local ? null : await currentLogin();
  let result: { summary: string; findings: Finding[] };
  const files: SourceFile[] = [];
  try {
    if (login) {
      // Signed in: the server reviews the change with the workspace's model, rules and index.
      if (values.engine || values.resume || values["runtime-evidence"]) throw new Error("--engine, --resume and --runtime-evidence run the review on this machine; add --local");
      const changed = new Set(diff.filter((f) => f.status !== "removed").map((f) => f.path));
      for (const entry of entries.filter((e) => changed.has(e.path))) files.push({ ...entry, content: await git("show", `HEAD:${entry.path}`) });
      const remoteTools = await mcp(login);
      try {
        result = await remoteReview(remoteTools.call, { remote: repositoryFromRemote((await git("remote", "get-url", "origin").catch(() => "")).trim()), baseSha, headSha, title, ...(mode ? { mode } : {}), security: Boolean(values.security), ...(values.instructions ? { instructions: values.instructions } : {}), diff: diffText, files }, { stage: (stage) => progress?.stage(stage), wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
      } finally { await remoteTools.close(); }
    } else {
      if (entries.length > 5000)
        throw new Error(
          "Local review currently supports up to 5,000 eligible files. Use server indexing for larger repositories.",
        );
      let bytes = 0;
      for (const entry of entries) {
        const content = await git("show", `HEAD:${entry.path}`);
        bytes += content.length;
        if (bytes > 20_000_000)
          throw new Error(
            "Local source indexing exceeds 20 MB; use server indexing.",
          );
        files.push({ ...entry, content });
      }
      result = await localReview(root, baseSha, headSha, title, diff, files, mode ?? "standard", progress);
    }
  } finally { progress?.done(); }
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else if (values.agent)
    console.log(
      JSON.stringify({
        repository: root,
        commit: headSha,
        findings: result.findings.map((f) => ({
          file: f.filePath,
          line: f.startLine,
          severity: f.severity,
          priority: priorityOf(f.severity),
          tags: findingTags(f),
          issue: f.title,
          evidence: f.evidence,
          fix: f.suggestedFix,
        })),
        summary: result.summary,
      }),
    );
  else if (values.inline) console.log(inlineReport(result.findings, files));
  else {
    console.log(result.summary);
    for (const f of result.findings)
      console.log(
        `\n[${[priorityOf(f.severity) + " " + f.severity, ...findingTags(f).map((t) => tagLabels[t])].join(", ")}] ${f.filePath}:${f.startLine} ${f.title}\n${f.description}\nFix: ${f.suggestedFix}`,
      );
  }

  // The review engine on this machine, with the model from the environment (--local, or signed out).
  async function localReview(root: string, baseSha: string, headSha: string, title: string, diff: ChangedFile[], files: SourceFile[], mode: "fast" | "standard" | "deep", progress?: { stage(name: string): void }) {
    // Same repository config schema and base-revision semantics as server reviews.
    const repoConfig = await loadRepoConfig({
      tree: async (_repository, sha) => (await git("ls-tree", "-r", "--long", sha)).split("\n").filter(Boolean).flatMap((line) => {
        const match = /^\d+ blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/.exec(line);
        return match ? [{ path: match[3], sha: match[1], size: Number(match[2]) || 0 }] : [];
      }),
      blob: async (_repository, _path, sha) => ({ content: await git("cat-file", "blob", sha) }),
    }, root, baseSha);
    for (const warning of repoConfig.warnings) process.stderr.write(`OpenReview config: ${warning}\n`);
    const rules: Rule[] = repoConfig.rules;
    // --resume continues an interrupted agentic review of this checkout (same base and HEAD only).
    const engine = z.enum(["pipeline", "agentic"]).parse(values.engine ?? (values.resume ? "agentic" : "pipeline"));
    if (values.resume && engine !== "agentic") throw new Error("--resume applies to the agentic engine");
    const saved = localAgentState(stateFile(cacheDirectory(), root, baseSha), { resume: Boolean(values.resume), headSha });
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const result = await reviewChange(
      {
        repository: path.basename(root),
        baseSha,
        headSha,
        title,
        description: "",
        diff,
        files,
        rules,
        runtimeEvidence: values["runtime-evidence"]
          ? runtimeEvidenceSchema.parse(
              JSON.parse(await readFile(values["runtime-evidence"], "utf8")),
            )
          : undefined,
        mode,
        settings: {
          ...(repoConfig.settings.ignoredPaths ? { ignoredPaths: repoConfig.settings.ignoredPaths } : {}),
          ...(repoConfig.settings.instructions || repoConfig.directories.length || values.instructions ? { instructions: [repoConfig.settings.instructions || repoConfig.directories.length ? applyRepoConfig({ instructions: repoConfig.settings.instructions ?? "" }, repoConfig).settings.instructions : "", values.instructions].filter(Boolean).join("\n\n") } : {}),
          ...(repoConfig.settings.categories ? { categories: repoConfig.settings.categories } : {}),
          ...(values.security ? { categories: ["security" as const] } : {}),
        },
      },
      modelFromEnvironment(),
      async (stage) => { progress?.stage(stage); },
      controller.signal,
      engine === "agentic" ? { engine, tools: memoryToolbox(files, headSha), agent: saved.hooks } : undefined,
    ).catch((error) => {
      if (engine === "agentic" && controller.signal.aborted) throw new Error("Interrupted. Run the same command with --resume to continue from the last completed step.");
      throw error;
    });
    if (engine === "agentic") {
      await saved.clear();
      if (saved.outcome() !== "fresh" && !values.json && !values.agent) process.stderr.write(saved.outcome() === "resumed" ? "Resumed the interrupted review.\n" : "HEAD moved since the interrupted review; started over.\n");
    }
    return result;
  }
}
main().catch(async (error) => {
  console.error(
    `OpenReview: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
  if (process.argv[2] === "bridge" && process.argv[3] === "dispatch" && process.argv.includes("--desktop") && process.stdin.isTTY && process.stdout.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try { await terminal.question("Press Enter to close this error. Findings remain unresolved. "); }
    finally { terminal.close(); }
  }
});
