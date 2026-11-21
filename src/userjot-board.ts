// URL helpers for the UserJot board embedded at /feedback (app/userjot.tsx). Kept apart from
// src/userjot.ts, which signs tokens on the server, so client components can import them.

/** Which part of the board a path shows: the roadmap, the rest of the board, or neither. */
export function boardView(pathname: string): "roadmap" | "feedback" | null {
  if (/^\/feedback\/roadmap(\/|$)/.test(pathname)) return "roadmap";
  return /^\/feedback(\/|$)/.test(pathname) ? "feedback" : null;
}

/** Load the UserJot SDK only on the public board and the signed-in dashboard (menu buttons).
 *  Guided setup keeps a sticky footer, so the launcher stays off those pages. */
export function userJotNeeded(pathname: string) {
  if (boardView(pathname) !== null) return true;
  if (pathname === "/dashboard/onboarding" || pathname.startsWith("/dashboard/onboarding/")) return false;
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

/** The page title for a board path, before the layout's " · OpenReview.tech" suffix. */
export const boardTitle = (pathname: string) => boardView(pathname) === "roadmap" ? "Roadmap" : "Feedback";

/**
 * The URL without the `theme` parameter the embed writes into it, or null when there is none. The
 * embed prefers that parameter over the theme it is created with, so a stale one would override the
 * visitor's appearance setting.
 */
export function withoutEmbedTheme(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("theme")) return null;
  url.searchParams.delete("theme");
  return url.href;
}
