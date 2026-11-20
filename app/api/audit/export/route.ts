import { cookies } from "next/headers";
import { current, backend } from "../../../../src/server";
import { api } from "../../../../convex/_generated/api";
import { auditCsvRow, auditExportRange } from "../../../../src/audit-export";

// Audit log export for workspace admins on Enterprise: GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|json.
// Rows are read a page at a time and streamed, so a long range never has to fit in memory or one query.
export async function GET(request: Request) {
  const user = await current(), jar = await cookies();
  const org = user.organizations.find((o) => o._id === jar.get("openreview_workspace")?.value) ?? user.organizations[0];
  const organizationId = org?._id;
  if (!organizationId) return new Response("Workspace required", { status: 403 });
  const q = new URL(request.url).searchParams, range = auditExportRange(q.get("from") ?? "", q.get("to") ?? ""), json = q.get("format") === "json";
  if ("error" in range) return new Response(range.error, { status: 400 });
  const load = (cursor?: string) => backend().query(api.scopes.activityExport, { token: user.token, organizationId, ...range, ...(cursor ? { cursor } : {}) });
  // The first page is read before the response starts, so a refusal (not an admin, not on Enterprise) is a status code.
  let page: Awaited<ReturnType<typeof load>>;
  try { page = await load(); } catch { return new Response("Audit log export needs a workspace admin on the Enterprise plan", { status: 403 }); }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ async start(controller) {
    const write = (text: string) => controller.enqueue(encoder.encode(text));
    try {
      let first = true;
      write(json ? "[" : "when_utc,action,actor,target\n");
      for (;;) {
        for (const e of page.page) { write(json ? `${first ? "" : ","}\n${JSON.stringify({ at: new Date(e.at).toISOString(), action: e.action, actor: e.actor, target: e.target })}` : auditCsvRow(e)); first = false; }
        if (page.isDone) break;
        page = await load(page.continueCursor);
      }
      if (json) write("\n]\n");
      controller.close();
    } catch (error) { controller.error(error); }
  } });
  return new Response(body, { headers: { "content-type": json ? "application/json" : "text/csv; charset=utf-8", "content-disposition": `attachment; filename="openreview-audit-${q.get("from")}-to-${q.get("to")}.${json ? "json" : "csv"}"`, "cache-control": "no-store" } });
}
