import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { createHash } from "node:crypto";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

const holder = vi.hoisted(() => ({ t: undefined as ReturnType<typeof convexTest> | undefined }));
vi.mock("../src/server", () => ({ backend: () => holder.t }));
import { POST } from "../app/api/bridge/[action]/route";

const modules = import.meta.glob("../convex/**/*.ts");
const service = "bridge-pairing-service", base = "https://review.example.com/api/bridge";
let sequence: number;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 18, 12));
  vi.stubEnv("SERVICE_SECRET", service);
  vi.stubEnv("BRIDGE_TRUSTED_IP_HEADER", undefined);
  vi.stubEnv("CLIENT_IP_SOURCE", "header:x-real-ip");
  vi.stubEnv("VERCEL", "1");
  holder.t = convexTest(schema, modules);
  sequence = 0;
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

function pair(headers: HeadersInit = {}) {
  const id = (++sequence).toString(16), requestHeaders = new Headers(headers);
  requestHeaders.set("authorization", `Bearer obr_${id.padStart(64, "0")}`);
  return POST(new Request(`${base}/pair`, {
    method: "POST", headers: requestHeaders,
    body: JSON.stringify({ code: id.padStart(12, "0"), name: "Desktop bridge" }),
  }), { params: Promise.resolve({ action: "pair" }) });
}

test.each(["x-real-ip", "x-forwarded-for"])("rotating untrusted %s cannot escape the shared pairing limit", async (header) => {
  for (let i = 1; i <= 30; i++) {
    const address = `198.51.100.${i}`;
    expect((await pair({ [header]: header === "x-forwarded-for" ? `${address}, 192.0.2.1` : address })).status).toBe(200);
  }
  expect((await pair({ [header]: "203.0.113.1" })).status).toBe(400);
  expect((await pair()).status).toBe(400);
  expect(await holder.t!.run((ctx) => ctx.db.query("bridgeDevices").collect())).toHaveLength(30);
  vi.advanceTimersByTime(60_000);
  expect((await pair()).status).toBe(200);
});

test("an unrecognized trust setting does not accept forwarding headers", async () => {
  vi.stubEnv("BRIDGE_TRUSTED_IP_HEADER", "xff-rightmost");
  for (let i = 1; i <= 30; i++) {
    expect((await pair({ "x-real-ip": `198.51.100.${i}`, "x-forwarded-for": `203.0.113.${i}` })).status).toBe(200);
  }
  expect((await pair()).status).toBe(400);
});

test.each(["x-real-ip", "x-forwarded-for"])("only the explicitly trusted %s separates clients", async (header) => {
  vi.stubEnv("BRIDGE_TRUSTED_IP_HEADER", header);
  const other = header === "x-real-ip" ? "x-forwarded-for" : "x-real-ip";
  for (let i = 1; i <= 30; i++) {
    expect((await pair({ [header]: " 203.0.113.1 ", [other]: `198.51.100.${i}` })).status).toBe(200);
  }
  expect((await pair({ [header]: "203.0.113.1", [other]: "198.51.100.31" })).status).toBe(400);
  expect((await pair({ [header]: "203.0.113.2", [other]: "198.51.100.31" })).status).toBe(200);
});

test.each(["x-real-ip", "x-forwarded-for"])("missing or malformed trusted %s shares one bucket without header fallback", async (header) => {
  vi.stubEnv("BRIDGE_TRUSTED_IP_HEADER", header);
  const other = header === "x-real-ip" ? "x-forwarded-for" : "x-real-ip";
  const invalid = [undefined, "", "unknown", "203.0.113.1, 192.0.2.1", "203.0.113.1:1234", "[2001:db8::1]", "fe80::1%eth0", "256.1.1.1", "1".repeat(101)];
  for (let i = 0; i < 30; i++) {
    const value = invalid[i % invalid.length];
    expect((await pair({ ...(value === undefined ? {} : { [header]: value }), [other]: `198.51.100.${i + 1}` })).status).toBe(200);
  }
  const duplicate = new Headers([[header, "203.0.113.2"], [header, "192.0.2.2"]]);
  expect((await pair(duplicate)).status).toBe(400);
  expect((await pair()).status).toBe(400);
  expect((await pair({ [header]: "203.0.113.2" })).status).toBe(200);
});

test.each([
  ["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
  ["::ffff:192.0.2.1", "::FFFF:c000:201", "192.0.2.1"],
])("equivalent IP spellings share one pairing limit (%s)", async (...addresses) => {
  vi.stubEnv("BRIDGE_TRUSTED_IP_HEADER", "x-real-ip");
  for (let i = 0; i < 30; i++) {
    expect((await pair({ "x-real-ip": addresses[i % addresses.length] })).status).toBe(200);
  }
  for (const address of addresses) expect((await pair({ "x-real-ip": address })).status).toBe(400);
});

test("trusted clients remain subject to the shared 300-per-minute cap", async () => {
  vi.stubEnv("BRIDGE_TRUSTED_IP_HEADER", "x-real-ip");
  for (let i = 0; i < 300; i++) {
    expect((await pair({ "x-real-ip": `192.0.2.${i % 11 + 1}` })).status).toBe(200);
  }
  expect((await pair({ "x-real-ip": "198.51.100.1" })).status).toBe(400);
  expect(await holder.t!.run((ctx) => ctx.db.query("bridgeDevices").collect())).toHaveLength(300);
});

test("pairing still validates bearer credentials and registers only an unapproved token hash", async () => {
  const invalid = await POST(new Request(`${base}/pair`, {
    method: "POST", headers: { authorization: "Bearer invalid" },
    body: JSON.stringify({ code: "abcdef123456", name: "Desktop bridge" }),
  }), { params: Promise.resolve({ action: "pair" }) });
  expect(invalid.status).toBe(400);
  expect(await holder.t!.run((ctx) => ctx.db.query("bridgeDevices").collect())).toHaveLength(0);
  expect(await (await pair()).json()).toEqual({ pending: true });
  const hash = createHash("sha256").update(`obr_${"1".padStart(64, "0")}`).digest("hex");
  expect(await holder.t!.run((ctx) => ctx.db.query("bridgeDevices").collect())).toEqual([
    expect.objectContaining({ tokenHash: hash, code: "000000000001", name: "Desktop bridge", revoked: false }),
  ]);
  expect(await holder.t!.mutation(api.bridge.pairStatus, { secret: service, hash })).toEqual({ paired: false });
  await expect(holder.t!.mutation(api.bridge.startPair, {
    secret: "wrong-service", hash: "a".repeat(64), code: "abcdef123456", name: "Desktop bridge",
  })).rejects.toThrow("Unauthorized service");
});
