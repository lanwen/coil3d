import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilMesh, CoilSpec, Design, Part } from "../src/core";

// Issue #132: the SKÅDIS mount plate's two alignment pegs are real printed
// parts (low-poly chamfered octagonal prisms), in every export, sized to a
// printed clearance fit in round holes. Only the public `design()` /
// `exportDesign()` interface.

function spec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 100 },
    height: { locked: true, value: 60 },
    layers: { locked: true, value: 1 },
    objective: "minVolume",
    topCap: "auto",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "skadis",
    plateJoint: "glue",
    ...overrides,
  };
}

const pegsOf = (d: Design) => d.parts.filter((p) => p.role === "peg");
const partOf = (d: Design, role: Part["role"]) => d.parts.find((p) => p.role === role)!;

function axisOf(mesh: CoilMesh): { x: number; y: number; zMin: number; zMax: number; radius: number } {
  const p = mesh.positions;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]);
    y1 = Math.max(y1, p[i + 1]);
    zMin = Math.min(zMin, p[i + 2]);
    zMax = Math.max(zMax, p[i + 2]);
  }
  const x = (x0 + x1) / 2;
  const y = (y0 + y1) / 2;
  let radius = 0;
  for (let i = 0; i < p.length; i += 3) radius = Math.max(radius, Math.hypot(p[i] - x, p[i + 1] - y));
  return { x, y, zMin, zMax, radius };
}

/** The nearest a hole's side wall comes to the axis at (x, y), between zLo and zHi: every steep triangle there, projected onto the flange plane, is a segment. */
function holeWallDistance(mesh: CoilMesh, x: number, y: number, zLo: number, zHi: number): number {
  const { positions: p, indices } = mesh;
  let best = Infinity;
  for (let t = 0; t < indices.length; t += 3) {
    const v = [indices[t], indices[t + 1], indices[t + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
    if (v.some(([vx, vy, vz]) => Math.hypot(vx - x, vy - y) > 3 || vz < zLo - 1e-6 || vz > zHi + 1e-6)) continue;
    const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
    const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.abs(n[2]) > 0.1 * Math.hypot(n[0], n[1], n[2])) continue;
    for (let k = 0; k < 3; k++) {
      const [ax, ay] = v[k];
      const [bx, by] = v[(k + 1) % 3];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const s = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - (ax + s * dx), y - (ay + s * dy)));
    }
  }
  return best;
}

describe("SKÅDIS alignment pegs (issue #132)", () => {
  it("the SKÅDIS design includes two peg parts, each one connected, low-poly solid", async () => {
    const d = await design(spec());
    expect(d.parts.map((p) => p.name)).toEqual(["core", "mount-plate", "peg-1", "peg-2"]);
    const wasm = await Module();
    wasm.setup();
    for (const peg of pegsOf(d)) {
      const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: peg.mesh.positions, triVerts: peg.mesh.indices }));
      expect(m.status(), peg.name).toBe("NoError");
      const pieces = m.decompose();
      expect(pieces.length, `${peg.name}: connected components`).toBe(1);
      for (const piece of pieces) piece.delete();
      m.delete();
      // 4 octagons plus the two end centres, at most.
      expect(peg.mesh.positions.length / 3).toBeLessThanOrEqual(34);
    }
  });

  it("a design with a top cap and a SKÅDIS plate has 5 parts", async () => {
    const d = await design(spec({ layers: { locked: true, value: 2 }, topCap: "on" }));
    expect(d.parts.map((p) => p.role)).toEqual(["core", "topCap", "mountPlate", "peg", "peg"]);
  });

  const SHAPES: Array<{ label: string; tolerance: number; overrides: Partial<CoilSpec> }> = [
    { label: "round", tolerance: 0.2, overrides: {} },
    { label: "round", tolerance: 0.5, overrides: {} },
    { label: "square", tolerance: 0.2, overrides: { shape: { kind: "sq", cornerRadius: 15 } } },
    // The triangle's holes sit on its up axis, where the flat is much nearer the centre than the opposite corner: both must still land in the plate.
    { label: "triangle", tolerance: 0.2, overrides: { shape: { kind: "tri", cornerRadius: 15 }, coreSize: { locked: true, dimension: "outer", value: 120 } } },
  ];
  for (const { label, tolerance, overrides } of SHAPES) {
    it(`${label}: each peg stands in its two holes with half the ${tolerance} mm tolerance of clearance across its corners`, async () => {
      const d = await design(spec({ tolerance, ...overrides }));
      const t = d.flangeSpec.thickness;
      const pegs = pegsOf(d);
      expect(pegs).toHaveLength(2);
      for (const peg of pegs) {
        const a = axisOf(peg.mesh);
        // Across the seam (z = -t), and shorter than the two 2.4 mm holes together.
        expect((a.zMin + a.zMax) / 2).toBeCloseTo(-t, 6);
        expect(a.zMax - a.zMin).toBeCloseTo(4.5, 6);
        const plateWall = holeWallDistance(partOf(d, "mountPlate").mesh, a.x, a.y, -t - 2.4, -t);
        const flangeWall = holeWallDistance(partOf(d, "core").mesh, a.x, a.y, -t, -t + 2.4);
        for (const wall of [plateWall, flangeWall]) {
          expect(wall - a.radius).toBeCloseTo(tolerance / 2, 3);
        }
      }
      // Wider than the old 1.75 mm filament pin, but still a small peg.
      expect(axisOf(pegs[0].mesh).radius).toBeGreaterThan(1.5);
      expect(axisOf(pegs[0].mesh).radius).toBeLessThan(2.2);
    });
  }

  it("prints lying on a wide flat, with no face steeper than 45 degrees overhanging", async () => {
    const d = await design(spec());
    for (const peg of pegsOf(d)) {
      const { rotateX } = peg.printTransform;
      const c = Math.cos(rotateX);
      const s = Math.sin(rotateX);
      const p = peg.mesh.positions;
      const q = new Float32Array(p.length);
      for (let i = 0; i < p.length; i += 3) {
        q[i] = p[i];
        q[i + 1] = p[i + 1] * c - p[i + 2] * s;
        q[i + 2] = p[i + 1] * s + p[i + 2] * c;
      }
      let zMin = Infinity, zMax = -Infinity;
      for (let i = 2; i < q.length; i += 3) {
        zMin = Math.min(zMin, q[i]);
        zMax = Math.max(zMax, q[i]);
      }
      // Lying down: as tall as the peg is wide (3 mm), not as long (4.5 mm).
      expect(zMax - zMin).toBeCloseTo(3, 4);
      let bedArea = 0;
      const { indices } = peg.mesh;
      for (let t = 0; t < indices.length; t += 3) {
        const v = [indices[t], indices[t + 1], indices[t + 2]].map((i) => [q[i * 3], q[i * 3 + 1], q[i * 3 + 2]]);
        const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
        const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        const onBed = v.every(([, , z]) => Math.abs(z - zMin) < 1e-4);
        if (onBed) {
          expect(n[2] / len).toBeCloseTo(-1, 6);
          bedArea += len / 2;
        } else {
          expect(n[2] / len, "overhang steeper than 45 degrees").toBeGreaterThanOrEqual(-Math.SQRT1_2 - 1e-4);
        }
      }
      // The 2 mm-wide flat along the 3.7 mm straight part.
      expect(bedArea).toBeCloseTo(2 * 3.7, 3);
    }
  });

  it("the STL zip and the 3MF both carry the pegs", async () => {
    const d = await design(spec());
    const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
    const stl = text(await exportDesign(d, "stl"));
    expect(stl).toContain("peg-1.stl");
    expect(stl).toContain("peg-2.stl");
    const threeMf = text(await exportDesign(d, "3mf"));
    expect(threeMf).toContain('name="peg-1"');
    expect(threeMf).toContain('name="peg-2"');
  });

  it("no pegs without a clip mount plate", async () => {
    for (const mount of ["none", "keyhole", "through"] as const) {
      const d = await design(spec({ mount }));
      expect(pegsOf(d)).toHaveLength(0);
    }
  });
});
