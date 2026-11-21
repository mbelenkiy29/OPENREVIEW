import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { comparePages } from "../src/compare-pages";
import { compareSocialTitle, pageSocialTitle, siteName, socialTitle } from "../src/structured-data";

// After `next build`, fetch the marketing routes on a local production server. Confirms
// /compare/greptile, /compare/coderabbit and /pricing return 200, an unknown compare slug 404s,
// and og:title / twitter:title name OpenReview.tech. Set SMOKE_URL to reuse an already-running
// localhost server; otherwise this script starts `next start` on SMOKE_PORT (default 3999).
const required = ["/compare/greptile", "/compare/coderabbit", "/pricing"] as const;
const missingSlug = "/compare/not-a-competitor";
let failures = 0;
const fail = (message: string) => { failures++; console.error(message); };

const attr = (html: string, kind: "property" | "name", key: string) =>
  html.match(new RegExp(`${kind}="${key}"[^>]*content="([^"]+)"`))?.[1]
  ?? html.match(new RegExp(`content="([^"]+)"[^>]*${kind}="${key}"`))?.[1];

const expectedTitle = (route: string) => {
  if (route === "/") return socialTitle;
  if (route === "/pricing") return pageSocialTitle("pricing");
  const slug = route.slice("/compare/".length);
  return slug in comparePages ? compareSocialTitle(comparePages[slug as keyof typeof comparePages].competitor) : socialTitle;
};

async function waitFor(origin: string) {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(origin + "/", { redirect: "manual" })).status) return; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${origin} did not become ready`);
}

async function withOrigin(run: (origin: string) => Promise<void>) {
  const given = process.env.SMOKE_URL?.replace(/\/$/, "");
  if (given) {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(given)) throw new Error("Marketing smoke fetches only localhost");
    await run(given);
    return;
  }
  const port = Number(process.env.SMOKE_PORT ?? 3999);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn("pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, APP_URL: origin, PORT: String(port) },
  });
  const stop = () => { try { child.kill("SIGTERM"); } catch { /* already exited */ } };
  process.on("exit", stop);
  try {
    await waitFor(origin);
    await run(origin);
  } finally {
    stop();
    await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 2000))]);
  }
}

const manifestPath = ".next/app-path-routes-manifest.json";
if (!existsSync(manifestPath)) throw new Error("Run pnpm build before scripts/marketing-smoke.ts");
const pages = Object.values(JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, string>);
if (!pages.includes("/pricing")) fail("app-path-routes-manifest missing /pricing");
if (!pages.includes("/compare/[slug]")) fail("app-path-routes-manifest missing /compare/[slug]");

await withOrigin(async (origin) => {
  for (const route of ["/", ...required]) {
    const response = await fetch(origin + route, { redirect: "manual" });
    const html = await response.text();
    if (response.status !== 200) fail(`${route} returned ${response.status}, expected 200`);
    const og = attr(html, "property", "og:title");
    const twitter = attr(html, "name", "twitter:title");
    const site = attr(html, "property", "og:site_name");
    const expected = expectedTitle(route);
    if (og !== expected) fail(`${route} og:title ${JSON.stringify(og)}, expected ${expected}`);
    if (twitter !== expected) fail(`${route} twitter:title ${JSON.stringify(twitter)}, expected ${expected}`);
    if (site !== siteName) fail(`${route} og:site_name ${JSON.stringify(site)}, expected ${siteName}`);
    console.log(`${String(response.status).padEnd(4)} ${route.padEnd(24)} ${og}`);
  }
  const missing = await fetch(origin + missingSlug, { redirect: "manual" });
  if (missing.status !== 404) fail(`${missingSlug} returned ${missing.status}, expected 404`);
  console.log(`${String(missing.status).padEnd(4)} ${missingSlug}`);
});

if (failures) {
  console.error(`FAILURES ${failures}`);
  process.exitCode = 1;
} else console.log("marketing routes ok");
