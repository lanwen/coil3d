import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, JOINT_ENGAGE_DEPTH } from "../src/core";
import type { CoilMesh, CoilSpec, ShapeSpec } from "../src/core";

// Issue #186: the snap clips' shape, measured on design() output in the
// assembly frame (the cap as drawn is the cap seated on the core's rim).
// - Each barb is a diamond point: a 45-degree lead-in toward the finger's
//   tip, a 45-degree back face toward the plate, and no flat face.
// - The step from the core's bore up to the seated cap's hole is 2.2 mm +
//   tolerance (2.8 mm before), and the fingers' tips are bevelled inside.
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

/** The cap's three fingers, between relief slots at 0, 120 and 240 degrees. */
const FINGERS = [60, 180, 300];
/** Ray angles over the fingers, clear of the slots. */
const FINGER_DEGS = FINGERS.flatMap((c) => Array.from({ length: 81 }, (_, i) => c - 40 + i));

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

describe("issue #186: diamond-profile snap barbs", () => {
  it.each(SHAPES.map((shape) => ({ name: shape.kind, spec: spec({ shape }) })))("$name: a 45-degree lead-in and back face, and no flat face on the hook", async (c) => {
    const { h, cap, core, capMesh } = await partsOf(c);
    try {
      // The finger's own outer face, per angle, above the barb and below the root flare.
      const shaftSlice = cap.slice(h - JOINT_ENGAGE_DEPTH + 3).toPolygons() as Slice;
      const shaftAt = (deg: number) => Math.max(...rayCrossings(shaftSlice, deg));
      const p = capMesh.positions;
      const tris = capMesh.indices;
      let leadIn = 0;
      let back = 0;
      const wrong: string[] = [];
      for (let t = 0; t < tris.length; t += 3) {
        const [a, b, q] = [tris[t] * 3, tris[t + 1] * 3, tris[t + 2] * 3];
        const cz = (p[a + 2] + p[b + 2] + p[q + 2]) / 3;
        if (cz < h - JOINT_ENGAGE_DEPTH - 0.01 || cz > h - JOINT_ENGAGE_DEPTH + 3) continue;
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
        if (Math.abs(tilt - 45) > 1.5) wrong.push(`${tilt.toFixed(1)} deg at (${cx.toFixed(1)}, ${cy.toFixed(1)}, ${(cz - h).toFixed(2)})`);
        else if (nz < 0) leadIn += area;
        else back += area;
      }
      expect(wrong.slice(0, 5), `${wrong.length} hook faces not at 45 deg (tilt from vertical)`).toEqual([]);
      expect(leadIn, "lead-in face area, mm^2").toBeGreaterThan(5);
      expect(back, "back face area, mm^2").toBeGreaterThan(5);
    } finally {
      cap.delete();
      core.delete();
    }
  });
});

describe("issue #186: a smaller, bevelled step inside the seated snap cap", () => {
  it.each(CASES)("$name", async (c) => {
    const { h, cap, core } = await partsOf(c);
    try {
      // The bore just under the collar, and the cap's hole above the tip and at the tip.
      const bore = core.slice(h - JOINT_ENGAGE_DEPTH - 1.5).toPolygons() as Slice;
      const hole = cap.slice(h - 3).toPolygons() as Slice;
      const tip = cap.slice(h - JOINT_ENGAGE_DEPTH + 0.05).toPolygons() as Slice;
      // The radial gap is smallest, and equals the offset between the two
      // outlines, where the ray is square to both (everywhere on round, a flat's middle otherwise).
      const step = Math.min(...FINGER_DEGS.map((deg) => rayCrossings(bore, deg)[0] - rayCrossings(hole, deg)[0]));
      const bevel = Math.min(...FINGER_DEGS.map((deg) => rayCrossings(tip, deg)[0] - rayCrossings(hole, deg)[0]));
      expect(step, "seated step from the bore to the cap's hole, mm").toBeGreaterThan(2.4 - 0.05);
      expect(step, "seated step from the bore to the cap's hole, mm").toBeLessThan(2.4 + 0.05);
      // A 45-degree, 0.8 mm bevel, measured 0.05 mm above the tip.
      expect(bevel, "the fingers' inner tip bevel, mm").toBeGreaterThan(0.7);
      expect(bevel, "the fingers' inner tip bevel, mm").toBeLessThan(0.8);
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
      for (let z = h - JOINT_ENGAGE_DEPTH - 1.5; z < h - 0.05; z += 0.1) {
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
