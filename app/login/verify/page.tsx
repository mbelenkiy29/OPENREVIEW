import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthChrome } from "../../auth-chrome";
import { safeNext } from "../../../src/identity";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

const valid = (token: string) => /^[A-Za-z0-9_-]{40,64}$/.test(token);

/** Click-to-confirm for a magic link. GET never consumes the token; the form POSTs to the same
 *  route the email pointed at. Mail scanners that prefetch the link stop here. */
export default async function Verify({ searchParams }: { searchParams: Promise<{ token?: string; next?: string }> }) {
  const query = await searchParams, token = query.token ?? "";
  if (!valid(token)) redirect("/login?error=signin");
  const next = safeNext(query.next);
  return <AuthChrome title="Sign in to OpenReview">
    <p className="auth-note">Click below to finish signing in. Opening the email link alone does not start a session.</p>
    <div className="sign-in-options">
      <form method="post" action="/api/auth/email/verify" className="sign-in-form">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="next" value={next} />
        <button className="primary">Sign in</button>
      </form>
    </div>
  </AuthChrome>;
}
