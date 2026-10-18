import type { MetadataRoute } from "next";
import { docPages } from "../src/docs-manifest";
import { userJotConfig } from "../src/userjot";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
  return [{ url: `${origin}/` }, { url: `${origin}/changelog` }, ...(userJotConfig() ? [{ url: `${origin}/feedback` }, { url: `${origin}/feedback/roadmap` }] : []), { url: `${origin}/privacy` }, { url: `${origin}/terms` }, { url: `${origin}/security` }, ...docPages.map((d) => ({ url: `${origin}/docs/${d.slug}` }))];
}
