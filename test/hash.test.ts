import { describe, expect, it } from "vitest";
import { DEFAULT_SHOW_WIRE, DEFAULT_SPEC, parseHash, toHash } from "../src/core";
import type { CoilSpec } from "../src/core";

describe("parseHash / toHash", () => {
  it("parses an empty hash as the defaults, with no notice", () => {
    expect(parseHash("")).toEqual({ spec: DEFAULT_SPEC, showWire: DEFAULT_SHOW_WIRE });
    expect(parseHash("#")).toEqual({ spec: DEFAULT_SPEC, showWire: DEFAULT_SHOW_WIRE });
  });

  it("always stamps the version, and omits fields equal to the default", () => {
    expect(toHash(DEFAULT_SPEC)).toBe("#v=1");
  });

  it("accepts a hash that only overrides one field", () => {
    const hash = "#v=1&d=6";
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

  it("round-trips locking height and outer size (issue #5 example: lock=h,outer)", () => {
    const spec: CoilSpec = {
      ...DEFAULT_SPEC,
      coreSize: { locked: true, dimension: "outer", value: 160 },
      height: { locked: true, value: 75 },
      layers: { locked: false },
    };
    const hash = toHash(spec);
    expect(hash).toContain("lock=");
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    expect(new Set(params.get("lock")!.split(","))).toEqual(new Set(["h", "outer"]));
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

  it("old links without a lock param keep working (default lock: outer size + layers)", () => {
    const { spec, notice } = parseHash("#v=1&L=1000&d=4&size=40");
    expect(notice).toBeUndefined();
    expect(spec.coreSize).toEqual({ locked: true, dimension: "outer", value: 40 });
    expect(spec.layers).toEqual({ locked: true, value: 1 });
    expect(spec.height).toEqual({ locked: false });
    expect(spec.wire.length).toBe(1000);
    expect(spec.wire.diameter).toBe(4);
  });

  it("falls back to defaults with a notice on an unsupported version", () => {
    const { spec, notice } = parseHash("#v=99&L=5000");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toMatch(/version/i);
  });

  it("falls back to defaults with a notice on a garbage value", () => {
    const { spec, notice } = parseHash("#v=1&L=not-a-number");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("falls back to defaults with a notice on an out-of-range value (cable length above 15 m)", () => {
    const { spec, notice } = parseHash("#v=1&L=999999");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("falls back to defaults with a notice on an unknown lock token", () => {
    const { spec, notice } = parseHash("#v=1&lock=bogus");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("falls back to defaults with a notice when both outer and inner are locked", () => {
    const { spec, notice } = parseHash("#v=1&lock=outer,inner&size=40");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("round-trips a rounded-square shape, with the corner radius namespaced as sq.rc (issue #6)", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, shape: { kind: "sq", cornerRadius: 18 } };
    const hash = toHash(spec);
    expect(hash).toContain("shape=sq");
    expect(hash).toContain("sq.rc=18");
    expect(hash).not.toContain("tri.rc");
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("round-trips a rounded-triangle shape, with the corner radius namespaced as tri.rc (issue #6)", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, shape: { kind: "tri", cornerRadius: 12.5 } };
    expect(parseHash(toHash(spec))).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("omits the shape param for round (the default) and a default-valued corner radius", () => {
    expect(toHash({ ...DEFAULT_SPEC, shape: { kind: "round" } })).toBe("#v=1");
    const hash = toHash({ ...DEFAULT_SPEC, shape: { kind: "sq", cornerRadius: 8 } }); // DEFAULT_CORNER_RADIUS
    expect(hash).toContain("shape=sq");
    expect(hash).not.toContain("sq.rc=");
  });

  it("falls back to defaults with a notice when a shape's corner radius is set without selecting that shape", () => {
    const { spec, notice } = parseHash("#v=1&sq.rc=20");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("the wire toggle (issue #4) defaults to shown and round-trips through the hash", () => {
    expect(parseHash("").showWire).toBe(true);
    expect(toHash(DEFAULT_SPEC, true)).toBe("#v=1"); // shown is the default: omitted from the hash

    const hidden = toHash(DEFAULT_SPEC, false);
    expect(hidden).toContain("wire=0");
    expect(parseHash(hidden)).toEqual({ spec: DEFAULT_SPEC, showWire: false });

    // An explicit wire=1 is accepted too, even though it's never written.
    expect(parseHash("#v=1&wire=1").showWire).toBe(true);
  });

  it("top cap/joint/tolerance (issue #9) round-trip and omit defaults", () => {
    expect(toHash({ ...DEFAULT_SPEC, topCap: "auto", joint: "press", tolerance: 0.2 })).toBe("#v=1");

    const spec: CoilSpec = { ...DEFAULT_SPEC, topCap: "on", joint: "bayonet", tolerance: 0.35 };
    const hash = toHash(spec);
    expect(hash).toContain("cap=on");
    expect(hash).toContain("joint=bayonet");
    expect(hash).toContain("tol=0.35");
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });

    const off: CoilSpec = { ...DEFAULT_SPEC, topCap: "off", joint: "snap" };
    expect(parseHash(toHash(off))).toEqual({ spec: off, showWire: DEFAULT_SHOW_WIRE });
  });

  it("falls back to defaults with a notice on an out-of-range tolerance", () => {
    const { spec, notice } = parseHash("#v=1&tol=5");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("print bed size (issue #10) round-trips and omits the default 256x256x256 mm bed", () => {
    expect(toHash({ ...DEFAULT_SPEC, print: { bedX: 256, bedY: 256, bedZ: 256 } })).toBe("#v=1");

    const spec: CoilSpec = { ...DEFAULT_SPEC, print: { bedX: 220, bedY: 220, bedZ: 250 } };
    const hash = toHash(spec);
    expect(hash).toContain("bx=220");
    expect(hash).toContain("by=220");
    expect(hash).toContain("bz=250");
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });

    // A single non-default axis omits the other two.
    const singleAxis: CoilSpec = { ...DEFAULT_SPEC, print: { bedX: 300, bedY: 256, bedZ: 256 } };
    const singleHash = toHash(singleAxis);
    expect(singleHash).toBe("#v=1&bx=300");
    expect(parseHash(singleHash)).toEqual({ spec: singleAxis, showWire: DEFAULT_SHOW_WIRE });
  });

  it("falls back to defaults with a notice on an unknown cap/joint value", () => {
    expect(parseHash("#v=1&cap=maybe").notice).toBeDefined();
    expect(parseHash("#v=1&joint=glue").notice).toBeDefined();
  });

  it("the top cap label (issue #12) round-trips, URL-encoded, and is omitted when unset", () => {
    expect(toHash(DEFAULT_SPEC)).toBe("#v=1"); // undefined label: omitted

    const spec: CoilSpec = { ...DEFAULT_SPEC, label: "USB-C 2m" };
    const hash = toHash(spec);
    expect(hash).toContain("label=USB-C+2m"); // URLSearchParams' own space encoding
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("an empty-string label in a raw hash decodes back to undefined, not ''", () => {
    expect(parseHash("#v=1&label=").spec.label).toBeUndefined();
  });

  it("falls back to defaults with a notice when the label exceeds the max length", () => {
    const tooLong = "x".repeat(41);
    expect(parseHash(`#v=1&label=${tooLong}`).notice).toBeDefined();
  });

  it("defaults to mount=none, omitted from the hash (issue #13)", () => {
    expect(DEFAULT_SPEC.mount).toBe("none");
    expect(parseHash("#v=1")).toEqual({ spec: DEFAULT_SPEC, showWire: DEFAULT_SHOW_WIRE });
  });

  it("round-trips the screw-keyhole mount", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, mount: "keyhole" };
    const hash = toHash(spec);
    expect(hash).toContain("mount=keyhole");
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("round-trips the skadis clip mount plate with the default (glue) plate joint, omitting pj", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, mount: "skadis" };
    const hash = toHash(spec);
    expect(hash).toContain("mount=skadis");
    expect(hash).not.toContain("pj=");
    expect(parseHash(hash)).toEqual({ spec, showWire: DEFAULT_SHOW_WIRE });
  });

  it("rejects mount=opengrid from a shared link, falling back to defaults with a notice (issue #14 PR review, issue #38: hidden until the real connector geometry lands)", () => {
    const { spec, notice } = parseHash("#v=1&mount=opengrid");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });

  it("omits pj from the hash when mount doesn't use a plate, even if plateJoint is non-default", () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, mount: "keyhole", plateJoint: "snap" };
    const hash = toHash(spec);
    expect(hash).not.toContain("pj=");
  });

  it("falls back to defaults with a notice on an unknown mount value", () => {
    // "skadis" is a real value (issue #14); "opengrid" is deliberately NOT
    // (see the dedicated test above) -- use a value that's still unknown to
    // keep testing the generic fallback path itself.
    const { spec, notice } = parseHash("#v=1&mount=bogus");
    expect(spec).toEqual(DEFAULT_SPEC);
    expect(notice).toBeDefined();
  });
});
