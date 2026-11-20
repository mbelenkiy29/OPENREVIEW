import { createHash } from "node:crypto";
import { api } from "../convex/_generated/api";
import { backend } from "./server";
import { scimError } from "./scim";

// The web side of SCIM (app/api/scim/v2): reads the bearer token and the JSON body, and hands the request to
// convex/scim.ts, which finds the workspace from the token's hash and applies it in one transaction.
const reply = (r: { status: number; body?: unknown }) => new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/scim+json", "cache-control": "no-store" } });
export async function scimRequest(request: Request, resource: "Users" | "Groups", id?: string): Promise<Response> {
  const bearer = /^Bearer\s+(\S{20,200})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!bearer) return reply(scimError(401, "Send the SCIM token as a bearer token"));
  let body: string | undefined;
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    body = await request.text();
    if (body.length > 900_000) return reply(scimError(413, "Request body too large"));
  }
  const q = new URL(request.url).searchParams, param = (name: string) => { const value = q.get(name); return value === null ? {} : { [name]: value.slice(0, 500) }; };
  try {
    return reply(await backend().mutation(api.scim.handle, { secret: process.env.SERVICE_SECRET ?? "", tokenHash: createHash("sha256").update(bearer).digest("hex"), baseUrl: `${new URL(process.env.APP_URL ?? request.url).origin}/api/scim/v2`, resource, method: request.method, ...(id ? { id: id.slice(0, 64) } : {}), ...(body === undefined ? {} : { body }), ...param("filter"), ...param("startIndex"), ...param("count") }));
  } catch (error) {
    return reply(error instanceof Error && error.message.includes("Rate limit exceeded") ? scimError(429, "Too many requests; retry in a minute") : scimError(500, "The request could not be completed"));
  }
}
