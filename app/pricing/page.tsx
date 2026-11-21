import type { Metadata } from "next";
import { pageSocialTitle, socialMeta } from "../../src/structured-data";
import { PricingSection } from "../pricing-cards";
import { SiteFooter, SiteHeader } from "../site-chrome";

const title = pageSocialTitle("pricing");
const description = "Starter, Pro and Enterprise plans for hosted OpenReview. The 14-day Starter trial needs no credit card; Pro collects a card at checkout.";

export const metadata: Metadata = {
  title: "Pricing",
  description,
  alternates: { canonical: "/pricing" },
  ...socialMeta(title, description),
};

export default function Pricing() {
  return <div className="landing">
    <SiteHeader current="pricing" />
    <main id="main">
      <PricingSection heading="h1" />
    </main>
    <SiteFooter />
  </div>;
}
