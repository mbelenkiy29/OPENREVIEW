import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Setup can't be skipped: its footer only leaves (Back to dashboard), which changes nothing, so the dashboard keeps
// prompting until the last step. While a plan is missing there is no way out at all (OPENREVIEW-5), and a page
// opened before Exit setup was removed lands back on the dashboard without finishing setup.
const holder = vi.hoisted(() => ({ planMissing: true, completes: 0 }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect ${url}`); }, useRouter: () => ({ push: () => {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("../src/server", () => ({
  current: async () => ({ token: "t" }),
  // Production Convex redacts the refusal's message.
  backend: () => ({ mutation: async () => { holder.completes++; throw new Error("[Request ID: 1] Server Error"); }, query: async () => ({ enabled: true, planMissing: holder.planMissing }) }),
}));
import { ReferralCodeField, WizardFrame } from "../app/dashboard/onboarding/wizard";
import { finishSetup } from "../app/dashboard/onboarding/actions";

test("setup offers Back to dashboard, never Exit setup, and no way out but Logout while the plan is missing", () => {
  const footer = (step: "plan" | "connect" | "workspace", planMissing: boolean, billing = true) => renderToStaticMarkup(WizardFrame({ step, organizationId: "org1", admin: true, billing, planMissing, nextLabel: "Next", children: null }));
  expect(footer("plan", true)).not.toMatch(/Exit setup|Back to dashboard/);
  expect(footer("plan", true)).toContain("Logout");
  for (const step of ["plan", "connect"] as const) {
    expect(footer(step, false)).toContain("Back to dashboard");
    expect(footer(step, false)).not.toContain("Exit setup");
  }
  expect(footer("workspace", false, true)).toMatch(/Step 1 of 10/i);
  expect(footer("plan", false, true)).toMatch(/Step 2 of 10/i);
  expect(footer("connect", false, true)).toMatch(/Step 3 of 10/i);
  expect(footer("workspace", false, false)).toMatch(/Step 1 of 9/i);
  expect(footer("connect", false, false)).toMatch(/Step 2 of 9/i);
});

test("the plan step's referral field is optional and is not marked required", () => {
  const html = renderToStaticMarkup(ReferralCodeField({ organizationId: "org1", disclosure: "Codes are optional." }));
  expect(html).toContain("(optional)");
  expect(html).toContain("Codes are optional.");
  expect(html).toContain("wizard-referral");
  expect(html).not.toMatch(/\srequired(=""|>)/);
  expect(html).not.toMatch(/<input[^>]*name="code"[^>]*required/);
});

test("an old Exit setup post leaves setup unfinished; finishing while the plan is missing returns to the plan step", async () => {
  const form = new FormData();
  form.set("organizationId", "org1");
  form.set("skipped", "true");
  await expect(finishSetup(form)).rejects.toThrow("redirect /dashboard/analytics");
  expect(holder.completes).toBe(0);
  form.delete("skipped");
  await expect(finishSetup(form)).rejects.toThrow("redirect /dashboard/onboarding/plan");
  holder.planMissing = false;
  await expect(finishSetup(form)).rejects.toThrow("Server Error");
  expect(holder.completes).toBe(2);
});
