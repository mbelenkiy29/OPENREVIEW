import { securityTxt } from "../../../src/security-txt";

// Static, regenerated daily so its expiry date keeps moving forward.
export const dynamic = "force-static";
export const revalidate = 86400;

export function GET() {
  const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
  return new Response(securityTxt(origin), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
