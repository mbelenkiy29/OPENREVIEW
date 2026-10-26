import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Exit setup while a workspace still has to choose a plan (OPENREVIEW-5): setup can't finish yet, so the
// plan step doesn't offer it, and a page opened earlier that still posts it lands back on the plan step.
const holder = vi.hoisted(() => ({ planMissing: true }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect ${url}`); }, useRouter: () => ({ push: () => {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("../src/server", () => ({
  current: async () => ({ token: "t" }),
  // Production Convex redacts the refusal's message.
  backend: () => ({ mutation: async () => { throw new Error("[Request ID: 1] Server Error"); }, query: async () => ({ enabled: true, planMissing: holder.planMissing }) }),
}));
import { WizardFrame } from "../app/dashboard/onboarding/wizard";
import { finishSetup } from "../app/dashboard/onboarding/actions";

test("the plan step offers no way out of setup but Log out while the plan is missing", () => {
  const footer = (planMissing: boolean) => renderToStaticMarkup(WizardFrame({ step: "plan", organizationId: "org1", admin: true, completed: false, billing: true, planMissing, nextLabel: "Choose Pro", children: null }));
  expect(footer(true)).not.toMatch(/Exit setup|Back to dashboard/);
  expect(footer(true)).toContain("Log out");
  expect(footer(false)).toContain("Exit setup");
});

test("Exit setup posted while the plan is missing returns to the plan step; other failures still surface", async () => {
  const form = new FormData();
  form.set("organizationId", "org1");
  form.set("skipped", "true");
  await expect(finishSetup(form)).rejects.toThrow("redirect /dashboard/onboarding/plan");
  holder.planMissing = false;
  await expect(finishSetup(form)).rejects.toThrow("Server Error");
});
