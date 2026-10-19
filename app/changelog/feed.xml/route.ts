import fs from "node:fs/promises";
import path from "node:path";
import { changelogFeed, parseChangelog } from "../../../src/changelog";

// Built with the site, from CHANGELOG.md.
export const dynamic = "force-static";

export async function GET() {
  const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
  const months = parseChangelog(await fs.readFile(path.join(process.cwd(), "CHANGELOG.md"), "utf8"));
  return new Response(changelogFeed(months, origin, new Date()), { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
}
