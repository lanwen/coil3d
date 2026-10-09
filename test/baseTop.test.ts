import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SPEC, design } from "../src/core";
import type { CoilMesh, CoilSpec, Design, ShapeSpec, WireSpec } from "../src/core";

// Issue #292: with the base on, the top of the core is the bare core's top: the same ring, centre hole and outer-end
// channel, with the same dimensions. Only the bottom differs. Each base-on design here is locked to the size and height
// the bare core solved to, so the two cores are the same wall; the checks then read the top through design().

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const SHAPES: Array<[string, ShapeSpec]> = [
  ["round", { kind: "round" }],
  ["square", { kind: "sq", cornerRadius: 12 }],
  ["triangle", { kind: "tri", cornerRadius: 12 }],
];

const CABLES: Array<[string, WireSpec]> = [
  ["USB 3.8 mm", { length: 2500, diameter: 3.8, type: "usb" }],
  ["HDMI 7 mm", { length: 2500, diameter: 7, type: "usb" }],
  ["flex 2.6 mm", { length: 2500, diameter: 2.6, type: "usb" }],
];

const GRID = SHAPES.flatMap(([shape]) => CABLES.flatMap(([cable]) => [1, 2, 3, 4].flatMap((layers) => (["on", "off"] as const).map((cap) => [shape, cable, layers, cap] as const))));

function spec(shape: ShapeSpec, wire: WireSpec, layers: number, topCap: "on" | "off", base: "on" | "off", fixed?: Design): CoilSpec {
  return {
    ...DEFAULT_SPEC,
    wire,
    shape,
    coreSize: fixed ? { locked: true, dimension: "outer", value: fixed.solution.outerSize } : { locked: false },
    height: fixed ? { locked: true, value: fixed.solution.height } : { locked: false },
    layers: { locked: true, value: layers },
    base,
    topCap,
  };
}

async function pair(shapeName: string, cableName: string, layers: number, cap: "on" | "off"): Promise<{ bare: Design; based: Design }> {
  const shape = SHAPES.find(([n]) => n === shapeName)![1];
  const wire = CABLES.find(([n]) => n === cableName)![1];
  const bare = await design(spec(shape, wire, layers, cap, "off"), "draft");
  const based = await design(spec(shape, wire, layers, cap, "on", bare), "draft");
  return { bare, based };
}

function core(d: Design): CoilMesh {
  return d.parts.find((p) => p.role === "core")!.mesh;
}

/** The lowest height of the top region: the funnel's foot under the top ring, or the top 12 mm where there is no ring. */
function topRegionFloor(bare: Design): number {
  const ring = bare.faceChannels;
  if (ring?.topThickness !== undefined) return ring.height - ring.topThickness - ring.funnelDepth;
  return bare.solution.height - 12;
}

const SECTIONS = 40;
/** Relative: the two meshes are refined and flattened separately, so a flat face may differ by a sliver. */
const SAME = 1e-4;

/** The cross-section area at `SECTIONS` heights through the top region, and the volume above its floor: the same wherever the surface is cut into triangles. */
function topRegion(mesh: CoilMesh, floor: number, height: number): { areas: number[]; volume: number } {
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  const above = m.trimByPlane([0, 0, 1], floor);
  const areas = Array.from({ length: SECTIONS }, (_, i) => {
    const section = m.slice(floor + ((height - floor) * (i + 0.5)) / SECTIONS);
    const area = section.area();
    section.delete();
    return area;
  });
  const volume = above.volume();
  above.delete();
  m.delete();
  return { areas, volume };
}

describe.each(GRID)("%s core, %s, %i layers, cap %s: the top with the base on", (shapeName, cableName, layers, cap) => {
  it("has the bare core's top region: the same sections and the same volume above the ring's funnel", async () => {
    const { bare, based } = await pair(shapeName, cableName, layers, cap);
    expect(based.solution.outerSize).toBeCloseTo(bare.solution.outerSize, 9);
    expect(based.solution.height).toBeCloseTo(bare.solution.height, 9);
    const floor = topRegionFloor(bare);
    const [want, got] = [bare, based].map((d) => topRegion(core(d), floor, d.solution.height));
    expect(want.volume).toBeGreaterThan(100);
    expect(Math.abs(got.volume - want.volume) / want.volume, "volume above the funnel").toBeLessThan(SAME);
    got.areas.forEach((area, i) => expect(Math.abs(area - want.areas[i]) / want.areas[i], `section ${i}`).toBeLessThan(SAME));
  });

  it("has the bare core's ring, hole and outer end", async () => {
    const { bare, based } = await pair(shapeName, cableName, layers, cap);
    const [a, b] = [bare.faceChannels, based.faceChannels];
    expect(b?.outer, "the outer end's top channel").toEqual(a?.outer);
    if (cap === "off") expect(a?.outer, "the outer end is in the top channel").toBeDefined();
    expect(b?.topThickness).toEqual(a?.topThickness);
    if (a?.topThickness !== undefined) {
      expect(b?.holeOutline).toEqual(a.holeOutline);
      expect(b?.ringWidth).toEqual(a.ringWidth);
      expect(b?.funnelDepth).toEqual(a.funnelDepth);
    }
    if (cap === "off") expect(Array.from(based.outerEndLeadOut)).toEqual(Array.from(bare.outerEndLeadOut));
  });

  it("keeps the base-on bottom: the flange, and the inner end's clip instead of a bottom channel", async () => {
    const { based } = await pair(shapeName, cableName, layers, cap);
    expect(based.flangeSpec.thickness).toBeGreaterThan(0);
    expect(based.innerEndClip).toBeDefined();
    expect(based.faceChannels?.inner).toBeUndefined();
    const z = core(based).positions.filter((_, i) => i % 3 === 2);
    expect(z.reduce((lo, v) => Math.min(lo, v), Infinity)).toBeCloseTo(-based.flangeSpec.thickness, 6);
  });
});

describe("the solver with the base on (issue #292)", () => {
  const free = (base: "on" | "off", layers: number, topCap: "on" | "off" | "auto" = "off"): CoilSpec => ({
    ...DEFAULT_SPEC,
    base,
    topCap,
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    coreSize: { locked: false },
    height: { locked: false },
    layers: { locked: true, value: layers },
  });

  it("counts the top channel's cable: a one-layer core with no cap holds more than the wound turns", async () => {
    const d = await design({ ...free("on", 1), coreSize: { locked: true, dimension: "outer", value: 40 }, height: { locked: true, value: 60 } }, "draft");
    expect(d.faceChannels?.outer).toBeDefined();
    expect(d.solution.totalWireLength - d.solution.totalWoundLength).toBeCloseTo(d.faceChannels!.outer!.length, 6);
    const capped = await design({ ...free("on", 1, "on"), coreSize: { locked: true, dimension: "outer", value: 40 }, height: { locked: true, value: 60 } }, "draft");
    expect(capped.faceChannels).toBeUndefined();
    expect(capped.solution.totalWireLength).toBeCloseTo(capped.solution.totalWoundLength, 6);
  });

  it("raises a core too small for the hole to the bare core's size, with the note", async () => {
    const small = { coreSize: { locked: true, dimension: "outer", value: 22 }, height: { locked: false } } as const;
    const bare = await design({ ...free("off", 1), ...small }, "draft");
    const based = await design({ ...free("on", 1), ...small }, "draft");
    expect(based.solution.outerSize).toBeGreaterThanOrEqual(bare.solution.minOuterSizeForShape - 1e-6);
    expect(based.solution.minOuterSizeForShape).toBeCloseTo(bare.solution.minOuterSizeForShape, 6);
    expect(based.notices.find((n) => /Core size raised/.test(n.message))?.message).toMatch(/centre hole/);
  });

  it.each([1, 2, 3, 4])("resolves the auto top cap the bare core's way at %i layers, whatever the base", async (layers) => {
    for (const base of ["on", "off"] as const) {
      const d = await design({ ...free(base, layers, "auto"), coreSize: { locked: true, dimension: "outer", value: 50 } }, "draft");
      expect(d.solution.topCapEnabled, base).toBe(false);
      expect(d.parts.map((p) => p.name), base).toEqual(["core"]);
    }
  });
});
