// "What's new" announcements, newest first. Each opens once per person in the dashboard; closing it
// records its id on the user (convex/announcements.ts), so adding an entry here announces it once more.
export type Announcement = {
  id: string;
  title: string;
  summary: string;
  points: string[];
  /** Self-hosted under public/, so the CSP (media-src 'self') needs no change. */
  video: string;
  poster: string;
  links: { label: string; href: string }[];
};

export const announcements: Announcement[] = [
  {
    id: "2026-10-issues-autofix",
    title: "New: Issues and Autofix",
    summary: "Every problem OpenReview finds is now a ticket, and its fix agent can open the fix pull request for you.",
    points: [
      "Issues: one ticket per problem across pull requests, with a status, an assignee and an activity log.",
      "Security problems are tagged, and a merged pull request marks an open issue so nothing slips into main unnoticed.",
      "Autofix: when a review finishes, the fix agent opens fix pull requests for critical and high findings.",
    ],
    video: "/whats-new/issues-autofix.mp4",
    poster: "/whats-new/issues-autofix.jpg",
    links: [
      { label: "Open Issues", href: "/dashboard/analytics/issues" },
      { label: "Turn on Autofix", href: "/dashboard/code-review#rs-autofix" },
      { label: "Read the docs", href: "/docs/issues-and-autofix" },
    ],
  },
];

/** The newest announcement this person has not closed yet, if any. */
export const currentAnnouncement = (dismissed: readonly string[] = []) => announcements.find((a) => !dismissed.includes(a.id));
