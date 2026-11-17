import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("app/globals.css", "utf8");
const signIn = readFileSync("app/sign-in.tsx", "utf8");
const fixPage = readFileSync("app/fix/[reviewId]/page.tsx", "utf8");

function srgb(channel: number) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * srgb((n >> 16) & 255) + 0.7152 * srgb((n >> 8) & 255) + 0.0722 * srgb(n & 255);
}
function contrast(fg: string, bg: string) {
  const a = luminance(fg), b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

test("onboarding connect at 390px leaves room under the sticky Start indexing bar", () => {
  const at = css.indexOf("@media (max-width: 900px)");
  assert.notEqual(at, -1);
  const mobile = css.slice(css.lastIndexOf("@media (max-width: 900px)"));
  assert.match(mobile, /\.wizard \.wizard-panel \{\n\s*padding: 32px 16px 120px;/);
  assert.match(mobile, /\.wizard \.wizard-body\.centered \{\n\s*padding: 32px 16px 120px;/);
});

test("login art filename --auth-idle meets 4.5:1 on the dark tile in every auth theme", () => {
  const idles = [...css.matchAll(/--auth-idle:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1]);
  const tiles = [...css.matchAll(/--auth-tile:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1]);
  assert.equal(idles.length, 3);
  assert.equal(tiles.length, 3);
  for (let i = 0; i < idles.length; i++) {
    assert.ok(contrast(idles[i], tiles[i]) >= 4.5, `${idles[i]} on ${tiles[i]}`);
  }
});

test("a missing /fix id renders the public not-found page instead of the error boundary", () => {
  assert.match(fixPage, /import \{ notFound, redirect \} from "next\/navigation"/);
  assert.match(fixPage, /api\.reviews\.detail[\s\S]*?\.catch\(\(\)\s*=>\s*notFound\(\)\)/);
});

test("the login legal line keeps Privacy Policy with the preceding and", () => {
  assert.match(signIn, /and&nbsp;<Link href="\/privacy">Privacy Policy<\/Link>/);
  const legal = css.slice(css.indexOf(".auth .sign-in-legal a {"));
  assert.match(legal.slice(0, legal.indexOf("\n}")), /white-space: nowrap/);
});

test("home replica chart labels use --muted so they meet AA", () => {
  const block = css.slice(css.indexOf(".replica :is(.chart-y-title"));
  assert.notEqual(css.indexOf(".replica :is(.chart-y-title"), -1);
  assert.match(block.slice(0, block.indexOf("\n}")), /color: var\(--muted\)/);
});

test("dashboard tabs at 390px show a thin scrollbar instead of clipping invisibly", () => {
  const mobile = css.slice(css.indexOf("/* At 390px the eight tabs overflow."));
  assert.match(mobile, /@media \(max-width: 720px\)/);
  assert.match(mobile, /\.portal \.primary-nav \{\n\s*height: 35px;\n\s*scrollbar-width: thin;/);
  assert.match(mobile, /\.portal \.primary-nav::-webkit-scrollbar \{\n\s*display: block;/);
});
