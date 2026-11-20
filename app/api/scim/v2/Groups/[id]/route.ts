import { scimRequest } from "../../../../../../src/scim-server";

// SCIM 2.0 Groups (Enterprise): read, replace, patch and delete one. See docs/scim.md.
const handle = async (request: Request, { params }: { params: Promise<{ id: string }> }) => scimRequest(request, "Groups", (await params).id);
export { handle as GET, handle as PUT, handle as PATCH, handle as DELETE };
