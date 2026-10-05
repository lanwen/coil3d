import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, Design, ShapeSpec } from "../src/core";
import { EAR_SEAT_WALL, EDGE_CHAMFER, RIM_SLOT_NECK } from "../src/core/constants";
import { rimSlotSeatOffset, rimSlotWidths } from "../src/core/innerEnd";
import { contourOffsetAt, plateContourOf } from "../src/core/plateContour";
import { outlineOffsetAt } from "../src/core/shapes";

// Issue #248: with two or more layers the rim slot of the plain plate would sit under the outer layers, so the base
// (and the cap, which shares its outline) grows a small local ear that carries the slot, outside the drawn cable.
// Checked through design(): the slot, the ear's shape on the real meshes, and the plate parts being one solid.

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 3000, diameter: 3, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: false },
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "on",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

/** The drawn cable's furthest reach outside the core's outline (its outer surface), the free tails left out: test/plateCoversCable.test.ts's scan. */
function reach(d: Design): number {
  const r = d.spec.wire.diameter / 2;
  const o = d.flangeSpec.outline;
  let best = 0;
  const scan = (points: ArrayLike<number>, keep: (z: number) => boolean = () => true) => {
    for (let i = 0; i < points.length; i += 3) if (keep(points[i + 2])) best = Math.max(best, outlineOffsetAt(o, points[i], points[i + 1]).offset + r);
  };
  for (const w of d.wirePaths) scan(w.points);
  d.layerTransitions.forEach((t) => scan(t));
  if (d.parts.some((p) => p.role === "topCap")) {
    const out = d.outerEndLeadOut;
    const zKey = out[out.length - 1];
    scan(out, (z) => Math.abs(z - zKey) > 1e-4);
  }
  return best;
}

function pieces(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  const n = m.decompose().length;
  m.delete();
  return n;
}

/** The mesh's vertices with z in [lo, hi]. */
function verticesBetween(mesh: { positions: Float32Array }, lo: number, hi: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < mesh.positions.length; i += 3) if (mesh.positions[i + 2] >= lo && mesh.positions[i + 2] <= hi) out.push([mesh.positions[i], mesh.positions[i + 1]]);
  return out;
}

/** How far a facet's chord may stand off the true contour: a 5 degree facet of a 3 mm fillet sags 0.003 mm (a cut can leave a vertex on a chord). */
const SAG = 0.005;

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }];

describe("the base rim slot's ear (issue #248)", () => {
  for (const shape of SHAPES) {
    for (const diameter of [3, 6]) {
      for (let layers = 1; layers <= 3; layers++) {
        for (const topCap of ["on", "off"] as const) {
          it(`shape=${shape.kind} d=${diameter} layers=${layers} cap=${topCap}`, async () => {
            const d = await design(baseSpec({ shape, wire: { length: 1000 * layers * diameter, diameter, type: "usb" }, layers: { locked: true, value: layers }, topCap }), "draft");
            const { outline, margin, thickness } = d.flangeSpec;
            const tol = d.spec.tolerance;
            const R = (diameter + tol) / 2;
            const { neck } = rimSlotWidths(diameter, tol);
            const base = d.rimSlots.base!;
            expect(base).toBeDefined();
            const seat = outlineOffsetAt(outline, base.seat.x, base.seat.y).offset;

            if (layers === 1) {
              // The slot already sits outside the single layer: no ear, the plain plate's slot.
              expect(d.flangeSpec.ears).toEqual([]);
              expect(seat).toBeCloseTo(rimSlotSeatOffset(margin, diameter, tol), 6);
            } else {
              // The seat disc lies outside the drawn cable, with an ear where the plain plate's slot would sit under it.
              expect(seat - R).toBeGreaterThanOrEqual(reach(d) - 1e-4);
              const plainFits = rimSlotSeatOffset(margin, diameter, tol) - R >= reach(d) - 1e-4;
              if (!plainFits) expect(d.flangeSpec.ears).toHaveLength(1);
              if (d.flangeSpec.ears!.length === 0) {
                expect(plainFits).toBe(true);
                expect(seat).toBeCloseTo(rimSlotSeatOffset(margin, diameter, tol), 6);
                for (const part of d.parts) expect(pieces(part.mesh), part.name).toBe(1);
                return;
              }
              // The ear's own chamfer foot is where the neck ends, as on a plain plate.
              const neckEnd = Math.sqrt(R * R - (neck / 2) ** 2) + RIM_SLOT_NECK;
              const end = { x: base.seat.x + base.axis.x * neckEnd, y: base.seat.y + base.axis.y * neckEnd };
              const pc = plateContourOf(d.flangeSpec);
              expect(contourOffsetAt(pc, end.x, end.y)).toBeCloseTo(margin - EDGE_CHAMFER, 6);

              // The core's flange covers the ear, and no more: every vertex at flange height is inside the contour,
              // some are past the plain plate (the ear), and none is in the seat's hole.
              const flange = verticesBetween(d.mesh, -thickness - 1e-3, 1e-3);
              for (const [x, y] of flange) expect(contourOffsetAt(pc, x, y)).toBeLessThanOrEqual(margin + SAG);
              expect(Math.max(...flange.map(([x, y]) => outlineOffsetAt(outline, x, y).offset))).toBeGreaterThan(margin + 0.1);
              for (const [x, y] of flange) expect(Math.hypot(x - base.seat.x, y - base.seat.y)).toBeGreaterThanOrEqual(R * Math.cos(Math.PI / 32) - 0.01);
              // Flat face all round the seat's flanks: the ear's contour, at the chamfer's foot, keeps EAR_SEAT_WALL beyond the hole.
              const flank = { x: base.seat.x - base.axis.y * R, y: base.seat.y + base.axis.x * R };
              expect(-(contourOffsetAt(pc, flank.x, flank.y) - margin)).toBeGreaterThanOrEqual(EDGE_CHAMFER + EAR_SEAT_WALL - 0.05);
            }

            const cap = d.parts.find((p) => p.role === "topCap");
            if (cap) {
              // The cap's slot is on the same ear (the same seat), and its plate follows the same contour.
              expect(d.rimSlots.cap).toBeDefined();
              expect(Math.hypot(d.rimSlots.cap!.seat.x - base.seat.x, d.rimSlots.cap!.seat.y - base.seat.y)).toBeLessThan(1e-6);
              if (layers >= 2) {
                const pc = plateContourOf(d.flangeSpec);
                const top = d.solution.height;
                const plate = verticesBetween(cap.mesh, top, top + 3 + 1e-3);
                for (const [x, y] of plate) expect(contourOffsetAt(pc, x, y)).toBeLessThanOrEqual(margin + SAG);
                expect(Math.max(...plate.map(([x, y]) => outlineOffsetAt(outline, x, y).offset))).toBeGreaterThan(margin + 0.1);
              }
            } else {
              expect(d.rimSlots.cap).toBeUndefined();
            }

            for (const part of d.parts) expect(pieces(part.mesh), part.name).toBe(1);
          });
        }
      }
    }
  }
});
