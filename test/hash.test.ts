import { describe, expect, it } from "vitest";
import { DEFAULT_SHOW_WIRE, DEFAULT_SPEC, parseHash, toHash } from "../src/core";
import type { CoilSpec } from "../src/core";

/**
 * Decodes a `#s=<base64url(JSON)>` hash back to its raw document, purely for
 * asserting on the wire format's own shape in these tests (issue #56 AC:
 * "the hash is `#s=<base64url(...)>`, with a version field inside"). This is
 * NOT part of the codec's public interface (`parseHash`/`toHash` only) --
 * it's a test-only mirror of `hash.ts`'s own `base64UrlToBytes`. Reads the
 * `s` param via `URLSearchParams` (not a plain string slice) because `wire`
 * -- deliberately kept OUTSIDE the document, see hash.ts's file header --
 * can sit alongside it as its own literal `&wire=0` companion param.
 */
function decodeDoc(hash: string): Record<string, unknown> {
  expect(hash).toMatch(/^#s=/);
  const encoded = new URLSearchParams(hash.slice(1)).get("s")!;
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
}

describe("parseHash / toHash (issue #56: versioned base64url JSON hash)", () => {
  it("parses an empty hash as the defaults, with no notice", () => {
    expect(parseHash("")).toEqual({ spec: DEFAULT_SPEC, showWire: DEFAULT_SHOW_WIRE });
    expect(parseHash("#")).toEqual({ spec: DEFAULT_SPEC, showWire: DEFAULT_SHOW_WIRE });
  });

  it("encodes as #s=<base64url(JSON)>, with a numeric version field inside, and omits fields equal to the default", () => {
    const hash = toHash(DEFAULT_SPEC);
    expect(hash).toMatch(/^#s=[A-Za-z0-9_-]+$/); // base64url alphabet only -- no +, /, = or & to clash with URLSearchParams
    expect(decodeDoc(hash)).toEqual({ v: 2 });
  });

  it("accepts a hash that only overrides one field", () => {
    const hash = toHash({ ...DEFAULT_SPEC, wire: { ...DEFAULT_SPEC.wire, diameter: 6 } });
    expect(decodeDoc(hash)).toEqual({ v: 2, d: 6 });
    expect(parseHash(hash)).toEqual({
      spec: { ...DEFAULT_SPEC, wire: { ...DEFAULT_SPEC.wire, diameter: 6 } },
      showWire: DEFAULT_SHOW_WIRE,
    });
  });

  it("round-trips a non-default spec with default locks", () => {
    const spec: CoilSpec = {
      ...DEFAULT_SPEC,
      wire: { length: 5000, diameter: 8, type: "usb" },
      coreSize: { locked: true, dimension: "outer", value: 60 },
    };
    expect(parseHash(toHash(spec))).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("round-trips locking height and outer size, with lock as a real JSON array (issue #5 example: lock=h,outer)", () => {
    const spec: CoilSpec = {
      ...DEFAULT_SPEC,
      coreSize: { locked: true, dimension: "outer", value: 160 },
      height: { locked: true, value: 75 },
      layers: { locked: false },
    };
    const hash = toHash(spec);
    const doc = decodeDoc(hash);
    expect(Array.isArray(doc.lock)).toBe(true);
    expect(new Set(doc.lock as string[])).toEqual(new Set(["h", "outer"]));
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("round-trips a locked inner bore, a custom wire type, quality and objective", () => {
    const spec: CoilSpec = {
      wire: { length: 3000, diameter: 4, type: "custom", customBendMultiplier: 7 },
      shape: { kind: "round" },
      windingQuality: 0.4,
      coreSize: { locked: true, dimension: "inner", value: 25 },
      height: { locked: true, value: 50 },
      layers: { locked: false },
      objective: "aspectRatio",
      topCap: "auto",
      joint: "press",
      tolerance: 0.2,
      print: { bedX: 256, bedY: 256, bedZ: 256 },
      mount: "none",
      plateJoint: "glue",
    };
    expect(parseHash(toHash(spec))).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("round-trips a fully free (0-locked) and a fully locked (3-locked) spec", () => {
    const free: CoilSpec = { ...DEFAULT_SPEC, coreSize: { locked: false }, layers: { locked: false } };
    expect(parseHash(toHash(free))).toEqual({ spec: free, showWire: DEFAULT_SHOW_WIRE });

    const fullyLocked: CoilSpec = { ...DEFAULT_SPEC, height: { locked: true, value: 45 } };
    expect(parseHash(toHash(fullyLocked))).toEqual({ spec: fullyLocked, showWire: DEFAULT_SHOW_WIRE });
  });

  it("falls back to defaults with a notice on an unsupported document version", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 99, L: 5000 })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toMatch(/version/i);
  });

  it("falls back to defaults with a notice on a garbage 's' value (not valid base64url)", () => {
    const { spec, notice } = parseHash("#s=not-valid-base64!!!");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("falls back to defaults with a notice on valid base64url that isn't JSON", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from("this is not json").toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("falls back to defaults with a notice on an out-of-range value (cable length above 15 m)", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, L: 999999 })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("falls back to defaults with a notice on an unknown key (strict schema rejects garbage payloads)", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, bogusKey: 1 })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("falls back to defaults with a notice on an unknown lock token", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, lock: ["bogus"] })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("falls back to defaults with a notice when both outer and inner are locked", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, lock: ["outer", "inner"], size: 40 })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("round-trips a rounded-square shape, with the corner radius as 'rc' (issue #6)", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, shape: { kind: "sq", cornerRadius: 18 } };
    const hash = toHash(spec);
    expect(decodeDoc(hash)).toMatchObject({ shape: "sq", rc: 18 });
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("round-trips a rounded-triangle shape", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, shape: { kind: "tri", cornerRadius: 12.5 } };
    expect(parseHash(toHash(spec))).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("omits the shape key for round (the default) and a default-valued corner radius", () => {
    expect(decodeDoc(toHash({ ...DEFAULT_SPEC, shape: { kind: "round" } }))).toEqual({ v: 2 });
    const doc = decodeDoc(toHash({ ...DEFAULT_SPEC, shape: { kind: "sq", cornerRadius: 8 } })); // DEFAULT_CORNER_RADIUS
    expect(doc.shape).toBe("sq");
    expect(doc.rc).toBeUndefined();
  });

  it("falls back to defaults with a notice when a corner radius is set without selecting a shape that uses one", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, rc: 20 })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("the wire toggle (issue #4) defaults to shown and round-trips through the hash", () => {
    expect(parseHash("").showWire).toBe(true);

    const shown = toHash(DEFAULT_SPEC, true);
    expect(shown).not.toContain("wire=0"); // shown is the default: omitted entirely
    expect(decodeDoc(shown)).toEqual({ v: 2 }); // NOT part of the document -- see hash.ts's file header

    const hidden = toHash(DEFAULT_SPEC, false);
    expect(hidden).toMatch(/&wire=0$/); // a literal companion param, not buried in the base64 document
    expect(decodeDoc(hidden)).toEqual({ v: 2 });
    expect(parseHash(hidden)).toEqual({ spec: DEFAULT_SPEC, showWire: false });
  });

  it("falls back to defaults with a notice on a garbage 'wire' companion param", () => {
    const hash = `${toHash(DEFAULT_SPEC)}&wire=maybe`;
    const { spec, notice } = parseHash(hash);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("top cap/joint/tolerance (issue #9) round-trip and omit defaults", () => {
    expect(decodeDoc(toHash({ ...DEFAULT_SPEC, topCap: "auto", joint: "press", tolerance: 0.2 }))).toEqual({ v: 2 });

    const spec: CoilSpec = { ...DEFAULT_SPEC, topCap: "on", joint: "bayonet", tolerance: 0.35 };
    const hash = toHash(spec);
    expect(decodeDoc(hash)).toEqual({ v: 2, cap: "on", joint: "bayonet", tol: 0.35 });
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });

    const off: CoilSpec = { ...DEFAULT_SPEC, topCap: "off", joint: "snap" };
    expect(parseHash(toHash(off))).toEqual({ spec: off, showWire: DEFAULT_SHOW_WIRE });
  });

  it("falls back to defaults with a notice on an out-of-range tolerance", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, tol: 5 })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("print bed size (issue #10) round-trips and omits the default 256x256x256 mm bed", () => {
    expect(decodeDoc(toHash({ ...DEFAULT_SPEC, print: { bedX: 256, bedY: 256, bedZ: 256 } }))).toEqual({ v: 2 });

    const spec: CoilSpec = { ...DEFAULT_SPEC, print: { bedX: 220, bedY: 220, bedZ: 250 } };
    const hash = toHash(spec);
    expect(decodeDoc(hash)).toEqual({ v: 2, bx: 220, by: 220, bz: 250 });
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });

    // A single non-default axis omits the other two.
    const singleAxis: CoilSpec = { ...DEFAULT_SPEC, print: { bedX: 300, bedY: 256, bedZ: 256 } };
    const singleHash = toHash(singleAxis);
    expect(decodeDoc(singleHash)).toEqual({ v: 2, bx: 300 });
    expect(parseHash(singleHash)).toEqual({ spec: singleAxis, showWire: DEFAULT_SHOW_WIRE });
  });

  it("falls back to defaults with a notice on an unknown cap/joint value", () => {
    expect(parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, cap: "maybe" })).toString("base64url")}`).notice).toBeDefined();
    expect(parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, joint: "glue" })).toString("base64url")}`).notice).toBeDefined();
  });

  it("the top cap label (issue #12) round-trips and is omitted when unset", () => {
    expect(decodeDoc(toHash(DEFAULT_SPEC))).toEqual({ v: 2 }); // undefined label: omitted

    const spec: CoilSpec = { ...DEFAULT_SPEC, label: "USB-C 2m" };
    const hash = toHash(spec);
    expect(decodeDoc(hash)).toEqual({ v: 2, label: "USB-C 2m" });
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("unicode labels (issue #56 AC) survive the round trip losslessly", () => {
    for (const label of ["USB-C 2м провід", "café ☕️ 3.5mm", "テプラ", "👍 done"]) {
      const spec: CoilSpec = { ...DEFAULT_SPEC, label };
      const hash = toHash(spec);
      expect(decodeDoc(hash).label).toBe(label);
      expect(parseHash(hash).spec.label).toBe(label);
    }
  });

  it("an empty-string label decodes back to undefined, not ''", () => {
    const { spec } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, label: "" })).toString("base64url")}`);
    expect(spec.label).toBeUndefined();
  });

  it("falls back to defaults with a notice when the label exceeds the max length", () => {
    const tooLong = "x".repeat(41);
    expect(parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, label: tooLong })).toString("base64url")}`).notice).toBeDefined();
  });

  it("defaults to mount=none, omitted from the hash (issue #13)", () => {
    expect(DEFAULT_SPEC.mount).toBe("none");
    expect(parseHash(toHash(DEFAULT_SPEC))).toEqual({ spec: DEFAULT_SPEC, showWire: DEFAULT_SHOW_WIRE });
  });

  it("round-trips the screw-keyhole mount", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, mount: "keyhole" };
    const hash = toHash(spec);
    expect(decodeDoc(hash)).toEqual({ v: 2, mount: "keyhole" });
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("round-trips the skadis clip mount plate with the default (glue) plate joint, omitting pj", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, mount: "skadis" };
    const hash = toHash(spec);
    expect(decodeDoc(hash)).toEqual({ v: 2, mount: "skadis" });
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("rejects mount=opengrid from a shared link, falling back to defaults with a notice (issue #14 PR review, issue #38: hidden until the real connector geometry lands)", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, mount: "opengrid" })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("omits pj from the hash when mount doesn't use a plate, even if plateJoint is non-default", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, mount: "keyhole", plateJoint: "snap" };
    expect(decodeDoc(toHash(spec)).pj).toBeUndefined();
  });

  it("falls back to defaults with a notice on an unknown mount value", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, mount: "bogus" })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  describe("legacy #v=1&... links (pre-issue-56 flat query string)", () => {
    it("keep working with no lock param (default lock: outer size + layers)", () => {
      const { spec, notice } = parseHash("#v=1&L=1000&d=4&size=40");
      expect(notice).toBeUndefined();
      expect(spec.coreSize).toEqual({ locked: true, dimension: "outer", value: 40 });
      expect(spec.layers).toEqual({ locked: true, value: 1 });
      expect(spec.height).toEqual({ locked: false });
      expect(spec.wire.length).toBe(1000);
      expect(spec.wire.diameter).toBe(4);
    });

    it("fall back to defaults with a notice on an unsupported version", () => {
      const { spec, notice } = parseHash("#v=99&L=5000");
      expect(spec).toEqual(DEFAULT_SPEC);
      expect(notice).toMatch(/version/i);
    });

    it("fall back to defaults with a notice on a garbage value", () => {
      const { spec, notice } = parseHash("#v=1&L=not-a-number");
      expect(spec).toEqual(DEFAULT_SPEC);
      expect(notice).toBeDefined();
    });

    it("fall back to defaults with a notice on an unknown lock token", () => {
      const { spec, notice } = parseHash("#v=1&lock=bogus");
      expect(spec).toEqual(DEFAULT_SPEC);
      expect(notice).toBeDefined();
    });

    it("fall back to defaults with a notice when both outer and inner are locked", () => {
      const { spec, notice } = parseHash("#v=1&lock=outer,inner&size=40");
      expect(spec).toEqual(DEFAULT_SPEC);
      expect(notice).toBeDefined();
    });

    it("fall back to defaults with a notice when a shape's corner radius is set without selecting that shape", () => {
      const { spec, notice } = parseHash("#v=1&sq.rc=20");
      expect(spec).toEqual(DEFAULT_SPEC);
      expect(notice).toBeDefined();
    });

    it("reject mount=opengrid the same way as the new format", () => {
      const { spec, notice } = parseHash("#v=1&mount=opengrid");
      expect(spec).toEqual(DEFAULT_SPEC);
      expect(notice).toBeDefined();
    });

    // issue #56 AC: "legacy links migrate losslessly" -- every legacy field,
    // round-tripped through the OLD codec then re-encoded/re-parsed through
    // the NEW one, must resolve to the exact same spec + showWire. This is
    // the migration `App.tsx` relies on (parse the old hash once, then
    // `toHash` immediately rewrites the URL bar to the new format).
    const LEGACY_LINKS = [
      "#v=1&L=1000&d=4&size=40",
      "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2",
      "#v=1&L=2000&d=4&wt=stiff&lock=outer,ly&size=60&ly=1",
      "#v=1&L=3000&d=4&wt=custom&mbr=7&lock=inner&size=25",
      "#v=1&shape=sq&sq.rc=20&lock=outer,ly&size=60",
      "#v=1&shape=tri&tri.rc=15&lock=outer,ly&size=60",
      "#v=1&q=0.4&obj=ar&lock=&h=45",
      "#v=1&cap=on&joint=bayonet&tol=0.35",
      "#v=1&cap=off&joint=snap",
      "#v=1&bx=220&by=220&bz=250",
      "#v=1&mount=keyhole",
      "#v=1&mount=skadis&pj=snap",
      "#v=1&label=USB-C+2m",
      "#v=1&wire=0",
      "#v=1&L=20&d=1&lock=outer,ly&size=6&h=20", // small-values edge case (mount e2e fixture)
    ];
    it.each(LEGACY_LINKS)("migrates '%s' losslessly through toHash/parseHash", (legacyHash) => {
      const first = parseHash(legacyHash);
      expect(first.notice).toBeUndefined();

      const migratedHash = toHash(first.spec, first.showWire);
      expect(migratedHash).toMatch(/^#s=/); // toHash always re-emits the new format

      const second = parseHash(migratedHash);
      expect(second).toEqual(first);
    });
  });

  describe("typical link lengths (issue #56 AC: 'typical links stay short')", () => {
    it("a bare default link is tiny", () => {
      const hash = toHash(DEFAULT_SPEC);
      expect(hash.length).toBeLessThan(20);
    });

    it("a typical single-override link (just the wire length/diameter and a locked size) stays short", () => {
      const spec: CoilSpec = { ...DEFAULT_SPEC, wire: { length: 3500, diameter: 3.8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 45 } };
      const hash = toHash(spec);
      expect(hash.length).toBeLessThan(60);
    });

    it("a heavily-customized link (shape, mount, unicode label, joint, tolerance) still stays well under a typical URL limit", () => {
      const spec: CoilSpec = {
        ...DEFAULT_SPEC,
        wire: { length: 6000, diameter: 3.8, type: "stiff" },
        shape: { kind: "sq", cornerRadius: 15 },
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 2 },
        topCap: "on",
        joint: "bayonet",
        tolerance: 0.35,
        mount: "skadis",
        label: "USB-C 2м café ☕️",
      };
      const hash = toHash(spec);
      // Emoji inflate disproportionately (each is several UTF-8 bytes, then
      // ~1.33x again through base64) -- still a small fraction of a
      // practical URL length limit (browsers/servers commonly cap total URL
      // length around 2000 chars).
      expect(hash.length).toBeLessThan(300);
    });
  });
});
