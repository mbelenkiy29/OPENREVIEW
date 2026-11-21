import type { Metadata } from "next";
import { pageSocialTitle, socialMeta } from "../../src/structured-data";
import { LegalPage } from "../legal";

const description = "The terms for using the hosted OpenReview service.";
export const metadata: Metadata = { title: "Terms of Service", description, alternates: { canonical: "/terms" }, ...socialMeta(pageSocialTitle("Terms of Service"), description) };
export default function Terms() {
  return <LegalPage name="terms" />;
}
