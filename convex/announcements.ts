// "What's new" pop-up (src/announcements.ts): closing it records the announcement on the user, so it
// never opens on its own again for them. Unknown ids are ignored.
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { authenticated } from "./auth";
import { announcements } from "../src/announcements";

export const dismiss = mutation({ args: { token: v.string(), id: v.string() }, handler: async (ctx, a) => {
  const user = await authenticated(ctx, a.token);
  if (!announcements.some((x) => x.id === a.id) || user.dismissedAnnouncements?.includes(a.id)) return;
  await ctx.db.patch(user._id, { dismissedAnnouncements: [...(user.dismissedAnnouncements ?? []), a.id].slice(-100) });
} });
