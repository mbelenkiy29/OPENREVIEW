import type { Metadata } from "next";
import { pageSocialTitle, socialMeta } from "../../src/structured-data";
import { AuthScreen, redirectIfSignedIn, type AuthQuery } from "../auth-screen";

export const metadata: Metadata = { title: "Sign in", alternates: { canonical: "/login" }, ...socialMeta(pageSocialTitle("Sign in")) };

export default async function Login({ searchParams }: { searchParams: Promise<AuthQuery> }) {
  const query = await searchParams;
  await redirectIfSignedIn(query);
  return <AuthScreen mode="login" query={query} />;
}
