import { describe, expect, it } from "vitest";
import { design, exportDesign, parseHash } from "../src/core";
import type { CoilSpec } from "../src/core";
import { CAP_THICKNESS, EDGE_CHAMFER } from "../src/core/constants";
import { plateTopZ } from "../src/core/flangePads";
import { pointAt } from "../src/core/shapes";
import { STEP_TIMEOUT_MS, insideAt, stepContains, verticalCrossings } from "./support/step";

// Issues #229, #237: the outer perimeter edges of the bottom flange and the top cap are chamfered 1 mm x 45 degrees on
// both faces. Checked on the built meshes, by casting vertical rays through them near the rim.

function rayHits(mesh: { positions: Float32Array; indices: Uint32Array }, x: number, y: number): number[] {
  const p = mesh.positions;
  const t = mesh.indices;
  const hits: number[] = [];
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
    const d = (p[b + 1] - p[c + 1]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 1] - p[c + 1]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((p[b + 1] - p[c + 1]) * (x - p[c]) + (p[c] - p[b]) * (y - p[c + 1])) / d;
    const l2 = ((p[c + 1] - p[a + 1]) * (x - p[c]) + (p[a] - p[c]) * (y - p[c + 1])) / d;
    if (l1 < -1e-9 || l2 < -1e-9 || 1 - l1 - l2 < -1e-9) continue;
    hits.push(l1 * p[a + 2] + l2 * p[b + 2] + (1 - l1 - l2) * p[c + 2]);
  }
  hits.sort((u, v) => u - v);
  return hits.filter((z, i) => i === 0 || z - hits[i - 1] > 1e-4);
}

function spec(overrides: Partial<CoilSpec>): CoilSpec {
  return { ...parseHash("").spec, topCap: "on", ...overrides };
}

const DESIGNS: Array<{ label: string; spec: CoilSpec }> = [
  { label: "round", spec: spec({ coreSize: { locked: true, dimension: "outer", value: 60 } }) },
  { label: "sq", spec: spec({ shape: { kind: "sq", cornerRadius: 10 }, coreSize: { locked: true, dimension: "outer", value: 60 } }) },
  { label: "tri", spec: spec({ shape: { kind: "tri", cornerRadius: 8 }, coreSize: { locked: true, dimension: "outer", value: 60 } }) },
  { label: "sq, keyhole (thicker flange)", spec: spec({ shape: { kind: "sq", cornerRadius: 10 }, coreSize: { locked: true, dimension: "outer", value: 60 }, mount: "keyhole" }) },
];

/** The vertical extent of the material on the vertical line `depth` mm inside the flange's outer edge, wherever it is one solid interval. */
function rimSpans(mesh: { positions: Float32Array; indices: Uint32Array }, d: { flangeSpec: { outline: Parameters<typeof pointAt>[0]; margin: number } }, depth: number): Array<[number, number]> {
  const { outline, margin } = d.flangeSpec;
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < 90; i++) {
    const p = pointAt(outline, (i + 0.5) / 90, margin - depth);
    const hits = rayHits(mesh, p.x, p.y).filter((z) => z < 0.5);
    if (hits.length === 2) spans.push([hits[0], hits[1]]);
  }
  return spans;
}

/** Within 0.15 mm: a corner arc's facets sag that much between two columns. */
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(0.15);

/** The share of `spans` satisfying `ok` -- a few rays cross a cable clip's bore or the flange's channel pad. */
const share = <T,>(spans: T[], ok: (s: T) => boolean) => spans.filter(ok).length / spans.length;

describe.each(DESIGNS)("edge chamfer: $label", ({ spec }) => {
  it("chamfers the flange's outer edge 45 degrees, about 1 mm, on both faces", async () => {
    const d = await design(spec);
    const T = d.flangeSpec.thickness;
    const zPlate = plateTopZ(d.flangeSpec);
    const core = d.parts.find((p) => p.role === "core")!;
    for (const depth of [0.25, 0.5, 0.75]) {
      const spans = rimSpans(core.mesh, d, depth);
      expect(spans.length).toBeGreaterThan(30);
      // Bottom (bed-side) edge: 45 degrees, so `depth` mm in from the rim the surface is (1 - depth) above the face.
      for (const [lo] of spans) near(lo, -T + (EDGE_CHAMFER - depth));
      // Top edge: on the plate (or on a pad at the rim) the same chamfer.
      const top = (z: number) => spans.filter(([, hi]) => Math.abs(hi - z) < 0.15).length;
      const onPlate = zPlate === undefined ? 0 : top(zPlate - (EDGE_CHAMFER - depth));
      expect(onPlate + top(-(EDGE_CHAMFER - depth))).toBeGreaterThanOrEqual(spans.length * 0.85);
    }
    // Deeper than the chamfer, the full land.
    const inner = rimSpans(core.mesh, d, 1.5);
    expect(inner.filter(([lo, hi]) => Math.abs(lo + T) < 1e-3 && (Math.abs(hi) < 1e-3 || Math.abs(hi - (zPlate ?? 0)) < 1e-3)).length).toBeGreaterThan(30);
  });

  it("chamfers the cap's outer edge the same way, on both faces (issue #237: the cable clips no longer force a square underside)", async () => {
    const d = await design(spec);
    const cap = d.parts.find((p) => p.role === "topCap")!;
    const { outline, margin } = d.flangeSpec;
    const z0 = d.solution.height;
    const spansAt = (depth: number) => {
      const out: Array<[number, number]> = [];
      for (let i = 0; i < 90; i++) {
        const p = pointAt(outline, (i + 0.5) / 90, margin - depth);
        const hits = rayHits(cap.mesh, p.x, p.y);
        // Not through a cable clip hanging under the plate.
        if (hits.length === 2 && hits[1] - hits[0] < CAP_THICKNESS + 0.01) out.push([hits[0] - z0, hits[1] - z0]);
      }
      return out;
    };
    for (const depth of [0.25, 0.5, 0.75]) {
      const spans = spansAt(depth);
      expect(spans.length).toBeGreaterThan(30);
      expect(share(spans, ([lo, hi]) => Math.abs(lo - (EDGE_CHAMFER - depth)) < 0.15 && Math.abs(hi - (CAP_THICKNESS - (EDGE_CHAMFER - depth))) < 0.15)).toBeGreaterThan(0.8);
    }
    expect(share(spansAt(1.5), ([lo, hi]) => Math.abs(lo) < 0.02 && Math.abs(hi - CAP_THICKNESS) < 0.02)).toBeGreaterThan(0.8);
    // The vertical land between the two chamfers is at least 1 mm.
    expect(CAP_THICKNESS - 2 * EDGE_CHAMFER).toBeGreaterThanOrEqual(1);
  });
});

describe("edge chamfer in the STEP export", () => {
  it(
    "cuts the same chamfer as the mesh, on the flange's bed face and on both faces of the cap",
    async () => {
      const d = await design(DESIGNS[1].spec);
      const bytes = await exportDesign(d, "step");
      const { outline, margin, thickness } = d.flangeSpec;
      const z0 = d.solution.height;
      // 0.25 mm in from the rim, the chamfer is 0.75 mm up its face: probe 0.3 mm either side of that line.
      const line = EDGE_CHAMFER - 0.25;
      const probes: Array<{ part: "core" | "topCap"; x: number; y: number; z: number; expectInside: boolean }> = [];
      for (const t of [0.07, 0.3, 0.55, 0.8]) {
        const { x, y } = pointAt(outline, t, margin - 0.25);
        probes.push({ part: "core", x, y, z: -thickness + line - 0.3, expectInside: false }, { part: "core", x, y, z: -thickness + line + 0.3, expectInside: true });
        // Not under a cable clip, which hangs below the plate there.
        if (verticalCrossings(d.parts.find((part) => part.role === "topCap")!.mesh, x, y).length !== 2) continue;
        probes.push({ part: "topCap", x, y, z: z0 + line - 0.3, expectInside: false }, { part: "topCap", x, y, z: z0 + line + 0.3, expectInside: true });
        probes.push({ part: "topCap", x, y, z: z0 + CAP_THICKNESS - line + 0.3, expectInside: false }, { part: "topCap", x, y, z: z0 + CAP_THICKNESS - line - 0.3, expectInside: true });
      }
      const inStep = await stepContains(bytes, "edge-chamfer", probes.map((p) => [p.x, p.y, p.z]));
      probes.forEach((p, i) => {
        const mesh = d.parts.find((part) => part.role === p.part)!.mesh;
        const inMesh = insideAt(verticalCrossings(mesh, p.x, p.y), p.z);
        expect([p.part, p.z.toFixed(2), "mesh", inMesh]).toEqual([p.part, p.z.toFixed(2), "mesh", p.expectInside]);
        expect([p.part, p.z.toFixed(2), "step", inStep[i]]).toEqual([p.part, p.z.toFixed(2), "step", p.expectInside]);
      });
    },
    STEP_TIMEOUT_MS,
  );
});

describe.each(DESIGNS)("rim triangles for the drawing: $label", ({ spec }) => {
  it("flags the chamfer bands (45 degrees) and the land (vertical) on the core and the cap, apart from the label", async () => {
    const d = await design({ ...spec, label: "USB-C 2m" });
    for (const role of ["core", "topCap"] as const) {
      const mesh = d.parts.find((p) => p.role === role)!.mesh;
      const rim = mesh.rimTriangles!;
      expect(rim.chamfer.length, role).toBeGreaterThan(100);
      expect(rim.land.length, role).toBeGreaterThan(50);
      const p = mesh.positions;
      const slope = (t: number) => {
        const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t * 3 + k] * 3);
        const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
        const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        return Math.abs(n[2]) / Math.hypot(...n);
      };
      for (const t of rim.chamfer) expect(Math.abs(slope(t) - Math.SQRT1_2)).toBeLessThan(0.15);
      for (const t of rim.land) expect(slope(t)).toBeLessThan(0.2);
      const label = new Set(mesh.labelTriangles);
      for (const t of [...rim.chamfer, ...rim.land]) expect(label.has(t)).toBe(false);
    }
  });
});
