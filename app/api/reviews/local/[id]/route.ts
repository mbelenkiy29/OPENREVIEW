import { api } from "../../../../../convex/_generated/api";
import { apiFailure, apiIdentity } from "../../../../../src/api-auth";
import { backend } from "../../../../../src/server";

// Status, stage and (once completed) the summary and findings of a local review; requester only.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { token, organizationId } = await apiIdentity(request, "read");
    const { id } = await params;
    try {
      return Response.json(await backend().query(api.cliReviews.progress, { token, organizationId, id }), { headers: { "cache-control": "no-store" } });
    } catch { return Response.json({ error: "Review not found" }, { status: 404 }); }
  } catch (error) {
    return apiFailure(error, { status: 400, error: "Invalid request" });
  }
}
