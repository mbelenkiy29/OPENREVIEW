// Audit log export (app/api/audit/export): the date range and the CSV row.
const dayStart = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : NaN;
/** from and to are UTC dates (YYYY-MM-DD), both included; at most ten years. */
export function auditExportRange(from: string, to: string): { from: number; to: number } | { error: string } {
  const start = dayStart(from), end = dayStart(to) + 86_400_000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: "from and to are dates like 2026-11-01" };
  if (start >= end || end - start > 3660 * 86_400_000) return { error: "The range must start on or before its end and cover at most ten years" };
  return { from: start, to: end };
}
// A cell that starts with = + - @ (or a tab or return) is a formula to a spreadsheet; a leading quote makes it text.
const cell = (value: string) => { const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value; return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v; };
export const auditCsvRow = (e: { at: number; action: string; actor: string; target: string }) => `${[new Date(e.at).toISOString(), e.action, e.actor, e.target].map(cell).join(",")}\n`;
