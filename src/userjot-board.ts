// URL helpers for the UserJot board embedded at /feedback (app/userjot.tsx). Kept apart from
// src/userjot.ts, which signs tokens on the server, so client components can import them.

/** Which part of the board a path shows: the roadmap, the rest of the board, or neither. */
export function boardView(pathname: string): "roadmap" | "feedback" | null {
  if (/^\/feedback\/roadmap(\/|$)/.test(pathname)) return "roadmap";
  return /^\/feedback(\/|$)/.test(pathname) ? "feedback" : null;
}

/** The page title for a board path, before the layout's " · OpenReview" suffix. */
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
