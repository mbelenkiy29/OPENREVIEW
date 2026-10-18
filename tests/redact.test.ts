import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/redact";
import { maskSecrets, scanChanges } from "../src/security-scan";

const stripe = "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const jwt = "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
// Fixtures are assembled from pieces so they never read as real credentials to secret scanners.
const awsSecret = "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYzEXAMPLEKE";

test("redaction masks provider tokens, JWTs and AWS secret keys", () => {
  const cases: [string, string][] = [
    [`stripe("${stripe}")`, 'stripe("[REDACTED TOKEN]")'],
    ["key = 'rk_live_" + "a1".repeat(12) + "'", "key = '[REDACTED TOKEN]'"],
    ["STRIPE_KEY: sk_test_" + "b2".repeat(12), "STRIPE_KEY: [REDACTED TOKEN]"],
    ["const hook = 'whsec_" + "c3".repeat(16) + "';", "const hook = '[REDACTED TOKEN]';"],
    ["slack.token = 'xo" + "xb-123456789012-1234567890123-AbCdEfGhIjKlMnOp';", "slack.token = '[REDACTED TOKEN]';"],
    ["curl -H 'Authorization: Bearer xo" + "xp-1234-5678-abcdefabcdef'", "curl -H 'Authorization: Bearer [REDACTED TOKEN]'"],
    ["gitlab(token: 'glpat-" + "x1Y2z3".repeat(4) + "')", "gitlab(token: '[REDACTED TOKEN]')"],
    ["maps?key=AIzaSyA1" + "b".repeat(31) + "&q=x", "maps?key=[REDACTED TOKEN]&q=x"],
    [`Authorization: Bearer ${jwt}`, "Authorization: Bearer [REDACTED TOKEN]"],
    [`aws_secret_access_key = ${awsSecret}`, "aws_secret_access_key = [REDACTED]"],
    [`"aws_secret_access_key": "${awsSecret}",`, '"aws_secret_access_key": "[REDACTED]",'],
    [`boto3.client("s3", aws_secret_access_key="${awsSecret}")`, 'boto3.client("s3", aws_secret_access_key="[REDACTED]")'],
    // Formats redaction already covered keep their output.
    ["token=ghp_" + "x".repeat(30), "token=[REDACTED TOKEN]"],
    ['const id = "AKIA' + 'QWERTYUIOPASDFGH";', 'const id = "[REDACTED TOKEN]";'],
  ];
  for (const [input, output] of cases) assert.equal(redact(input), output, input);
});

test("redaction masks quoted secret assignments, including JSON keys and := / =>", () => {
  const cases: [string, string][] = [
    ['    password: "hunter2-is-not-strong",', '    password: "[REDACTED]",'],
    ['{ "password": "hunter2!x", "user": "ada" }', '{ "password": "[REDACTED]", "user": "ada" }'],
    ['"client_secret": "GOCSPX-abcdefghijklmnop",', '"client_secret": "[REDACTED]",'],
    ["db_passwd = 'p4ssw0rd!'", 'db_passwd = "[REDACTED]"'],
    ['authToken := "abc123defg"', 'authToken := "[REDACTED]"'],
    ["'private_key' => 'Zm9vYmFyYmF6cXV4'", "'private_key' => \"[REDACTED]\""],
  ];
  for (const [input, output] of cases) assert.equal(redact(input), output, input);
});

test("redaction masks secret values in .env-style lines", () => {
  const cases: [string, string][] = [
    ["DB_PASSWORD=hunter2hunter2", "DB_PASSWORD=[REDACTED]"],
    ["OPENAI_API_KEY=sk-proj-abc", "OPENAI_API_KEY=[REDACTED]"],
    ["SESSION_SECRET=4f9a8b7c6d5e4f3a2b1c", "SESSION_SECRET=[REDACTED]"],
    ["SECRET_KEY_BASE=0123456789abcdef0123", "SECRET_KEY_BASE=[REDACTED]"],
    ["AWS_SECRET_ACCESS_KEY=" + awsSecret, "AWS_SECRET_ACCESS_KEY=[REDACTED]"],
    ["export GITHUB_TOKEN=abcdef123456 # local only", "export GITHUB_TOKEN=[REDACTED] # local only"],
    ['ENV NPM_TOKEN="npm_abcdefgh12345"', 'ENV NPM_TOKEN="[REDACTED]"'],
    ["      - POSTGRES_PASSWORD=s3cretvalue", "      - POSTGRES_PASSWORD=[REDACTED]"],
    // Lines inside a diff, with Windows line endings.
    ["@@ -1,2 +1,2 @@\n-SIGNING_KEY=oldvalue123\r\n+SIGNING_KEY=newvalue456\r", "@@ -1,2 +1,2 @@\n-SIGNING_KEY=[REDACTED]\r\n+SIGNING_KEY=[REDACTED]\r"],
  ];
  for (const [input, output] of cases) assert.equal(redact(input), output, input);
});

test("redaction leaves ordinary code, labels and placeholders unchanged (false-positive fixtures)", () => {
  const unchanged = [
    "const password = req.body.password;",
    "if (password === confirmPassword) return;",
    'if (secret == "abcdefgh12") deny();',
    "password: string;",
    '"password": "Password",',
    '"forgotPassword": "Forgot your password?",',
    '"newPassword": "Choose a new password",',
    '"secretName": "db-credentials",',
    '{ token: "colorPrimary500" }',
    'export const API_TOKEN_HEADER = "x-api-token";',
    'API_KEY = os.environ["API_KEY"]',
    "SECRET_KEY = get_random_secret_key()",
    "API_TOKEN = settings.API_TOKEN",
    "    password=db_password",
    "NODE_ENV=production",
    "PORT=3000",
    "PWD=/home/runner/work",
    "TOKEN_URL=https://oauth2.googleapis.com/token",
    "PASSWORD_MIN_LENGTH=12",
    "DATABASE_PASSWORD=${DB_PASSWORD}",
    "API_KEY=$OPENAI_KEY_FROM_VAULT",
    "OPENAI_API_KEY=your-openai-api-key",
    "STRIPE_SECRET_KEY=sk_test_xxx",
    "NEXT_PUBLIC_POSTHOG_KEY=phc_abcdefghijklmnop",
    "# API_KEY=documented-in-a-comment",
    'const task = "risk-assessment-for-the-new-billing-module";',
    'const header = "eyJhbGciOiJIUzI1NiJ9";',
    'const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";',
    'const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";',
    "const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';",
    "aws_secret_access_key=secret_value",
  ];
  for (const line of unchanged) assert.equal(redact(line), line, line);
});

test("redaction is idempotent and keeps line numbers", () => {
  const file = ["import x from 'y';", `const key = "${stripe}";`, "API_TOKEN=abcdef123456", '  "password": "hunter2!x",', `jwt: ${jwt}`, "done();"].join("\n");
  const once = redact(file);
  assert.equal(redact(once), once);
  assert.equal(once.split("\n").length, file.split("\n").length);
  for (const secret of [stripe, "abcdef123456", "hunter2!x", jwt]) assert.ok(!once.includes(secret), secret);
});

test("every token or secret assignment the security checks flag is masked by redaction", () => {
  const flagged = [
    'const id = "AKIA' + 'QWERTYUIOPASDFGH";',
    'TOKEN = "ghp_' + "a".repeat(36) + '"',
    'pat = "github_pat_' + "B".repeat(60) + '"',
    `stripe("${stripe}")`,
    'slack("xo' + 'xs-1234567890-abcdef")',
    'gl("glpat-' + "c".repeat(20) + '")',
    'maps("AIza' + "D".repeat(35) + '")',
    'const config = { password: "hunter2-is-not-strong" };',
    "passwd = 'abcdefghijkl'",
    'creds = { "client_secret": "abcdefghijklmnop" }',
    'auth_token: "zyxwvutsrqpo1"',
  ];
  for (const line of flagged) {
    const [finding] = scanChanges([{ path: "src/config.ts", status: "modified", patch: "@@ -0,0 +1 @@\n+" + line }]);
    assert.ok(finding && ["cloud-token", "assigned-secret"].includes(finding.symbol), line);
    const secret = /"([^"]+)"[^"]*$|'([^']+)'[^']*$/.exec(line)!.slice(1).find(Boolean)!;
    assert.ok(!redact(line).includes(secret), line);
    assert.equal(finding.evidence[0].quote, maskSecrets(line));
  }
});
