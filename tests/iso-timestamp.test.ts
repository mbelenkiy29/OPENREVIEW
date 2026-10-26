import { test } from "node:test";
import assert from "node:assert/strict";
import { isoTimestamp } from "../src/iso-timestamp";

test("isoTimestamp accepts what zod 3's datetime({ offset: true }) did, including Jira's +0000 offsets", () => {
  for (const value of ["2026-10-20T12:00:00Z", "2026-10-20T12:00:00.000+00:00", "2026-10-20T12:00:00.000+0000", "2026-10-20T12:00:00.123456789-07:00", "2026-10-20T12:00Z", "2024-02-29T00:00:00Z"])
    assert.ok(isoTimestamp.safeParse(value).success, value);
  for (const value of ["2026-10-20T12:00:00+02", "2026-10-20 12:00:00Z", "2026-02-30T00:00:00Z", "2025-02-29T00:00:00Z", "2026-10-20T24:00:00Z", "2026-10-20T12:00:00"])
    assert.ok(!isoTimestamp.safeParse(value).success, value);
});
