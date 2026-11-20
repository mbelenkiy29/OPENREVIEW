import { scimRequest } from "../../../../../src/scim-server";

// SCIM 2.0 Groups (Enterprise): list and create. See docs/scim.md.
const handle = (request: Request) => scimRequest(request, "Groups");
export { handle as GET, handle as POST };
