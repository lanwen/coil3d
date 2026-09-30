import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, parseHash } from "../src/core";
import type { CoilSpec, Design } from "../src/core";
import { FLANGE_PLATE_THICKNESS, INNER_CHANNEL_MIN_SHELF, MIN_FLANGE_THICKNESS_FOR_PLATE, MOUNT_PLATE_PIN_HOLE_DEPTH, SCREW_MOUNT_MIN_SHELF, SCREW_MOUNT_RECESS_DEPTH, THROUGH_MOUNT_COUNTERBORE_DEPTH } from "../src/core/constants";
import { layoutKeyholeMount } from "../src/core/mount";
import { mountPlateLayoutFor } from "../src/core/mountPlate";
import { layoutInnerEnd, resolveChannelDepth } from "../src/core/innerEnd";
import { offsetOutline, pointAt } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";

// Issue #122: the bottom flange is a thin plate with its wall-facing face
// flat, thickened (on pads) only under the wall, the inner-end channel and
// each mount cut. Checked on the built core mesh itself, by casting vertical
// rays through it.

/** The user's repro: 1 m of 2.4 mm cable, triangle, keyhole mount, cap on. */
const REPRO = "#s=eyJ2IjoyLCJMIjoxMDAwLCJkIjoyLjQsInNoYXBlIjoidHJpIiwiaCI6MzMsImxvY2siOlsiaCJdLCJjYXAiOiJvbiIsIm1vdW50Ijoia2V5aG9sZSIsImtyIjo0NSwiYngiOjU3NiwiYnkiOjU0NywiYnoiOjU3NX0";

/** Every z where the vertical line through (x, y) crosses the mesh, ascending (in, out, in, out, ...). */
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
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    hits.push(l1 * p[a + 2] + l2 * p[b + 2] + l3 * p[c + 2]);
  }
  hits.sort((u, v) => u - v);
  return hits.filter((z, i) => i === 0 || z - hits[i - 1] > 1e-4);
}

/** The flange's material spans (z intervals) on the vertical line through (x, y), below z = 0.5 -- the wall and cable never reach there outside the wall's own footprint. */
function flangeSpans(d: Design, x: number, y: number): Array<[number, number]> {
  const hits = rayHits(d.mesh, x, y).filter((z) => z < 0.5);
  const spans: Array<[number, number]> = [];
  for (let i = 0; i + 1 < hits.length; i += 2) spans.push([hits[i], hits[i + 1]]);
  return spans;
}

/** Points halfway across the flange margin, all the way round. */
function midMarginPoints(d: Design, count = 72) {
  const { outline, margin } = d.flangeSpec;
  return Array.from({ length: count }, (_, i) => pointAt(outline, i / count, margin / 2));
}

function spec(overrides: Partial<CoilSpec>): CoilSpec {
  return { ...parseHash("").spec, ...overrides };
}

const DESIGNS: Array<{ label: string; spec: CoilSpec }> = [
  { label: "repro (tri, keyhole, 2.4 mm)", spec: parseHash(REPRO).spec },
  { label: "round, no mount, 3.8 mm", spec: spec({ coreSize: { locked: true, dimension: "outer", value: 60 } }) },
  { label: "sq, through-hole", spec: spec({ shape: { kind: "sq", cornerRadius: 10 }, coreSize: { locked: true, dimension: "outer", value: 60 }, mount: "through" }) },
  { label: "round, SKADIS plate", spec: spec({ coreSize: { locked: true, dimension: "outer", value: 80 }, mount: "skadis" }) },
  { label: "round, 8 mm cable, keyhole", spec: spec({ wire: { length: 3000, diameter: 8, type: "custom" }, coreSize: { locked: true, dimension: "outer", value: 90 }, height: { locked: true, value: 120 }, mount: "keyhole" }) },
];

describe("thin bottom flange (issue #122)", () => {
  describe.each(DESIGNS)("$label", ({ spec }) => {
    it("is the structural minimum away from the channel and mount, with the wall face flat", async () => {
      const d = await design(spec, "draft");
      const T = d.flangeSpec.thickness;
      const spans = midMarginPoints(d).map((p) => flangeSpans(d, p.x, p.y));
      const thin = spans.filter((s) => s.length === 1 && Math.abs(s[0][1] - s[0][0] - FLANGE_PLATE_THICKNESS) < 1e-3);
      // Most of the flange is the thin plate (on main it was all full thickness).
      expect(thin.length).toBeGreaterThan(spans.length / 2);
      // The thin plate lies on the wall face: z = -thickness, the same plane as every pad.
      for (const s of thin) expect(s[0][0]).toBeCloseTo(-T, 3);
      // Nothing sticks out past either face: the wall face at -thickness, the winding face at 0.
      for (const s of spans) {
        expect(s.length).toBeGreaterThan(0);
        expect(s[0][0]).toBeGreaterThanOrEqual(-T - 1e-3);
        expect(s[s.length - 1][1]).toBeLessThanOrEqual(1e-3);
      }
    });

    it("keeps the channel flush with the face on a full-thickness pad, with its shelf below", async () => {
      const d = await design(spec, "draft");
      const T = d.flangeSpec.thickness;
      const { from, to } = d.innerEndClip;
      const c = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      // Straight down the cable's centre: the bore floor, then the shelf to the wall face.
      const below = flangeSpans(d, c.x, c.y);
      expect(below).toHaveLength(1);
      expect(below[0][0]).toBeCloseTo(-T, 3);
      expect(below[0][1] - below[0][0]).toBeGreaterThanOrEqual(INNER_CHANNEL_MIN_SHELF - d.spec.tolerance / 2 - 1e-3);
      // Beside the bore (in the clip's lips' root): solid up to the face, z = 0 (#43).
      const ax = to.x - from.x;
      const ay = to.y - from.y;
      const l = Math.hypot(ax, ay);
      const side = (d.spec.wire.diameter + d.spec.tolerance) / 2 + 0.8;
      for (const sign of [1, -1]) {
        const s = flangeSpans(d, c.x - (sign * ay * side) / l, c.y + (sign * ax * side) / l);
        expect(s[s.length - 1][1]).toBeCloseTo(0, 3);
        expect(s[0][0]).toBeCloseTo(-T, 3);
      }
    });

    it("stays one connected, valid solid, and the overall height is the built one", async () => {
      const d = await design(spec, "draft");
      const wasm = await Module();
      wasm.setup();
      const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: d.mesh.positions, triVerts: d.mesh.indices }));
      try {
        expect(m.status()).toBe("NoError");
        const pieces = m.decompose();
        expect(pieces.length).toBe(1);
        for (const p of pieces) p.delete();
      } finally {
        m.delete();
      }
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const part of d.parts.filter((p) => p.role !== "mountPlate")) {
        for (let i = 2; i < part.mesh.positions.length; i += 3) {
          minZ = Math.min(minZ, part.mesh.positions[i]);
          maxZ = Math.max(maxZ, part.mesh.positions[i]);
        }
      }
      expect(minZ).toBeCloseTo(-d.flangeSpec.thickness, 3);
      expect(d.solution.overallHeight!).toBeCloseTo(maxZ - minZ, 2);
    });
  });

  it("the repro's flange: 3 mm plate, 5 mm on the pads (was 6.9 mm everywhere)", async () => {
    const d = await design(parseHash(REPRO).spec, "draft");
    expect(d.flangeSpec.plateThickness).toBeCloseTo(FLANGE_PLATE_THICKNESS, 9);
    expect(d.flangeSpec.thickness).toBeCloseTo(SCREW_MOUNT_RECESS_DEPTH + SCREW_MOUNT_MIN_SHELF, 9);
    expect(d.solution.overallHeight!).toBeCloseTo(5 + 33 + 3, 6);
  });

  it("keeps the keyhole's shelf on a pad", async () => {
    const d = await design(parseHash(REPRO).spec, "draft");
    const f = d.flangeSpec;
    const { slots } = layoutKeyholeMount(f.outline, f.boreOutline, f.margin, f.keyholeRotation);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      for (const p of [slot.head, slot.shankEnd]) {
        const s = flangeSpans(d, p.x, p.y);
        expect(s).toHaveLength(1);
        expect(s[0][0]).toBeCloseTo(-f.thickness + SCREW_MOUNT_RECESS_DEPTH, 3);
        expect(s[0][1]).toBeCloseTo(0, 3);
      }
    }
  });

  it("keeps each through-hole's counterbore shelf and each SKADIS pin hole's shelf on a pad", async () => {
    const through = await design(DESIGNS[2].spec, "draft");
    // The counterbore floor + shelf: the flange is its full thickness round every hole.
    expect(through.flangeSpec.thickness).toBeGreaterThanOrEqual(THROUGH_MOUNT_COUNTERBORE_DEPTH + 1);
    const skadis = await design(DESIGNS[3].spec, "draft");
    const f = skadis.flangeSpec;
    expect(skadis.parts.some((p) => p.role === "mountPlate")).toBe(true);
    const d = skadis.spec.wire.diameter;
    const innerEnd = layoutInnerEnd(f.outline, f.margin, d, skadis.spec.tolerance, bendMultiplierOf(skadis.spec.wire) * d, resolveChannelDepth(d, f.thickness));
    const layout = mountPlateLayoutFor("skadis", offsetOutline(f.outline, f.margin), f.boreOutline, innerEnd);
    expect(layout.anchors.length).toBeGreaterThan(0);
    for (const a of layout.anchors) {
      // Just beside the pin hole: solid from the wall face up to the inner face.
      const s = flangeSpans(skadis, a.x + 1.6, a.y);
      expect(s).toHaveLength(1);
      expect(s[0][1] - s[0][0]).toBeGreaterThanOrEqual(MIN_FLANGE_THICKNESS_FOR_PLATE - 1e-3);
      // In it: the pin hole, then at least the anchor shelf above it.
      const inHole = flangeSpans(skadis, a.x, a.y);
      expect(inHole).toHaveLength(1);
      expect(inHole[0][0]).toBeCloseTo(-f.thickness + MOUNT_PLATE_PIN_HOLE_DEPTH, 3);
      expect(inHole[0][1]).toBeCloseTo(0, 3);
    }
  });
});
