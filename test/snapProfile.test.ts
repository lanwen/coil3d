import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilMesh, CoilSpec, ShapeSpec } from "../src/core";
import { SNAP_FINGER_LENGTH, SNAP_SEAT_GAP } from "../src/core/constants";

// Issue #186 and the snap-joint rework: the snap clips' shape, measured on
// design() output in the assembly frame (the cap as drawn is the cap seated
// on the core's rim).
// - Each barb is a point: a 30-degree lead-in toward the finger's tip, a
//   45-degree back face toward the plate, and no flat face. It runs the whole
//   width of every finger, corners included, on every shape.
// - Under the finger tips the core's bore narrows to the seated cap's hole,
//   so there is no step from the bore up into the cap (2.4 mm before).
// - Nothing is cut into the core's wall for the joint: the wall behind it
//   keeps at least 1.2 mm next to the cable groove.

function spec(overrides: Partial<CoilSpec>): CoilSpec {
  return {
    wire: { length: 4000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
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
    ...overrides,
  };
}

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 12 }, { kind: "tri", cornerRadius: 12 }];
// The three cable sizes printability.test.ts uses.
const SIZES: Array<{ label: string; overrides: Partial<CoilSpec> }> = [
  { label: "40 mm, 2.5 mm cable", overrides: { coreSize: { locked: true, dimension: "outer", value: 40 }, height: { locked: true, value: 40 }, wire: { length: 3000, diameter: 2.5, type: "usb" } } },
  { label: "60 mm, 3.8 mm cable", overrides: {} },
  { label: "90 mm, 5 mm cable", overrides: { coreSize: { locked: true, dimension: "outer", value: 90 }, height: { locked: true, value: 60 }, wire: { length: 5000, diameter: 5, type: "usb" } } },
];
const CASES = SHAPES.flatMap((shape) => SIZES.map((size) => ({ name: `${shape.kind}, ${size.label}`, spec: spec({ shape, ...size.overrides }) })));

/** Ray angles over the fingers (one per side, four for round and square, three for a triangle), clear of the slots at the corners. */
function fingerDegs(shape: ShapeSpec): number[] {
  const n = shape.kind === "tri" ? 3 : 4;
  const half = 180 / n - 4;
  return Array.from({ length: n }, (_, f) => (360 * f) / n + 180 / n).flatMap((c) => Array.from({ length: 2 * half + 1 }, (_, i) => c - half + i));
}
const TIP = -SNAP_FINGER_LENGTH;

type Wasm = Awaited<ReturnType<typeof Module>>;
let wasmPromise: Promise<Wasm> | undefined;
const getWasm = () =>
  (wasmPromise ??= Module().then((w) => {
    w.setup();
    return w;
  }));

async function solid(mesh: CoilMesh) {
  const wasm = await getWasm();
  return new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
}

type Slice = Array<Array<[number, number]>>;

/** Distances along the ray from the axis at `deg` where it crosses the slice's boundary, nearest first. */
function rayCrossings(slice: Slice, deg: number): number[] {
  const [ux, uy] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  const hits: number[] = [];
  for (const poly of slice) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
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

async function partsOf(c: { spec: CoilSpec }) {
  const d = await design(c.spec);
  const core = await solid(d.parts.find((p) => p.role === "core")!.mesh);
  const capMesh = d.parts.find((p) => p.role === "topCap")!.mesh;
  const cap = await solid(capMesh);
  return { d, h: d.solution.height, core, cap, capMesh };
}

describe("snap barbs: a 30-degree lead-in, a 45-degree back face, along the whole finger", () => {
  it.each(SHAPES.map((shape) => ({ name: shape.kind, shape, spec: spec({ shape }) })))("$name: no other face on the hook, and the barb all along every finger", async (c) => {
    const { h, cap, core, capMesh } = await partsOf(c);
    try {
      // The finger's own outer face, per angle, above the barb and below the root flare.
      const shaftSlice = cap.slice(h + TIP + 5).toPolygons() as Slice;
      const shaftAt = (deg: number) => Math.max(...rayCrossings(shaftSlice, deg));
      const p = capMesh.positions;
      const tris = capMesh.indices;
      let leadIn = 0;
      let back = 0;
      const wrong: string[] = [];
      for (let t = 0; t < tris.length; t += 3) {
        const [a, b, q] = [tris[t] * 3, tris[t + 1] * 3, tris[t + 2] * 3];
        const cz = (p[a + 2] + p[b + 2] + p[q + 2]) / 3;
        if (cz < h + TIP - 0.01 || cz > h + TIP + 4) continue;
        const [cx, cy] = [(p[a] + p[b] + p[q]) / 3, (p[a + 1] + p[b + 1] + p[q + 1]) / 3];
        const deg = (Math.atan2(cy, cx) * 180) / Math.PI;
        // The hook: what stands out past the finger.
        if (Math.hypot(cx, cy) < shaftAt(deg) + 0.05) continue;
        const [ux, uy, uz] = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
        const [vx, vy, vz] = [p[q] - p[a], p[q + 1] - p[a + 1], p[q + 2] - p[a + 2]];
        const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        const len = Math.hypot(nx, ny, nz);
        if (len < 2e-4) continue; // a boolean sliver
        const area = len / 2;
        const tilt = (Math.asin(Math.min(1, Math.abs(nz) / len)) * 180) / Math.PI; // 0 = vertical face, 90 = flat
        if (tilt < 1) continue; // the relief slots' side walls
        // The lead-in faces down and leans 30 degrees from the axis; the back face faces up at 45.
        if (Math.abs(tilt - (nz < 0 ? 30 : 45)) > 1.5) wrong.push(`${nz < 0 ? "lead-in" : "back face"} at ${tilt.toFixed(1)} deg, (${cx.toFixed(1)}, ${cy.toFixed(1)}, ${(cz - h).toFixed(2)})`);
        else if (nz < 0) leadIn += area;
        else back += area;
      }
      expect(wrong.slice(0, 5), `${wrong.length} hook faces at the wrong angle (tilt from vertical)`).toEqual([]);
      expect(leadIn, "lead-in face area, mm^2").toBeGreaterThan(50);
      expect(back, "back face area, mm^2").toBeGreaterThan(50);
      // The barb's point stands SNAP_BARB (1.1 mm) out from the finger at every angle over the fingers.
      const pointSlice = cap.slice(h + TIP + (1.3 / Math.tan(Math.PI / 6))).toPolygons() as Slice;
      const reach = fingerDegs(c.shape).map((deg) => Math.max(...rayCrossings(pointSlice, deg)) - shaftAt(deg));
      expect(Math.min(...reach), "the barb's least reach past the finger, mm").toBeGreaterThan(0.9);
    } finally {
      cap.delete();
      core.delete();
    }
  });
});

describe("snap joint: no step from the core's bore up into the seated cap's hole", () => {
  it.each(CASES)("$name", async (c) => {
    const { h, cap, core } = await partsOf(c);
    try {
      // The seat's top edge under the finger tips, the plain bore under the seat, and the cap's hole, above the tips and at them.
      const seat = core.slice(h + TIP - SNAP_SEAT_GAP - 0.02).toPolygons() as Slice;
      const bore = core.slice(h + TIP - 8).toPolygons() as Slice;
      const hole = cap.slice(h - 3).toPolygons() as Slice;
      const tip = cap.slice(h + TIP + 0.05).toPolygons() as Slice;
      // The radial gap is smallest, and equals the offset between the two
      // outlines, where the ray is square to both (everywhere on round, a flat's middle otherwise).
      const degs = fingerDegs(c.spec.shape);
      const gap = (a: Slice, b: Slice) => Math.min(...degs.map((deg) => rayCrossings(a, deg)[0] - rayCrossings(b, deg)[0]));
      // Within the two outlines' faceting.
      expect(Math.abs(gap(seat, hole)), "seated step from the seat to the cap's hole, mm").toBeLessThan(0.1);
      // Under the seat, the bore is back to its full size (the wall's 3 mm), 2.6 mm out from the hole at the default tolerance.
      expect(gap(bore, hole), "the bore under the seat, out from the cap's hole, mm").toBeGreaterThan(2.6 - 0.05);
      // The hole runs straight down to the tips: no bevel, which would only leave a groove at the seat.
      expect(Math.abs(gap(tip, hole)), "the hole at the finger tips, out from the hole above, mm").toBeLessThan(0.05);
    } finally {
      cap.delete();
      core.delete();
    }
  });
});

describe("issue #186: the snap joint cuts nothing into the core's wall", () => {
  it.each(CASES)("$name: at least 1.2 mm of wall behind the joint", async (c) => {
    const { h, cap, core } = await partsOf(c);
    try {
      let thinnest = { mm: Infinity, at: "" };
      for (let z = h + TIP - 8; z < h - 0.05; z += 0.1) {
        const slice = core.slice(z).toPolygons() as Slice;
        for (let deg = 0; deg < 360; deg += 2) {
          const hits = rayCrossings(slice, deg);
          // Solid between each pair of crossings.
          let wall = 0;
          for (let i = 0; i + 1 < hits.length; i += 2) wall += hits[i + 1] - hits[i];
          if (wall < thinnest.mm) thinnest = { mm: wall, at: `${deg} deg, ${(z - h).toFixed(1)} mm under the rim` };
        }
      }
      expect(thinnest.mm, `thinnest core wall in the joint's height, at ${thinnest.at}`).toBeGreaterThanOrEqual(1.2);
    } finally {
      cap.delete();
      core.delete();
    }
  });
});

describe("issue #186: a core too small for the snap clips", () => {
  it("gets the press-fit collar, and says so", async () => {
    const d = await design(
      spec({ coreSize: { locked: true, dimension: "outer", value: 10 }, height: { locked: true, value: 20 }, wire: { length: 500, diameter: 1.2, type: "usb" } }),
    );
    expect(d.warnings).toContain("This core is too small for the snap clips, so the top cap uses a press-fit collar.");
  });
});
