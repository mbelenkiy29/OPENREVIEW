import { test } from "node:test";
import assert from "node:assert/strict";
import { chartScale, linePoints, niceTicks, segments } from "../src/charts";

test("chart geometry: shared zero-based scale, padded points, gaps split lines", () => {
  assert.equal(chartScale([{ label: "a", values: [1, 5, null] }, { label: "b", values: [3, Number.NaN] }]), 5);
  assert.equal(chartScale([{ label: "a", values: [0, 0] }]), 1, "flat zero series still has a scale");
  assert.deepEqual(linePoints([0, 5, 10], 10, 104, 104), ["4.0,100.0", "52.0,52.0", "100.0,4.0"]);
  assert.deepEqual(linePoints([7], 10, 104, 104), ["52.0,32.8"], "a single point is centred");
  assert.deepEqual(linePoints([-3], 10, 104, 104), ["52.0,100.0"], "negative values clamp to the baseline");
  assert.deepEqual(segments(["1,1", "2,2", null, "4,4", null, null, "6,6", "7,7"]), ["1,1 2,2", "4,4", "6,6 7,7"]);
  assert.deepEqual(segments([null, null]), []);
});

test("nice ticks: zero-based, about four even steps, last at or above the maximum", () => {
  assert.deepEqual(niceTicks(2), [0, 0.5, 1, 1.5, 2]);
  assert.deepEqual(niceTicks(3), [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(7), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(37), [0, 10, 20, 30, 40]);
  assert.deepEqual(niceTicks(100), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(0.3), [0, 0.1, 0.2, 0.3]);
});
