import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { comparePage, comparePages, compareSlugs, compareStaticParams } from "../src/compare-pages";
import { compareSocialTitle, pageSocialTitle, siteName, socialTitle } from "../src/structured-data";
import sitemap from "../app/sitemap";
import { metadata as pricingMetadata } from "../app/pricing/page";
import ComparePage, { generateMetadata, generateStaticParams } from "../app/compare/[slug]/page";
import Pricing from "../app/pricing/page";
import { accountCta } from "../app/site-chrome";

const isNotFound = (error: unknown) => typeof error === "object" && error !== null && "digest" in error && String((error as { digest?: string }).digest).includes("404");

test("compare slugs are greptile and coderabbit, and unknown slugs are absent", () => {
  assert.deepEqual([...compareSlugs].sort(), ["coderabbit", "greptile"]);
  assert.deepEqual(compareStaticParams().map((p) => p.slug).sort(), ["coderabbit", "greptile"]);
  assert.deepEqual(generateStaticParams().map((p) => p.slug).sort(), ["coderabbit", "greptile"]);
  assert.equal(comparePage("greptile")?.file, "docs/compare/greptile.md");
  assert.equal(comparePage("coderabbit")?.file, "docs/compare/coderabbit.md");
  assert.equal(comparePage("not-a-competitor"), undefined);
  assert.equal(comparePage("toString"), undefined);
  assert.equal(comparePage("__proto__"), undefined);
  for (const slug of compareSlugs) assert.ok(existsSync(comparePages[slug].file), comparePages[slug].file);
});

test("compare pages render their markdown with canonical and social titles; unknown slugs 404", async () => {
  for (const slug of compareSlugs) {
    const page = comparePages[slug];
    const tree = await ComparePage({ params: Promise.resolve({ slug }) });
    assert.equal(tree.type, "div");
    const meta = await generateMetadata({ params: Promise.resolve({ slug }) });
    assert.equal(meta.title, page.title);
    assert.equal(meta.description, page.description);
    assert.equal(meta.alternates?.canonical, `/compare/${slug}`);
    assert.equal(meta.openGraph?.title, compareSocialTitle(page.competitor));
    assert.equal(meta.twitter?.title, compareSocialTitle(page.competitor));
    assert.equal(meta.openGraph?.siteName, siteName);
  }
  await assert.rejects(() => ComparePage({ params: Promise.resolve({ slug: "not-a-competitor" }) }), isNotFound);
  await assert.rejects(() => ComparePage({ params: Promise.resolve({ slug: "toString" }) }), isNotFound);
  await assert.rejects(() => ComparePage({ params: Promise.resolve({ slug: "__proto__" }) }), isNotFound);
  const empty = await generateMetadata({ params: Promise.resolve({ slug: "not-a-competitor" }) });
  assert.deepEqual(empty, {});
});

test("the pricing page renders and names OpenReview.tech in social titles", () => {
  const tree = Pricing();
  assert.equal(tree.type, "div");
  assert.equal(pricingMetadata.alternates?.canonical, "/pricing");
  assert.equal(pricingMetadata.openGraph?.title, pageSocialTitle("pricing"));
  assert.equal(pricingMetadata.twitter?.title, pageSocialTitle("pricing"));
  assert.equal(pricingMetadata.openGraph?.siteName, siteName);
  assert.match(String(pricingMetadata.description), /Starter and Pro/);
  assert.doesNotMatch(String(pricingMetadata.description), /Enterprise/);
});

test("root metadata sets og:title, twitter:title and og:site_name to OpenReview.tech", () => {
  const layout = readFileSync("app/layout.tsx", "utf8");
  assert.match(layout, /title: socialTitle/);
  assert.match(layout, /openGraph: \{ type: "website", siteName, title: socialTitle/);
  assert.match(layout, /twitter: \{ card: "summary_large_image", title: socialTitle/);
  assert.equal(socialTitle, "OpenReview.tech: open-source AI code review");
  assert.equal(siteName, "OpenReview.tech");
});

test("the sitemap lists compare pages and pricing", () => {
  const urls = sitemap().map((entry) => new URL(entry.url).pathname);
  for (const path of ["/pricing", "/compare/greptile", "/compare/coderabbit"]) assert.ok(urls.includes(path), path);
});

test("unknown compare slugs are not statically generated", () => {
  const source = readFileSync("app/compare/[slug]/page.tsx", "utf8");
  assert.match(source, /export const dynamicParams = false/);
  assert.match(source, /if \(!page\) notFound\(\)/);
});

test("hero, pricing cards and FAQ match the cardless Starter trial", () => {
  const home = readFileSync("app/page.tsx", "utf8");
  const cards = readFileSync("app/pricing-cards.tsx", "utf8");
  const signup = readFileSync("app/auth-screen.tsx", "utf8");
  assert.match(home, /Starter trial, no credit card/);
  assert.match(home, /Pro collects a card at checkout/);
  assert.match(home, /href="\/pricing">See pricing/);
  assert.doesNotMatch(home, /href="#pricing"/);
  assert.match(home, /Do I need a credit card\?/);
  assert.doesNotMatch(home, /Cancel anytime/);
  assert.doesNotMatch(cards, /days free/);
  assert.match(cards, /no credit card/);
  assert.match(cards, /Checkout collects a card/);
  assert.match(signup, /trial with no credit card/);
  assert.match(signup, /Pro collects a card at checkout/);
});

test("the footer links to compare pages and /pricing", () => {
  const chrome = readFileSync("app/site-chrome.tsx", "utf8");
  assert.match(chrome, /\/compare\/greptile/);
  assert.match(chrome, /\/compare\/coderabbit/);
  assert.match(chrome, /href="\/pricing"/);
});

test("logged-out public headers show Sign in; a valid session shows Dashboard", () => {
  assert.deepEqual(accountCta(false), { href: "/login", label: "Sign in" });
  assert.deepEqual(accountCta(true), { href: "/dashboard", label: "Dashboard" });
  const chrome = readFileSync("app/site-chrome.tsx", "utf8");
  assert.match(chrome, /sessionJwtValid/);
  assert.match(chrome, /accountCta\(/);
  assert.doesNotMatch(chrome, /home \?\s*<Link className="site-account"/);
  assert.doesNotMatch(chrome, /home \? <Link href="\/login">Sign in<\/Link>/);
});

test("compare pages last-checked date and Starter trial copy", () => {
  for (const slug of compareSlugs) {
    const markdown = readFileSync(comparePages[slug].file, "utf8");
    assert.match(markdown, /Last checked Nov 20, 2026/);
    assert.match(markdown, /14-day Starter trial, no card; Pro collects a card at checkout/);
    assert.doesNotMatch(markdown, /14-day trial(?!.*Starter)/);
  }
});

test("compare pages cite /pricing as the OpenReview pricing source", () => {
  for (const slug of compareSlugs) {
    const markdown = readFileSync(comparePages[slug].file, "utf8");
    assert.match(markdown, /OpenReview pricing and demo: https:\/\/openreview\.tech\/pricing/);
  }
});
