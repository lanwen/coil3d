// Test-only helper (issue #56): decodes the current `#s=<base64url(JSON)>`
// hash back to its raw document, so e2e specs can assert on a spec (or
// view-only `ui`) field having changed without depending on the old flat
// `key=value` substrings the hash used to be made of (see
// src/core/hash.ts's own file header for the document's shape). Mirrors
// hash.ts's own base64url decode -- not the codec's public interface, which
// stays exactly `parseHash`/`toHash`.
//
// The wire-visibility toggle and the design/guide view both live nested
// under the document's own `ui` key (e.g. `decodeHashDoc(url).ui?.wire`,
// `.ui?.view`) -- see guide.spec.ts/wire.spec.ts for their own use of this.
export function decodeHashDoc(url: string): Record<string, unknown> {
  const hash = new URL(url).hash;
  const s = new URLSearchParams(hash.replace(/^#/, "")).get("s");
  if (s === null) return {};
  const base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
}
