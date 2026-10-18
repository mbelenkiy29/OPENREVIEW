import test from "node:test";
import assert from "node:assert/strict";
import { decodeJwt, jwtVerify } from "jose";
import { userJotConfig, userJotIdentity, userJotToken } from "../src/userjot";
import { boardTitle, boardView, withoutEmbedTheme } from "../src/userjot-board";

const secret = "userjot-project-secret-for-tests";
const me = { user: { _id: "u123", login: "ada", avatar: "https://avatars.example/ada.png" }, email: "ada@example.com" };

test("UserJot is off unless a project ID is set, and always off in offline mode", () => {
  assert.equal(userJotConfig({}), null);
  assert.equal(userJotConfig({ NEXT_PUBLIC_USERJOT_PROJECT_ID: " " }), null);
  assert.equal(userJotConfig({ NEXT_PUBLIC_USERJOT_PROJECT_ID: "proj", OPENREVIEW_OFFLINE: "true" }), null);
  assert.deepEqual(userJotConfig({ NEXT_PUBLIC_USERJOT_PROJECT_ID: "proj" }), { projectId: "proj", boardUrl: undefined, secret: undefined });
  assert.deepEqual(userJotConfig({ NEXT_PUBLIC_USERJOT_PROJECT_ID: "proj", NEXT_PUBLIC_USERJOT_URL: "https://openreview.userjot.com/", USERJOT_PROJECT_SECRET: secret }), { projectId: "proj", boardUrl: "https://openreview.userjot.com", secret });
});

test("identity tokens carry the claims UserJot verifies and last exactly one hour", async () => {
  const now = Date.UTC(2026, 9, 17, 12);
  const token = await userJotToken({ id: "u123", email: "ada@example.com", firstName: "ada" }, { projectId: "proj", secret, now });
  const claims = decodeJwt(token);
  assert.equal(claims.sub, "u123");
  assert.equal(claims.iss, "proj");
  assert.equal(claims.aud, "userjot");
  assert.equal(claims.iat, now / 1000);
  assert.equal(claims.exp! - claims.iat!, 3600);
  assert.equal(claims.email, "ada@example.com");
  assert.equal(claims.firstName, "ada");
  const { protectedHeader } = await jwtVerify(token, new TextEncoder().encode(secret), { issuer: "proj", audience: "userjot", currentDate: new Date(now) });
  assert.equal(protectedHeader.alg, "HS256");
  await assert.rejects(jwtVerify(token, new TextEncoder().encode("another-secret-entirely"), { currentDate: new Date(now) }));
});

test("the widget identity is signed when a secret is set and unsigned otherwise", async () => {
  const user = { id: "u123", firstName: "ada", email: "ada@example.com", avatar: "https://avatars.example/ada.png" };
  assert.deepEqual(await userJotIdentity(me, { projectId: "proj" }), { user });
  const signed = await userJotIdentity(me, { projectId: "proj", secret });
  assert.deepEqual(signed.user, user);
  assert.equal(decodeJwt(signed.token!).sub, "u123");
  assert.deepEqual(await userJotIdentity({ user: { _id: "u9", login: "bob", avatar: "" } }, { projectId: "proj" }), { user: { id: "u9", firstName: "bob" } }, "no email or empty avatar is left out, never sent blank");
});

test("board paths map to the roadmap or the board, and nothing else does", () => {
  assert.equal(boardView("/feedback"), "feedback");
  assert.equal(boardView("/feedback/"), "feedback", "the embed writes a trailing slash");
  assert.equal(boardView("/feedback/board/p/dark-mode"), "feedback");
  assert.equal(boardView("/feedback/roadmap"), "roadmap");
  assert.equal(boardView("/feedback/roadmap/"), "roadmap");
  assert.equal(boardView("/feedback/roadmapping"), "feedback");
  assert.equal(boardView("/feedbacks"), null);
  assert.equal(boardView("/docs/quickstart"), null);
  assert.equal(boardTitle("/feedback/roadmap"), "Roadmap");
  assert.equal(boardTitle("/feedback/board/p/dark-mode"), "Feedback");
});

test("the embed's theme parameter is removed and every other parameter kept", () => {
  assert.equal(withoutEmbedTheme("https://openreview.tech/feedback"), null);
  assert.equal(withoutEmbedTheme("https://openreview.tech/feedback/?cursor=1&order=top"), null);
  assert.equal(withoutEmbedTheme("https://openreview.tech/feedback?theme=dark"), "https://openreview.tech/feedback");
  assert.equal(withoutEmbedTheme("https://openreview.tech/feedback/?cursor=1&order=top&limit=10&theme=dark"), "https://openreview.tech/feedback/?cursor=1&order=top&limit=10");
  assert.equal(withoutEmbedTheme("https://openreview.tech/feedback/roadmap?theme=light#planned"), "https://openreview.tech/feedback/roadmap#planned");
});
