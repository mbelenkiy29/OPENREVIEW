import { changedLines, riskScore } from "./engine/classify";
import type { ChangedFile } from "./engine/types";

// Per-pull-request review tier: an explicit comment command, then an openreview:<tier> label, then the
// configured tier (settings, raised by touched .openreview/ folders). A request can raise the configured
// tier, never lower it. An admin cap always applies last.
export const tiers = ["fast", "standard", "deep"] as const;
export type Tier = (typeof tiers)[number];
// "auto" is a configured value only: it counts as no tier, so any explicit tier (folder, label, comment) beats it.
export const modes = [...tiers, "auto"] as const;
export type Mode = (typeof modes)[number];
// Auto: pick the tier from the pull request's size and its riskiest file. Generated, lock and docs
// files (negative riskScore) don't count toward size, so a lockfile bump stays cheap.
export function autoTier(diff: readonly ChangedFile[]): Tier {
  const scored = diff.map((file) => ({ file, risk: riskScore(file) })).filter((f) => f.risk >= 0);
  const lines = scored.reduce((sum, f) => sum + changedLines(f.file), 0), risk = Math.max(0, ...scored.map((f) => f.risk));
  if (lines >= 1000 || (risk >= 50 && lines >= 200)) return "deep";
  return risk < 20 && lines <= 50 ? "fast" : "standard";
}
export const reviewCommandPattern = /@openreview\s+review(?:\s+(again|security|fast|standard|deep))?\b/i;
// A bare mention asks for a review, as a bare @greptileai does, not an empty question.
export const wantsReview = (body: string) => reviewCommandPattern.test(body) || /^\s*@openreview[\s.!?]*$/i.test(body);
export function reviewCommand(body: string): { category?: "security"; mode?: Tier } | null {
  const m = reviewCommandPattern.exec(body);
  if (!m) return null;
  const word = m[1]?.toLowerCase();
  return word === "security" ? { category: "security" } : word && (tiers as readonly string[]).includes(word) ? { mode: word as Tier } : {};
}
const labelPattern = /^openreview:(fast|standard|deep)$/i;
export const isTierLabel = (label: string) => labelPattern.test(label.trim());
// Several tier labels: the highest wins.
export function labelTier(labels: readonly string[]): Tier | undefined {
  const found = labels.map((l) => labelPattern.exec(l.trim())?.[1]?.toLowerCase() as Tier | undefined).filter((t): t is Tier => !!t);
  return found.sort((a, b) => tiers.indexOf(b) - tiers.indexOf(a))[0];
}
// With a fixed configured tier a request can only raise it; "auto" counts as no tier, so any request wins.
export function resolveTier(a: { configured: Mode; diff?: readonly ChangedFile[]; requested?: { mode: Tier; source: "comment" | "label" }; cap?: Tier }) {
  const auto = a.configured === "auto";
  const requested = a.requested && (auto || tiers.indexOf(a.requested.mode) > tiers.indexOf(a.configured as Tier)) ? a.requested : undefined;
  const wanted = requested?.mode ?? (auto ? autoTier(a.diff ?? []) : (a.configured as Tier)), source = requested?.source ?? (auto ? "auto" : "settings");
  const cap = a.cap ?? "deep", capped = tiers.indexOf(wanted) > tiers.indexOf(cap);
  return { mode: capped ? cap : wanted, source, capped, requested: wanted } as const;
}
