import { NextResponse } from "next/server";
import { api } from "../../../../convex/_generated/api";
import { auditActions } from "../../../../src/ci-audit";
import { fetchActionsHistory, GithubAuditError, parseRepository } from "../../../../src/ci-audit-github";
import { clientIp, ipBucket } from "../../../../src/client-ip";
import { limitKey } from "../../../../src/limit-key";
import { backend } from "../../../../src/server";

// The /ci page's live check: a 30-day CI audit of one public GitHub repository, read with the operator's
// CI_AUDIT_GITHUB_TOKEN (a token that can read public repositories only). Private repositories are refused
// even if the token could read them. Answers are cached by the CDN for six hours per repository, and
// uncached checks are rate-limited (convex/ciAudit.ts).
export const maxDuration = 60;

const fail = (status: number, error: string) => NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  const token = process.env.CI_AUDIT_GITHUB_TOKEN?.trim();
  if (!token) return fail(503, "The live check is not switched on for this site.");
  const repository = parseRepository(new URL(request.url).searchParams.get("repo") ?? "")?.toLowerCase();
  if (!repository) return fail(400, "Enter a public GitHub repository as owner/name or its github.com link.");
  const ip = clientIp(request.headers), ipHash = ip ? await limitKey(ipBucket(ip)) : undefined;
  try {
    await backend().mutation(api.ciAudit.allowPublicCheck, { secret: process.env.SERVICE_SECRET ?? "", ...(ipHash ? { ipHash } : {}) });
  } catch {
    return fail(429, "Too many checks right now. Try again in an hour, or run pnpm ci:audit yourself.");
  }
  try {
    const history = await fetchActionsHistory({ repository, token, days: 30, maxJobRuns: 120, reserve: 300, maxWait: 0, publicOnly: true, deadline: Date.now() + 45000 });
    return NextResponse.json(auditActions(history), { headers: { "cache-control": "public, s-maxage=21600, stale-while-revalidate=3600" } });
  } catch (error) {
    if (error instanceof GithubAuditError) return fail(error.status === 404 ? 404 : 503, error.status === 404 ? "No public repository by that name." : "GitHub is not answering right now. Try again later.");
    console.error(JSON.stringify({ event: "ci.audit.failed", message: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    return fail(500, "The check could not finish. Try again later.");
  }
}
