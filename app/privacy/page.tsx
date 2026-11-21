import type { Metadata } from "next";
import { pageSocialTitle, socialMeta } from "../../src/structured-data";
import { LegalPage } from "../legal";

const description = "What the hosted OpenReview service collects, how it is used and shared, and your choices.";
export const metadata: Metadata = { title: "Privacy Policy", description, alternates: { canonical: "/privacy" }, ...socialMeta(pageSocialTitle("Privacy Policy"), description) };
export default function Privacy() {
  return <LegalPage name="privacy" />;
}
