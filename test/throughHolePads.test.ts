import { describe, expect, it } from "vitest";
import { design, exportDesign, parseHash } from "../src/core";
import type { CoilSpec, Design } from "../src/core";
import { EDGE_CHAMFER } from "../src/core/constants";
import { STEP_TIMEOUT_MS, reimportStep, stepContains } from "./support/step";

// Issue #139: a through-hole's screw head bears on the plate's winding-side
// face (issue #129), so the head must sit flat on the plain plate -- never on
// the inner-end channel's pad (its chamfers, the #133 fillet or the tail) nor
// on the collar under the wall. Checked on the built core mesh: the holes are
// found as the small loops in its flat wall-facing face, and vertical rays
// round each one must cross only the plain plate. The STEP export cuts its
// holes in the same places.

/** A screw head's radius for a given clearance hole: the hole plus a 2 mm bearing ring (a #8 wood screw in the default 4.5 mm hole has a head of about 8 mm). */
const headRadius = (holeRadius: number) => holeRadius + 2;
/** How far past the head the plate must stay plain, mm. */
const PAD_CLEARANCE = 0.5;

type Mesh = Design["mesh"];

/** Every z where the vertical line through (x, y) crosses the given triangles, ascending (in, out, in, out, ...). */
function rayHits(mesh: Mesh, tris: number[], x: number, y: number): number[] {
  const p = mesh.positions;
  const hits: number[] = [];
  for (const i of tris) {
    const [a, b, c] = [mesh.indices[i] * 3, mesh.indices[i + 1] * 3, mesh.indices[i + 2] * 3];
    const d = (p[b + 1] - p[c + 1]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 1] - p[c + 1]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((p[b + 1] - p[c + 1]) * (x - p[c]) + (p[c] - p[b]) * (y - p[c + 1])) / d;
    const l2 = ((p[c + 1] - p[a + 1]) * (x - p[c]) + (p[a] - p[c]) * (y - p[c + 1])) / d;
    const l3 = 1 - l1 - l2;
    // A ray along a shared edge counts for both triangles (the hits are merged below), whatever the triangulation puts there.
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
    hits.push(l1 * p[a + 2] + l2 * p[b + 2] + l3 * p[c + 2]);
  }
  hits.sort((u, v) => u - v);
  return hits.filter((z, i) => i === 0 || z - hits[i - 1] > 1e-4);
}

/** The holes through the flange: the centres and radii of the small boundary loops of the mesh's flat wall-facing face (z = -thickness). */
function throughHoles(d: Design): Array<{ x: number; y: number; r: number }> {
  const { positions: p, indices: t } = d.mesh;
  const zBottom = -d.flangeSpec.thickness;
  const onBottom = (v: number) => Math.abs(p[v * 3 + 2] - zBottom) < 1e-4;
  // Directed edges of the bottom face's triangles; a boundary edge has no twin.
  const edges = new Map<string, [number, number]>();
  for (let i = 0; i < t.length; i += 3) {
    if (!onBottom(t[i]) || !onBottom(t[i + 1]) || !onBottom(t[i + 2])) continue;
    for (let k = 0; k < 3; k++) {
      const a = t[i + k];
      const b = t[i + ((k + 1) % 3)];
      const twin = `${b},${a}`;
      if (edges.has(twin)) edges.delete(twin);
      else edges.set(`${a},${b}`, [a, b]);
    }
  }
  const next = new Map<number, number>();
  for (const [a, b] of edges.values()) next.set(a, b);
  const holes: Array<{ x: number; y: number; r: number }> = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    for (let v: number | undefined = start; v !== undefined && !seen.has(v); v = next.get(v)) {
      seen.add(v);
      loop.push(v);
    }
    const x = loop.reduce((s, v) => s + p[v * 3], 0) / loop.length;
    const y = loop.reduce((s, v) => s + p[v * 3 + 1], 0) / loop.length;
    const r = loop.reduce((s, v) => s + Math.hypot(p[v * 3] - x, p[v * 3 + 1] - y), 0) / loop.length;
    // The rim and the bore are far larger; a hole is a small, round loop.
    if (r < d.spec.throughHoleDiameter!) holes.push({ x, y, r });
  }
  return holes;
}

function spec(shape: CoilSpec["shape"], diameter: number, size: number): CoilSpec {
  const base = parseHash("").spec;
  return {
    ...base,
    shape,
    wire: { length: 2000, diameter, type: "custom" },
    coreSize: { locked: true, dimension: "outer", value: size },
    height: { locked: true, value: 60 },
    mount: "through",
  };
}

const SHAPES: Array<{ label: string; shape: CoilSpec["shape"] }> = [
  { label: "round", shape: { kind: "round" } },
  { label: "sq", shape: { kind: "sq", cornerRadius: 10 } },
  { label: "tri", shape: { kind: "tri", cornerRadius: 10 } },
];
const CASES = [60, 100].flatMap((size) => [2.4, 4, 6, 8].map((diameter) => ({ size, diameter })));

describe("through-hole screw heads sit on the plain plate, clear of every pad (issue #139)", () => {
  describe.each(SHAPES)("$label core", ({ shape }) => {
    it.each(CASES)("$diameter mm cable, $size mm core", async ({ size, diameter }) => {
      const d = await design(spec(shape, diameter, size));
      const T = d.flangeSpec.thickness;
      const plateTop = -T + (d.flangeSpec.plateThickness ?? T);
      const holes = throughHoles(d);
      expect(holes.length).toBeGreaterThanOrEqual(2);

      const { positions: p, indices: t } = d.mesh;
      for (const hole of holes) {
        expect(hole.r).toBeCloseTo(d.spec.throughHoleDiameter! / 2, 1);
        const reach = headRadius(hole.r) + PAD_CLEARANCE;
        // Only the triangles whose bounding box reaches this hole's surroundings.
        const tris: number[] = [];
        for (let i = 0; i < t.length; i += 3) {
          const xs = [t[i], t[i + 1], t[i + 2]].map((v) => p[v * 3]);
          const ys = [t[i], t[i + 1], t[i + 2]].map((v) => p[v * 3 + 1]);
          if (Math.min(...xs) > hole.x + reach || Math.max(...xs) < hole.x - reach) continue;
          if (Math.min(...ys) > hole.y + reach || Math.max(...ys) < hole.y - reach) continue;
          tris.push(i);
        }
        const bad: string[] = [];
        for (let k = 1; k <= 12; k++) {
          const rr = hole.r + 0.2 + ((reach - hole.r - 0.2) * k) / 12;
          for (let a = 0; a < 48; a++) {
            const phi = (2 * Math.PI * a) / 48;
            const x = hole.x + rr * Math.cos(phi);
            const y = hole.y + rr * Math.sin(phi);
            const hits = rayHits(d.mesh, tris, x, y);
            const plain = hits.length === 2 && Math.abs(hits[0] + T) < 1e-3 && Math.abs(hits[1] - plateTop) < 1e-3;
            // Under the head itself the plate must be plain; in the margin past it, the rim may end the plate, or
            // (issue #229) have begun its chamfer, which lifts the plate's bottom face.
            const chamfered = hits.length === 2 && hits[0] > -T + 1e-3 && hits[0] < -T + EDGE_CHAMFER + 1e-3;
            const ok = plain || (rr > headRadius(hole.r) + 1e-9 && (hits.length === 0 || chamfered));
            if (!ok) bad.push(`r=${rr.toFixed(2)} phi=${((phi * 180) / Math.PI).toFixed(0)}: [${hits.map((z) => z.toFixed(2)).join(", ")}]`);
          }
        }
        expect(bad.slice(0, 6), `hole at (${hole.x.toFixed(1)}, ${hole.y.toFixed(1)}): ${bad.length} rays off the plain plate (top ${plateTop.toFixed(2)})`).toEqual([]);
      }
    });
  });
});

describe("the STEP export cuts the same through-holes (issue #139)", () => {
  // A round ring that had to rotate off the channel pad, and a triangle that skips the corner on it.
  it.each([
    { label: "round, 4 mm cable", shape: { kind: "round" } as CoilSpec["shape"], diameter: 4 },
    { label: "tri, 8 mm cable", shape: { kind: "tri", cornerRadius: 10 } as CoilSpec["shape"], diameter: 8 },
  ])(
    "$label",
    async ({ shape, diameter }) => {
      const d = await design(spec(shape, diameter, 60));
      const holes = throughHoles(d);
      expect(holes.length).toBeGreaterThanOrEqual(2);
      const bytes = await exportDesign(d, "step");
      const { valid, solidVolumes } = await reimportStep(bytes, "through-pads");
      expect(valid).toBe(true);
      expect(solidVolumes.length).toBe(1);
      // Mid-plate: open at each mesh hole's centre, solid just past its edge.
      const z = -d.flangeSpec.thickness + 1.5;
      const points = holes.flatMap((h): Array<[number, number, number]> => [
        [h.x, h.y, z],
        ...[0, 1, 2, 3].map((k): [number, number, number] => [h.x + (h.r + 1) * Math.cos((k * Math.PI) / 2), h.y + (h.r + 1) * Math.sin((k * Math.PI) / 2), z]),
      ]);
      const inside = await stepContains(bytes, "through-pads-points", points);
      expect(inside).toEqual(holes.flatMap(() => [false, true, true, true, true]));
    },
    STEP_TIMEOUT_MS,
  );
});
