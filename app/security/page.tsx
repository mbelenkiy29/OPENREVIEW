import type { Metadata } from "next";
import { LegalPage } from "../legal";

export const metadata: Metadata = { title: "Security", description: "How the hosted OpenReview service handles your code: what is stored, what the model sees, who can access it, and how to report a vulnerability.", alternates: { canonical: "/security" } };
export default function Security() {
  return <LegalPage name="security" />;
}
