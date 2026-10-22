import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { CAP_THICKNESS, DEFAULT_SPEC, design, parseHash } from "../src/core";
import type { CoilMesh, CoilSpec, Design } from "../src/core";
import { expectWithinBendLimit } from "./support/cableBend";
import { expectSelfClear, woundWithLeadOut } from "./support/cableClearance";
import { unsupportedOverhangs } from "./support/overhangs";
import { meshVolume } from "./support/mesh";
import { minBendRadius } from "./support/wire";

// Issue #376: a flat spiral lies on the base, so the cap closes on the cable and the gap between them is the
// cable's diameter plus a fixed clearance. 0.4 mm forgives an undersized top layer plus a fat jacket.
const FLAT_CLEARANCE = 0.4;
const flatGap = (d: number) => d + FLAT_CLEARANCE;
const flatZ = (d: number) => flatGap(d) / 2;

// 2000 mm of 3.8 mm usb, 9 layers, height locked at 9.5 mm, cap and base on.
const REPRO_HASH = "#s=eyJ2IjoyLCJoIjo5LjUsImx5Ijo5LCJsb2NrIjpbImgiLCJseSJdLCJjYXAiOiJvbiIsImJhc2UiOiJvbiJ9";
// A flat turn's length counts its radial growth, so the same cable needs a core 3.8 mm smaller than a circle per layer did.
const REPRO_ENVELOPE = 101.1;

const wasm = await Module();
wasm.setup();

function make(overrides: Partial<CoilSpec> & { d?: number; length?: number }): CoilSpec {
  const { d = 3.8, length = 300, ...rest } = overrides;
  return { ...DEFAULT_SPEC, wire: { ...DEFAULT_SPEC.wire, length, diameter: d }, base: "on", topCap: "on", ...rest };
}

const lockedHeight = (value: number) => ({ height: { locked: true as const, value } });
const oneLayerSizeFree = { coreSize: { locked: false as const }, layers: { locked: true as const, value: 1 } };
const reproAt = (value: number | undefined, extra: Partial<CoilSpec> = {}): CoilSpec => {
  const spec = parseHash(REPRO_HASH).spec;
  return { ...spec, height: value === undefined ? { locked: false } : { locked: true, value }, ...extra };
};
const raisedNote = (d: Design) => d.notices.find((n) => /Height raised/.test(n.message));

function zRange(points: Float32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < points.length; i += 3) {
    lo = Math.min(lo, points[i]);
    hi = Math.max(hi, points[i]);
  }
  return [lo, hi];
}

function solids(mesh: CoilMesh): number {
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  const pieces = m.decompose();
  const n = m.status() === "NoError" ? pieces.length : -1;
  pieces.forEach((p) => p.delete());
  m.delete();
  return n;
}

const partOf = (d: Design, role: string) => d.parts.find((p) => p.role === role)!;
const minZ = (mesh: CoilMesh) => {
  let lo = Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) lo = Math.min(lo, mesh.positions[i]);
  return lo;
};

describe("the lowest height with the cap and base on is the cable plus the clearance", () => {
  for (const d of [2, 3.8, 8]) {
    it(`d = ${d} mm: minHeight and the raised height are ${flatGap(d).toFixed(1)} mm, one turn`, async () => {
      const r = await design(make({ d, ...oneLayerSizeFree, ...lockedHeight(1) }), "draft");
      expect(r.solution.minHeight).toBeCloseTo(flatGap(d), 6);
      expect(r.solution.height).toBeCloseTo(flatGap(d), 6);
      expect(r.solution.layerResults.map((l) => l.turns)).toEqual([1]);
      expect(r.solution.diagnosis.status).toBe("ok");
      expect(raisedNote(r)?.message).toMatch(new RegExp(`${d} mm plus ${FLAT_CLEARANCE} mm`));
    });
  }

  it("a free height snaps to the gap", async () => {
    const spec = make({ length: 1000, coreSize: { locked: true, dimension: "outer", value: 120 }, layers: { locked: true, value: 3 }, height: { locked: false } });
    const r = await design(spec, "draft");
    expect(r.solution.diagnosis.status).toBe("ok");
    expect(r.solution.height).toBeCloseTo(flatGap(3.8), 6);
    expect(r.solution.layerResults.map((l) => l.turns)).toEqual([1, 1, 1]);
    expect(r.solution.overallHeight).toBeCloseTo(r.flangeSpec.thickness + flatGap(3.8) + CAP_THICKNESS, 6);
  });

  it("the repro's core with a free height has the cap on the cable: the gap is d + 0.4, the play is 0.4", async () => {
    const r = await design(reproAt(undefined, { coreSize: { locked: true, dimension: "outer", value: 41 } }), "draft");
    expect(r.solution.diagnosis.status).toBe("ok");
    expect(r.solution.height - 3.8).toBeLessThanOrEqual(FLAT_CLEARANCE + 1e-6);
    expect(r.solution.layerResults.map((l) => l.turns)).toEqual(Array(9).fill(1));
  });
});

describe("a locked height at the gap winds the repro", () => {
  it("is ok with no raise note, nine one-turn layers and the full length", async () => {
    const spec = reproAt(flatGap(3.8));
    const r = await design(spec, "draft");
    expect(r.solution.diagnosis.status).toBe("ok");
    expect(raisedNote(r)).toBeUndefined();
    expect(r.solution.height).toBeCloseTo(flatGap(3.8), 6);
    expect(r.solution.layerResults.map((l) => l.turns)).toEqual(Array(9).fill(1));
    expect(r.solution.totalWireLength).toBeGreaterThanOrEqual(spec.wire.length);
    expect(Math.abs(r.solution.envelopeDiameter - REPRO_ENVELOPE)).toBeLessThan(0.5);
  });

  it("the cable is planar: every layer and hop sits at (d + 0.4) / 2, inside the gap", async () => {
    const r = await design(reproAt(flatGap(3.8)), "draft");
    const z = flatZ(3.8);
    for (const w of r.wirePaths) {
      const [lo, hi] = zRange(w.points);
      expect(lo, `layer ${w.layer}`).toBeCloseTo(z, 3);
      expect(hi, `layer ${w.layer}`).toBeCloseTo(z, 3);
    }
    expect(r.layerTransitions, "the layers are turns of one spiral, with no hops between them").toEqual([]);
    for (const lead of [r.outerEndLeadOut]) {
      const [lo, hi] = zRange(lead);
      expect(lo - 3.8 / 2).toBeGreaterThanOrEqual(-1e-3);
      expect(hi + 3.8 / 2).toBeLessThanOrEqual(r.solution.height + 1e-3);
    }
  });

  it("the cable stays below the cap and above the base all the way round", async () => {
    const r = await design(reproAt(flatGap(3.8)), "draft");
    const wound = r.cablePath.slice(r.innerEndLeadIn.length);
    const [lo, hi] = zRange(wound);
    expect(lo - 3.8 / 2).toBeGreaterThanOrEqual(-1e-3);
    expect(hi + 3.8 / 2).toBeLessThanOrEqual(r.solution.height + 1e-3);
  });

  it("the bend limit holds through the planar hops and the lead-out", async () => {
    const spec = reproAt(flatGap(3.8));
    const r = await design(spec, "final");
    expect(r.warnings.filter((w) => w.includes("bends tighter"))).toEqual([]);
    expectWithinBendLimit(r.cablePath, minBendRadius(spec.wire), "flat gap repro");
  });

  it("a free-height core keeps the bend limit too, and so does a thick cable", async () => {
    for (const spec of [
      make({ length: 1000, coreSize: { locked: true, dimension: "outer", value: 120 }, layers: { locked: true, value: 3 }, height: { locked: false } }),
      make({ d: 8, length: 1200, coreSize: { locked: true, dimension: "outer", value: 160 }, layers: { locked: true, value: 3 }, height: { locked: false } }),
    ]) {
      const r = await design(spec, "final");
      expect(r.solution.height).toBeCloseTo(flatGap(spec.wire.diameter), 6);
      expect(r.warnings.filter((w) => w.includes("bends tighter"))).toEqual([]);
      expectWithinBendLimit(r.cablePath, minBendRadius(spec.wire), `flat gap d=${spec.wire.diameter}`);
    }
  });
});

describe("the flat spiral is a cable that fits in the space it is drawn in (issue #376)", () => {
  const FLAT_CASES: Array<{ name: string; spec: CoilSpec }> = [
    { name: "repro at 4.2 mm", spec: reproAt(flatGap(3.8)) },
    { name: "repro at 9.5 mm", spec: parseHash(REPRO_HASH).spec },
    { name: "free height, 3 layers", spec: make({ length: 1000, coreSize: { locked: true, dimension: "outer", value: 120 }, layers: { locked: true, value: 3 }, height: { locked: false } }) },
    { name: "d = 8 mm", spec: make({ d: 8, length: 1200, coreSize: { locked: true, dimension: "outer", value: 160 }, layers: { locked: true, value: 3 }, height: { locked: false } }) },
    { name: "d = 2 mm", spec: make({ d: 2, ...oneLayerSizeFree, ...lockedHeight(1) }) },
    { name: "square", spec: make({ length: 1000, shape: { kind: "sq", cornerRadius: 10 }, coreSize: { locked: true, dimension: "outer", value: 90 }, layers: { locked: true, value: 3 }, height: { locked: false } }) },
    { name: "triangle", spec: make({ length: 800, shape: { kind: "tri", cornerRadius: 10 }, coreSize: { locked: true, dimension: "outer", value: 90 }, layers: { locked: true, value: 3 }, height: { locked: false } }) },
  ];

  it.each(FLAT_CASES)("$name: no two passes of the layers or the lead-out come closer than the cable allows", async (c) => {
    const d = await design(c.spec, "final");
    expectSelfClear(woundWithLeadOut(d), c.spec.wire.diameter, c.name);
  });

  const pathLength = (points: Float32Array) => {
    let total = 0;
    for (let i = 3; i < points.length; i += 3) total += Math.hypot(points[i] - points[i - 3], points[i + 1] - points[i - 2], points[i + 2] - points[i - 1]);
    return total;
  };

  it.each(FLAT_CASES)("$name: the capacity is the length of the cable drawn in the layers", async (c) => {
    const d = await design(c.spec, "final");
    const drawn = d.wirePaths.reduce((sum, w) => sum + pathLength(w.points), 0);
    expect(Math.abs(drawn - d.solution.totalWoundLength) / d.solution.totalWoundLength).toBeLessThan(0.001);
  });

  // The inner lead-in still crosses the stack at the layers' height for its first millimetres: pre-existing, tracked in #377. Flips to a pass when #377 lands.
  it.fails("the inner lead-in clears the layers too", async () => {
    const d = await design(reproAt(flatGap(3.8)), "final");
    expectSelfClear(d.cablePath, 3.8, "whole cable path");
  });
});

describe("a locked height above the gap is honoured and says what would close the cap", () => {
  it("the repro at 9.5 mm: the cable still lies flat on the base, and a note names 4.2 mm", async () => {
    const r = await design(parseHash(REPRO_HASH).spec, "draft");
    expect(r.solution.height).toBe(9.5);
    expect(r.solution.diagnosis.status).toBe("ok");
    expect(r.solution.layerResults.map((l) => l.turns)).toEqual(Array(9).fill(1));
    for (const w of r.wirePaths) {
      const [lo, hi] = zRange(w.points);
      expect(lo).toBeCloseTo(flatZ(3.8), 3);
      expect(hi).toBeCloseTo(flatZ(3.8), 3);
    }
    expect(r.notices.find((n) => n.message.includes("one turn per layer"))?.message).toBe("This core winds one turn per layer; at 4.2 mm the cap holds the cable without play.");
  });

  it("says nothing at the gap itself", async () => {
    const r = await design(reproAt(flatGap(3.8)), "draft");
    expect(r.notices.filter((n) => n.message.includes("without play"))).toEqual([]);
  });
});

describe("the joint with a one-turn-tall core", () => {
  it("the bayonet fits through the base's bore at 4.2 mm", async () => {
    const r = await design(reproAt(flatGap(3.8), { joint: "bayonet" }), "draft");
    expect(r.notices.filter((n) => n.message.includes("twist lock"))).toEqual([]);
    expect(r.capJoint?.kind).toBe("bayonet");
    expect(r.solution.height).toBeCloseTo(flatGap(3.8), 6);
  });

  it("the snap clips don't fit: press collar, same gap, the existing note", async () => {
    const r = await design(reproAt(flatGap(3.8), { joint: "snap" }), "draft");
    expect(r.capJoint?.kind).toBe("press");
    expect(r.notices.some((n) => n.message.includes("too small for the snap clips"))).toBe(true);
    expect(r.solution.height).toBeCloseTo(flatGap(3.8), 6);
  });

  it("d = 2 mm: the press collar stops short of the base's underside", async () => {
    const r = await design(make({ d: 2, ...oneLayerSizeFree, ...lockedHeight(1) }), "final");
    expect(r.solution.height).toBeCloseTo(flatGap(2), 6);
    expect(minZ(partOf(r, "topCap").mesh)).toBeGreaterThanOrEqual(minZ(partOf(r, "core").mesh) + 0.5);
  });
});

describe("a flat core prints", () => {
  const CASES: Array<{ name: string; spec: CoilSpec }> = [
    { name: "repro at 4.2 mm", spec: reproAt(flatGap(3.8)) },
    { name: "d = 2 mm", spec: make({ d: 2, ...oneLayerSizeFree, ...lockedHeight(1) }) },
    { name: "d = 8 mm", spec: make({ d: 8, ...oneLayerSizeFree, ...lockedHeight(1) }) },
    { name: "bayonet", spec: reproAt(flatGap(3.8), { joint: "bayonet" }) },
  ];
  it.each(CASES)("$name: no unsupported overhang, one solid, a positive volume", async (c) => {
    const d = await design(c.spec, "final");
    expect(d.solution.height).toBeCloseTo(flatGap(c.spec.wire.diameter), 6);
    expect(unsupportedOverhangs(d, c.name)).toEqual([]);
    for (const role of ["core", "topCap"]) {
      const part = partOf(d, role);
      expect(solids(part.mesh), `${role}: one solid`).toBe(1);
      expect(meshVolume(part.mesh), `${role}: volume`).toBeGreaterThan(0);
    }
  });
});
