// SCIM 2.0 (RFC 7643/7644) subset for Enterprise provisioning: /Users and /Groups. Pure parsing and shaping; the
// workspace rules live in convex/scim.ts. Attributes this file does not name are ignored, as the RFC allows.
export const scimRoles = ["admin", "member", "viewer"] as const;
export type ScimRole = (typeof scimRoles)[number];
/** The role from several mapped groups: the one with most access. Owner is never assigned by SCIM. */
export const highestRole = (roles: ScimRole[]): ScimRole | null => scimRoles.find((r) => roles.includes(r)) ?? null;

const errorSchema = "urn:ietf:params:scim:api:messages:2.0:Error", listSchema = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User", groupSchema = "urn:ietf:params:scim:schemas:core:2.0:Group";
export type ScimReply = { status: number; body?: unknown };
export const scimError = (status: number, detail: string): ScimReply => ({ status, body: { schemas: [errorSchema], status: String(status), detail } });
export const scimList = (resources: unknown[], total: number, startIndex: number): ScimReply => ({ status: 200, body: { schemas: [listSchema], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources } });

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, max = 300) => typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined;
// Entra ID sends booleans as the strings "True" and "False".
const flag = (v: unknown) => typeof v === "boolean" ? v : typeof v === "string" && /^(true|false)$/i.test(v) ? v.toLowerCase() === "true" : undefined;
const emailLike = (v: string | undefined) => v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : undefined;

/** `attribute eq "value"`, the only filter identity providers need here. undefined: no filter; null: not supported. */
export function filterValue(filter: string | undefined | null, attribute: string): string | undefined | null {
  if (!filter?.trim()) return undefined;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  return m && m[1].toLowerCase() === attribute.toLowerCase() ? m[2].replace(/\\(.)/g, "$1") : null;
}
export const paging = (startIndex: string | null | undefined, count: string | null | undefined) => ({ startIndex: Math.max(1, Math.floor(Number(startIndex)) || 1), count: Math.min(200, Math.max(0, count === null || count === undefined || count === "" ? 100 : Math.floor(Number(count)) || 0)) });

export type UserInput = { userName?: string; externalId?: string; displayName?: string; active?: boolean };
/** A user resource from POST or PUT. userName must be the person's email: it is how the account is matched. */
export function userInput(body: unknown): UserInput {
  const b = record(body), name = record(b.name);
  return { userName: emailLike(text(b.userName)), externalId: text(b.externalId), displayName: text(b.displayName) ?? text(name.formatted) ?? text([name.givenName, name.familyName].filter((p) => typeof p === "string").join(" ")), active: flag(b.active) };
}
type Op = { op: string; path?: string; value?: unknown };
const operations = (body: unknown): Op[] => (Array.isArray(record(body).Operations) ? record(body).Operations as unknown[] : []).slice(0, 100).map((o) => ({ op: String(record(o).op ?? "").toLowerCase(), path: text(record(o).path), value: record(o).value }));
/** PATCH on a user: `replace` (or `add`) of active, userName, displayName, by path or as an object of attributes. */
export function userPatch(body: unknown): UserInput {
  const out: UserInput = {};
  for (const o of operations(body)) {
    if (o.op !== "replace" && o.op !== "add") continue;
    const values = o.path ? { [o.path]: o.value } : record(o.value);
    for (const [key, value] of Object.entries(values)) {
      const k = key.toLowerCase();
      if (k === "active") out.active = flag(value) ?? out.active;
      else if (k === "username") out.userName = emailLike(text(value)) ?? out.userName;
      else if (k === "displayname") out.displayName = text(value) ?? out.displayName;
      else if (k === "externalid") out.externalId = text(value) ?? out.externalId;
    }
  }
  return out;
}
const memberIds = (v: unknown) => (Array.isArray(v) ? v : []).flatMap((m) => { const id = text(record(m).value ?? m, 64); return id ? [id] : []; }).slice(0, 1000);
export type GroupInput = { displayName?: string; externalId?: string; members?: string[] };
export const groupInput = (body: unknown): GroupInput => { const b = record(body); return { displayName: text(b.displayName, 200), externalId: text(b.externalId), ...(b.members === undefined ? {} : { members: memberIds(b.members) }) }; };
/** PATCH on a group: add or remove members, or replace the member list or the name. */
export function groupPatch(body: unknown): { displayName?: string; add: string[]; remove: string[]; replace?: string[] } {
  const out: { displayName?: string; add: string[]; remove: string[]; replace?: string[] } = { add: [], remove: [] };
  for (const o of operations(body)) {
    const path = o.path?.toLowerCase(), one = /^members\[value eq "([^"]{1,64})"\]$/i.exec(o.path ?? "")?.[1];
    if (o.op === "remove") { if (one) out.remove.push(one); else if (path === "members") { const ids = memberIds(o.value); if (ids.length) out.remove.push(...ids); else out.replace = []; } }
    else if (o.op === "add" && (path === "members" || !path)) out.add.push(...memberIds(path ? o.value : record(o.value).members));
    else if (o.op === "replace") {
      const values = path ? { [path]: o.value } : record(o.value);
      for (const [key, value] of Object.entries(values)) { const k = key.toLowerCase(); if (k === "members") out.replace = memberIds(value); else if (k === "displayname") out.displayName = text(value, 200) ?? out.displayName; }
    }
  }
  return out;
}

const meta = (type: "User" | "Group", base: string, id: string, created: number, modified: number) => ({ resourceType: type, created: new Date(created).toISOString(), lastModified: new Date(modified).toISOString(), location: `${base}/${type}s/${id}` });
export const userResource = (u: { _id: string; userName: string; externalId?: string; displayName?: string; active: boolean; createdAt: number; updatedAt: number }, base: string) => ({ schemas: [userSchema], id: u._id, userName: u.userName, ...(u.externalId ? { externalId: u.externalId } : {}), ...(u.displayName ? { displayName: u.displayName } : {}), active: u.active, emails: [{ value: u.userName, primary: true }], meta: meta("User", base, u._id, u.createdAt, u.updatedAt) });
export const groupResource = (g: { _id: string; displayName: string; externalId?: string; members: string[]; createdAt: number; updatedAt: number }, base: string) => ({ schemas: [groupSchema], id: g._id, displayName: g.displayName, ...(g.externalId ? { externalId: g.externalId } : {}), members: g.members.map((value) => ({ value })), meta: meta("Group", base, g._id, g.createdAt, g.updatedAt) });
