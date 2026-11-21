import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { comparePage, compareStaticParams } from "../../../src/compare-pages";
import { resolveDocLink } from "../../../src/docs-manifest";
import { markdownTableLabels } from "../../../src/markdown-tables";
import { compareSocialTitle, socialMeta } from "../../../src/structured-data";
import { ScrollTable } from "../../dashboard/scroll-table";
import { SiteFooter, SiteHeader } from "../../site-chrome";

export const dynamicParams = false;
export function generateStaticParams() { return compareStaticParams(); }

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const page = comparePage((await params).slug);
  if (!page) return {};
  const title = compareSocialTitle(page.competitor);
  return { title: page.title, description: page.description, alternates: { canonical: `/compare/${page.slug}` }, ...socialMeta(title, page.description) };
}

export default async function ComparePage({ params }: { params: Promise<{ slug: string }> }) {
  const page = comparePage((await params).slug);
  if (!page) notFound();
  const source = await fs.readFile(path.join(process.cwd(), "docs", "compare", `${page.slug}.md`), "utf8");
  const labels = markdownTableLabels(source);
  let table = 0;
  return <div className="docs-layout single">
    <SiteHeader />
    <main id="main" className="docs-content review-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]} components={{
      a: ({ href, children }) => {
        const link = resolveDocLink(`compare/${page.slug}.md`, href ?? "");
        return link.kind === "external" ? <a href={link.url} target="_blank" rel="noopener noreferrer">{children}</a>
          : link.kind === "text" || !link.url ? <span>{children}</span>
          : <Link href={link.url}>{children}</Link>;
      },
      pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
      table: ({ children }) => <ScrollTable label={labels[table++] ?? "Table"} className="table-scroll"><table>{children}</table></ScrollTable>,
    }}>{source}</Markdown></main>
    <SiteFooter />
  </div>;
}
