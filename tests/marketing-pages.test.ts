import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { comparePage, comparePages, compareSlugs, compareStaticParams } from "../src/compare-pages";
import { compareSocialTitle, pageSocialTitle, siteName, socialTitle } from "../src/structured-data";
import sitemap from "../app/sitemap";
import { metadata as pricingMetadata } from "../app/pricing/page";
import ComparePage, { generateMetadata, generateStaticParams } from "../app/compare/[slug]/page";
import Pricing from "../app/pricing/page";

const isNotFound = (error: unknown) => typeof error === "object" && error !== null && "digest" in error && String((error as { digest?: string }).digest).includes("404");

test("compare slugs are greptile and coderabbit, and unknown slugs are absent", () => {
  assert.deepEqual([...compareSlugs].sort(), ["coderabbit", "greptile"]);
  assert.deepEqual(compareStaticParams().map((p) => p.slug).sort(), ["coderabbit", "greptile"]);
  assert.deepEqual(generateStaticParams().map((p) => p.slug).sort(), ["coderabbit", "greptile"]);
  assert.equal(comparePage("greptile")?.file, "docs/compare/greptile.md");
  assert.equal(comparePage("coderabbit")?.file, "docs/compare/coderabbit.md");
  assert.equal(comparePage("not-a-competitor"), undefined);
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
