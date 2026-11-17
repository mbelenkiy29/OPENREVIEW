import test from "node:test";
import assert from "node:assert/strict";
import { originWebhookResponse, providerWebhookResponse, webhookErrorMessage } from "../src/webhook-http";

test("Convex-wrapped webhook errors expose the inner message", () => {
  assert.equal(
    webhookErrorMessage(new Error("[CONVEX A(providerJobs:webhook)] [Request ID: abc] Server Error\nUncaught Error: Invalid webhook signature\n")),
    "Invalid webhook signature",
  );
  assert.equal(webhookErrorMessage(new Error("Invalid Origin signature")), "Invalid Origin signature");
});

test("provider webhook failures map signature errors to 401, bad JSON to 400, and backend failures to 503", async () => {
  const unauthorized = providerWebhookResponse(new Error("Uncaught Error: Invalid webhook signature"));
  assert.equal(unauthorized.status, 401);
  assert.equal(await unauthorized.text(), "Invalid or unauthorized delivery");
  const badJson = providerWebhookResponse(new Error("Invalid JSON body"));
  assert.equal(badJson.status, 400);
  const unavailable = providerWebhookResponse(new Error("Connection disabled"));
  assert.equal(unavailable.status, 503);
  assert.equal(await unavailable.text(), "Delivery unavailable");
});

test("Origin webhook failures map signature errors to 401 instead of 503", async () => {
  const unauthorized = originWebhookResponse(new Error("Uncaught Error: Invalid Origin signature"));
  assert.equal(unauthorized.status, 401);
  assert.equal(await unauthorized.text(), "Invalid or unauthorized Origin delivery");
  const badJson = originWebhookResponse(new Error("Invalid Origin JSON body"));
  assert.equal(badJson.status, 400);
  const down = originWebhookResponse(new Error("fetch failed"));
  assert.equal(down.status, 503);
});
