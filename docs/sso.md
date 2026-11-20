# Single sign-on (SAML 2.0 and OpenID Connect)

Each workspace can connect one identity provider under **Organization Settings → People → Single sign-on**. Only workspace owners and admins can change it, and every change is recorded in the audit log.

## Set up

1. **Choose the protocol and enter the IdP details.**
   - **SAML 2.0:** the IdP's HTTPS sign-in URL (HTTP-Redirect binding) and its signing certificate (PEM). The IdP entity ID is optional.
     - In the IdP, register OpenReview with entity ID `https://<openreview>/api/sso/saml/<connection id>` and ACS URL `https://<openreview>/api/sso/saml/<connection id>/acs` (HTTP-POST). The panel shows both, and the entity ID URL also serves this service provider's metadata.
     - Send the user's email as the `NameID` (email format) or as an `email` / `mail` attribute.
     - Assertions must be signed.
   - **OpenID Connect:** the HTTPS issuer (discovery is used), a client ID and a client secret. Register `https://<openreview>/api/sso/oidc/callback` as the redirect URI.
     - The client secret is encrypted with `CREDENTIAL_ENCRYPTION_KEY` before it is stored.
2. **Prove each email domain.** Add the domain, publish the TXT record shown (`_openreview-challenge.<domain>` = `openreview-domain-verification=<token>`) at your DNS provider, then select **Check DNS**.
   - Only one workspace can verify a domain.
   - Until a domain is verified, SSO sign-ins still work, but the email they carry is not trusted for account linking.
3. **Optional: just-in-time membership.** New people whose email is on a verified domain join the workspace as members or viewers the first time they sign in. Otherwise they need an invitation.
4. **Optional: require SSO.** This needs an active connection and a verified domain.
   - Members, admins and viewers must then use a session started through this workspace's SSO.
   - Owners keep their other sign-in methods, so a broken IdP cannot lock the workspace out.
   - API keys are unaffected.
   - Turning the connection off also turns the requirement off.

People sign in from the landing page with **Use single sign-on**. Their email domain selects the workspace's connection.

## Security

- **SAML** (`@node-saml/node-saml`):
  - The assertion must be signed by the configured key.
  - It must name this service provider as its audience, and be within its `NotBefore`/`NotOnOrAfter` window (one minute of clock skew).
  - It must answer an authentication request OpenReview issued. Request IDs are single-use and expire after 10 minutes.
  - Each assertion ID is accepted once, so a captured response cannot be replayed.
- **OIDC** (`openid-client`):
  - The authorization code flow uses PKCE (S256), state and nonce.
  - The ID token's signature is always checked against the issuer's keys, together with its issuer, audience and expiry.
  - Discovery, key and token requests may only reach public addresses, since the issuer is entered by a workspace owner. A self-hosted operator whose IdP is on an internal network sets `SSO_ALLOW_PRIVATE=true` on the web server.
- **Account linking** follows the same rule as other sign-in methods: an identity joins an existing account only when both carry the same verified email.
  - An email asserted by an IdP counts as verified only on a domain this workspace proved with DNS.
  - For OIDC, it must also not be marked `email_verified: false`.
  - An IdP therefore cannot take over accounts at other domains.
- **Changing the identity provider** (protocol, SAML sign-in URL, signing certificate or entity ID, OIDC issuer or client ID) unverifies every domain with a new TXT token, turns the SSO requirement off and forgets every SSO sign-in made through the old IdP (people sign in again and relink by verified email). SSO sign-in pauses until a domain is verified again, so an admin cannot point the connection at an IdP they control and sign in as existing users. Rotating the OIDC client secret is not an IdP change and keeps domains, enforcement and SSO sign-ins. Rotating the SAML signing certificate is an IdP change, because its key can sign any assertion, so it requires re-verifying every domain's DNS record: plan certificate rollovers for that.

## SCIM provisioning (Enterprise)

With SCIM your identity provider creates, deactivates and groups people, and the workspace's members follow. It is on the Enterprise plan (`auth.scim`) and on self-hosted installs.

**Set it up:** a workspace admin opens Organization Settings → Organization → SCIM provisioning and creates a token. It is shown once and stored only as a hash. Give the identity provider:
- **Base URL:** `https://<your OpenReview host>/api/scim/v2`
- **Authentication:** the token as a bearer token.

**What is supported:** SCIM 2.0 `/Users` and `/Groups`: list (with `userName eq "…"` or `displayName eq "…"` and paging), read, create, replace, patch and delete. Attributes OpenReview does not use are ignored. There is no `/Bulk`, `/Schemas` or `/ServiceProviderConfig` endpoint.

**How people are matched:** `userName` must be the person's email address. Someone who already has an OpenReview account with that verified email becomes a member at once. Someone who does not joins at their first SSO sign-in.

**Rules:**
- **Deactivating or deleting a user** removes them from the workspace and signs them out everywhere, and revokes their API keys for the workspace.
- **Groups and roles:** an admin maps a provisioned group to Admin, Member or Viewer. Someone in several mapped groups gets the role with the most access. Once any group is mapped, someone in none of the mapped groups is a Member.
- **Owners:** SCIM never makes anyone an owner and never changes an owner's role. The last owner cannot be deprovisioned (the request gets `409`).
- **Billing:** Enterprise bills active contributors, counted from pull requests, so provisioning never changes an invoice.
- **Limits:** 600 requests a minute per workspace; past that the answer is `429`.

Not tested against a live identity provider yet. The request shapes follow RFC 7643 and 7644, including Microsoft Entra ID's string booleans (`"False"`).
