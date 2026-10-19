# Security policy

## Reporting a vulnerability

Email **mbelenkiy29@gmail.com** with "Security" in the subject line, a minimal reproduction and the affected version or URL. This address covers the open-source project and the hosted service at openreview.tech; the same contact is published at https://openreview.tech/.well-known/security.txt, and https://openreview.tech/security describes how the hosted service handles code. For a self-hosted installation, also contact its operator.

Do not post live credentials, private repository source, or exploitable deployment details in public issues. While testing, use only your own accounts and workspaces, don't access or change other people's data, and don't run denial-of-service attacks.

## Running OpenReview securely

Operators must use HTTPS for web/backend, strong independent secrets, protected Convex administrative endpoints, trusted reverse proxies, encrypted disks/backups, and current dependency patches. Restrict inbound access and model endpoint configuration. Keep GitHub App private keys out of client environments. Rotate compromised App/model/API/session credentials promptly.

The application verifies webhook HMACs, OAuth/install state, signed session tokens, tenant membership, model response schemas, and finding evidence. API keys are stored only as hashes. Repository secrets receive defensive redaction, but pattern-based redaction cannot guarantee removal of all secrets. Limit App repository access and approve external model data processing before enabling reviews on sensitive code.

Untrusted repository code must never run on the application host. Optional runtime validation must use an isolated container with explicit limits and no application secrets. Source/model text cannot grant permissions or change system instructions.

No independent security audit has been done. Tenant isolation, webhook authentication and unsafe execution defects are especially welcome reports.
