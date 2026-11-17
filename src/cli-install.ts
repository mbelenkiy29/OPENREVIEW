/** The publishable CLI package in `packages/cli`. It is not on the npm registry yet. */
export const cliNpmPackage = "openreview-cli";
/** Flip this after the first successful `npm publish` of packages/cli, then restore `npm install -g`. */
export const cliNpmPublished = false;
export const cliSourceRepository = "https://github.com/mbelenkiy29/OPENREVIEW.git";

/** Put `openreview` on PATH from a clone (uses `bin/openreview.mjs`, no extra build). */
export const cliLinkFromCheckout = ["pnpm install", "npm link"].join("\n");
/** Packaged binary, equivalent to what npm would ship after publish. */
export const cliBuildAndLink = ["pnpm build:cli", "npm --prefix packages/cli link"].join("\n");
/** Dashboard / docs snippet for the local agent bridge. */
export const cliBridgeInstall = `${cliLinkFromCheckout}\nopenreview bridge install`;
