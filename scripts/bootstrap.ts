import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
let env = await readFile(".env.local", "utf8").catch(() => "");
for (const name of [
  "SESSION_SECRET",
  "SERVICE_SECRET",
  "CREDENTIAL_ENCRYPTION_KEY",
  "GITHUB_WEBHOOK_SECRET",
]) {
  const empty = new RegExp(`^${name}=(?:""|'')?[ \\t]*$`, "m");
  if (empty.test(env))
    env = env.replace(empty, `${name}=${randomBytes(32).toString("hex")}`);
  else if (!new RegExp(`^${name}=`, "m").test(env))
    env += `\n${name}=${randomBytes(32).toString("hex")}\n`;
}
if (!/^APP_URL=/m.test(env)) env += "\nAPP_URL=http://localhost:3000\n";
await writeFile(".env.local", env, { mode: 0o600 });
await chmod(".env.local", 0o600);
// Billing settings only when set, so a blank line copied from .env.example never clears a key set on Convex directly.
const billing = (line: string) => /^(STRIPE_|BILLING_|REFERRAL)[A-Z_]*=\S/.test(line);
const backendEnv =
  env
    .split("\n")
    .filter((line) =>
      /^(SESSION_SECRET|SERVICE_SECRET|CREDENTIAL_ENCRYPTION_KEY|APP_URL|SCM_ALLOWED_HOSTS|ORIGIN_APP_ID|LINEAR_CLIENT_ID|ATLASSIAN_CLIENT_|GITHUB_|LLM_|EMBEDDING_|OSV_)/.test(line) ||
      billing(line),
    )
    .join("\n") + "\n";
await writeFile(".env.backend", backendEnv, { mode: 0o600 });
await chmod(".env.backend", 0o600);
const convexEnvSet = (...args: string[]) => execFileSync(
  "pnpm",
  ["exec", "convex", "env", "set", ...args],
  { stdio: "inherit", env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" } },
);
// A new sandbox or webhook secret replaces the billing settings the backend has. Without --force, convex refuses
// the whole batch when any value differs, which is what every other setting keeps.
const billingEnv = env.split("\n").filter(billing);
if (billingEnv.length) {
  await writeFile(".env.backend.billing", billingEnv.join("\n") + "\n", { mode: 0o600 });
  await chmod(".env.backend.billing", 0o600);
  try { convexEnvSet("--force", "--from-file", ".env.backend.billing"); }
  finally { await rm(".env.backend.billing", { force: true }); }
}
convexEnvSet("--from-file", ".env.backend");
console.log(
  "Local secrets created and backend environment synchronized. No secret values were printed.",
);
