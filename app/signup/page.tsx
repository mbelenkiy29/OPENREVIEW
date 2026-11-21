import type { Metadata } from "next";
import { pageSocialTitle, socialMeta } from "../../src/structured-data";
import { AuthScreen, redirectIfSignedIn, type AuthQuery } from "../auth-screen";

export const metadata: Metadata = { title: "Create your account", alternates: { canonical: "/signup" }, ...socialMeta(pageSocialTitle("Create your account")) };

export default async function Signup({ searchParams }: { searchParams: Promise<AuthQuery> }) {
  const query = await searchParams;
  await redirectIfSignedIn(query);
  return <AuthScreen mode="signup" query={query} />;
}
