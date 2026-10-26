import { afterEach, expect, test, vi } from "vitest";

// The dashboard's plan gate: a new workspace on a billing deployment that has not chosen a plan reaches
// only the Billing, Account and personal Referrals settings; every other page leads to the plan step.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect ${url}`); }, notFound: () => { throw new Error("not found"); } }));
vi.mock("../src/server", () => ({ current: async () => ({ token: "t", organizations: [{ _id: "org1", role: "owner", planRequired: true }] }), backend: () => { throw new Error("loaded"); } }));
vi.mock("../app/dashboard/sections/shared", () => ({ navigation: ["Repositories", "Team", "Settings"] }));
import { loadDashboard } from "../app/dashboard/load";

afterEach(() => { delete process.env.BILLING_ENABLED; delete process.env.REFERRALS_ENABLED; });
const load = (section: string[]) => loadDashboard({ params: Promise.resolve({ section }), searchParams: Promise.resolve({}) });

test("a workspace without a plan reaches Billing, Account and Referrals settings, and nothing else", async () => {
  process.env.BILLING_ENABLED = "true";
  process.env.REFERRALS_ENABLED = "true";
  for (const section of [["organization", "billing"], ["account"], ["account", "referrals"]]) await expect(load(section)).rejects.toThrow("loaded");
  for (const section of [["organization", "people"], ["repositories"]]) await expect(load(section)).rejects.toThrow("redirect /dashboard/onboarding/plan");
});
