// Record the public sample-data demo at openreview.tech for the README GIF.
// Never signs in, never uses tokens or private data. Re-run: pnpm exec tsx scripts/demo/record.ts
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Locator, type Page } from "playwright";

const VIEW = { width: 1440, height: 900 } as const;
const FPS = 12;
const GIF_WIDTH = 860;
const GIF_MAX_BYTES = 8 * 1024 * 1024;
const SHORT_MAX_BYTES = 3 * 1024 * 1024;
const STORYBOARD_MS = 25_000;
const SHORT_START_MS = 3_500;
const SHORT_DURATION_S = 8;

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "https://openreview.tech" },
    out: { type: "string", default: "docs/images" },
    work: { type: "string", default: "output/demo" },
  },
});
const demoUrl = values.url!;
const outDir = path.resolve(values.out!);
const workDir = path.resolve(values.work!);
if (!/^https:\/\/openreview\.tech\/?$/.test(demoUrl) && process.env.DEMO_ALLOW_LOCAL !== "1")
  throw new Error("Refusing to record a URL that is not the public demo (set DEMO_ALLOW_LOCAL=1 to override).");

const skipped: string[] = [];
const log = (message: string) => console.error(message);

const HUD = `
  html.or-recording, html.or-recording * { cursor: none !important; }
  #or-demo-backdrop {
    position: fixed; inset: 0; z-index: 2147483000;
    background: #f7f7f4; pointer-events: none;
  }
  figure.replica[data-or-focus] {
    position: fixed !important;
    inset: 18px 32px 108px !important;
    z-index: 2147483001;
    margin: 0 !important;
    width: auto !important;
    max-width: none !important;
    transform: none !important;
    background: var(--bg, #f7f7f4);
  }
  figure.replica[data-or-focus] .replica-screen.tall,
  figure.replica[data-or-focus] .replica-screen.short {
    height: 100% !important;
    max-height: none !important;
  }
  #or-demo-cursor {
    position: fixed; top: 0; left: 0; z-index: 2147483645;
    width: 22px; height: 22px; margin: -3px 0 0 -3px;
    border: 2px solid #c03c00; border-radius: 50%;
    background: rgba(245, 78, 0, 0.38);
    box-shadow: 0 1px 8px rgba(0,0,0,0.28);
    pointer-events: none;
  }
  #or-demo-cursor.or-down { transform: scale(0.82); background: rgba(245, 78, 0, 0.6); }
  #or-demo-badge {
    position: fixed; top: 18px; right: 18px; z-index: 2147483647;
    padding: 7px 11px; border-radius: 4px;
    background: #26251e; color: #f7f7f4;
    font: 650 12px/1 "Inter Variable", Inter, system-ui, sans-serif;
    letter-spacing: 0.08em; text-transform: uppercase;
    pointer-events: none;
  }
  #or-demo-caption {
    position: fixed; left: 50%; bottom: 22px; z-index: 2147483647;
    transform: translateX(-50%);
    max-width: min(1180px, calc(100vw - 48px));
    padding: 14px 28px; border-radius: 8px;
    background: #14120b; color: #f7f7f4;
    font: 650 36px/1.25 "Inter Variable", Inter, system-ui, sans-serif;
    letter-spacing: -0.02em; text-align: center;
    box-shadow: 0 14px 36px rgba(0,0,0,0.28);
    pointer-events: none;
  }
  #or-demo-caption:empty { display: none; }
  #or-demo-end {
    position: fixed; inset: 0; z-index: 2147483644;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; background: #f7f7f4; color: #26251e;
    opacity: 0; pointer-events: none;
    transition: opacity 480ms ease;
  }
  #or-demo-end.or-show { opacity: 1; }
  #or-demo-end .or-kicker {
    margin: 0; font: 600 16px/1 "Inter Variable", Inter, system-ui, sans-serif;
    letter-spacing: 0.14em; text-transform: uppercase; color: #64635c;
  }
  #or-demo-end .or-line {
    margin: 0; font: 650 52px/1.15 "Inter Variable", Inter, system-ui, sans-serif;
    letter-spacing: -0.03em; text-align: center;
  }
  #or-demo-end .or-url {
    margin: 8px 0 0; font: 500 30px/1.2 "JetBrains Mono Variable", ui-monospace, monospace;
    color: #c03c00;
  }
  .consent, [id*="userjot" i], [class*="userjot" i] { display: none !important; }
`;

async function installHud(page: Page) {
  await page.addStyleTag({ content: HUD });
  await page.evaluate(() => {
    document.documentElement.classList.add("or-recording");
    document.documentElement.dataset.theme = "light";
    if (!document.getElementById("or-demo-backdrop")) {
      document.body.insertAdjacentHTML("beforeend", [
        `<div id="or-demo-backdrop"></div>`,
        `<div id="or-demo-cursor"></div>`,
        `<div id="or-demo-badge">Sample data</div>`,
        `<div id="or-demo-caption"></div>`,
        `<div id="or-demo-end"><p class="or-kicker">OpenReview</p><p class="or-line">Open source. Self-host free.</p><p class="or-url">openreview.tech</p></div>`,
      ].join(""));
    }
    const cursor = document.getElementById("or-demo-cursor");
    if (!cursor) return;
    document.addEventListener("mousemove", (event) => { cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`; }, { passive: true });
    document.addEventListener("mousedown", () => { cursor.classList.add("or-down"); });
    document.addEventListener("mouseup", () => { cursor.classList.remove("or-down"); });
  });
}

async function caption(page: Page, text: string) {
  await page.evaluate((value) => {
    const el = document.getElementById("or-demo-caption");
    if (el) el.textContent = value;
  }, text);
}

async function focusFigure(figure: Locator) {
  await figure.evaluate((el) => {
    document.querySelectorAll("[data-or-focus]").forEach((node) => node.removeAttribute("data-or-focus"));
    el.setAttribute("data-or-focus", "");
  });
}

async function moveTo(page: Page, locator: Locator, steps = 32) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Target is not visible");
  await page.mouse.move(box.x + Math.min(Math.max(box.width / 2, 10), 90), box.y + Math.min(Math.max(box.height / 2, 8), 18), { steps });
}

async function clickLocator(page: Page, locator: Locator) {
  await moveTo(page, locator);
  await page.waitForTimeout(280);
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
}

async function animateScroll(page: Page, screen: Locator, top: number, duration = 900) {
  const from = await screen.evaluate((el) => (el as HTMLElement).scrollTop);
  const steps = Math.max(10, Math.round(duration / 40));
  for (let i = 1; i <= steps; i++) {
    const t = 1 - (1 - i / steps) ** 3;
    await screen.evaluate((el, value) => { (el as HTMLElement).scrollTop = value; }, from + (top - from) * t);
    await page.waitForTimeout(duration / steps);
  }
}

async function scrollScreen(page: Page, figure: Locator, top: number, duration = 900) {
  await animateScroll(page, figure.locator(".replica-screen"), top, duration);
}

async function scrollToChild(page: Page, figure: Locator, child: Locator, duration = 800) {
  const screen = figure.locator(".replica-screen");
  const top = await child.evaluate((el) => {
    const node = el as HTMLElement;
    const box = node.closest(".replica-screen") as HTMLElement | null;
    if (!box) return 0;
    return node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 70;
  });
  await animateScroll(page, screen, top, duration);
}

async function zoomTo(locator: Locator, scale = 1.32) {
  await locator.evaluate((el, factor) => {
    const screen = el.closest(".replica-screen") as HTMLElement | null;
    if (!screen) return;
    const s = screen.getBoundingClientRect(), r = el.getBoundingClientRect();
    screen.style.transition = "transform 900ms cubic-bezier(0.16, 1, 0.3, 1)";
    screen.style.transformOrigin = `${((r.left + r.width / 2 - s.left) / s.width) * 100}% ${((r.top + r.height / 2 - s.top) / s.height) * 100}%`;
    screen.style.transform = `scale(${factor})`;
  }, scale);
}

async function resetZoom(figure: Locator) {
  await figure.locator(".replica-screen").evaluate((screen) => {
    const el = screen as HTMLElement;
    el.style.transition = "transform 500ms ease";
    el.style.transform = "scale(1)";
  });
}

function run(bin: string, args: string[]) {
  const shown = args.length > 16 ? `${args.slice(0, 12).join(" ")} … (${args.length} args)` : args.join(" ");
  log(`$ ${bin} ${shown}`);
  const result = spawnSync(bin, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${bin} exited ${result.status}`);
}

function which(bin: string) {
  const result = spawnSync("which", [bin], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function bytes(file: string) {
  return statSync(file).size;
}

function mb(file: string) {
  return `${(bytes(file) / (1024 * 1024)).toFixed(2)} MB`;
}

function encodeGif(framesDir: string, dest: string, fps: number, width: number, quality: number, maxBytes: number) {
  const frames = readdirSync(framesDir).filter((name) => name.endsWith(".png")).sort().map((name) => path.join(framesDir, name));
  if (!frames.length) throw new Error(`No frames in ${framesDir}`);
  const gifski = which("gifski") || `${process.env.HOME}/.cargo/bin/gifski` || "/usr/local/cargo/bin/gifski";
  let usedQuality = quality, usedFps = fps;
  for (const nextFps of [fps, 10, 8]) {
    for (const nextQuality of [quality, 80, 70, 60, 50]) {
      usedQuality = nextQuality;
      usedFps = nextFps;
      run(gifski, ["--fps", String(nextFps), "--width", String(width), "--quality", String(nextQuality), "--repeat", "0", "-o", dest, ...frames]);
      if (bytes(dest) <= maxBytes) {
        log(`${path.basename(dest)}: ${mb(dest)} (${usedFps} fps, quality ${usedQuality})`);
        return { fps: usedFps, quality: usedQuality, bytes: bytes(dest) };
      }
      log(`${path.basename(dest)} is ${mb(dest)}, retrying at fps=${nextFps} quality=${nextQuality - 10 || nextQuality}`);
    }
  }
  log(`warning: ${path.basename(dest)} is ${mb(dest)}, over the ${maxBytes} byte budget`);
  return { fps: usedFps, quality: usedQuality, bytes: bytes(dest) };
}

function extractFrames(video: string, dest: string, start: number, duration: number, fps: number) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  run("ffmpeg", ["-hide_banner", "-y", "-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", video, "-vf", `fps=${fps}`, path.join(dest, "%04d.png")]);
}

async function record() {
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  process.env.PATH = `/usr/local/cargo/bin:${process.env.PATH}`;
  if (!which("ffmpeg")) throw new Error("ffmpeg is required on PATH");
  if (!which("gifski")) throw new Error("gifski is required on PATH (cargo install gifski)");

  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const domain = new URL(demoUrl).hostname;
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
    recordVideo: { dir: workDir, size: VIEW },
    locale: "en-US",
  });
  await context.addCookies([
    { name: "openreview_theme", value: "light", domain, path: "/", secure: true },
    { name: "openreview_consent", value: "denied", domain, path: "/", secure: true },
  ]);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(demoUrl).origin });
  const page = await context.newPage();
  const videoOrigin = Date.now();
  page.setDefaultTimeout(20_000);

  try {
    await page.goto(demoUrl, { waitUntil: "domcontentloaded" });
    const hero = page.getByRole("figure", { name: /dashboard for a sample workspace/ });
    await hero.waitFor();
    await hero.locator('[role="tablist"][data-indicator]').waitFor();
    await hero.getByRole("tab", { name: "Code" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await installHud(page);
    await focusFigure(hero);
    await hero.locator(".review-diff .diff-file").filter({ hasText: "src/cart.ts" }).waitFor();
    await page.screenshot({ path: path.join(workDir, "setup.png"), caret: "initial" });
    await page.mouse.move(240, 220, { steps: 8 });
    await page.waitForTimeout(400);

    const origin = Date.now();
    const trimStart = (origin - videoOrigin) / 1000;
    const until = async (ms: number) => {
      const wait = ms - (Date.now() - origin);
      if (wait > 16) await page.waitForTimeout(wait);
    };

    // Beat 1: PR diff of src/cart.ts and test/cart.test.ts.
    await caption(page, "A small change. Tests are green.");
    const cartLine = hero.locator(".review-diff").getByText("return (cents * qty) / 100").first();
    if (await cartLine.count()) {
      await moveTo(page, cartLine, 28);
      await page.waitForTimeout(400);
    } else skipped.push("beat 1 cursor on cart.ts added line (text not found in the diff)");
    const testFile = hero.locator(".diff-file").filter({ hasText: "test/cart.test.ts" });
    if (await testFile.count()) {
      await scrollToChild(page, hero, testFile, 900);
      await moveTo(page, testFile.getByText("assert.equal(total(1250, 2), 25)").first(), 24);
    } else skipped.push("beat 1 pan to test/cart.test.ts (file block not found)");

    // Beat 2: Overview verdict and score.
    await until(3_000);
    await caption(page, "OpenReview reviews the whole repo, not just the diff");
    await scrollScreen(page, hero, 0, 500);
    const overview = hero.getByRole("tab", { name: "Overview" });
    await clickLocator(page, overview);
    const verdict = hero.getByRole("tabpanel", { name: "Overview" }).getByText("Needs changes", { exact: true });
    await verdict.waitFor();
    await moveTo(page, verdict, 20);
    await verdict.evaluate((el) => {
      (el as HTMLElement).style.outline = "3px solid #c03c00";
      (el as HTMLElement).style.outlineOffset = "6px";
      (el as HTMLElement).style.borderRadius = "4px";
    });
    const score = hero.getByRole("tabpanel", { name: "Overview" }).getByText("2/5");
    if (await score.count()) await page.waitForTimeout(600);

    // Beat 3: P0 finding and quoted lines.
    await until(7_000);
    await caption(page, "Every finding quotes the code it depends on");
    await clickLocator(page, hero.getByRole("tab", { name: /^Findings/ }));
    const p0 = hero.locator(".verified-finding").filter({ hasText: "total() now returns dollar value" }).first();
    await p0.waitFor();
    const quotes = p0.locator(".evidence");
    const quoteCount = await quotes.count();
    if (quoteCount === 0) skipped.push("beat 3 quoted evidence blocks (none rendered)");
    for (let i = 0; i < Math.min(quoteCount, 3); i++) {
      await scrollToChild(page, hero, quotes.nth(i), 700);
      await moveTo(page, quotes.nth(i).locator("pre"), 18);
      await page.waitForTimeout(280);
    }
    if (quoteCount) {
      await zoomTo(quotes.nth(Math.min(2, quoteCount - 1)), 1.22);
      await page.waitForTimeout(900);
    }

    // Beat 4: P2 finding on the edited test.
    await until(13_000);
    await caption(page, "It also flags the test that hides the bug");
    await resetZoom(hero);
    await page.waitForTimeout(550);
    await p0.evaluate((el) => { (el as HTMLDetailsElement).open = false; });
    const p2 = hero.locator(".verified-finding").filter({ hasText: "Updated test asserts the dollar value" }).first();
    if (await p2.count()) {
      await scrollToChild(page, hero, p2, 500);
      await clickLocator(page, p2.locator("summary"));
      await p2.getByText("assert.equal(total(1250, 2), 25)").waitFor();
      await scrollToChild(page, hero, p2, 400);
      await moveTo(page, p2.locator("pre").first(), 18);
    } else skipped.push("beat 4 P2 finding (not present in the public demo)");

    // Beat 5: Fix page — coding agent selector, then Copy fix prompt.
    await until(17_000);
    await caption(page, "Hand the fix to your coding agent");
    const agent = page.getByRole("figure", { name: /send it to Codex, Claude Code or Cursor Agent/ });
    if (await agent.count()) {
      await focusFigure(agent);
      await page.waitForTimeout(350);
      const select = agent.getByLabel("Coding agent");
      if (await select.count()) {
        await moveTo(page, select, 26);
        await page.waitForTimeout(700);
      } else skipped.push("beat 5 coding agent selector (label not found)");
      const copy = agent.getByRole("button", { name: "Copy fix prompt" });
      if (await copy.count()) {
        await clickLocator(page, copy);
        await agent.getByText(/Fix prompt copied|select the prompt below/i).waitFor();
      } else skipped.push("beat 5 Copy fix prompt (button not found)");
    } else skipped.push("beat 5 Fix page (agent replica not on the public demo)");

    // Beat 6: end card.
    await until(21_000);
    await caption(page, "");
    await page.evaluate(() => document.getElementById("or-demo-end")?.classList.add("or-show"));
    await until(STORYBOARD_MS);
    await page.waitForTimeout(200);

    const video = page.video();
    await page.close();
    const videoPath = video ? await video.path() : "";
    await context.close();
    await browser.close();
    if (!videoPath) throw new Error("Playwright did not write a video");

    const raw = path.join(workDir, "demo-raw.webm");
    copyFileSync(videoPath, raw);
    const duration = STORYBOARD_MS / 1000;
    const mp4 = path.join(outDir, "demo.mp4");
    run("ffmpeg", [
      "-hide_banner", "-y",
      "-ss", Math.max(0, trimStart).toFixed(3),
      "-t", duration.toFixed(3),
      "-i", raw,
      "-an",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-crf", "18",
      "-movflags", "+faststart",
      mp4,
    ]);

    const frames = path.join(workDir, "frames");
    extractFrames(raw, frames, Math.max(0, trimStart), duration, FPS);
    const gif = path.join(outDir, "demo.gif");
    encodeGif(frames, gif, FPS, GIF_WIDTH, 90, GIF_MAX_BYTES);

    const shortFrames = path.join(workDir, "frames-short");
    extractFrames(raw, shortFrames, Math.max(0, trimStart) + SHORT_START_MS / 1000, SHORT_DURATION_S, FPS);
    const shortGif = path.join(outDir, "demo-short.gif");
    const short = encodeGif(shortFrames, shortGif, FPS, GIF_WIDTH, 90, SHORT_MAX_BYTES);
    if (short.bytes > SHORT_MAX_BYTES) {
      log(`demo-short.gif is ${mb(shortGif)}; leaving it in place for review (budget 3 MB)`);
    }

    const report = {
      url: demoUrl,
      files: {
        gif: { path: gif, bytes: bytes(gif), mb: mb(gif) },
        mp4: { path: mp4, bytes: bytes(mp4), mb: mb(mp4) },
        short: { path: shortGif, bytes: bytes(shortGif), mb: mb(shortGif) },
      },
      skipped,
      trimStart,
    };
    console.log(JSON.stringify(report, null, 2));
    if (skipped.length) log(`Skipped: ${skipped.join("; ")}`);
  } catch (error) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

await record();
