import { parseArgs } from "node:util";
import { auditActions, formatCiAudit } from "../src/ci-audit";
import { fetchActionsHistory, GithubAuditError } from "../src/ci-audit-github";

// pnpm ci:audit owner/repo [--days 30] [--max-job-runs 600] [--json]
// Read-only: lists GitHub Actions runs, jobs and workflow files and prints where the minutes go.
// Uses GITHUB_TOKEN or GH_TOKEN when set (needed for private repositories and for busy public ones).
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { days: { type: "string", default: "30" }, "max-job-runs": { type: "string" }, json: { type: "boolean", default: false }, help: { type: "boolean", default: false } },
});
const repository = positionals[0];
if (values.help || !repository) {
  console.log("Usage: pnpm ci:audit owner/repo [--days 30] [--max-job-runs 600] [--json]\nSet GITHUB_TOKEN (Actions: read, Contents: read) for private or busy repositories.");
  process.exit(repository ? 0 : 1);
}
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
if (!token) console.error("No GITHUB_TOKEN set: using GitHub's anonymous limit (60 requests an hour), so job minutes are sampled lightly.");
try {
  const history = await fetchActionsHistory({
    repository, token, days: Number(values.days),
    ...(values["max-job-runs"] ? { maxJobRuns: Number(values["max-job-runs"]) } : {}),
    onProgress: (m) => { if (!values.json) console.error(m); },
  });
  const audit = auditActions(history);
  console.log(values.json ? JSON.stringify(audit, null, 2) : formatCiAudit(audit));
} catch (error) {
  console.error(error instanceof GithubAuditError ? `CI audit failed: ${error.message}` : error);
  process.exit(1);
}
