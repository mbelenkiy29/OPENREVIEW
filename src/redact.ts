// Defensive secret redaction for code, diffs and text before they are stored, sent to a model or shown
// (legal/security.md lists what it covers). It matches recognisable credential formats and values
// assigned to secret-named keys, so ordinary code passes through unchanged; it cannot catch every secret.
// Rules only ever widen: P4 baselines indexed under earlier rules are compared line by line with freshly
// redacted diffs (src/p4-shelf.ts), so narrowing a rule would make them disagree until re-indexed. Every
// rule matches within one line and so keeps line numbers intact.

// Documentation and template values that are not credentials (the security checks share it).
export const placeholder = /EXAMPLE|example|dummy|placeholder|changeme|your[_-]?|xxx+|\*{3,}|<[^>]+>|\$\{|process\.env|os\.environ|getenv/i;
// Stripe keys and webhook secrets, Slack, GitLab and Google API tokens, and JSON Web Tokens.
const providerTokens = /\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b|whsec_[A-Za-z0-9]{24,}\b|xox[abposr]-[A-Za-z0-9-]{10,}|glpat-[\w-]{20,}|AIza[\w-]{35}\b|eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,})/g;
// AWS secret access keys are 40 base64 characters, recognisable only by the name they are assigned to.
const awsSecret = /(aws_?secret_?access_?key["']?[ \t]*(?::=|=>|[:=])[ \t]*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi;
// Quoted values under secret-named keys, including quoted (JSON) keys and Go/Ruby assignment operators.
// Values with spaces, short plain words and placeholders are kept, so labels such as
// "password": "Password" in translation files stay readable.
const quotedSecret = /((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?[ \t]*(?::=|=>|[:=])[ \t]*)(["'])([^"'\s]{8,})(["'])/gi;
// .env-style lines: KEY=value (optionally export/ENV/ARG, a YAML list dash or a diff marker first) where
// the upper-case KEY ends in a secret word. No spaces around "=", which keeps code assignments out.
const envSecret = /^([ \t+-]*(?:(?:export|ENV|ARG)[ \t]+)?(?:[A-Z][A-Z0-9]*_)*(?:PASS(?:WORD|WD|PHRASE)?|SECRET|TOKEN|CREDENTIALS?|(?:API|ACCESS|SECRET|PRIVATE|ENCRYPTION|SIGNING|MASTER)_?KEY)(?:_BASE)?=)(["']?)([^\s"'`]{8,})\2(?=[ \t]*(?:#.*)?\r?$)/gm;

export function redact(content: string): string {
  return content
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED KEY]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED TOKEN]",
    )
    .replace(providerTokens, "[REDACTED TOKEN]")
    .replace(awsSecret, "$1[REDACTED]")
    .replace(
      /((?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)["'][^"'\n]{8,}["']/gi,
      '$1"[REDACTED]"',
    )
    .replace(quotedSecret, (all, key: string, _open: string, value: string) =>
      !placeholder.test(value) && (value.length >= 12 || /[^\p{L}]/u.test(value)) ? key + '"[REDACTED]"' : all)
    .replace(envSecret, (all, key: string, quote: string, value: string) =>
      !placeholder.test(value) && !/^[$%]/.test(value) ? key + quote + "[REDACTED]" + quote : all);
}
