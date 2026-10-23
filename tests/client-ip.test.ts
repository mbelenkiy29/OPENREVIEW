import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { clientIp, ipBucket } from "../src/client-ip";
import { limitKey } from "../src/limit-key";
import { canonicalEmail, emailAddress } from "../src/email";

const forged = new Headers({ "x-forwarded-for": "198.51.100.7", "x-real-ip": "198.51.100.8" });

test("without a configured source no header is trusted, so a client cannot pick its own address", () => {
  assert.equal(clientIp(forged, {}), null);
  assert.equal(clientIp(forged, { CLIENT_IP_SOURCE: "" }), null);
  assert.equal(clientIp(forged, { CLIENT_IP_SOURCE: "nonsense" }), null);
});

test("each source reads only the header its proxy sets", () => {
  assert.equal(clientIp(forged, { VERCEL: "1" }), "198.51.100.8", "Vercel overwrites x-real-ip");
  assert.equal(clientIp(forged, { CLIENT_IP_SOURCE: "header:x-real-ip" }), "198.51.100.8");
  // An appending proxy (AWS ALB) adds the address it saw last; anything before it came from the client.
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.4" }), { CLIENT_IP_SOURCE: "xff-rightmost" }), "203.0.113.4");
  assert.equal(clientIp(new Headers({ "x-real-ip": "not-an-ip" }), { VERCEL: "1" }), null);
  assert.equal(clientIp(new Headers({ "x-real-ip": "1".repeat(60) }), { VERCEL: "1" }), null);
  assert.equal(clientIp(new Headers(), { VERCEL: "1" }), null);
});

test("IPv6 clients share a limit across their /64; IPv4 and mapped IPv4 are per address", () => {
  assert.equal(ipBucket("203.0.113.4"), "203.0.113.4");
  assert.equal(ipBucket("::ffff:203.0.113.4"), "203.0.113.4");
  assert.equal(ipBucket("2001:db8:aa:bb:1:2:3:4"), "2001:db8:aa:bb::/64");
  assert.equal(ipBucket("2001:0db8:00aa:00bb::9"), "2001:db8:aa:bb::/64");
  assert.equal(ipBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipBucket("2001:db8:aa:bb:ffff::1"), ipBucket("2001:db8:aa:bb::2"));
});

test("limit keys are a keyed hash: stable, secret-dependent, and the same as Node's HMAC", async () => {
  const expected = createHmac("sha256", createHash("sha256").update("rate-limit:s3cret").digest()).update("a@b.co").digest("hex");
  assert.equal(await limitKey("a@b.co", "s3cret"), expected);
  assert.notEqual(await limitKey("a@b.co", "other"), expected);
  assert.match(expected, /^[a-f0-9]{64}$/);
});

test("variants of one inbox share a limit, but the address used to sign in and deliver is unchanged", () => {
  assert.equal(canonicalEmail("J.Doe+promo@GMail.com"), "jdoe@gmail.com");
  assert.equal(canonicalEmail("jdoe@googlemail.com"), "jdoe@gmail.com");
  assert.equal(canonicalEmail("jane.doe+x@company.com"), "jane.doe@company.com", "dots matter outside Gmail");
  assert.equal(canonicalEmail("+only@example.com"), "+only@example.com");
  assert.equal(emailAddress.parse(" J.Doe+promo@GMail.com "), "j.doe+promo@gmail.com");
});
