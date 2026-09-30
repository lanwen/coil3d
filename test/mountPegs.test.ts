import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, exportDesign } from "../src/core";
import type { CoilMesh, CoilSpec, Design, Part } from "../src/core";

// Issue #132: the SKÅDIS mount plate's two alignment pegs are real printed
// parts (low-poly chamfered octagonal prisms), in every export, sized to a
// printed clearance fit in holes. Issue #143: the holes match the peg's own
// octagonal profile (not a circumscribing circle any more), grown by half
// the print tolerance on every flat side. Only the public `design()` /
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

/**
 * Every distinct (x, y) among `mesh`'s own vertices within `radius` mm of
 * (cx, cy) and z in [zLo, zHi], deduplicated to a small epsilon (issue #143:
 * the octagonal hole/peg cross-section is extruded straight -- no rounding,
 * no extra subdivision -- so its vertices sit ONLY at its own 8 corners; this
 * recovers that polygon's actual corner set straight from the built mesh,
 * not from re-deriving the module's own math).
 */
function nearbyXY(mesh: CoilMesh, cx: number, cy: number, zLo: number, zHi: number, radius = 3): Array<{ x: number; y: number }> {
  const { positions: p } = mesh;
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    if (Math.hypot(x - cx, y - cy) > radius || z < zLo - 1e-6 || z > zHi + 1e-6) continue;
    if (!out.some((q) => Math.hypot(q.x - x, q.y - y) < 1e-3)) out.push({ x, y });
  }
  return out;
}

/**
 * The 8 corners of the peg's own straight, unchamfered mid-section: every
 * distinct vertex over the peg's whole span, kept to just the ones at the
 * single largest radius from (cx, cy) -- `pegSweep`'s two chamfered end
 * rings shrink uniformly (both the flats and the 45 degree cuts), so they're
 * always strictly closer in than the nominal cross-section shared by its two
 * middle rings.
 */
function pegCorners(peg: CoilMesh, cx: number, cy: number, zLo: number, zHi: number): Array<{ x: number; y: number }> {
  const pts = nearbyXY(peg, cx, cy, zLo, zHi);
  const dist = (q: { x: number; y: number }) => Math.hypot(q.x - cx, q.y - cy);
  const maxR = Math.max(...pts.map(dist));
  return pts.filter((q) => dist(q) > maxR - 1e-3);
}

/**
 * The hole's own 8 corners, all at ONE shared radius from (cx, cy) (a
 * straight, untapered prism, unlike the peg): every distinct nearby vertex,
 * grouped by its (rounded) radius, keeping only the largest group. Issue
 * #143's own round-flange fixture puts the flange's relief-slab boundary
 * (flangePads.ts's pad around the hole) a stray vertex or two away from the
 * hole at a DIFFERENT radius -- this rejects those without assuming an exact
 * search radius.
 */
function holeCorners(mesh: CoilMesh, cx: number, cy: number, zLo: number, zHi: number): Array<{ x: number; y: number }> {
  const pts = nearbyXY(mesh, cx, cy, zLo, zHi);
  const dist = (q: { x: number; y: number }) => Math.hypot(q.x - cx, q.y - cy);
  const groups = new Map<string, Array<{ x: number; y: number }>>();
  for (const p of pts) {
    const key = dist(p).toFixed(2);
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  let best: Array<{ x: number; y: number }> = [];
  for (const g of groups.values()) if (g.length > best.length) best = g;
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
    it(`${label}: each hole is the peg's own octagon, grown by half the ${tolerance} mm tolerance on every flat side (issue #143)`, async () => {
      const d = await design(spec({ tolerance, ...overrides }));
      const t = d.flangeSpec.thickness;
      const pegs = pegsOf(d);
      expect(pegs).toHaveLength(2);
      for (const peg of pegs) {
        const a = axisOf(peg.mesh);
        // Across the seam (z = -t), and shorter than the two 2.4 mm holes together.
        expect((a.zMin + a.zMax) / 2).toBeCloseTo(-t, 6);
        expect(a.zMax - a.zMin).toBeCloseTo(4.5, 6);

        const pegPts = pegCorners(peg.mesh, a.x, a.y, a.zMin, a.zMax);
        expect(pegPts).toHaveLength(8);

        for (const [holeMesh, zLo, zHi] of [
          [partOf(d, "mountPlate").mesh, -t - 2.4, -t],
          [partOf(d, "core").mesh, -t, -t + 2.4],
        ] as const) {
          const holePts = holeCorners(holeMesh, a.x, a.y, zLo, zHi);
          // The hole's cross-section is the peg's own profile, not a
          // circumscribing circle (a round hole would show many more than 8
          // distinct rim/floor vertices here).
          expect(holePts).toHaveLength(8);

          // Clearance is measured PER SIDE (the support distance along each
          // flat's and each 45 degree cut's own outward normal -- the 8
          // directions a regular octagon's faces point in), not corner to
          // corner: a true polygon offset grows every edge by the tolerance
          // itself along its own normal, but a mitred corner vertex moves out
          // by MORE than that (the corner is where two grown edges meet).
          for (let i = 0; i < 8; i++) {
            const dir = { x: Math.cos((i * Math.PI) / 4), y: Math.sin((i * Math.PI) / 4) };
            const support = (pts: Array<{ x: number; y: number }>) =>
              Math.max(...pts.map((p) => (p.x - a.x) * dir.x + (p.y - a.y) * dir.y));
            // The peg fits in the hole without intersecting it: the hole's
            // own face sits strictly farther out than the peg's matching
            // face along every one of the octagon's 8 face normals, by
            // exactly half the tolerance.
            expect(support(holePts) - support(pegPts)).toBeCloseTo(tolerance / 2, 3);
          }
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
