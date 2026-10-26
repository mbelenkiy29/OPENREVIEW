// The visitor's address for rate limits, read only from a header that something we trust sets.
// On Vercel the platform overwrites x-real-ip; elsewhere Next keeps whatever x-forwarded-for the client
// sent, so a self-hosted install trusts nothing until CLIENT_IP_SOURCE names its proxy's header:
//   vercel          x-real-ip (the default when VERCEL=1)
//   header:<name>   a header the proxy overwrites, e.g. header:x-real-ip behind nginx
//   xff-rightmost   the last X-Forwarded-For entry, which an appending proxy (AWS ALB) adds
// Without one there is no address and the per-IP limit is skipped rather than guessed.
import { isIP } from "node:net";

export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string | null {
  const source = env.CLIENT_IP_SOURCE?.trim() || (env.VERCEL === "1" ? "vercel" : "");
  const value = source === "vercel" ? headers.get("x-real-ip")
    : source.startsWith("header:") ? headers.get(source.slice(7).trim())
    : source === "xff-rightmost" ? headers.get("x-forwarded-for")?.split(",").at(-1)
    : null;
  const ip = value?.trim().split("%")[0];
  return ip && ip.length <= 45 && isIP(ip) ? ip : null;
}

/** The limit bucket for an address: IPv4 as is, IPv6 by its /64 (what one subscriber is usually given). */
export function ipBucket(ip: string) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (isIP(ip) !== 6) return ip;
  const groups = (part: string) => part ? part.split(":").flatMap((g) => g.includes(".") ? ["0", "0"] : [g]) : [];
  const [head, tail] = ip.toLowerCase().split("::"), h = groups(head), t = tail === undefined ? [] : groups(tail);
  const all = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${all.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
