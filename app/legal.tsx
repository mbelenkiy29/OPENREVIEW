import fs from "node:fs/promises";
import path from "node:path";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownTableLabels } from "../src/markdown-tables";
import { ScrollTable } from "./dashboard/scroll-table";
import { SiteFooter, SiteHeader } from "./site-chrome";

// Privacy Policy, Terms of Service and the Security page for the hosted service, read from
// legal/*.md at build time.
export async function LegalPage({ name }: { name: "privacy" | "terms" | "security" }) {
  const source = await fs.readFile(path.join(process.cwd(), "legal", `${name}.md`), "utf8");
  const labels = markdownTableLabels(source);
  let table = 0;
  return <div className="docs-layout single">
    <SiteHeader />
    <main id="main" className="docs-content review-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]} components={{
      pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
      table: ({ children }) => <ScrollTable label={labels[table++] ?? "Table"} className="table-scroll"><table>{children}</table></ScrollTable>,
    }}>{source}</Markdown></main>
    <SiteFooter />
  </div>;
}
