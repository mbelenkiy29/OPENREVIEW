# GitHub App setup

Each OpenReview deployment uses its own GitHub App. Register it under GitHub **Settings → Developer settings → GitHub Apps**.

| Setting | Value |
| --- | --- |
| Homepage URL | your `APP_URL` |
| Callback URL (user authorization) | `APP_URL/api/auth/callback` |
| Setup URL | `APP_URL/api/github/callback` |
| Webhook URL | `CONVEX_SITE_URL/github/webhook` |
| Webhook secret | `GITHUB_WEBHOOK_SECRET` |
| Request user authorization (OAuth) during installation | **off**. When it is on, GitHub skips the Setup URL and the installation is not linked to a workspace. |
| Redirect on update | **on**, so changing repository access on GitHub returns to OpenReview and refreshes the repository list |

## Repository permissions

The required permissions are:
- **Contents:** read.
- **Metadata:** read.
- **Pull requests:** read and write (for review comments, the summary in the pull request description, and reactions).
- **Issues:** read (for comment webhooks).
- **Checks:** read.

Two upgrades are optional, and OpenReview skips each feature at runtime when the permission is missing:
- **Checks: read and write:** an "OpenReview" check run per review.
- **Contents: read and write:** fix pull requests, from `@openreview fix this in a new PR` or the **Open a fix PR** button on a finding's Fix page. They must also be enabled per repository. After you add the permission to the App, each installation's owner accepts it on GitHub (Settings → Applications → Installed GitHub Apps); Settings → Code providers shows which installations granted it.

## Events

Subscribe to:
- Installation and Installation repositories.
- Pull request, Pull request review, and Pull request review comment.
- Issue comment.
- Push.
- Repository.

## Credentials

1. Generate a private key and convert it to PKCS#8:

   ```sh
   openssl pkcs8 -topk8 -nocrypt -in github-key.pem -out app-key.pem
   ```

2. Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` on the backend.
3. Copy the client ID and secret to the web app too, because they are used for sign-in.

Keep the private key on server infrastructure only. Installation tokens are minted per request and never stored.

## Linking and recovery

Installs started from OpenReview link to the workspace when GitHub returns to the Setup URL, for up to 30 minutes. If the GitHub sign-in token expired meanwhile, OpenReview re-authorizes once without signing you in again.

An installation made directly on github.com, or one that did not return to OpenReview, can be linked from **Link an existing installation** (on the setup wizard, Repositories and Code providers pages). The page lists this App's installations your GitHub user can see. An installation belongs to one workspace at a time.

When GitHub suspends or uninstalls the App, OpenReview turns off the affected repositories. Unsuspending, or reinstalling and linking again, turns back on the ones that were on, and the index is refreshed.

