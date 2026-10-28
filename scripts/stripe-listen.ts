import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
// Forwards Stripe sandbox webhooks to this checkout's local backend: a worktree with its own backend names it
// in its own .env.local. The events are the ones docs/billing.md lists for the production endpoint.
const site = parseEnv(await readFile(".env.local", "utf8").catch(() => "")).NEXT_PUBLIC_CONVEX_SITE_URL;
if (!site) throw new Error("Set NEXT_PUBLIC_CONVEX_SITE_URL in .env.local (the local backend's HTTP actions URL, http://127.0.0.1:3211 by default)");
const events = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.updated", "invoice.payment_failed", "invoice.paid", "charge.refunded", "charge.dispute.created", "charge.dispute.closed"];
process.exitCode = spawnSync("stripe", ["listen", "--forward-to", new URL("/stripe/webhook", site).href, "--events", events.join(",")], { stdio: "inherit" }).status ?? 1;
