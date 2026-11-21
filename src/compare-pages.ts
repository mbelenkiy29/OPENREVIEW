// Hosted comparison pages at /compare/<slug>, rendered from docs/compare/*.md.

export const comparePages = {
  greptile: {
    slug: "greptile",
    competitor: "Greptile",
    title: "OpenReview vs Greptile",
    description: "How OpenReview compares with Greptile on licensing, self-hosting, cloud pricing, models and code hosts.",
    file: "docs/compare/greptile.md",
  },
  coderabbit: {
    slug: "coderabbit",
    competitor: "CodeRabbit",
    title: "OpenReview vs CodeRabbit",
    description: "How OpenReview compares with CodeRabbit on licensing, self-hosting, cloud pricing, models and review surfaces.",
    file: "docs/compare/coderabbit.md",
  },
} as const;

export type CompareSlug = keyof typeof comparePages;
export const compareSlugs = Object.keys(comparePages) as CompareSlug[];
export const comparePage = (slug: string) => (slug in comparePages ? comparePages[slug as CompareSlug] : undefined);
export const compareStaticParams = () => compareSlugs.map((slug) => ({ slug }));
