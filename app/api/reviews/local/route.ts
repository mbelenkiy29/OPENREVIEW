import { api } from "../../../../convex/_generated/api";
import { apiFailure, apiIdentity } from "../../../../src/api-auth";
import { backend } from "../../../../src/server";
import { backendFailure } from "../../../../src/public-api";
import { localReviewRequest } from "../../../../src/cli-review";

// Review local commits (the CLI's logged-in `openreview review`): queues a server-side review of the
// uploaded diff and changed files; poll GET /api/reviews/local/{id} for the result.
export async function POST(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request, "write");
    const body = localReviewRequest.parse(await request.json());
    let started;
    try {
      started = await backend().action(api.cliReviews.start, { token, organizationId, ...body });
    } catch (error) { return backendFailure(error) ?? Response.json({ error: "Review rejected" }, { status: 400 }); }
    if ("refused" in started) return Response.json({ error: started.refused }, { status: started.status });
    return Response.json({ reviewId: started.id, status: "queued" }, { status: 202 });
  } catch (error) {
    return apiFailure(error, { status: 400, error: "Invalid request" });
  }
}
