import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { service } from "./auth";
import { rateLimit } from "./rateLimit";

// Rate limits for the public /ci repository check (app/api/ci/audit/route.ts). Each check spends up to
// a few hundred requests of the operator's GitHub token, so the whole deployment gets 60 an hour and
// one address 6. Cached answers (a CDN hit on the same repository) never reach this.
export const allowPublicCheck = mutation({
  args: { secret: v.string(), ipHash: v.optional(v.string()) },
  handler: async (ctx, a) => {
    service(a.secret);
    await rateLimit(ctx, "ci-audit-public", 60, 3600000);
    if (a.ipHash && /^[a-f0-9]{64}$/.test(a.ipHash)) await rateLimit(ctx, `ci-audit-public:ip:${a.ipHash}`, 6, 3600000);
    return null;
  },
});
