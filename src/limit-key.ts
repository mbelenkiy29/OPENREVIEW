// A keyed hash (HMAC-SHA256) for rate-limit keys and logs, so neither email addresses nor IPs are
// stored or logged. The key derives from SERVICE_SECRET, which the web app and Convex share, and Web
// Crypto runs in both (Node and Convex's default runtime), so a value hashes the same everywhere.
const encoder = new TextEncoder();
export async function limitKey(value: string, secret = process.env.SERVICE_SECRET ?? "") {
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(`rate-limit:${secret}`));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
