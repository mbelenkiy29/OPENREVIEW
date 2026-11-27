import { afterEach, beforeEach, expect, test, vi } from "vitest";

const holder = vi.hoisted(() => ({ allow: true, calls: [] as unknown[] }));
vi.mock("../src/server", () => ({
  backend: () => ({ mutation: async (_ref: unknown, args: unknown) => { holder.calls.push(args); if (!holder.allow) throw new Error("Rate limit exceeded"); return null; } }),
}));
import { GET } from "../app/api/ci/audit/route";

const repoBody = (isPrivate: boolean) => ({ private: isPrivate, default_branch: "main", full_name: "acme/app" });
beforeEach(() => {
  holder.allow = true; holder.calls = [];
  vi.stubEnv("CI_AUDIT_GITHUB_TOKEN", "github_pat_test");
  vi.stubEnv("SERVICE_SECRET", "s".repeat(32));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const get = (repo: string) => GET(new Request(`http://localhost:3000/api/ci/audit?repo=${encodeURIComponent(repo)}`));
const github = (isPrivate = false) => vi.stubGlobal("fetch", vi.fn(async (url: string) => {
  const u = new URL(url);
  if (u.pathname === "/repos/acme/app") return Response.json(repoBody(isPrivate), { headers: { "x-ratelimit-remaining": "4000" } });
  if (u.pathname.endsWith("/actions/workflows")) return Response.json({ workflows: [] }, { headers: { "x-ratelimit-remaining": "4000" } });
  return Response.json({ total_count: 0, workflow_runs: [] }, { headers: { "x-ratelimit-remaining": "4000" } });
}));

test("without a token the check is off", async () => {
  vi.stubEnv("CI_AUDIT_GITHUB_TOKEN", "");
  const response = await get("acme/app");
  expect(response.status).toBe(503);
});

test("a malformed repository is refused before the rate limit", async () => {
  expect((await get("not a repo")).status).toBe(400);
  expect(holder.calls).toHaveLength(0);
});

test("a rate-limited check answers 429 and reads nothing from GitHub", async () => {
  holder.allow = false; github();
  expect((await get("acme/app")).status).toBe(429);
  expect(fetch).not.toHaveBeenCalled();
});

test("other spellings of a repository redirect to its one cached URL", async () => {
  github();
  const response = await get("https://github.com/Acme/App");
  expect(response.status).toBe(308);
  expect(new URL(response.headers.get("location")!).searchParams.get("repo")).toBe("acme/app");
  expect(holder.calls).toHaveLength(0);
});

test("a private repository looks the same as a missing one", async () => {
  github(true);
  const response = await get("acme/app");
  expect(response.status).toBe(404);
  expect((await response.json()).error).toBe("No public repository by that name.");
});

test("a public repository returns the audit, cached by the CDN", async () => {
  github();
  const response = await get("acme/app");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("s-maxage=21600");
  const body = await response.json();
  expect(body.repository).toBe("acme/app");
  expect(body.minutes.total).toBe(0);
  expect(holder.calls[0]).toMatchObject({ secret: "s".repeat(32) });
});
