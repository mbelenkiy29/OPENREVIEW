import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LevelSlider, Stepper, TagInput, SaveBar } from "../app/dashboard/review-controls";
import { SummarySettings } from "../app/dashboard/summary-settings";

// Code Review Settings' Greptile controls must submit the same fields saveSettings reads.
test("review setting controls submit the fields saveSettings reads", () => {
  // tsx compiles these components' JSX to React.createElement without importing React.
  Object.assign(globalThis, { React });
  const stops = [{ value: "0", label: "Custom", help: "c" }, { value: "2", label: "Medium", help: "Balanced" }];
  const slider = renderToStaticMarkup(createElement(LevelSlider, { id: "s", name: "strictness", title: "Strictness level", stops, value: "2" }));
  assert.match(slider, /<input type="hidden" name="strictness" value="2"\/>/);
  assert.match(slider, /aria-valuetext="Medium"/);
  assert.match(slider, />Balanced</);
  assert.match(renderToStaticMarkup(createElement(TagInput, { id: "t", name: "excludedAuthors", value: ["dependabot[bot]", "*-bot"] })), /name="excludedAuthors" value="dependabot\[bot\], \*-bot"/);
  assert.match(renderToStaticMarkup(createElement(Stepper, { id: "m", name: "minimumConfidence", value: 0.92, min: 0.5, max: 1, step: 0.01 })), /type="number"[^>]*name="minimumConfidence" value="0.92"/);
  // Before hydration the save bar stays visible, so the form can always be submitted.
  assert.doesNotMatch(renderToStaticMarkup(createElement(SaveBar)), /data-clean/);
  const summary = renderToStaticMarkup(createElement(SummarySettings, { initial: ["overview", "score"], style: "detailed" }));
  assert.match(summary, /name="summaryConfigured" value="true"/);
  const on = [...summary.matchAll(/<input[^>]*name="summarySections"[^>]*>/g)].filter((m) => m[0].includes('checked=""')).map((m) => m[0].match(/value="(\w+)"/)?.[1]);
  assert.deepEqual(on, ["overview", "score"]);
  assert.match(summary, /<select[^>]*name="commentStyle"/);
});
