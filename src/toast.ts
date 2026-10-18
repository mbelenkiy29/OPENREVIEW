import "server-only";
import { cookies } from "next/headers";

// One-shot message shown by the dashboard Toaster (app/ui/toaster.tsx) after a redirect or
// revalidation. Server actions and route handlers both set it.
export async function notify(message: string, tone: "success" | "error" = "success") {
  (await cookies()).set("openreview_toast", encodeURIComponent(JSON.stringify({ text: message.slice(0, 200), tone })), { path: "/", sameSite: "lax", maxAge: 30, httpOnly: false, secure: process.env.NODE_ENV === "production" });
}
