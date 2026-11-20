import { siteDescription } from "../../src/structured-data";
import { sourceRepository } from "../site-chrome";

export const dynamic = "force-static";

// A short guide for AI agents (llmstxt.org): what the product is and where its key pages are.
const pages = [
  ["/docs/quickstart", "Quickstart", "connect a repository and get a first review"],
  ["/docs/reviews", "How reviews work", "indexing, investigation, verification and what a review posts"],
  ["/docs/configuration", "Configuration", "rules and settings in .openreview.json"],
  ["/docs/self-hosting", "Self-hosting", "run it on your own Next.js host, Convex backend and model provider"],
  ["/docs/chat", "Codebase chat", "ask questions and get cited answers"],
  ["/docs/api", "Public API", "REST API reference"],
  ["/docs/mcp", "MCP", "use OpenReview from an AI agent"],
  ["/docs/cli", "CLI", "local reviews and the agent bridge"],
  ["/changelog", "Changelog", "what changed and when"],
] as const;

export function GET() {
  const origin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : "";
  const body = [
    "# OpenReview",
    "",
    `> ${siteDescription}`,
    "",
    "OpenReview reviews pull requests using the whole repository, not only the diff. Every finding quotes the code it depends on, and nothing is posted until it has been verified. It is open source (MIT) and can be self-hosted.",
    "",
    "## Docs",
    "",
    ...pages.map(([path, title, about]) => `- [${title}](${origin}${path}): ${about}`),
    "",
    "## Source",
    "",
    `- [GitHub repository](${sourceRepository})`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
