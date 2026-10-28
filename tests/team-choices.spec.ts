import { expect, test, vi } from "vitest";

// The switcher's team picker (app/dashboard/load.ts teamChoices), as on Greptile: shown only when a team is a choice.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("../src/server", () => ({}));
vi.mock("../app/dashboard/sections/shared", () => ({ navigation: [] }));
import { teamChoices } from "../app/dashboard/load";

test("one team that holds every repository is no choice; a second team or a repository outside teams is", () => {
  const web = { _id: "t1" }, api = { _id: "t2" };
  expect(teamChoices({ teams: [web], repositories: [{ teamId: "t1" }, { teamId: "t1" }] })).toEqual([]);
  expect(teamChoices({ teams: [web], repositories: [] })).toEqual([]);
  expect(teamChoices({ teams: [web], repositories: [{ teamId: "t1" }, {}] })).toEqual([web]);
  expect(teamChoices({ teams: [web, api], repositories: [{ teamId: "t1" }] })).toEqual([web, api]);
  expect(teamChoices({ teams: [], repositories: [{}] })).toEqual([]);
});
