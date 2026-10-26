import "server-only";
import { cookies } from "next/headers";

// One-shot message shown by the dashboard Toaster (app/ui/toaster.tsx) after a redirect or
// revalidation. Server actions and route handlers both set it. Next URI-encodes cookie values itself, and
// the Toaster decodes once, so the JSON goes in as is (encoding it here too made every toast unreadable).
export async function notify(message: string, tone: "success" | "error" = "success") {
  (await cookies()).set("openreview_toast", JSON.stringify({ text: message.slice(0, 200), tone }), { path: "/", sameSite: "lax", maxAge: 30, httpOnly: false, secure: process.env.NODE_ENV === "production" });
}
