import { build } from "esbuild";
import { copyFile, readFile, rm } from "node:fs/promises";

// Bundles src/cli.ts into packages/cli/dist/openreview.mjs for the openreview-cli npm package. The
// tree-sitter packages stay external (their WASM files are resolved from node_modules at runtime), and so
// does typescript, the local indexer's parser, which is larger than the rest of the CLI put together.
const pkg = JSON.parse(await readFile("packages/cli/package.json", "utf8")) as { version: string };
await rm("packages/cli/dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "packages/cli/dist/openreview.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["web-tree-sitter", "tree-sitter-wasms", "typescript"],
  // Bundled CommonJS dependencies call require(); ESM output has none of its own.
  banner: { js: "import { createRequire as __openreviewRequire } from 'node:module'; const require = __openreviewRequire(import.meta.url);" },
  define: { "process.env.OPENREVIEW_CLI_VERSION": JSON.stringify(pkg.version) },
  logLevel: "warning",
});
await copyFile("LICENSE", "packages/cli/LICENSE");
console.log(`Built openreview-cli ${pkg.version}: packages/cli/dist/openreview.mjs`);
