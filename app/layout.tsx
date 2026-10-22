import type { Metadata } from "next";
import { headers } from "next/headers";
import {siteDescription as description} from "../src/structured-data";
import {themeScript} from "../src/theme";
import {ThemeProvider} from "./theme";
import {ConsentBanner} from "./consent";
import {AdsPageViews} from "./ads-page-views";
import {UserJot} from "./userjot";
import {userJotConfig} from "../src/userjot";
// Fonts are bundled from npm so builds never fetch them: Inter for UI, JetBrains Mono for code
// and metadata, EB Garamond for editorial subheads, DM Sans and Space Mono for the Pull Requests
// tab's Greptile look (browsers download a font file only where a page uses it).
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/dm-sans";
import "@fontsource/space-mono/400.css";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/500.css";
import "./globals.css";
export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
  title: { default: "OpenReview: repository-aware pull request reviews", template: "%s · OpenReview" },
  description,
  openGraph: { type: "website", siteName: "OpenReview", title: "OpenReview", description },
  twitter: { card: "summary_large_image", title: "OpenReview", description },
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The theme is applied in the browser from its cookie (src/theme.ts), so this layout reads no
  // cookies. The script sets data-theme, which the server never renders. It runs under the request's
  // CSP nonce from middleware.ts; reading it renders every page per request, which nonces require.
  // Browsers hide nonce attributes from the DOM, hence suppressHydrationWarning on the script.
  const nonce=(await headers()).get("x-nonce")??undefined;
  const userJot=userJotConfig();
  return (
    <html lang="en" suppressHydrationWarning data-userjot={userJot ? "" : undefined}>
      <head><script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{__html:themeScript}} /></head>
      <body><ThemeProvider>{children}<ConsentBanner /><AdsPageViews />{userJot&&<UserJot projectId={userJot.projectId} boardUrl={userJot.boardUrl} />}</ThemeProvider></body>
    </html>
  );
}
