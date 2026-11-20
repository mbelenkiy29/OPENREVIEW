// Enterprise billing counts active contributors: distinct authors of pull requests with a completed review in a
// UTC month (docs/roadmap/enterprise-plan.md, E1.1). The count is the invoice, so the rules live here as pure functions.

/** Automation accounts never count: GitHub Apps ("name[bot]"), GitLab project and group access-token users
 *  ("project_<id>_bot_<random>", "group_<id>_bot_<random>"), and logins the contract lists as not billable. */
export const isBotAuthor = (login: string, nonBillableAuthors: string[] = []) => {
  const l = login.trim().toLowerCase();
  return l.endsWith("[bot]") || /^(project|group)_\d+_bot/.test(l) || nonBillableAuthors.some((a) => a.trim().toLowerCase() === l);
};

/** One key per person. An author linked to an OpenReview user is that user on every provider; an unlinked author is
 *  one key per provider connection, so the same person on two unlinked providers counts twice until they link them.
 *  null when the review has no author. */
export function contributorKey(a: { provider: string; connectionId?: string; login?: string | null; userId?: string }): string | null {
  const login = a.login?.trim().toLowerCase();
  if (!login) return null;
  return a.userId ? `user:${a.userId}` : `${a.provider}:${a.connectionId ?? "github"}:${login}`;
}
