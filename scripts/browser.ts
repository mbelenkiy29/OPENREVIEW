import { loadEnvFile } from "node:process";
import { chromium, type Locator } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { SignJWT } from "jose";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { api } from "../convex/_generated/api";

loadEnvFile(".env.local");
const url = process.env.APP_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url))
  throw new Error("Browser fixture tests only run against localhost");
const backend = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const id = await backend.mutation(api.users.login, {
  secret: process.env.SERVICE_SECRET!,
  githubId: -100,
  login: "openreview-browser-fixture",
  avatar: "",
});
const token = await new SignJWT({})
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(id)
  .setIssuer("openreview")
  .setAudience("openreview")
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1365, height: 900 },
});
const page = await context.newPage(),
  errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await mkdir("output/playwright", { recursive: true });
try {
  await page.goto(url);
  await page.getByRole("link", { name: "Get started" }).first().waitFor();
  await page.getByRole("heading", { name: "How it works" }).waitFor();
  await page.screenshot({ path: "output/playwright/home.png", fullPage: true, caret: "initial" });
  // The landing demos are interactive: the hero window switches sections, chat answers a sample
  // question with citations, and the summary demo re-reviews a pushed fix.
  const hero = page.getByRole("figure", { name: /dashboard for a sample workspace/ });
  await hero.getByRole("button", { name: "Analytics", exact: true }).click();
  await hero.getByLabel("Repository").selectOption("acme/api");
  await hero.getByText("$2.10").waitFor();
  await hero.getByRole("button", { name: "Chat", exact: true }).click();
  await hero.locator(".demo-suggestions").getByRole("button", { name: "Which tests cover charge()?" }).click();
  await hero.locator(".chat-message.assistant").last().getByRole("list", { name: "Citations" }).waitFor();
  const summaryDemo = page.getByRole("figure", { name: /re-reviews a newly pushed fix/ });
  await summaryDemo.getByRole("button", { name: "Re-review current PR" }).click();
  await summaryDemo.getByText("0 findings · Score 5/5").first().waitFor();
  // Landing motion (app/landing/motion.tsx), all on one running page so teardown is tested too: an
  // in-page link glides to its section and scrolling reveals everything; turning on reduced motion
  // mid-page removes the smoother, pin and hidden states without losing the reader's place; and a
  // client-side link to the docs leaves no smoother or page height behind.
  await page.goto(url);
  await page.locator(".landing[data-motion='on']").waitFor({ state: "attached" });
  await page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "How it works" }).click();
  await page.waitForFunction(() => { const r = document.getElementById("how-heading")!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  await page.mouse.move(600, 450);
  for (let i = 0; i < 120 && await page.evaluate(() => scrollY + innerHeight < document.documentElement.scrollHeight - 2); i++) await page.mouse.wheel(0, 600);
  await page.waitForFunction(() => [...document.querySelectorAll("[data-reveal], [data-stagger] > *")].every((e) => getComputedStyle(e).opacity === "1"));
  const ctaTop = () => page.evaluate(() => document.getElementById("cta-heading")!.getBoundingClientRect().top);
  await page.waitForTimeout(1500); // smoothing settles and the reader's place is noted
  const place = await ctaTop();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".landing[data-motion='reduced']").waitFor({ state: "attached" });
  assert.equal(await page.locator("#smooth-content").evaluate((e) => getComputedStyle(e).transform), "none", "Landing scrolls smoothly under reduced motion");
  assert.equal(await page.locator(".pin-spacer").count(), 0, "Landing pins a section under reduced motion");
  assert.equal(await page.evaluate(() => document.body.style.height), "", "Landing keeps the smoother's page height under reduced motion");
  assert.equal(await page.locator(".hero h1 .line > span").first().evaluate((e) => getComputedStyle(e).animationName), "none", "Landing hero animates under reduced motion");
  assert.ok(Math.abs(await ctaTop() - place) < 60, "Landing loses the reader's place when reduced motion turns on");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator(".landing[data-motion='on'].is-smooth").waitFor({ state: "attached" });
  await page.getByRole("contentinfo").getByRole("link", { name: "Quickstart" }).click();
  await page.getByRole("heading", { name: "Quickstart", level: 1 }).first().waitFor();
  assert.equal(await page.evaluate(() => document.body.getAttribute("style") ?? ""), "", "Landing leaves smoother styles on the docs");
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => scrollY > 0);
  for (const [path, heading] of [["/docs/quickstart", "Quickstart"], ["/docs/api", "Public API"], ["/docs/configuration", "Repository configuration as code"], ["/changelog", "Changelog"]]) {
    await page.goto(url + path);
    await page.getByRole("heading", { name: heading, level: 1 }).first().waitFor();
  }
  // Sign in and sign up: the same choices, linked to each other.
  await page.goto(url + "/login?error=link");
  await page.getByRole("heading", { name: "Sign in to OpenReview", level: 1 }).waitFor();
  await page.getByRole("link", { name: "Continue with GitHub" }).waitFor();
  await page.getByRole("alert").filter({ hasText: "expired or already used" }).waitFor();
  await page.screenshot({ path: "output/playwright/login.png", fullPage: true, caret: "initial" });
  await page.getByRole("link", { name: "Create an account" }).click();
  await page.waitForURL("**/signup");
  await page.getByRole("heading", { name: "Create your account", level: 1 }).waitFor();
  await page.getByRole("link", { name: "Continue with GitHub" }).waitFor();
  await page.goto(url + "/?error=signin");
  await page.waitForURL("**/login?error=signin");
  assert.equal((await page.request.get(`${url}/docs/openapi.yaml`)).status(), 200);
  assert.equal((await page.request.get(`${url}/docs/not-a-page`)).status(), 404);
  await context.addCookies([
    {
      name: "openreview_session",
      value: token,
      url,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(`${url}/dashboard`);
  // loading.tsx streams first; wait for the real page before choosing the fresh-database branch.
  await page.waitForLoadState("networkidle");
  if (
    await page.getByRole("heading", { name: "Create your workspace" }).count()
  ) {
    await page
      .getByLabel("Workspace name")
      .fill("Browser verification workspace");
    await page.getByRole("button", { name: "Create workspace" }).click();
    // A new workspace continues into guided setup; this branch only runs on a fresh database.
    await page.waitForURL("**/dashboard/onboarding/connect");
    await page.getByRole("heading", { name: "Connect your code", level: 1 }).waitFor();
  }
  const me = await backend.query(api.users.me, { token });
  const organizationId = me.organizations[0]._id!;
  await backend.mutation(api.repositories.connect, {
    token,
    secret: process.env.SERVICE_SECRET!,
    organizationId,
    installationId: -100,
    account: "test-fixture-only",
    accountId: -100,
    repositories: [
      {
        id: -100,
        fullName: "test-fixture/context-example",
        defaultBranch: "main",
      },
    ],
  });
  await page.goto(`${url}/dashboard/repositories`);
  await page
    .getByRole("heading", { name: "test-fixture/context-example", exact: true })
    .waitFor();
  // Guided setup: every step with the keyboard shortcut, live previews, reduced motion, 390 px, finish.
  await page.goto(`${url}/dashboard/onboarding/connect`);
  await page.getByRole("heading", { name: "Connect your code", level: 1 }).waitFor();
  await page.getByLabel("Filter repositories").fill("context-example");
  await page.getByRole("checkbox", { name: /test-fixture\/context-example/ }).check();
  await page.keyboard.press("Control+Enter");
  await page.waitForURL("**/dashboard/onboarding/indexing");
  await page.getByRole("heading", { name: "Mapping your repositories", level: 1 }).waitFor();
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.waitForURL("**/dashboard/onboarding/summary");
  const overviewSwitch = page.getByRole("switch", { name: /^Overview/ });
  await overviewSwitch.uncheck();
  assert.equal(await page.locator(".preview-block").first().getAttribute("data-on"), "false", "Summary preview ignores the Overview toggle");
  await overviewSwitch.check();
  await page.keyboard.press("Control+Enter");
  await page.waitForURL("**/dashboard/onboarding/comments");
  await page.getByText("Quiet", { exact: true }).click();
  await page.getByText(/1 of 6 example findings would post inline/i).waitFor();
  await page.getByText("Balanced", { exact: true }).click();
  await page.getByText(/4 of 6 example findings would post inline/i).waitFor();
  await page.keyboard.press("Control+Enter");
  await page.waitForURL("**/dashboard/onboarding/triggers");
  await page.keyboard.press("Control+Enter");
  await page.waitForURL("**/dashboard/onboarding/tools");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".wizard-panel").evaluate((e) => getComputedStyle(e).animationName), "none", "Setup animates under reduced motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Fixes can start with a cloud agent: the preview follows the choice.
  await page.locator('select[name="handoff"]').selectOption("cloud");
  await page.locator('select[name="cloudAgent"]').selectOption("copilot");
  await page.getByText("Fix with Copilot", { exact: true }).waitFor();
  await page.locator('select[name="handoff"]').selectOption("bridge");
  await page.keyboard.press("Control+Enter");
  await page.waitForURL("**/dashboard/onboarding/team");
  await page.keyboard.press("Control+Enter");
  await page.waitForURL("**/dashboard/onboarding/done");
  const billing = (await backend.query(api.billing.status, { token, organizationId })).enabled;
  if (billing) {
    // A workspace from before plans were required keeps the optional plan step (trial without a card).
    await page.goto(`${url}/dashboard/onboarding/plan`);
    await page.getByRole("heading", { name: "Choose your plan", level: 1 }).waitFor();
    await page.getByRole("button", { name: /Continue on the trial/ }).click();
    await page.waitForURL("**/dashboard/onboarding/connect");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const step of [...(billing ? ["plan"] : []), "connect", "indexing", "summary", "comments", "triggers", "tools", "team", "done"]) {
    await page.goto(`${url}/dashboard/onboarding/${step}`);
    await page.locator("[data-wizard-heading]").waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Setup step ${step} overflows at 390 px`);
  }
  await page.screenshot({ path: "output/playwright/setup-mobile.png", fullPage: true, caret: "initial" });
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.screenshot({ path: "output/playwright/setup-done.png", fullPage: true, caret: "initial" });
  await page.getByRole("button", { name: /^Go to dashboard/ }).click();
  await page.waitForURL("**/dashboard/analytics");
  assert.ok((await backend.query(api.onboarding.status, { token, organizationId })).onboarding?.completedAt, "Setup completion was not recorded");
  // A new workspace on a billing deployment must choose a plan first: every dashboard page leads to the
  // plan step, which only offers Checkout (card required). Then switch back to the fixture workspace.
  if (billing) {
    const required = await backend.mutation(api.users.createOrganization, { token, name: "Plan gate check" });
    const asWorkspace = (id: string) => context.addCookies([{ name: "openreview_workspace", value: id, url, sameSite: "Lax" }]);
    await asWorkspace(required);
    await page.goto(`${url}/dashboard/analytics`);
    await page.waitForURL("**/dashboard/onboarding/plan");
    await page.getByRole("heading", { name: "Choose your plan", level: 1 }).waitFor();
    await page.getByRole("button", { name: /Start free trial/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: /Continue on the trial/ }).count(), 0, "A required plan can be skipped");
    await page.goto(`${url}/dashboard/onboarding/connect`);
    await page.waitForURL("**/dashboard/onboarding/plan");
    await asWorkspace(organizationId);
  }
  // Fix agents: settings list the cloud agents and what each needs; the link page answers without a raw error.
  await page.goto(`${url}/dashboard/settings/agents`);
  await page.getByRole("heading", { name: "Personal fix agent" }).waitFor();
  await page.getByRole("heading", { name: "Cloud agents" }).waitFor();
  await page.getByText("Local bridge (Fix on your machine)", { exact: true }).waitFor();
  for (const mention of ["@claude", "@codex", "@copilot", "@cursor"]) await page.getByText(mention, { exact: true }).waitFor();
  const link = await page.request.get(`${url}/dashboard/github-link?organization=${organizationId}&returnTo=%2Fdashboard%2Frepositories`, { maxRedirects: 0 });
  assert.ok(link.status() === 200 || (link.status() === 307 && /purpose=github-install/.test(link.headers().location ?? "")), `Link page answered ${link.status()}`);
  // A signed-out developer following a Fix link from a pull request returns there after signing in.
  const signedOut = await browser.newContext();
  const outPage = await signedOut.newPage();
  await outPage.goto(`${url}/fix/missing-review?finding=fp1`);
  await outPage.waitForURL((u) => u.pathname === "/login" && u.searchParams.get("next") === "/fix/missing-review?finding=fp1");
  await signedOut.close();
  // Walk every page in the main navigation and in each section's secondary navigation.
  const settled = () =>
    page.waitForFunction(
      () =>
        document.querySelector("h1") &&
        ![...document.querySelectorAll("h1")].some(
          (h) => h.textContent === "Loading…",
        ),
    );
  const visit = async (link: Locator) => {
    const href = (await link.getAttribute("href"))!.split("?")[0];
    await link.click();
    await page.waitForURL((u) => u.pathname.startsWith(href));
    await settled();
  };
  let dashboardPages = 0;
  for (const name of [
    "Analytics",
    "Chat",
    "Memory",
    "Pull Requests",
    "Settings",
  ]) {
    await visit(
      page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name, exact: true }),
    );
    dashboardPages++;
    const secondary = page.locator("aside.secondary-nav nav").first();
    if (!(await secondary.count())) continue;
    for (const label of await secondary.getByRole("link").allTextContents()) {
      const link = secondary.getByRole("link", { name: label, exact: true });
      await visit(link);
      assert.equal(
        await link.getAttribute("aria-current"),
        "page",
        `${label} is not marked as the current page`,
      );
      dashboardPages++;
    }
  }
  const [repository] = await backend.query(api.repositories.list, {
    token,
    organizationId,
  });
  await page.goto(`${url}/dashboard/settings?repository=${repository._id}`);
  await page.getByLabel("Minimum confidence", { exact: true }).fill("0.92");
  await page.getByRole("button", { name: "Save review settings" }).click();
  await page.waitForTimeout(500);
  assert.equal(
    (
      await backend.query(api.settings.repository, {
        token,
        repositoryId: repository._id,
      })
    ).settings.minimumConfidence,
    0.92,
  );
  await page.goto(`${url}/dashboard/rules`);
  // Admins see the rule assistant; without a model run it has no suggestions to approve.
  await page.getByRole("heading", { name: "Rule assistant" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Draft rule" }).count(), 1);
  await page
    .getByLabel("Title", { exact: true })
    .first()
    .fill("Browser check membership");
  await page
    .getByLabel("Instructions", { exact: true })
    .first()
    .fill(
      "All routes must validate organization membership before reading organization data.",
    );
  await page.getByRole("button", { name: "Create rule", exact: true }).click();
  await page
    .getByRole("heading", { name: /Browser check membership/ })
    .last()
    .waitFor();
  await page.getByRole("link", { name: "Chat", exact: true }).first().click();
  await page.getByRole("heading", { name: "Chat", exact: true }).waitFor();
  await page.getByRole("link", { name: "New chat" }).waitFor();
  await page.getByRole("heading", { name: "No indexed repositories" }).waitFor();
  assert.equal((await page.request.get(`${url}/api/chat/abcdefghij/stream`)).status(), 404);
  await page.goto(`${url}/dashboard/memory/preferences`);
  await page.getByRole("heading", { name: "Learned team conventions" }).waitFor();
  await page.getByLabel("Convention status").selectOption("suggested");
  await page.getByLabel("Search memory").fill("pagination");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/convention=suggested/);
  await page.getByText("0 matching conventions", { exact: false }).waitFor();
  // Screenshots and layout checks wait for the page content, not the streamed loading skeleton.
  await page.goto(`${url}/dashboard`);
  await settled();
  await page.screenshot({
    path: "output/playwright/dashboard.png",
    fullPage: true, caret: "initial",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "output/playwright/mobile.png",
    fullPage: true, caret: "initial",
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile page overflows horizontally",
  );
  // Dark theme at mobile and desktop widths: no overflow, no console errors.
  await page.emulateMedia({ colorScheme: "dark" });
  for (const path of ["/", "/dashboard", "/dashboard/chat", "/dashboard/settings/billing", "/docs/quickstart"]) {
    await page.goto(url + path);
    await settled();
    await page.screenshot({ path: `output/playwright/dark-mobile${path === "/" ? "-home" : path.replaceAll("/", "-")}.png`, fullPage: true, caret: "initial" });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Dark mobile ${path} overflows horizontally`);
  }
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(`${url}/dashboard`);
  await settled();
  await page.screenshot({ path: "output/playwright/dark-desktop.png", fullPage: true, caret: "initial" });
  assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
  console.log(
    `Browser verification passed: landing (interactive demos, motion and reduced motion), docs, changelog, guided setup (all steps, previews, reduced motion, 390 px), repository selection, ${dashboardPages} dashboard pages (main and secondary navigation), persisted settings/rules, Memory page filters, Chat page, mobile layout and dark theme. GitHub OAuth and real indexing still require external credentials.`,
  );
} finally {
  await browser.close();
}
