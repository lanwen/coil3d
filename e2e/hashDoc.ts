// Test-only helper (issue #56): decodes the current `#s=<base64url(JSON)>`
// hash back to its raw document, so e2e specs can assert on a spec field
// having changed without depending on the old flat `key=value` substrings
// the hash used to be made of (see src/core/hash.ts's own file header for
// why the format changed). Mirrors hash.ts's own base64url decode -- not
// the codec's public interface, which stays exactly `parseHash`/`toHash`.
//
// `view` and the wire-visibility toggle are deliberately NOT part of this
// document (see hash.ts's file header) -- they stay plain, literal
// `&view=guide`/`&wire=0` suffixes outside the `s=` value, so specs that
// check for those (guide.spec.ts, wire.spec.ts) keep using a plain
// substring/regex check on `page.url()` instead of this helper.
export function decodeHashDoc(url: string): Record<string, unknown> {
  const hash = new URL(url).hash;
  const s = new URLSearchParams(hash.replace(/^#/, "")).get("s");
  if (s === null) return {};
  const base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
}
