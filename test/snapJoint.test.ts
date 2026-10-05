import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, JOINT_TRANSITION_HEIGHT } from "../src/core";
import type { CoilMesh, CoilSpec, ShapeSpec } from "../src/core";
import { SNAP_FINGER_LENGTH, SNAP_PRELOAD } from "../src/core/constants";
import { inRibNotch } from "./support/ribNotch";

// Issue #168: the snap joint still snaps once its overhangs are chamfered
// for printing. The cap and the core are checked against each other, as
// assembled (both parts' meshes share the assembly frame): the seated cap
// runs into the core only where its barbs bear on the ridge, by the designed
// preload (the snap-joint rework), its fingers clear the core by at least the
// print tolerance, and every finger's barb hooks under the core's ridge.

function spec(shape: ShapeSpec): CoilSpec {
  return {
    wire: { length: 4000, diameter: 3.8, type: "usb" },
    shape,
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 50 },
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "on",
    joint: "snap",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    base: "on",
    mount: "none",
    plateJoint: "glue",
  };
}

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 12 }, { kind: "tri", cornerRadius: 12 }];
/** The cap's fingers, one per side of the outline (four for round and square, three for a triangle), between relief slots at its corners. */
const fingersOf = (shape: ShapeSpec) => (shape.kind === "tri" ? [60, 180, 300] : [45, 135, 225, 315]);
/** The barb's height above the finger tips: its lead-in and back face. */
const BARB_ZONE = 3.6;

type Wasm = Awaited<ReturnType<typeof Module>>;
let wasmPromise: Promise<Wasm> | undefined;
const getWasm = () =>
  (wasmPromise ??= Module().then((w) => {
    w.setup();
    return w;
  }));

async function solids(meshes: CoilMesh[]) {
  const wasm = await getWasm();
  return meshes.map((m) => new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices })));
}

/** Distances along the ray from the axis at `deg`, in the slice at `z`, where it crosses the part's boundary. */
function rayCrossings(slice: Array<Array<[number, number]>>, deg: number): number[] {
  const [ux, uy] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  const hits: number[] = [];
  for (const poly of slice) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      // Solve a + s (b - a) = t u for s in [0, 1), t > 0.
      const [ex, ey] = [bx - ax, by - ay];
      const den = ex * uy - ey * ux;
      if (Math.abs(den) < 1e-12) continue;
      const s = (ay * ux - ax * uy) / den;
      const t = (ax * ey - ay * ex) / -den;
      if (s >= 0 && s < 1 && t > 0) hits.push(t);
    }
  }
  return hits.sort((a, b) => a - b);
}

describe.each(SHAPES)("issue #168: the snap joint still engages, shape=$kind", (shape) => {
  it("the seated cap runs into the core only where the barbs bear on the ridge, by the preload", async () => {
    const d = await design(spec(shape));
    const h = d.solution.height;
    const [core, cap] = await solids(d.parts.map((p) => p.mesh));
    const hit = core.intersect(cap);
    const pieces = hit.decompose().filter((p) => p.volume() > 0.01);
    // The cap's barbs, lowered by `drop`: an undeflected barb would sit SNAP_PRELOAD lower.
    const barbs = cap.trimByPlane([0, 0, -1], -(h - SNAP_FINGER_LENGTH + BARB_ZONE));
    const overlapping = (drop: number) => {
      const lowered = barbs.translate([0, 0, -drop]);
      const m = core.intersect(lowered);
      const v = m.volume();
      for (const x of [lowered, m]) x.delete();
      return v;
    };
    try {
      // The cap rests on the core's rim. Seated, the fingers stay bent by the
      // preload: each barb's back face sits SNAP_PRELOAD (axially) into the
      // ridge's underside, and that is the only overlap.
      expect(pieces.length, "overlapping pieces (one per finger, two for the one the rib's notch splits)").toBeGreaterThanOrEqual(fingersOf(shape).length);
      expect(pieces.length).toBeLessThanOrEqual(fingersOf(shape).length + 1);
      for (const p of pieces) {
        const { min, max } = p.boundingBox();
        expect(min[2], "overlap's bottom, mm above the finger tips").toBeGreaterThan(h - SNAP_FINGER_LENGTH);
        expect(max[2], "overlap's top, mm above the finger tips").toBeLessThan(h - SNAP_FINGER_LENGTH + BARB_ZONE);
      }
      // Lowered by a little less than the preload, the barbs still bear on the
      // ridge; lowered a little more, nothing overlaps (tessellation noise aside).
      expect(overlapping(SNAP_PRELOAD - 0.05), "overlap with the barbs lowered 0.05 mm short of the preload, mm^3").toBeGreaterThan(1);
      expect(overlapping(SNAP_PRELOAD + 0.05), "overlap with the barbs lowered 0.05 mm past the preload, mm^3").toBeLessThan(0.1);
    } finally {
      for (const m of [core, cap, hit, barbs, ...pieces]) m.delete();
    }
  });

  it("the fingers clear the core by at least the print tolerance, all round", async () => {
    const d = await design(spec(shape));
    const [core, cap] = await solids(d.parts.map((p) => p.mesh));
    // The collar below its flared, welded top and above the barbs, which bear
    // on the ridge (the test above): the part that slides past the ridge.
    const h = d.solution.height;
    const trimmed = cap.trimByPlane([0, 0, -1], -(h - JOINT_TRANSITION_HEIGHT));
    const collar = trimmed.trimByPlane([0, 0, 1], h - SNAP_FINGER_LENGTH + BARB_ZONE);
    const overlaps: string[] = [];
    try {
      for (let a = 0; a < 360; a += 15) {
        const step = d.spec.tolerance;
        const moved = collar.translate([step * Math.cos((a * Math.PI) / 180), step * Math.sin((a * Math.PI) / 180), 0]);
        const hit = core.intersect(moved);
        if (hit.volume() > 0.01) overlaps.push(`${a} deg: ${hit.volume().toFixed(3)} mm^3`);
        moved.delete();
        hit.delete();
      }
      expect(overlaps, `the collar moved sideways by ${d.spec.tolerance} mm hits the core`).toEqual([]);
    } finally {
      for (const m of [core, cap, trimmed, collar]) m.delete();
    }
  });

  it("every finger's barb hooks under the core's ridge by about 0.8 mm, and pulling the cap runs it into the ridge", async () => {
    const d = await design(spec(shape));
    const h = d.solution.height;
    const [core, cap] = await solids(d.parts.map((p) => p.mesh));
    try {
      // The barb: the cap's outermost reach over the finger's lowest 3.5 mm
      // (a pointed barb, so its reach changes with height). The ridge: the
      // narrowest point of the core's bore between the finger tips and 6 mm
      // above them (the seat under the tips is lower).
      const fingers = fingersOf(shape);
      const halfWidth = 180 / fingers.length - 3;
      const barbSlices = Array.from({ length: 35 }, (_, i) => cap.slice(h - SNAP_FINGER_LENGTH + 0.05 + 0.1 * i).toPolygons() as Array<Array<[number, number]>>);
      const coreSlices = Array.from({ length: 61 }, (_, i) => core.slice(h - SNAP_FINGER_LENGTH + 0.1 * i).toPolygons() as Array<Array<[number, number]>>);
      const overlapAt = (deg: number) => {
        const reach = Math.max(...barbSlices.map((s) => Math.max(...rayCrossings(s, deg))));
        const ridge = Math.min(...coreSlices.map((s) => rayCrossings(s, deg)[0] ?? Infinity));
        return reach - ridge;
      };
      for (const centre of fingers) {
        // Square to the outline at the finger's middle (a flat's middle on sq/tri): 1.0 mm - tolerance.
        if (!inRibNotch(d, centre)) {
          expect(overlapAt(centre), `finger at ${centre} deg: barb over ridge at its middle, mm`).toBeGreaterThan(0.75);
          expect(overlapAt(centre), `finger at ${centre} deg: barb over ridge at its middle, mm`).toBeLessThan(0.85);
        }
        // And all along the finger, up to the slots at the corners (a ray off square only measures more).
        const along = Array.from({ length: 2 * halfWidth + 1 }, (_, i) => centre - halfWidth + i).filter((deg) => !inRibNotch(d, deg)).map(overlapAt);
        expect(Math.min(...along), `finger at ${centre} deg: least barb over ridge along the finger, mm`).toBeGreaterThan(0.75);
      }

      // Lifted 1 mm, every finger's barb runs into the ridge.
      const lifted = cap.translate([0, 0, 1]);
      const hit = core.intersect(lifted);
      const pieces = hit.decompose();
      try {
        const fingersHit = new Set(
          pieces.map((p) => {
            const { min, max } = p.boundingBox();
            const deg = (Math.atan2((min[1] + max[1]) / 2, (min[0] + max[0]) / 2) * 180) / Math.PI;
            return fingers.find((c) => Math.abs((((deg - c) % 360) + 540) % 360 - 180) < 180 / fingers.length);
          }),
        );
        expect([...fingersHit].sort((a, b) => a! - b!), "fingers whose barb runs into the ridge when the cap is pulled 1 mm").toEqual(fingers);
      } finally {
        for (const m of [lifted, hit, ...pieces]) m.delete();
      }
    } finally {
      for (const m of [core, cap]) m.delete();
    }
  });
});
