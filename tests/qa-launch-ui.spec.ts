import { expect, test, vi } from "vitest";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/dashboard/context", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => createElement("a", { href, className }, children) }));

import { ChartCard } from "../app/dashboard/analytics-chart";
import { ContextTable } from "../app/dashboard/context-client";

test("a zero-data count chart shows integer ticks and No reviews yet", () => {
  const html = renderToStaticMarkup(createElement(ChartCard, {
    icon: "gitPullRequest",
    title: "Reviews by OpenReview",
    labels: ["2026-01-01", "2026-01-02", "2026-01-03"],
    views: [{ label: "Reviews", kind: "bar", series: [{ label: "Reviews", values: [0, 0, 0] }], yTitle: "Reviews", empty: "No reviews yet" }],
  }));
  expect(html).toContain("No reviews yet");
  expect(html).not.toMatch(/>0\.5</);
  expect(html).toMatch(/>0</);
  expect(html).toMatch(/>1</);
});

test("an empty custom context table is an empty state without a header row", () => {
  const html = renderToStaticMarkup(createElement(ContextTable, {
    label: "Custom rules",
    columns: ["Rules", "Scope", "Type", "Usage", "Last updated", "Status"],
    rows: [],
    empty: createElement("div", { className: "empty-state" }, createElement("strong", null, "No custom rules yet"), createElement("p", null, "Teach OpenReview your conventions."), createElement("div", { className: "actions" }, createElement("button", { className: "primary" }, "Add Context"))),
  }));
  expect(html).toContain("ctx-empty-page");
  expect(html).toContain("No custom rules yet");
  expect(html).toContain("Add Context");
  expect(html).not.toContain("<thead>");
  expect(html).not.toContain("Last updated");
});

