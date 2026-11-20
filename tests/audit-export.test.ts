import { test } from "node:test";
import assert from "node:assert/strict";
import { auditCsvRow, auditExportRange } from "../src/audit-export";

test("the export range is whole UTC days, both ends included", () => {
  assert.deepEqual(auditExportRange("2026-11-01", "2026-11-01"), { from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 2) });
  assert.deepEqual(auditExportRange("2026-01-01", "2026-12-31"), { from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 0, 1) });
  for (const [from, to] of [["", ""], ["2026-11-02", "2026-11-01"], ["11/01/2026", "2026-11-02"], ["2010-01-01", "2026-01-01"]]) assert.ok("error" in auditExportRange(from, to), `${from}..${to}`);
});
test("CSV rows quote commas and quotes, and never start a cell with a formula", () => {
  assert.equal(auditCsvRow({ at: Date.UTC(2026, 10, 1, 12), action: "billing.plan_changed", actor: "ada", target: "pro" }), "2026-11-01T12:00:00.000Z,billing.plan_changed,ada,pro\n");
  assert.equal(auditCsvRow({ at: 0, action: "x", actor: 'a "b", c', target: "=HYPERLINK(1)" }), '1970-01-01T00:00:00.000Z,x,"a ""b"", c",\'=HYPERLINK(1)\n');
});
