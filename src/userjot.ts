// UserJot feedback boards (feature requests, bug reports, roadmap) for the hosted site. Off unless
// NEXT_PUBLIC_USERJOT_PROJECT_ID is set, and off in offline mode, so self-hosted installs load nothing.
// The widget identifies signed-in users with a short-lived HS256 token signed by USERJOT_PROJECT_SECRET
// (UserJot Settings → Login → Secrets); without the secret, identification is unsigned.
import { SignJWT } from "jose";
import { egressAllowed } from "./egress";

type Env = Record<string, string | undefined>;
export type UserJotConfig = { projectId: string; boardUrl?: string; secret?: string };
/** The profile UserJot shows next to a person's posts, votes and comments. */
export type UserJotUser = { id: string; email?: string; firstName: string; avatar?: string };
export type UserJotIdentity = { token?: string; user: UserJotUser };

export function userJotConfig(env: Env = process.env): UserJotConfig | null {
  const projectId = env.NEXT_PUBLIC_USERJOT_PROJECT_ID?.trim();
  if (!projectId || !egressAllowed("feedback", env)) return null;
  return { projectId, boardUrl: env.NEXT_PUBLIC_USERJOT_URL?.trim().replace(/\/+$/, "") || undefined, secret: env.USERJOT_PROJECT_SECRET || undefined };
}

/** A UserJot identity token: HS256, at most an hour long, as UserJot's signed identity requires. */
export async function userJotToken(user: UserJotUser, { projectId, secret, now = Date.now() }: { projectId: string; secret: string; now?: number }) {
  const iat = Math.floor(now / 1000);
  return new SignJWT({ email: user.email, firstName: user.firstName, avatar: user.avatar })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuer(projectId)
    .setAudience("userjot")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(new TextEncoder().encode(secret));
}

/** What the browser passes to `uj.identify`: the user by internal id, signed when a secret is set. */
export async function userJotIdentity(me: { user: { _id: string; login: string; avatar?: string }; email?: string }, config: UserJotConfig, now?: number): Promise<UserJotIdentity> {
  const user: UserJotUser = { id: me.user._id, firstName: me.user.login, ...(me.email ? { email: me.email } : {}), ...(me.user.avatar ? { avatar: me.user.avatar } : {}) };
  return config.secret ? { token: await userJotToken(user, { projectId: config.projectId, secret: config.secret, now }), user } : { user };
}
