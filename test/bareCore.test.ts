import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { CAP_THICKNESS, DEFAULT_SPEC, design } from "../src/core";
import type { CoilMesh, CoilSpec } from "../src/core";

// Issue #254: the base plate is an option. A bare core (base off) has no flange,
// takes both cable ends through a hole in a ring at each end of the core (part 2,
// test/faceChannel.test.ts), sizes itself to fit them, and counts the cable its core
// holds. Everything here goes through design(); the numbers are worked out here from
// the cable, not read back from the core's constants.

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function solids(mesh: CoilMesh): number {
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  const pieces = m.decompose();
  const n = m.status() === "NoError" ? pieces.length : -1;
  pieces.forEach((p) => p.delete());
  m.delete();
  return n;
}

function zRange(mesh: CoilMesh): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) {
    lo = Math.min(lo, mesh.positions[i]);
    hi = Math.max(hi, mesh.positions[i]);
  }
  return [lo, hi];
}

/** The default spec with the core size, height and layers locked, as a base-on / base-off pair. */
function spec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    ...DEFAULT_SPEC,
    coreSize: { locked: true, dimension: "outer", value: 36 },
    height: { locked: true, value: 80 },
    layers: { locked: true, value: 1 },
    ...overrides,
  };
}

const WALL = (d: number) => Math.max(3, 0.4 * d + 1.5);
/** USB, flexible cord 2.6 x d; stiff 6.5 x d (every cable's multiplier was cut by 35% in #255). */
const MBR = { usb: 2.6, flex: 2.6, stiff: 6.5 } as const;
/** An HDMI plug's diagonal: the free circle the bore of a bare core always passes. */
const PASSAGE = 22.4;

describe("a bare core (base off)", () => {
  it("is one part and one solid, with no flange: it stands on its own bottom face", async () => {
    const d = await design(spec({ base: "off", topCap: "off" }));
    expect(d.parts.map((p) => p.name)).toEqual(["core"]);
    expect(solids(d.mesh)).toBe(1);
    const [lo, hi] = zRange(d.mesh);
    expect(lo).toBeCloseTo(0, 6);
    expect(hi).toBeCloseTo(d.solution.height, 4);
    expect(d.flangeSpec.thickness).toBe(0);
    expect(d.innerEndClip).toBeUndefined();
    expect(d.faceChannels).toBeDefined();
    expect(d.innerEndLeadIn.length).toBeGreaterThan(0);
    expect(d.rimSlots.base).toBeUndefined();
  });

  it("has the base's real size numbers: the core's own footprint and height", async () => {
    const d = await design(spec({ base: "off", topCap: "off" }));
    expect(d.solution.overallHeight).toBeCloseTo(d.solution.height, 6);
    expect(d.solution.flangeExtent!.acrossFlats).toBeCloseTo(d.solution.outerSize, 6);
    const on = await design(spec({ base: "on", topCap: "off" }));
    expect(on.solution.overallHeight!).toBeGreaterThan(on.solution.height + 2);
    expect(on.solution.flangeExtent!.acrossFlats).toBeGreaterThan(on.solution.outerSize + 2);
  });

  it("draws the cable from the inner end's tail at the top, down the hole and along the bottom channel into layer 1's first turn", async () => {
    const d = await design(spec({ base: "off", topCap: "off" }));
    const lead = d.innerEndLeadIn;
    const first = d.wirePaths[0].points;
    expect([d.cablePath[0], d.cablePath[1], d.cablePath[2]]).toEqual([lead[0], lead[1], lead[2]]);
    expect(lead[2]).toBeCloseTo(d.solution.height, 4);
    expect([lead[lead.length - 3], lead[lead.length - 2], lead[lead.length - 1]]).toEqual([first[0], first[1], first[2]]);
  });

  it("with the base on, the same spec is what it was: a flange below z = 0 and an inner-end clip", async () => {
    const d = await design(spec({ base: "on", topCap: "off" }));
    const [lo] = zRange(d.mesh);
    expect(lo).toBeCloseTo(-d.flangeSpec.thickness, 6);
    expect(d.flangeSpec.thickness).toBeGreaterThan(0);
    expect(d.innerEndClip).toBeDefined();
  });

  it.each([
    ["round", { kind: "round" }],
    ["sq", { kind: "sq", cornerRadius: 15 }],
    ["tri", { kind: "tri", cornerRadius: 12 }],
  ] as const)("a %s core with no cap is one solid on the bed, at draft and final", async (_name, shape) => {
    for (const resolution of ["draft", "final"] as const) {
      const d = await design(spec({ base: "off", topCap: "off", shape, coreSize: { locked: true, dimension: "outer", value: 60 } }), resolution);
      expect(solids(d.mesh), resolution).toBe(1);
      expect(zRange(d.mesh)[0], resolution).toBeCloseTo(0, 6);
    }
  });

  it("topCap auto resolves to off, even with several layers; an explicit cap is still built, sized to the cable", async () => {
    const auto = await design(spec({ base: "off", layers: { locked: true, value: 2 }, coreSize: { locked: true, dimension: "outer", value: 40 } }));
    expect(auto.solution.capsAuto).toBe(false);
    expect(auto.solution.topCapEnabled).toBe(false);
    expect(auto.parts.map((p) => p.name)).toEqual(["core"]);

    const withBase = await design(spec({ base: "on", layers: { locked: true, value: 2 }, coreSize: { locked: true, dimension: "outer", value: 40 } }));
    expect(withBase.solution.capsAuto).toBe(true);
    expect(withBase.parts.map((p) => p.name)).toEqual(["core", "top-cap"]);

    const on = await design(spec({ base: "off", topCap: "on", layers: { locked: true, value: 2 }, coreSize: { locked: true, dimension: "outer", value: 40 } }));
    expect(on.parts.map((p) => p.name)).toEqual(["core", "top-cap"]);
    expect(solids(on.mesh)).toBe(1);
    expect(on.solution.overallHeight).toBeCloseTo(on.solution.height + CAP_THICKNESS, 6);
    // The cap covers the wound cable.
    expect(on.solution.flangeExtent!.acrossFlats).toBeGreaterThan(on.solution.envelopeDiameter - 1e-6);
    expect(on.notices.filter((n) => n.severity === "problem")).toEqual([]);
  });

  it("a wall mount needs the base: it stays on, with no notice, and the spec keeps the user's choice", async () => {
    const mounted = { topCap: "off", mount: "keyhole", coreSize: { locked: true, dimension: "outer", value: 50 } } as const;
    const bare = await design(spec(mounted));
    expect(bare.spec.base).toBe("off");
    expect(bare.flangeSpec.thickness).toBeGreaterThan(0);
    expect(bare.faceChannels).toBeUndefined();
    expect(bare.notices.some((n) => /mount needs the base/i.test(n.message))).toBe(false);
    const explicit = await design(spec({ ...mounted, base: "on" }));
    expect(explicit.flangeSpec.thickness).toBe(bare.flangeSpec.thickness);
  });
});

describe("a bare core's minimum size (issue #254)", () => {
  // The cable's own bend rule sets the size when it's the bigger of the two; otherwise the 22.4 mm connector passage does.
  const free = (type: "usb" | "stiff", d: number, base: "on" | "off"): CoilSpec => ({
    ...DEFAULT_SPEC,
    base,
    wire: { length: 2000, diameter: d, type },
    coreSize: { locked: false },
    height: { locked: false },
    layers: { locked: true, value: 1 },
  });

  it.each([
    ["USB 3 mm", "usb", 3],
    ["USB 3.8 mm", "usb", 3.8],
    ["USB 6 mm", "usb", 6],
    ["stiff 3 mm", "stiff", 3],
    ["stiff 6 mm", "stiff", 6],
  ] as const)("%s: the bore passes the connector, and the core is never smaller than with a base", async (_name, type, d) => {
    const bare = await design(free(type, d, "off"), "draft");
    const based = await design(free(type, d, "on"), "draft");
    const bore = bare.solution.outerSize - 2 * WALL(d);
    expect(bare.solution.diagnosis.status).toBe("ok");
    expect(bore).toBeGreaterThanOrEqual(PASSAGE - 1e-6);
    expect(bare.solution.outerSize).toBeGreaterThanOrEqual(based.solution.minOuterSizeForBend - 1e-6);
    expect(bare.solution.minOuterSizeForShape).toBeGreaterThanOrEqual(based.solution.minOuterSizeForShape - 1e-6);
    expect(bare.solution.outerSize).toBeGreaterThanOrEqual(bare.solution.minOuterSizeForShape - 1e-6);
  });

  it("the default cable's smallest bare core holds the hole, the channel and a web each side: 36 mm for 3.8 mm USB", async () => {
    // Half the 22.4 mm passage and the clearance (11.4), the channel's width d + 2c (4.2), and 2 x 1.2 mm of web: 18 mm to the winding surface.
    const wanted = 2 * (22.4 / 2 + 0.2 + (3.8 + 2 * 0.2) + 2 * 1.2);
    const d = await design({ ...DEFAULT_SPEC, base: "off" }, "draft");
    expect(d.solution.minOuterSizeForShape).toBeCloseTo(wanted, 1);
    expect(d.solution.outerSize).toBeCloseTo(wanted, 1);
    expect(d.notices.some((n) => /Core size raised/.test(n.message))).toBe(true);
  });

  it("a stiff cable's bend radius, not the passage, sets the size, and it grows with the cable", async () => {
    const stiff3 = await design(free("stiff", 3, "off"), "draft");
    const stiff6 = await design(free("stiff", 6, "off"), "draft");
    // 6.5 x d: 19.5 mm and 39 mm. The path must dip up to 2 x MBR into the bore, so these cores are well over the passage floor.
    expect(stiff3.solution.minOuterSizeForShape).toBeGreaterThan(2 * MBR.stiff * 3);
    expect(stiff6.solution.minOuterSizeForShape).toBeGreaterThan(2 * MBR.stiff * 6);
    expect(stiff6.solution.minOuterSizeForShape).toBeGreaterThan(stiff3.solution.minOuterSizeForShape * 1.5);
  });

  it("a locked size below the minimum is raised, with a note saying why", async () => {
    const d = await design(spec({ base: "off", topCap: "off", coreSize: { locked: true, dimension: "outer", value: 22 }, height: { locked: false } }), "draft");
    expect(d.solution.outerSize).toBeGreaterThanOrEqual(PASSAGE + 2 * WALL(3.8) - 1e-6);
    const note = d.notices.find((n) => /Core size raised/.test(n.message));
    expect(note?.message).toMatch(/centre hole/);
    // With the base, 22 mm is not raised for this reason.
    const based = await design(spec({ base: "on", topCap: "off", coreSize: { locked: true, dimension: "outer", value: 22 }, height: { locked: false } }), "draft");
    expect(based.notices.find((n) => /Core size raised/.test(n.message))).toBeUndefined();
  });
});

describe("a bare core's cable length (issue #254)", () => {
  it("counts both ends the core holds: at least its height more than the same core with a base", async () => {
    const on = await design(spec({ base: "on", topCap: "off" }), "draft");
    const off = await design(spec({ base: "off", topCap: "off" }), "draft");
    expect(off.solution.totalWoundLength).toBeCloseTo(on.solution.totalWoundLength, 6);
    expect(off.solution.totalWireLength - on.solution.totalWireLength).toBeGreaterThanOrEqual(80);
  });

  it("the held length grows with the core height", async () => {
    const lengthAt = async (height: number) => (await design(spec({ base: "off", topCap: "off", height: { locked: true, value: height } }), "draft")).solution;
    const [a, b] = [await lengthAt(60), await lengthAt(100)];
    const wound = (s: typeof a) => s.totalWoundLength;
    expect(b.totalWireLength - wound(b)).toBeGreaterThan(a.totalWireLength - wound(a) + 39);
  });

  it("never reports ok below the target, whichever dimensions are free", async () => {
    const long = { length: 9000, diameter: 3.8, type: "usb" as const };
    // Fully locked and too small for 9 m: over-constrained, short of the target.
    const locked = await design(spec({ base: "off", topCap: "off", wire: long, coreSize: { locked: true, dimension: "outer", value: 40 }, height: { locked: true, value: 60 } }), "draft");
    expect(locked.solution.diagnosis.status).toBe("over-constrained");
    expect(locked.solution.totalWireLength).toBeLessThan(long.length);
    // Every other combination that reports ok holds the target.
    const cases: Partial<CoilSpec>[] = [
      { coreSize: { locked: false }, height: { locked: true, value: 60 } },
      { coreSize: { locked: true, dimension: "outer", value: 40 }, height: { locked: false } },
      { coreSize: { locked: false }, height: { locked: false } },
      { coreSize: { locked: false }, height: { locked: false }, layers: { locked: false } },
    ];
    for (const c of cases) {
      const d = await design(spec({ base: "off", wire: long, ...c }), "draft");
      if (d.solution.diagnosis.status === "ok" || d.solution.diagnosis.status === "under-constrained") {
        expect(d.solution.totalWireLength, JSON.stringify(c)).toBeGreaterThanOrEqual(long.length * (1 - 1e-6));
      }
    }
  });

  it("a locked height under what the two rings and the bend need is raised, with a note", async () => {
    const d = await design(spec({ base: "off", topCap: "off", height: { locked: true, value: 12 }, coreSize: { locked: true, dimension: "outer", value: 60 } }), "draft");
    // The bottom ring (5.5 mm), the top ring (up to 10.2 mm) and a funnel under it (4.8 mm at least).
    expect(d.solution.height).toBeGreaterThanOrEqual(20);
    expect(d.notices.some((n) => /Height raised/.test(n.message))).toBe(true);
    const based = await design(spec({ base: "on", topCap: "off", height: { locked: true, value: 12 }, coreSize: { locked: true, dimension: "outer", value: 60 } }), "draft");
    expect(based.solution.height).toBe(12);
  });
});
