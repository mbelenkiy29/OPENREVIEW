"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend, current } from "../../src/server";
import { notify } from "../../src/toast";

// Manage Repos: enable or disable several repositories at once; each goes through the same mutation
// (and its admin check) as the single-repository action.
export async function setRepositoriesEnabled(form: FormData) {
  const { token } = await current();
  const ids = z.array(z.string().min(1).max(64)).min(1).max(2000).parse(form.getAll("repositoryId").map(String));
  const enabled = form.get("enabled") === "true";
  const results: PromiseSettledResult<unknown>[] = [];
  for (let i = 0; i < ids.length; i += 10) results.push(...await Promise.allSettled(ids.slice(i, i + 10).map((id) =>
    backend().mutation(api.repositories.configure, { token, repositoryId: id as Id<"repositories">, enabled }))));
  const failed = results.filter((r) => r.status === "rejected").length, done = ids.length - failed;
  const count = (n: number) => `${n} ${n === 1 ? "repository" : "repositories"}`;
  await notify(failed ? `${enabled ? "Enabled" : "Disabled"} ${count(done)}; ${count(failed)} couldn’t be changed.` : `${enabled ? "Enabled" : "Disabled"} ${count(done)}.`, failed ? "error" : "success");
  revalidatePath("/dashboard", "layout");
}
