import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, JOINT_ENGAGE_DEPTH, JOINT_TRANSITION_HEIGHT } from "../src/core";
import type { CoilMesh, CoilSpec, ShapeSpec } from "../src/core";

// Issue #168: the snap joint still snaps once its overhangs are chamfered
// for printing. The cap and the core are checked against each other, as
// assembled (both parts' meshes share the assembly frame): the seated cap
// doesn't run into the core, its fingers clear the core by at least the
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
    mount: "none",
    plateJoint: "glue",
  };
}

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 12 }, { kind: "tri", cornerRadius: 12 }];
/** The cap's three fingers, between relief slots at 0, 120 and 240 degrees. */
const FINGERS = [60, 180, 300];

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
  it("the seated cap does not run into the core", async () => {
    const d = await design(spec(shape));
    const [core, cap] = await solids(d.parts.map((p) => p.mesh));
    const hit = core.intersect(cap);
    try {
      // The cap rests on the core's rim: faces touch, but nothing overlaps (a little tessellation noise aside).
      expect(hit.volume(), "cap/core overlap, mm^3").toBeLessThan(0.1);
    } finally {
      for (const m of [core, cap, hit]) m.delete();
    }
  });

  it("the fingers clear the core by at least the print tolerance, all round", async () => {
    const d = await design(spec(shape));
    const [core, cap] = await solids(d.parts.map((p) => p.mesh));
    // The collar below its flared, welded top: the part that slides into the core.
    const collar = cap.trimByPlane([0, 0, -1], -(d.solution.height - JOINT_TRANSITION_HEIGHT));
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
      for (const m of [core, cap, collar]) m.delete();
    }
  });

  it("every finger's barb hooks under the core's ridge by about 0.5 mm, and pulling the cap runs it into the ridge", async () => {
    const d = await design(spec(shape));
    const h = d.solution.height;
    const [core, cap] = await solids(d.parts.map((p) => p.mesh));
    try {
      // The barb: the cap's outermost reach over the finger's lowest 2.5 mm
      // (issue #186: a diamond point, so its reach changes with height). The
      // ridge: the narrowest point of the core's bore over the joint's depth.
      const barbSlices = Array.from({ length: 25 }, (_, i) => cap.slice(h - JOINT_ENGAGE_DEPTH + 0.05 + 0.1 * i).toPolygons() as Array<Array<[number, number]>>);
      const coreSlices = Array.from({ length: 61 }, (_, i) => core.slice(h - JOINT_ENGAGE_DEPTH + 0.1 * i).toPolygons() as Array<Array<[number, number]>>);
      for (const centre of FINGERS) {
        let best = -Infinity;
        for (let deg = centre - 55; deg <= centre + 55; deg += 1) {
          const reach = Math.max(...barbSlices.map((s) => Math.max(...rayCrossings(s, deg))));
          const ridge = Math.min(...coreSlices.map((s) => rayCrossings(s, deg)[0] ?? Infinity));
          best = Math.max(best, reach - ridge);
        }
        expect(best, `finger at ${centre} deg: barb over ridge, mm`).toBeGreaterThan(0.4);
        expect(best, `finger at ${centre} deg: barb over ridge, mm`).toBeLessThan(0.6);
      }

      // Seated, the barb sits below the ridge; lifted 1 mm, every finger's barb bears on it.
      const lifted = cap.translate([0, 0, 1]);
      const hit = core.intersect(lifted);
      const pieces = hit.decompose();
      try {
        const fingersHit = new Set(
          pieces.map((p) => {
            const { min, max } = p.boundingBox();
            const deg = (Math.atan2((min[1] + max[1]) / 2, (min[0] + max[0]) / 2) * 180) / Math.PI;
            return FINGERS.find((c) => Math.abs((((deg - c) % 360) + 540) % 360 - 180) < 60);
          }),
        );
        expect([...fingersHit].sort((a, b) => a! - b!), "fingers whose barb runs into the ridge when the cap is pulled 1 mm").toEqual(FINGERS);
      } finally {
        for (const m of [lifted, hit, ...pieces]) m.delete();
      }
    } finally {
      for (const m of [core, cap]) m.delete();
    }
  });
});
