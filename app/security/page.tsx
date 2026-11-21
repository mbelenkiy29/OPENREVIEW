import type { Metadata } from "next";
import { pageSocialTitle, socialMeta } from "../../src/structured-data";
import { LegalPage } from "../legal";

const description = "How the hosted OpenReview service handles your code: what is stored, what the model sees, who can access it, and how to report a vulnerability.";
export const metadata: Metadata = { title: "Security", description, alternates: { canonical: "/security" }, ...socialMeta(pageSocialTitle("Security"), description) };
export default function Security() {
  return <LegalPage name="security" />;
}
