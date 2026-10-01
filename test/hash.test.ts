import { describe, expect, it } from "vitest";
import { DEFAULT_SHOW_WIRE, DEFAULT_SPEC, parseHash, toHash } from "../src/core";
import type { CoilSpec } from "../src/core";
import { encodeHashDoc } from "../e2e/hashDoc";

const DESIGN = { spec: DEFAULT_SPEC, showWire: DEFAULT_SHOW_WIRE, view: "design" as const };

/**
 * Decodes a `#s=<base64url(JSON)>` hash back to its raw document, purely for
 * asserting on the wire format's own shape in these tests (issue #56 AC:
 * "the hash is `#s=<base64url(...)>`, with a version field inside"). This is
 * NOT part of the codec's public interface (`parseHash`/`toHash` only) --
 * it's a test-only mirror of `hash.ts`'s own `base64UrlToBytes`.
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
    expect(parseHash("")).toEqual(DESIGN);
    expect(parseHash("#")).toEqual(DESIGN);
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
      ...DESIGN,
      spec: { ...DEFAULT_SPEC, wire: { ...DEFAULT_SPEC.wire, diameter: 6 } },
    });
  });

  it("round-trips a non-default spec with default locks", () => {
    const spec: CoilSpec = {
      ...DEFAULT_SPEC,
      wire: { length: 5000, diameter: 8, type: "usb" },
      coreSize: { locked: true, dimension: "outer", value: 60 },
    };
    expect(parseHash(toHash(spec))).toEqual({ ...DESIGN, spec });
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
    expect(parseHash(hash)).toEqual({ ...DESIGN, spec });
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
      keyholeRotation: 0,
      throughHoleDiameter: 4.5,
    };
    expect(parseHash(toHash(spec))).toEqual({ ...DESIGN, spec });
  });

  it("round-trips a fully free (0-locked) spec", () => {
    const free: CoilSpec = { ...DEFAULT_SPEC, coreSize: { locked: false }, layers: { locked: false } };
    expect(parseHash(toHash(free))).toEqual({ ...DESIGN, spec: free });
  });

  // Issue #119: at most 2 of {core size, height, layers} may be locked at
  // once -- the UI itself can no longer produce a 3-locked spec (the third
  // lock toggle disables itself), but an `#s=` link predating that rule (or
  // hand-crafted) can still ask for all three. `parseHash` normalizes it
  // instead of falling back to full defaults: it drops the "ly" (layers)
  // lock -- a documented, deterministic tie-break (see hash.ts's
  // `capMaxTwoLocked`) -- and reports why via `notice`, keeping every other
  // field the link set.
  it("normalizes a link locking all three by dropping the layers lock, with a notice", () => {
    const fullyLocked: CoilSpec = { ...DEFAULT_SPEC, height: { locked: true, value: 45 } };
    const { spec, notice } = parseHash(toHash(fullyLocked));
    expect(spec).toEqual({ ...fullyLocked, layers: { locked: false } });
    expect(notice).toMatch(/layers/i);
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

  it("falls back to defaults with a notice on an unknown key inside 'ui' too", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, ui: { bogus: true } })).toString("base64url")}`);
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

  // Issue #119: a hand-crafted `#s=` document (not just one round-tripped
  // through `toHash`) locking all three must still parse -- never crash --
  // and land in a valid (at most 2 locked) state, keeping the rest of the
  // link (here, the wire length) rather than discarding it.
  it("normalizes a hand-crafted doc locking all three, keeping the rest of the link", () => {
    const { spec, notice } = parseHash(
      `#s=${Buffer.from(JSON.stringify({ v: 2, L: 6000, lock: ["outer", "h", "ly"], size: 60, h: 60, ly: 2 })).toString("base64url")}`,
    );
    expect(spec.wire.length).toBe(6000);
    expect(spec.coreSize).toEqual({ locked: true, dimension: "outer", value: 60 });
    expect(spec.height).toEqual({ locked: true, value: 60 });
    expect(spec.layers).toEqual({ locked: false });
    expect(notice).toMatch(/layers/i);
  });

  it("does not touch a doc locking only 2 of the 3 (no notice)", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, lock: ["outer", "h"], size: 60, h: 60 })).toString("base64url")}`);
    expect(spec.coreSize.locked).toBe(true);
    expect(spec.height.locked).toBe(true);
    expect(spec.layers.locked).toBe(false);
    expect(notice).toBeUndefined();
  });

  it("round-trips a rounded-square shape, with the corner radius as 'rc' (issue #6)", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, shape: { kind: "sq", cornerRadius: 18 } };
    const hash = toHash(spec);
    expect(decodeDoc(hash)).toMatchObject({ shape: "sq", rc: 18 });
    expect(parseHash(hash)).toEqual({ ...DESIGN, spec });
  });

  it("round-trips a rounded-triangle shape", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, shape: { kind: "tri", cornerRadius: 12.5 } };
    expect(parseHash(toHash(spec))).toEqual({ ...DESIGN, spec });
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

  describe("the wire toggle and the design/guide view (issue #4, #17) -- nested under 'ui' in the document", () => {
    it("default to shown/design and round-trip through the hash", () => {
      expect(parseHash("").showWire).toBe(true);
      expect(parseHash("").view).toBe("design");

      const shown = toHash(DEFAULT_SPEC, true, "design");
      expect(decodeDoc(shown)).toEqual({ v: 2 }); // both at default: 'ui' omitted entirely
      expect(parseHash(shown)).toEqual(DESIGN);
    });

    it("hiding the wire writes ui.wire=false, nested inside the document (not a literal URL substring)", () => {
      const hidden = toHash(DEFAULT_SPEC, false);
      expect(hidden).not.toContain("wire=0"); // a literal substring would be a companion param
      expect(decodeDoc(hidden)).toEqual({ v: 2, ui: { wire: false } });
      expect(parseHash(hidden)).toEqual({ ...DESIGN, showWire: false });
    });

    it("switching to the guide view writes ui.view='guide', nested inside the document", () => {
      const guideHash = toHash(DEFAULT_SPEC, DEFAULT_SHOW_WIRE, "guide");
      expect(guideHash).not.toContain("view=guide"); // a literal substring would be a companion param
      expect(decodeDoc(guideHash)).toEqual({ v: 2, ui: { view: "guide" } });
      expect(parseHash(guideHash)).toEqual({ ...DESIGN, view: "guide" });
    });

    it("both hidden wire and the guide view round-trip together under one 'ui' object", () => {
      const hash = toHash(DEFAULT_SPEC, false, "guide");
      expect(decodeDoc(hash)).toEqual({ v: 2, ui: { wire: false, view: "guide" } });
      expect(parseHash(hash)).toEqual({ ...DESIGN, showWire: false, view: "guide" });
    });

    it("falls back to defaults with a notice on a garbage ui.wire value (schema rejects anything but false)", () => {
      const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, ui: { wire: true } })).toString("base64url")}`);
      expect(spec).toEqual(DEFAULT_SPEC);
      expect(notice).toBeDefined();
    });

    it("falls back to defaults with a notice on a garbage ui.view value", () => {
      const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, ui: { view: "bogus" } })).toString("base64url")}`);
      expect(spec).toEqual(DEFAULT_SPEC);
      expect(notice).toBeDefined();
    });

    // Beta: no compatibility with the short-lived `&wire=0`/`&view=guide`
    // params that once sat next to `s=`; only `ui` inside the document counts.
    it("ignores params next to 's' (the old '&wire=0' / '&view=guide' companions)", () => {
      expect(parseHash(`${toHash(DEFAULT_SPEC)}&wire=0&view=guide&wire=maybe`)).toEqual(DESIGN);
    });
  });

  it("top cap/joint/tolerance (issue #9) round-trip and omit defaults", () => {
    expect(decodeDoc(toHash({ ...DEFAULT_SPEC, topCap: "auto", joint: "press", tolerance: 0.2 }))).toEqual({ v: 2 });

    const spec: CoilSpec = { ...DEFAULT_SPEC, topCap: "on", joint: "bayonet", tolerance: 0.35 };
    const hash = toHash(spec);
    expect(decodeDoc(hash)).toEqual({ v: 2, cap: "on", joint: "bayonet", tol: 0.35 });
    expect(parseHash(hash)).toEqual({ ...DESIGN, spec });

    const off: CoilSpec = { ...DEFAULT_SPEC, topCap: "off", joint: "snap" };
    expect(parseHash(toHash(off))).toEqual({ ...DESIGN, spec: off });
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
    expect(parseHash(hash)).toEqual({ ...DESIGN, spec });

    // A single non-default axis omits the other two.
    const singleAxis: CoilSpec = { ...DEFAULT_SPEC, print: { bedX: 300, bedY: 256, bedZ: 256 } };
    const singleHash = toHash(singleAxis);
    expect(decodeDoc(singleHash)).toEqual({ v: 2, bx: 300 });
    expect(parseHash(singleHash)).toEqual({ ...DESIGN, spec: singleAxis });
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
    expect(parseHash(hash)).toEqual({ ...DESIGN, spec });
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
    expect(parseHash(toHash(DEFAULT_SPEC))).toEqual(DESIGN);
  });

  it("round-trips the screw-keyhole mount", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, mount: "keyhole" };
    const hash = toHash(spec);
    expect(decodeDoc(hash)).toEqual({ v: 2, mount: "keyhole" });
    expect(parseHash(hash)).toEqual({ ...DESIGN, spec });
  });

  it("round-trips a non-default keyhole rotation (issue #71), omitting kr at the default (0)", () => {
    const rotated: CoilSpec = { ...DEFAULT_SPEC, mount: "keyhole", keyholeRotation: 45 };
    const hash = toHash(rotated);
    expect(decodeDoc(hash)).toEqual({ v: 2, mount: "keyhole", kr: 45 });
    expect(parseHash(hash)).toEqual({ ...DESIGN, spec: rotated });

    const atDefault: CoilSpec = { ...DEFAULT_SPEC, mount: "keyhole", keyholeRotation: 0 };
    expect(decodeDoc(toHash(atDefault)).kr).toBeUndefined();
  });

  it("rejects a keyhole rotation ('kr') set without mount=keyhole, falling back to defaults with a notice", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, kr: 45 })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("rejects an out-of-set keyhole rotation value, falling back to defaults with a notice", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, mount: "keyhole", kr: 30 })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("round-trips the through-hole mount, including a non-default hole diameter (issue #70)", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, mount: "through" };
    const hash = toHash(spec);
    expect(decodeDoc(hash)).toEqual({ v: 2, mount: "through" });
    expect(parseHash(hash)).toEqual({ ...DESIGN, spec });

    const custom: CoilSpec = { ...DEFAULT_SPEC, mount: "through", throughHoleDiameter: 6 };
    const customHash = toHash(custom);
    expect(decodeDoc(customHash)).toEqual({ v: 2, mount: "through", thd: 6 });
    expect(parseHash(customHash)).toEqual({ ...DESIGN, spec: custom });
  });

  it("rejects a through-hole diameter ('thd') set without mount=through, falling back to defaults with a notice", () => {
    const { spec, notice } = parseHash(`#s=${Buffer.from(JSON.stringify({ v: 2, thd: 6 })).toString("base64url")}`);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("round-trips the skadis clip mount plate with the default (glue) plate joint, omitting pj", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, mount: "skadis" };
    const hash = toHash(spec);
    expect(decodeDoc(hash)).toEqual({ v: 2, mount: "skadis" });
    expect(parseHash(hash)).toEqual({ ...DESIGN, spec });
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

  // Beta: there is no compatibility layer for the old flat `#v=1&...` links.
  it.each(["#v=1&L=1000&d=4&size=40", "#v=1", "#L=1000&d=4"])("falls back to defaults with the usual notice on a link without an 's' document: %s", (hash) => {
    const { spec, notice, showWire, view } = parseHash(hash);
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(showWire).toBe(DEFAULT_SHOW_WIRE);
    expect(view).toBe("design");
    expect(notice).toMatch(/could not read this link/i);
  });

  // Every document field survives parse -> toHash -> parse unchanged.
  const ROUND_TRIP_DOCS: Record<string, unknown>[] = [
    { L: 1000, d: 4, size: 40 },
    { L: 2000, d: 4, wt: "stiff", size: 60, ly: 1 },
    { L: 3000, d: 4, wt: "custom", mbr: 7, lock: ["inner"], size: 25 },
    { shape: "sq", rc: 20, size: 60 },
    { shape: "tri", rc: 15, size: 60 },
    { q: 0.4, obj: "ar", lock: [], h: 45 },
    { cap: "on", joint: "bayonet", tol: 0.35 },
    { cap: "off", joint: "snap" },
    { bx: 220, by: 220, bz: 250 },
    { mount: "keyhole" },
    { mount: "keyhole", kr: 45 },
    { mount: "skadis", pj: "snap" },
    { mount: "through", thd: 6 },
    { label: "USB-C 2m" },
    { label: "Кабель \u{1F50C}" },
    { ui: { wire: false } },
    { L: 1000, d: 4, size: 40, ui: { view: "guide" } },
    { ui: { wire: false, view: "guide" } },
    { L: 20, d: 1, size: 6, h: 20 }, // small-values edge case
    { L: 6000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60 },
  ];
  it.each(ROUND_TRIP_DOCS)("round-trips %j through parseHash/toHash", (...[doc]) => {
    const first = parseHash(encodeHashDoc(doc));
    expect(first.notice).toBeUndefined();

    const rewritten = toHash(first.spec, first.showWire, first.view);
    expect(rewritten).toMatch(/^#s=/);
    expect(parseHash(rewritten)).toEqual(first);
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
