import { after } from "next/server";
import { verifyWebhook } from "../../../../src/github";

type SentryIssue = { shortId?: string; title?: string; culprit?: string; level?: string; web_url?: string; project?: { slug?: string } };

// Sentry internal integration (issue webhooks) → a Claude Code scheduled task's API trigger, so each new
// issue starts a triage run. Off (404) until all three variables are set; see docs/observability.md.
export async function POST(request: Request) {
  const secret = process.env.SENTRY_WEBHOOK_SECRET, fireUrl = process.env.CLAUDE_ROUTINE_FIRE_URL, token = process.env.CLAUDE_ROUTINE_TOKEN;
  if (!secret || !fireUrl || !token) return new Response("Not found", { status: 404 });
  const body = await request.text();
  // Sentry signs with the same HMAC-SHA256 hex digest as GitHub, just without the "sha256=" prefix.
  if (!verifyWebhook(body, `sha256=${request.headers.get("sentry-hook-signature")}`, secret)) return new Response("Invalid signature", { status: 401 });
  const { action, data } = JSON.parse(body) as { action?: string; data?: { issue?: SentryIssue } };
  const issue = data?.issue, project = process.env.SENTRY_PROJECT;
  if (request.headers.get("sentry-hook-resource") !== "issue" || action !== "created" || !issue || (project && issue.project?.slug !== project))
    return new Response(null, { status: 204 });
  const text = `New Sentry issue ${issue.shortId} in ${issue.project?.slug}: ${issue.title}\nCulprit: ${issue.culprit}\nLevel: ${issue.level}\n${issue.web_url}`;
  // Sentry gives up on a webhook after a second; starting the run can take longer, so it goes after the reply.
  after(async () => {
    const response = await fetch(fireUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!response.ok) console.error(`Claude Code routine fire failed: ${response.status} ${await response.text()}`);
  });
  return new Response("Accepted", { status: 202 });
}
