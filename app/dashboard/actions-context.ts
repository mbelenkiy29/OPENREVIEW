"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend, current } from "../../src/server";
import { notify } from "../../src/toast";
import { importCandidates } from "../../src/rule-files";

// Custom Context actions: bulk changes from the rules table and AI rule-file imports from Add Context.
const text = (f: FormData, key: string) => z.string().parse(f.get(key) ?? "");
const backendMessage = (e: unknown, fallback: string) => /Uncaught Error: ([^\n]+?)(?:\s+at |\n|$)/.exec(e instanceof Error ? e.message : "")?.[1] ?? fallback;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Back to the Custom Context list the form came from (same-page paths only).
const back = (form: FormData) => { const to = text(form, "returnTo"); if (/^\/dashboard\/context(\?[\w=&%.:+~-]*)?$/.test(to)) redirect(to); };

// Bulk Delete / Deactivate / Activate: the existing rule mutation once per selected rule, with the rule's
// own fields so only `enabled` (or removal) changes.
export async function bulkRules(form: FormData) {
  const { token } = await current();
  const organizationId = text(form, "organizationId") as Id<"organizations">, op = z.enum(["delete", "deactivate", "activate"]).parse(text(form, "op"));
  const ids = new Set(form.getAll("ruleId").map(String));
  if (!ids.size || ids.size > 50) { await notify("Select between 1 and 50 rules.", "error"); return; }
  // shortcut: overview returns the workspace's first 200 rules; a selection beyond that reports as failed. Add a by-id query if workspaces outgrow it.
  const { rules } = await backend().query(api.dashboard.overview, { token, organizationId });
  const results = await Promise.allSettled(rules.filter((r) => ids.has(r._id)).map((r) => backend().mutation(api.dashboard.rules, {
    token, organizationId, id: r._id, remove: op === "delete", title: r.title, instructions: r.instructions, category: r.category, severity: r.severity, globs: r.globs,
    enabled: op === "delete" ? r.enabled : op === "activate",
    ...(r.repositoryId ? { repositoryId: r.repositoryId } : {}), ...(r.teamId ? { teamId: r.teamId } : {}), ...(r.repositoryPattern ? { repositoryPattern: r.repositoryPattern } : {}),
  })));
  const done = results.filter((r) => r.status === "fulfilled").length, verb = { delete: "Deleted", deactivate: "Deactivated", activate: "Activated" }[op];
  await notify(done === ids.size ? `${verb} ${plural(done, "rule")}.` : `${verb} ${done} of ${plural(ids.size, "rule")}. The rest changed or are no longer accessible.`, done === ids.size ? "success" : "error");
  revalidatePath("/dashboard", "layout");
}

// Add Context → File: an AI rules file (AGENTS.md, CLAUDE.md, .cursorrules…) parsed into candidate rules and
// imported through the rule assistant, so every candidate is guarded and waits for an admin's approval.
export async function importRuleFile(form: FormData) {
  const { token } = await current();
  const organizationId = text(form, "organizationId") as Id<"organizations">, repositoryId = text(form, "repositoryId");
  const path = text(form, "path").trim().slice(0, 200) || "AGENTS.md", rules = importCandidates([{ path, content: text(form, "content").slice(0, 200_000) }]);
  if (!rules.length) await notify(`No rules found in ${path}. Only directive lines about code (always, never, must, avoid…) are imported.`, "error");
  else try {
    const result = await backend().mutation(api.ruleAssistant.importRules, { token, organizationId, ...(repositoryId ? { repositoryId: repositoryId as Id<"repositories"> } : {}), rules });
    await notify(`Imported ${plural(result.suggested, "rule")} from ${path} as suggestions to approve${result.rejected.length ? `; skipped ${result.rejected.length}` : ""}.`);
  } catch (e) { await notify(backendMessage(e, "The rules file could not be imported."), "error"); }
  revalidatePath("/dashboard", "layout");
  back(form);
}
