import { describe, expect, it } from "vitest";
import { DEFAULT_SPEC, design, outlineOffsetAt } from "../src/core";
import type { CoilSpec, Design } from "../src/core";

// Issue #381: where the inner-end channel meets the bore, the cut left needle
// triangles on the bore wall and rim (angles of 0.2 to 0.9 degrees, edges of
// 0.02 mm). A needle narrower than a pixel is drawn or skipped depending on how
// the camera lands, so the viewer showed a dot on the bore wall in some framings.
// The invariant is on the mesh, so it holds in every framing and in the STL too.

const RIM_BAND = 1;
const MIN_ANGLE_DEG = 1;
const MIN_EDGE = 0.05;

const ROUND: CoilSpec = {
  ...DEFAULT_SPEC,
  wire: { length: 300, diameter: 3.8, type: "usb" },
  coreSize: { locked: true, dimension: "outer", value: 25 },
  height: { locked: true, value: 1 },
  tolerance: 0.1,
  mount: "through",
  topCap: "on",
};

const CASES: [string, CoilSpec][] = [
  ["round, through mount", ROUND],
  ["pill, through mount", { ...ROUND, shape: { kind: "pill", cornerRadius: 10 } }],
  ["default design", DEFAULT_SPEC],
  ["square, through mount", { ...ROUND, shape: { kind: "sq", cornerRadius: 5 }, coreSize: { locked: true, dimension: "outer", value: 40 } }],
  ["triangle, through mount", { ...ROUND, shape: { kind: "tri", cornerRadius: 8 }, coreSize: { locked: true, dimension: "outer", value: 40 } }],
  ["round, no mount", { ...ROUND, mount: "none" }],
];

type Corner = [number, number, number];

function minAngleDeg(a: Corner, b: Corner, c: Corner): number {
  const angleAt = (p: Corner, q: Corner, r: Corner) => {
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v));
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  };
  return Math.min(angleAt(a, b, c), angleAt(b, c, a), angleAt(c, a, b));
}

function needlesAtBoreRim(d: Design): string[] {
  const core = d.parts.find((p) => p.role === "core")!.mesh;
  const { positions, indices } = core;
  const bore = d.flangeSpec.boreOutline;
  const corner = (i: number): Corner => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
  const levels = [0, -d.flangeSpec.thickness, d.solution.height];
  const nearBore = (p: Corner) => Math.abs(outlineOffsetAt(bore, p[0], p[1]).offset) <= RIM_BAND;
  const atRimLevel = (p: Corner) => levels.some((z) => Math.abs(p[2] - z) <= RIM_BAND);
  const found: string[] = [];
  for (let t = 0; t < indices.length / 3; t++) {
    const [a, b, c] = [corner(indices[3 * t]), corner(indices[3 * t + 1]), corner(indices[3 * t + 2])];
    if (![a, b, c].every(nearBore) || ![a, b, c].some(atRimLevel)) continue;
    const angle = minAngleDeg(a, b, c);
    const edge = Math.min(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]));
    if (angle < MIN_ANGLE_DEG || edge < MIN_EDGE) found.push(`triangle ${t}: min angle ${angle.toFixed(2)} deg, min edge ${edge.toFixed(3)} mm at ${a.map((x) => x.toFixed(2)).join(",")}`);
  }
  return found;
}

describe("the core's bore rim", () => {
  it.each(CASES)("%s: no triangle within 1 mm of the bore has an angle under 1 degree or an edge under 0.05 mm", async (_name, spec) => {
    const needles = needlesAtBoreRim(await design(spec));
    expect(needles).toEqual([]);
  });
});
