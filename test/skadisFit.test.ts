import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec } from "../src/core";

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
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
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

// Issue #106: does the printed plate really fit a SKÅDIS board? The board
// here is built ONLY from the researched facts (docs/mounts.md, SKÅDIS),
// never from the core's own layout: slots are stadiums on two interleaved
// 40 mm grids offset by (20, 20) mm, in boards 4.0-5.2 mm thick. The clips
// are found by slicing the plate's own mesh, so the check is on the real
// geometry end to end: every clip through a slot, resting on the slot's
// bottom (bearing the weight), the barb behind the board, and nothing
// intersecting the board once seated.
const LATTICE = 20; // mm between neighbouring columns, and their vertical shift
const BOARDS = [
  { label: "tight 4.8 x 14.8 slot, 5.2 mm board", slotWidth: 4.8, slotLength: 14.8, thickness: 5.2 },
  { label: "nominal 5 x 15 slot, 5 mm board", slotWidth: 5, slotLength: 15, thickness: 5 },
  { label: "nominal 5 x 15 slot, thin 4 mm board", slotWidth: 5, slotLength: 15, thickness: 4 },
];

type Wasm = Awaited<ReturnType<typeof Module>>;
type Frame = { up: { x: number; y: number }; side: { x: number; y: number } };

function frameOf(axisDeg: number): Frame {
  const a = (axisDeg * Math.PI) / 180;
  return { up: { x: Math.sin(a), y: Math.cos(a) }, side: { x: Math.cos(a), y: -Math.sin(a) } };
}

/** The clips as the mesh really has them: slice the plate through its legs and pair up the leg cross-sections. */
function clipsFromMesh(plate: InstanceType<Wasm["Manifold"]>, z: number, f: Frame) {
  const legs = plate
    .slice(z)
    .toPolygons()
    .map((poly) => {
      // The centre of the leg's own bounding box in the (up, side) frame (a vertex average would be skewed by extra vertices).
      const ups = poly.map((p) => p[0] * f.up.x + p[1] * f.up.y);
      const sides = poly.map((p) => p[0] * f.side.x + p[1] * f.side.y);
      const u = (Math.max(...ups) + Math.min(...ups)) / 2;
      const s = (Math.max(...sides) + Math.min(...sides)) / 2;
      return { cx: u * f.up.x + s * f.side.x, cy: u * f.up.y + s * f.side.y, poly };
    });
  const clips: Array<{ up: number; side: number; halfWidth: number; height: number }> = [];
  const used = new Set<number>();
  for (let i = 0; i < legs.length; i++) {
    if (used.has(i)) continue;
    const j = legs.findIndex((l, k) => k !== i && !used.has(k) && Math.hypot(l.cx - legs[i].cx, l.cy - legs[i].cy) < 5);
    expect(j, "every clip leg has a mirrored partner").toBeGreaterThanOrEqual(0);
    used.add(i);
    used.add(j);
    const x = (legs[i].cx + legs[j].cx) / 2;
    const y = (legs[i].cy + legs[j].cy) / 2;
    const pts = [...legs[i].poly, ...legs[j].poly];
    const sides = pts.map((p) => (p[0] - x) * f.side.x + (p[1] - y) * f.side.y);
    const ups = pts.map((p) => (p[0] - x) * f.up.x + (p[1] - y) * f.up.y);
    clips.push({
      up: x * f.up.x + y * f.up.y,
      side: x * f.side.x + y * f.side.y,
      halfWidth: Math.max(...sides.map(Math.abs)),
      height: Math.max(...ups) - Math.min(...ups),
    });
  }
  return clips;
}

/** A board section: a slab `thickness` thick behind z=frontZ, with a stadium slot at every lattice point near the plate, seated around `clips[0]`. */
function buildBoard(wasm: Wasm, f: Frame, frontZ: number, anchor: { up: number; side: number }, seatDrop: number, board: (typeof BOARDS)[number], radius: number) {
  const { CrossSection, Manifold } = wasm;
  const r = board.slotWidth / 2;
  const straight = board.slotLength - board.slotWidth;
  const size = 2 * radius + 60;
  const slab = Manifold.cube([size, size, board.thickness], true).translate([0, 0, frontZ - board.thickness / 2]);
  const holes: InstanceType<Wasm["Manifold"]>[] = [];
  const slot = CrossSection.hull([CrossSection.circle(r, 256).translate([0, straight / 2]), CrossSection.circle(r, 256).translate([0, -straight / 2])]);
  const cutter = slot.extrude(board.thickness + 2).translate([0, 0, frontZ - board.thickness - 1]);
  const n = Math.ceil(radius / LATTICE) + 3;
  const angle = (Math.atan2(f.up.x, f.up.y) * 180) / Math.PI; // rotates local +Y (the slot's own axis) onto `up`
  for (let a = -n; a <= n; a++) {
    for (let b = -n; b <= n; b++) {
      if (Math.abs(a + b) % 2 !== 0) continue;
      const side = anchor.side + a * LATTICE;
      const up = anchor.up + seatDrop + b * LATTICE;
      if (Math.hypot(side, up) > radius + 30) continue;
      const x = up * f.up.x + side * f.side.x;
      const y = up * f.up.y + side * f.side.y;
      holes.push(cutter.rotate([0, 0, -angle]).translate([x, y, 0]));
    }
  }
  return slab.subtract(Manifold.union(holes));
}

describe("the SKÅDIS clip really fits a SKÅDIS board (issue #106)", () => {
  it.each([
    { label: "round 100", overrides: {} },
    { label: "square 100", overrides: { shape: { kind: "sq", cornerRadius: 15 } as const } },
    { label: "triangle 120", overrides: { shape: { kind: "tri", cornerRadius: 15 } as const, coreSize: { locked: true, dimension: "outer", value: 120 } as const } },
    { label: "round 200 (several columns and rows)", overrides: { coreSize: { locked: true, dimension: "outer", value: 200 } as const } },
  ])("$label: clips on the board's lattice, seated without touching it, weight on the slot bottoms, barbs behind the board", async ({ overrides }) => {
    const d = await design(baseSpec({ mount: "skadis", ...overrides }));
    const part = d.parts.find((p) => p.role === "mountPlate")!;
    const wasm = await Module();
    wasm.setup();
    const plate = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: part.mesh.positions, triVerts: part.mesh.indices }));
    const f = frameOf(d.mountAxisDeg!);
    const backZ = -d.flangeSpec.thickness - 3; // the plate's back face (3 mm panel on the flange's outer face)
    const clips = clipsFromMesh(plate, backZ - 3, f);
    expect(clips.length).toBeGreaterThanOrEqual(2);

    // Every clip-to-clip vector is a lattice vector: (20a, 20b) with a + b even.
    for (const c of clips) {
      const a = (c.side - clips[0].side) / LATTICE;
      const b = (c.up - clips[0].up) / LATTICE;
      expect(Math.abs(a - Math.round(a)), "side offset on the 20 mm lattice").toBeLessThan(1e-3);
      expect(Math.abs(b - Math.round(b)), "up offset on the 20 mm lattice").toBeLessThan(1e-3);
      expect(Math.abs(Math.round(a) + Math.round(b)) % 2, "same one of the two interleaved grids").toBe(0);
    }

    // `design().pegboard` (the slot grid the viewer and guide draw) has a nominal 5 x 15 slot right where each clip seats.
    const w0 = clips[0].halfWidth;
    const nominalDrop = 15 / 2 - (2.5 - Math.sqrt(2.5 * 2.5 - w0 * w0)) - clips[0].height / 2;
    expect(d.pegboard).toBeDefined();
    for (const c of clips) {
      const x = (c.up + nominalDrop) * f.up.x + c.side * f.side.x;
      const y = (c.up + nominalDrop) * f.up.y + c.side * f.side.y;
      expect(d.pegboard!.slots.some((s) => Math.hypot(s.x - x, s.y - y) < 1e-3), "a drawn slot around every clip").toBe(true);
    }

    const radius = Math.max(...clips.map((c) => Math.hypot(c.up, c.side))) + 20;
    const shift = (dUp: number, dSide: number, dz: number) =>
      plate.translate([dUp * f.up.x + dSide * f.side.x, dUp * f.up.y + dSide * f.side.y, dz]);
    const overlap = (m: InstanceType<Wasm["Manifold"]>, board: InstanceType<Wasm["Manifold"]>) => {
      const i = m.intersect(board);
      const v = i.volume();
      i.delete();
      return v;
    };

    for (const spec of BOARDS) {
      // Seated: each leg's outer bottom corner rests on the slot's rounded bottom end.
      const r = spec.slotWidth / 2;
      const w = clips[0].halfWidth;
      expect(w, `${spec.label}: legs narrower than the slot`).toBeLessThan(r);
      // (0.01 mm above exact contact, so faceted-arc rounding never reads as an overlap.)
      const seatDrop = spec.slotLength / 2 - (r - Math.sqrt(r * r - w * w)) - clips[0].height / 2 - 0.01;
      const board = buildBoard(wasm, f, backZ, clips[0], seatDrop, spec, radius);

      expect(overlap(plate, board), `${spec.label}: seated plate intersects the board`).toBeLessThan(1e-3);
      // Nudged 0.2 mm further down, the clips dig into the slot bottoms: the weight bears on them.
      expect(overlap(shift(-0.2, 0, 0), board), `${spec.label}: clips don't rest on the slot bottoms`).toBeGreaterThan(1e-3);
      // Lifted off the slot bottoms, the legs clear the slot sides by at least 0.1 mm either way (no binding).
      expect(overlap(shift(0.4, 0.1, 0), board), `${spec.label}: legs bind sideways`).toBeLessThan(1e-3);
      expect(overlap(shift(0.4, -0.1, 0), board), `${spec.label}: legs bind sideways`).toBeLessThan(1e-3);
      // Pulled away from the board (toward the room, +z), the barbs catch its back face within 0.7 mm of play past
      // the thickest board: the plate can't just fall off.
      const play = 5.2 - spec.thickness + 0.7;
      expect(overlap(shift(0, 0, play), board), `${spec.label}: barbs don't hook behind the board`).toBeGreaterThan(1e-3);
      board.delete();
    }
    plate.delete();
  }, 60_000);

  it("the barb is wider than the slot but can flex through it: legs 1.6 mm apart, barb 0.5 mm per side past a 4.8 mm slot", async () => {
    const d = await design(baseSpec({ mount: "skadis" }));
    const part = d.parts.find((p) => p.role === "mountPlate")!;
    const wasm = await Module();
    wasm.setup();
    const plate = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: part.mesh.positions, triVerts: part.mesh.indices }));
    const f = frameOf(d.mountAxisDeg!);
    const backZ = -d.flangeSpec.thickness - 3;
    const barb = clipsFromMesh(plate, backZ - 6.6, f)[0]; // through the barbs
    const leg = clipsFromMesh(plate, backZ - 3, f)[0];
    const perSide = barb.halfWidth - 4.8 / 2;
    expect(perSide).toBeGreaterThan(0.3);
    // Each leg must flex inward by `perSide` to pass; the gap between the legs allows up to half of it each.
    const legThickness = 1.4;
    const gapHalf = leg.halfWidth - legThickness;
    expect(perSide).toBeLessThan(gapHalf);
    plate.delete();
  });

  it("prints without supports: in its print pose, no downward face except the bed face and the peg holes' small bridged roofs", async () => {
    const d = await design(baseSpec({ mount: "skadis" }));
    const part = d.parts.find((p) => p.role === "mountPlate")!;
    expect(part.printTransform.rotateX).toBeCloseTo(Math.PI, 9);
    const { positions, indices } = part.mesh;
    // rotateX(pi): (x, y, z) -> (x, -y, -z)
    const pt = (i: number) => [positions[3 * i], -positions[3 * i + 1], -positions[3 * i + 2]];
    let minZ = Infinity;
    for (let i = 0; i < positions.length / 3; i++) minZ = Math.min(minZ, pt(i)[2]);
    const bad: string[] = [];
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [pt(indices[t]), pt(indices[t + 1]), pt(indices[t + 2])];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len < 1e-9) continue;
      const nz = n[2] / len;
      if (nz > -0.72) continue; // up to ~46 degrees from vertical is fine
      const zs = [a[2], b[2], c[2]];
      if (Math.max(...zs) < minZ + 1e-3) continue; // on the bed
      const span = Math.max(Math.max(a[0], b[0], c[0]) - Math.min(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]) - Math.min(a[1], b[1], c[1]));
      if (nz < -0.999 && span <= 4) continue; // a peg hole's roof (issue #132): a flat bridge under 4 mm
      bad.push(`nz=${nz.toFixed(3)} at z=${Math.min(...zs).toFixed(2)}`);
    }
    expect(bad, "overhanging faces that would need supports").toEqual([]);
  });
});

