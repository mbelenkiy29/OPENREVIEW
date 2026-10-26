import { z } from "zod";

// zod 3's .datetime({ offset: true }), kept for provider timestamps: zod 4 rejects "+0000" offsets (Jira sends them)
// and times without seconds, which zod 3 accepted.
const date = String.raw`((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))`;
export const isoTimestamp = z.string().regex(new RegExp(String.raw`^${date}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|([+-]\d{2}:?\d{2}))$`), "Invalid ISO datetime");
