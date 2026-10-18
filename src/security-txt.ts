// /.well-known/security.txt (RFC 9116): where to report a vulnerability. The contact is the same
// address the Privacy Policy and Terms use; a self-hosted deployment can change it here.
export const securityContact = "mbelenkiy29@gmail.com";

/** The file's text. `Expires` must be within a year; the route regenerates it daily. */
export function securityTxt(origin: string, now = new Date()) {
  const expires = new Date(now.getTime() + 180 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    `Contact: mailto:${securityContact}`,
    `Expires: ${expires}`,
    "Preferred-Languages: en",
    `Policy: ${origin}/security`,
    `Canonical: ${origin}/.well-known/security.txt`,
    "",
  ].join("\n");
}
