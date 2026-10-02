import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilMesh, CoilSpec, Design, Part } from "../src/core";

// Issue #207: do the printed rim clips really hang on a SKÅDIS board and hold
// the coil? The board here is built ONLY from the researched facts
// (docs/mounts.md, SKÅDIS), never from the core's own layout: stadium slots
// on two interleaved 40 mm grids offset by (20, 20) mm, their edges rounded
// over by 1 mm on both faces, in boards 4.0-5.2 mm thick. The clips are found
// by slicing their own meshes, so the check is on the real geometry end to
// end. Only the public `design()` interface.

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 85 },
    height: { locked: false },
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

const LATTICE = 20; // mm between neighbouring columns, and their vertical shift
const FILLET = 1; // mm, the slot edges' round-over on both faces
const BOARDS = [
  { label: "tight 4.8 x 14.8 slot, 5.2 mm board", slotWidth: 4.8, slotLength: 14.8, thickness: 5.2 },
  { label: "nominal 5 x 15 slot, 5 mm board", slotWidth: 5, slotLength: 15, thickness: 5 },
  { label: "nominal 5 x 15 slot, thin 4 mm board", slotWidth: 5, slotLength: 15, thickness: 4 },
];

type Wasm = Awaited<ReturnType<typeof Module>>;
type M = InstanceType<Wasm["Manifold"]>;
type Frame = { up: { x: number; y: number }; side: { x: number; y: number } };

let wasmPromise: Promise<Wasm> | undefined;
function getWasm(): Promise<Wasm> {
  wasmPromise ??= Module().then((w) => {
    w.setup();
    return w;
  });
  return wasmPromise;
}

function frameOf(axisDeg: number): Frame {
  const a = (axisDeg * Math.PI) / 180;
  return { up: { x: Math.sin(a), y: Math.cos(a) }, side: { x: Math.cos(a), y: -Math.sin(a) } };
}

const manifoldOf = (wasm: Wasm, mesh: CoilMesh): M => new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
const clipsOf = (d: Design) => d.parts.filter((p) => p.role === "mountClip");

/** A clip's stem, as its mesh has it: the cross-section through the board (behind the latch tooth), in the (up, side) frame. */
function stemOf(clip: M, z: number, f: Frame) {
  const pts = clip.slice(z).toPolygons().flat();
  const ups = pts.map((p) => p[0] * f.up.x + p[1] * f.up.y);
  const sides = pts.map((p) => p[0] * f.side.x + p[1] * f.side.y);
  return { bottom: Math.min(...ups), top: Math.max(...ups), side: (Math.max(...sides) + Math.min(...sides)) / 2, halfWidth: (Math.max(...sides) - Math.min(...sides)) / 2 };
}

/** Where a stem with this half width rests, below its slot's centre: its lower corners on the slot's rounded end. */
const seatOf = (slotWidth: number, slotLength: number, w: number) => slotLength / 2 - (slotWidth / 2 - Math.sqrt((slotWidth / 2) ** 2 - w * w));

/**
 * A board section: a slab behind z = frontZ with a stadium slot at every
 * lattice point near the coil, around slot centre `origin`, each slot's edges
 * rounded over by FILLET on both faces (modelled as a 45 degree chamfer that
 * cuts at least as much as the round-over would: a conservative stand-in).
 */
function buildBoard(wasm: Wasm, f: Frame, frontZ: number, origin: { up: number; side: number }, board: (typeof BOARDS)[number], radius: number): M {
  const { CrossSection, Manifold } = wasm;
  const slab = Manifold.cube([2 * radius + 80, 2 * radius + 80, board.thickness], true).translate([0, 0, frontZ - board.thickness / 2]);
  const stadium = (grow: number) => {
    const r = board.slotWidth / 2 + grow;
    const straight = board.slotLength - board.slotWidth;
    return CrossSection.hull([CrossSection.circle(r, 128).translate([0, straight / 2]), CrossSection.circle(r, 128).translate([0, -straight / 2])]);
  };
  const through = stadium(0).extrude(board.thickness + 2).translate([0, 0, frontZ - board.thickness - 1]);
  // A chamfer at each face: FILLET wide at the face, nothing at FILLET deep.
  const front = Manifold.hull([stadium(FILLET).extrude(0.01).translate([0, 0, frontZ]), stadium(0).extrude(0.01).translate([0, 0, frontZ - FILLET])]);
  const back = Manifold.hull([stadium(FILLET).extrude(0.01).translate([0, 0, frontZ - board.thickness - 0.01]), stadium(0).extrude(0.01).translate([0, 0, frontZ - board.thickness + FILLET])]);
  const cutter = Manifold.union([through, front, back]);
  const n = Math.ceil(radius / LATTICE) + 3;
  const angle = (Math.atan2(f.up.x, f.up.y) * 180) / Math.PI;
  const holes: M[] = [];
  for (let a = -n; a <= n; a++) {
    for (let b = -n; b <= n; b++) {
      if (Math.abs(a + b) % 2 !== 0) continue;
      const s = origin.side + a * LATTICE;
      const u = origin.up + b * LATTICE;
      if (Math.hypot(s, u) > radius + 30) continue;
      holes.push(cutter.rotate([0, 0, -angle]).translate([u * f.up.x + s * f.side.x, u * f.up.y + s * f.side.y, 0]));
    }
  }
  return slab.subtract(Manifold.union(holes));
}

const overlap = (a: M, b: M) => {
  const i = a.intersect(b);
  const v = i.volume();
  i.delete();
  return v;
};
const shifted = (m: M, f: Frame, dUp: number, dSide: number, dz: number) => m.translate([dUp * f.up.x + dSide * f.side.x, dUp * f.up.y + dSide * f.side.y, dz]);

const CASES: Array<{ label: string; overrides: Partial<CoilSpec>; clips: number }> = [
  { label: "round 60", overrides: { coreSize: { locked: true, dimension: "outer", value: 60 } }, clips: 3 },
  { label: "round 85", overrides: {}, clips: 3 },
  { label: "round 120", overrides: { coreSize: { locked: true, dimension: "outer", value: 120 } }, clips: 3 },
  { label: "square 85", overrides: { shape: { kind: "sq", cornerRadius: 10 } }, clips: 3 },
  { label: "triangle 85", overrides: { shape: { kind: "tri", cornerRadius: 10 } }, clips: 3 },
  { label: "round 85, 10 m of 8 mm cable (heavy: two top clips)", overrides: { wire: { length: 10000, diameter: 8, type: "flex" }, layers: { locked: true, value: 4 } }, clips: 4 },
];

describe("the SKÅDIS rim clips hang on a real SKÅDIS board (issue #207)", () => {
  it.each(CASES)("$label: clips on the lattice, seated clear of the board, weight on the slot bottoms, tongues behind the board, latch against lifting", async ({ overrides, clips: count }) => {
    const wasm = await getWasm();
    const d = await design(baseSpec(overrides));
    const parts = clipsOf(d);
    expect(parts.length).toBe(count);
    expect(d.pegboard).toBeDefined();
    const f = frameOf(d.mountAxisDeg!);
    const frontZ = d.pegboard!.frontZ;
    const clips = parts.map((p) => ({ part: p, m: manifoldOf(wasm, p.mesh) }));
    // Through the board, below the latch tooth's depth: only the stems.
    const stems = clips.map(({ m }) => stemOf(m, frontZ - 3, f));
    const tops = clips.map(({ part }, i) => ({ part, i })).filter(({ part }) => part.name.includes("-top-"));
    expect(tops.length).toBeGreaterThanOrEqual(1);
    const origin = stems[tops[0].i];

    // Every clip's slot (its stem's seat in a nominal slot) is a lattice vector from the first top clip's: (20a, 20b), a + b even.
    const nominalSeat = (s: (typeof stems)[number]) => s.bottom + seatOf(5, 15, s.halfWidth);
    for (const s of stems) {
      const a = (s.side - origin.side) / LATTICE;
      const b = (nominalSeat(s) - nominalSeat(origin)) / LATTICE;
      expect(Math.abs(a - Math.round(a)), "side offset on the 20 mm lattice").toBeLessThan(1e-3);
      expect(Math.abs(b - Math.round(b)), "up offset on the 20 mm lattice").toBeLessThan(1e-3);
      expect(Math.abs(Math.round(a) + Math.round(b)) % 2, "same one of the two interleaved grids").toBe(0);
      // `design().pegboard` (the grid the viewer and guide draw) has a slot right where each clip seats.
      const u = nominalSeat(s);
      const x = u * f.up.x + s.side * f.side.x;
      const y = u * f.up.y + s.side * f.side.y;
      expect(d.pegboard!.slots.some((p) => Math.hypot(p.x - x, p.y - y) < 1e-3), "a drawn slot around every clip").toBe(true);
    }

    const radius = Math.max(...stems.map((s) => Math.hypot(s.bottom, s.side))) + 30;
    for (const board of BOARDS) {
      // The slots sit where the first top clip's stem rests on this board's slot bottom; every clip is seated with it
      // (0.01 mm above exact contact, so faceted-arc rounding never reads as an overlap).
      const seat = seatOf(board.slotWidth, board.slotLength, origin.halfWidth);
      const lift = 0.01;
      const slab = buildBoard(wasm, f, frontZ, { up: origin.bottom + seat, side: origin.side }, board, radius);
      for (const { part, m } of clips) {
        const seated = shifted(m, f, lift, 0, 0);
        expect(overlap(seated, slab), `${board.label}, ${part.name}: seated clip intersects the board`).toBeLessThan(1e-3);
        // 0.2 mm further down, the stem digs into its slot's bottom: the weight bears there.
        expect(overlap(shifted(seated, f, -0.2, 0, 0), slab), `${board.label}, ${part.name}: stem doesn't rest on the slot bottom`).toBeGreaterThan(1e-3);
        // Pulled out toward the room, the tongue catches the back of the board within its play (thinner boards play more).
        const play = 5.2 - board.thickness + 0.3;
        expect(overlap(shifted(seated, f, 0, 0, play + 0.3), slab), `${board.label}, ${part.name}: tongue doesn't hook behind the board`).toBeGreaterThan(1e-3);
        // A top clip's latch tooth sits in the top of its slot: a 1.6 mm lift hits the slot's end.
        if (part.name.includes("-top-")) {
          expect(overlap(shifted(seated, f, 1.6, 0, 0), slab), `${board.label}, ${part.name}: the latch doesn't stop a lift`).toBeGreaterThan(1e-3);
        } else {
          // A bottom clip lifts freely until its tongue meets the slot's top end (it can't come off while the top clip holds).
          expect(overlap(shifted(seated, f, 1.6, 0, 0), slab), `${board.label}, ${part.name}: bottom clip binds`).toBeLessThan(1e-3);
        }
        seated.delete();
      }
      slab.delete();
    }
    for (const { m } of clips) m.delete();
  }, 120_000);

  it("insertion: raised by the drop, each clip's stem and tongue pass straight through the tightest slot", async () => {
    const wasm = await getWasm();
    const d = await design(baseSpec());
    const f = frameOf(d.mountAxisDeg!);
    const frontZ = d.pegboard!.frontZ;
    const board = BOARDS[0];
    for (const part of clipsOf(d)) {
      const m = manifoldOf(wasm, part.mesh);
      const stem = stemOf(m, frontZ - 3, f);
      const seat = seatOf(board.slotWidth, board.slotLength, stem.halfWidth);
      // The part that has to go through: everything behind the latch tooth's depth (the tooth itself springs back against the board's face).
      const box = wasm.Manifold.cube([1000, 1000, 100], true).translate([0, 0, frontZ - 2.6 - 50]);
      const through = m.intersect(box);
      // Raised so the stem's top meets the top of the slot's full-width part: the most the clip has to drop.
      const fullWidth = 2 * seat;
      const drop = fullWidth - (stem.top - stem.bottom);
      expect(drop, `${part.name}: drop`).toBeGreaterThan(5);
      const slab = buildBoard(wasm, f, frontZ, { up: stem.bottom + seat, side: stem.side }, board, 80);
      // Swept along z through the board's whole thickness: never touching it.
      for (const dz of [0, 2, 4, 6, 8]) {
        expect(overlap(shifted(through, f, drop, 0, dz), slab), `${part.name}: hits the slot at dz=${dz}`).toBeLessThan(1e-3);
      }
      through.delete();
      box.delete();
      slab.delete();
      m.delete();
    }
  }, 60_000);

  it("the latch arm bends along the layers, and little: at most 1.5 % strain to clear the board face", async () => {
    const wasm = await getWasm();
    const d = await design(baseSpec());
    const f = frameOf(d.mountAxisDeg!);
    const frontZ = d.pegboard!.frontZ;
    const top = clipsOf(d).find((p) => p.name.includes("-top-"))!;
    const m = manifoldOf(wasm, top.mesh);
    const stem = stemOf(m, frontZ - 3, f);
    // Turned so up is +Z (and the board's normal -Y: the board face at y = -frontZ, the tooth at larger y), then sliced along up.
    const a = (Math.atan2(f.up.x, f.up.y) * 180) / Math.PI;
    const turned = m.rotate([0, 0, a]).rotate([90, 0, 0]);
    const face = -frontZ;
    const box = turned.boundingBox();
    const sections: Array<{ at: number; polys: Array<{ lo: number; hi: number }> }> = [];
    for (let at = stem.top + 0.05; at < box.max[2]; at += 0.1) {
      sections.push({ at, polys: turned.slice(at).toPolygons().map((poly) => ({ lo: Math.min(...poly.map((p) => p[1])), hi: Math.max(...poly.map((p) => p[1])) })) });
    }
    // Above the stem, the slit splits the arm (on the board face) from the mast; they join at the root.
    const split = sections.filter((s) => s.polys.length >= 2);
    expect(split.length, "the slit separates the arm from the mast").toBeGreaterThan(0);
    const root = Math.max(...split.map((s) => s.at));
    const tooth = sections.filter((s) => s.polys.some((p) => p.hi > face + 0.5));
    expect(tooth.length, "a tooth reaches into the slot").toBeGreaterThan(0);
    const toothCentre = tooth.reduce((sum, s) => sum + s.at, 0) / tooth.length;
    const depth = Math.max(...tooth.flatMap((s) => s.polys.map((p) => p.hi))) - face;
    expect(depth, "the tooth reaches past the slot's 1 mm fillet").toBeGreaterThan(FILLET + 1);
    const mid = split[Math.floor(split.length / 2)];
    const arm = mid.polys.find((p) => Math.abs(p.hi - face) < 1e-3)!;
    const t = arm.hi - arm.lo;
    const reach = root - toothCentre;
    const strain = (3 * t * depth) / (2 * reach * reach);
    expect(strain, `arm ${t.toFixed(2)} mm thick, tooth ${depth.toFixed(2)} mm deep, ${reach.toFixed(1)} mm from the root`).toBeLessThan(0.015);
    turned.delete();
    m.delete();
  });

  it("without the latch, the top clip lifts off freely (a plain hook)", async () => {
    const wasm = await getWasm();
    const d = await design(baseSpec({ skadisLatch: false }));
    const f = frameOf(d.mountAxisDeg!);
    const frontZ = d.pegboard!.frontZ;
    const top = clipsOf(d).find((p) => p.name.includes("-top-"))!;
    const m = manifoldOf(wasm, top.mesh);
    const stem = stemOf(m, frontZ - 3, f);
    const seat = seatOf(5, 15, stem.halfWidth);
    const slab = buildBoard(wasm, f, frontZ, { up: stem.bottom + seat, side: stem.side }, BOARDS[1], 80);
    expect(overlap(shifted(m, f, 4, 0, 0), slab)).toBeLessThan(1e-3);
    slab.delete();
    m.delete();
  });

  it("the clips hold the coil: the rim rests on the bottom clips, the top lip stops it tipping, and nothing touches the wound cable", async () => {
    const wasm = await getWasm();
    for (const c of CASES) {
      const d = await design(baseSpec(c.overrides));
      const f = frameOf(d.mountAxisDeg!);
      const core = manifoldOf(wasm, d.parts.find((p) => p.role === "core")!.mesh);
      for (const part of clipsOf(d)) {
        const m = manifoldOf(wasm, part.mesh);
        expect(overlap(core, m), `${c.label}, ${part.name}: clip intersects the core`).toBeLessThan(1e-3);
        if (part.name.includes("-bottom-")) {
          // The coil 0.3 mm lower sits on the bottom clips' bights.
          expect(overlap(shifted(core, f, -0.3, 0, 0), m), `${c.label}, ${part.name}: the rim doesn't rest on it`).toBeGreaterThan(1e-3);
        } else {
          // The coil tipping 0.3 mm away from the board meets the top clip's lip.
          expect(overlap(shifted(core, f, 0, 0, 0.3), m), `${c.label}, ${part.name}: the lip doesn't hold the rim`).toBeGreaterThan(1e-3);
        }
        // Every clip keeps clear of the wound cable (the drawn cable path, at its radius).
        const r = d.spec.wire.diameter / 2;
        const box = m.boundingBox();
        for (const path of d.wirePaths) {
          for (let i = 0; i < path.points.length; i += 3) {
            const [x, y, z] = [path.points[i], path.points[i + 1], path.points[i + 2]];
            if (x < box.min[0] - r || x > box.max[0] + r || y < box.min[1] - r || y > box.max[1] + r || z < box.min[2] - r || z > box.max[2] + r) continue;
            const ball = wasm.Manifold.sphere(r, 16).translate([x, y, z]);
            expect(overlap(ball, m), `${c.label}, ${part.name}: touches the wound cable`).toBeLessThan(1e-3);
            ball.delete();
          }
        }
        m.delete();
      }
      core.delete();
    }
  }, 180_000);

  it("prints without supports: every clip is one solid, lying on its flat face with every other face vertical", async () => {
    const wasm = await getWasm();
    for (const c of CASES) {
      const d = await design(baseSpec(c.overrides));
      for (const part of clipsOf(d)) {
        const m = manifoldOf(wasm, part.mesh);
        expect(m.decompose().length, `${c.label}, ${part.name}: one solid`).toBe(1);
        m.delete();
        const { positions, indices } = printPosed(part);
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (let i = 2; i < positions.length; i += 3) {
          minZ = Math.min(minZ, positions[i]);
          maxZ = Math.max(maxZ, positions[i]);
        }
        expect(maxZ - minZ, `${c.label}, ${part.name}: lies on its face`).toBeCloseTo(4.4, 3);
        for (let t = 0; t < indices.length; t += 3) {
          const p = [0, 1, 2].map((k) => [positions[3 * indices[t + k]], positions[3 * indices[t + k] + 1], positions[3 * indices[t + k] + 2]]);
          const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
          const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
          const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const len = Math.hypot(n[0], n[1], n[2]);
          if (len < 1e-9) continue;
          const nz = n[2] / len;
          const zs = p.map((q) => q[2]);
          const flat = Math.abs(Math.abs(nz) - 1) < 1e-4 && (Math.max(...zs) < minZ + 1e-4 || Math.min(...zs) > maxZ - 1e-4);
          expect(flat || Math.abs(nz) < 1e-4, `${c.label}, ${part.name}: a face that's neither vertical nor the bed/top (nz=${nz.toFixed(4)})`).toBe(true);
        }
      }
    }
  }, 120_000);
});

/** A part's mesh in its own print pose (rotate about Z, then X, then translate -- the public `RigidTransform`). */
function printPosed(part: Part): CoilMesh {
  const t = part.printTransform;
  const cz = Math.cos(t.rotateZ ?? 0);
  const sz = Math.sin(t.rotateZ ?? 0);
  const cx = Math.cos(t.rotateX);
  const sx = Math.sin(t.rotateX);
  const out = new Float32Array(part.mesh.positions.length);
  for (let i = 0; i < out.length; i += 3) {
    const [x0, y0, z] = [part.mesh.positions[i], part.mesh.positions[i + 1], part.mesh.positions[i + 2]];
    const x = x0 * cz - y0 * sz;
    const y = x0 * sz + y0 * cz;
    out[i] = x + t.translate[0];
    out[i + 1] = y * cx - z * sx + t.translate[1];
    out[i + 2] = y * sx + z * cx + t.translate[2];
  }
  return { positions: out, indices: part.mesh.indices };
}

// Issue #213: the T-clips (after the CC BY 4.0 Skadis T-Clip System), against
// the same fact-built boards. Each clip's stem is found by slicing its mesh
// through the board; the twist is checked by turning the real clip mesh
// about its own axis.
const TCLIP_CASES: Array<{ label: string; overrides: Partial<CoilSpec>; clips: number }> = [
  { label: "round 60", overrides: { mount: "skadis-tclip", coreSize: { locked: true, dimension: "outer", value: 60 } }, clips: 3 },
  { label: "round 85", overrides: { mount: "skadis-tclip" }, clips: 3 },
  { label: "round 120", overrides: { mount: "skadis-tclip", coreSize: { locked: true, dimension: "outer", value: 120 } }, clips: 3 },
  { label: "square 85", overrides: { mount: "skadis-tclip", shape: { kind: "sq", cornerRadius: 10 } }, clips: 3 },
  { label: "triangle 85", overrides: { mount: "skadis-tclip", shape: { kind: "tri", cornerRadius: 10 } }, clips: 3 },
  { label: "round 85, heavy cable", overrides: { mount: "skadis-tclip", wire: { length: 10000, diameter: 8, type: "flex" }, layers: { locked: true, value: 4 } }, clips: 4 },
];

/** `m` turned by `deg` (counter-clockwise seen from the room, +z) about the vertical line through `axis`, then moved. */
function turned(m: M, axis: { x: number; y: number }, deg: number, f: Frame, dUp: number, dz: number): M {
  return m
    .translate([-axis.x, -axis.y, 0])
    .rotate([0, 0, deg])
    .translate([axis.x + dUp * f.up.x, axis.y + dUp * f.up.y, dz]);
}

describe("the SKÅDIS T-clips lock onto a real SKÅDIS board (issue #213)", () => {
  it.each(TCLIP_CASES)("$label: on the lattice, seated clear of the board and the lugs, stems on the slot bottoms, the coil on the handles, clamped", async ({ overrides, clips: count }) => {
    const wasm = await getWasm();
    const d = await design(baseSpec(overrides));
    const parts = clipsOf(d);
    expect(parts.length).toBe(count);
    const f = frameOf(d.mountAxisDeg!);
    const frontZ = d.pegboard!.frontZ;
    expect(frontZ, "the flange lies flat on the board").toBeCloseTo(-d.flangeSpec.thickness, 6);
    const core = manifoldOf(wasm, d.parts.find((p) => p.role === "core")!.mesh);
    expect(core.decompose().length, "the core with its lugs is one solid").toBe(1);
    const clips = parts.map((p) => ({ part: p, m: manifoldOf(wasm, p.mesh) }));
    const stems = clips.map(({ m }) => stemOf(m, frontZ - 2.5, f));
    const origin = stems[0];
    const nominal = (s: (typeof stems)[number]) => s.bottom + seatOf(5, 15, s.halfWidth);
    for (const s of stems) {
      const a = (s.side - origin.side) / LATTICE;
      const b = (nominal(s) - nominal(origin)) / LATTICE;
      expect(Math.abs(a - Math.round(a)), "side offset on the 20 mm lattice").toBeLessThan(1e-3);
      expect(Math.abs(b - Math.round(b)), "up offset on the 20 mm lattice").toBeLessThan(1e-3);
      expect(Math.abs(Math.round(a) + Math.round(b)) % 2, "same one of the two interleaved grids").toBe(0);
      const u = nominal(s);
      expect(d.pegboard!.slots.some((p) => Math.hypot(p.x - (u * f.up.x + s.side * f.side.x), p.y - (u * f.up.y + s.side * f.side.y)) < 1e-3), "a drawn slot round every clip").toBe(true);
    }
    const radius = Math.max(...stems.map((s) => Math.hypot(s.bottom, s.side))) + 30;
    for (const { part, m } of clips) expect(overlap(m, core), `${part.name}: intersects the core`).toBeLessThan(1e-3);
    for (const board of BOARDS) {
      const seat = seatOf(board.slotWidth, board.slotLength, origin.halfWidth);
      const slab = buildBoard(wasm, f, frontZ, { up: origin.bottom + seat, side: origin.side }, board, radius);
      for (const { part, m } of clips) {
        const seated = shifted(m, f, 0.01, 0, 0);
        expect(overlap(seated, slab), `${board.label}, ${part.name}: seated clip intersects the board`).toBeLessThan(1e-3);
        expect(overlap(shifted(seated, f, -0.2, 0, 0), slab), `${board.label}, ${part.name}: stem doesn't rest on the slot bottom`).toBeGreaterThan(1e-3);
        // Pulled toward the room, the T bar catches the back of the board within the board's play.
        expect(overlap(shifted(m, f, 0, 0, 5.2 - board.thickness + 0.2), slab), `${board.label}, ${part.name}: T bar doesn't catch the board`).toBeGreaterThan(1e-3);
        seated.delete();
      }
      slab.delete();
    }
    for (const { part, m } of clips) {
      // The coil 0.3 mm lower rests on the handle (the recess's lower edge); pulled 0.2 mm off the board, the lug meets the handle (the clamp).
      expect(overlap(shifted(core, f, -0.3, 0, 0), m), `${part.name}: the lug doesn't rest on the handle`).toBeGreaterThan(1e-3);
      expect(overlap(shifted(core, f, 0, 0, 0.2), m), `${part.name}: the handle doesn't clamp the lug`).toBeGreaterThan(1e-3);
      m.delete();
    }
    core.delete();
  }, 120_000);

  it.each(TCLIP_CASES.slice(0, 3))("$label: twist lock -- in upright through the tightest slot, a quarter turn clockwise with nothing in the way, stopped beyond it, then the drop", async ({ overrides }) => {
    const wasm = await getWasm();
    const d = await design(baseSpec(overrides));
    const f = frameOf(d.mountAxisDeg!);
    const frontZ = d.pegboard!.frontZ;
    const core = manifoldOf(wasm, d.parts.find((p) => p.role === "core")!.mesh);
    const board = BOARDS[0];
    for (const part of clipsOf(d)) {
      const m = manifoldOf(wasm, part.mesh);
      const stem = stemOf(m, frontZ - 2.5, f);
      const axisUp = (stem.bottom + stem.top) / 2;
      const axis = { x: axisUp * f.up.x + stem.side * f.side.x, y: axisUp * f.up.y + stem.side * f.side.y };
      const seat = seatOf(board.slotWidth, board.slotLength, stem.halfWidth);
      const slotUp = stem.bottom + seat;
      const slab = buildBoard(wasm, f, frontZ, { up: slotUp, side: stem.side }, board, Math.hypot(slotUp, stem.side) + 10);
      // The clip goes in and turns at the slot's centre, the coil held up with it (they drop together once turned).
      const rise = slotUp - axisUp;
      const raisedCore = shifted(core, f, rise, 0, 0);
      const clear = (pose: M, what: string) => {
        expect(overlap(pose, slab), `${part.name}: ${what} hits the board`).toBeLessThan(1e-3);
        expect(overlap(pose, raisedCore), `${part.name}: ${what} hits the lug`).toBeLessThan(1e-3);
        pose.delete();
      };
      // Upright (a quarter turn back, counter-clockwise from the room), pushed in from the room side.
      for (const dz of [16, 12, 8, 4, 2, 0]) clear(turned(m, axis, 90, f, rise, dz), `going in upright (dz=${dz})`);
      // Turned clockwise, upright to across, at the slot's centre.
      for (const deg of [75, 60, 45, 30, 15, 0]) clear(turned(m, axis, deg, f, rise, 0), `turning (${deg} deg to go)`);
      // Let go: clip and coil drop together onto the slot's bottom, the T bar sliding down behind the board.
      for (const k of [0.75, 0.5, 0.25]) expect(overlap(turned(m, axis, 0, f, rise * k, 0), slab), `${part.name}: dropping hits the board`).toBeLessThan(1e-3);
      // The recess stops the handle past a quarter turn, and past upright.
      const over = turned(m, axis, -15, f, rise, 0);
      expect(overlap(over, raisedCore), `${part.name}: turns past a quarter turn`).toBeGreaterThan(1e-3);
      over.delete();
      const back = turned(m, axis, 105, f, rise, 0);
      expect(overlap(back, raisedCore), `${part.name}: turns back past upright`).toBeGreaterThan(1e-3);
      back.delete();
      raisedCore.delete();
      // Turned back upright while dropped, it can't be pulled out: the T bar is below the slot's full width.
      const stuck = turned(m, axis, 90, f, 0, 3);
      expect(overlap(stuck, slab), `${part.name}: comes out without being lifted`).toBeGreaterThan(1e-3);
      stuck.delete();
      slab.delete();
      m.delete();
    }
    core.delete();
  }, 120_000);

  it("the T-clips print without supports: one solid each, lying on the flat face with every other face vertical", async () => {
    const wasm = await getWasm();
    for (const c of TCLIP_CASES) {
      const d = await design(baseSpec(c.overrides));
      for (const part of clipsOf(d)) {
        const m = manifoldOf(wasm, part.mesh);
        expect(m.decompose().length, `${c.label}, ${part.name}: one solid`).toBe(1);
        m.delete();
        const { positions, indices } = printPosed(part);
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (let i = 2; i < positions.length; i += 3) {
          minZ = Math.min(minZ, positions[i]);
          maxZ = Math.max(maxZ, positions[i]);
        }
        expect(maxZ - minZ, `${c.label}, ${part.name}: lies on its face`).toBeCloseTo(4, 3);
        for (let t = 0; t < indices.length; t += 3) {
          const p = [0, 1, 2].map((k) => [positions[3 * indices[t + k]], positions[3 * indices[t + k] + 1], positions[3 * indices[t + k] + 2]]);
          const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
          const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
          const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const len = Math.hypot(n[0], n[1], n[2]);
          if (len < 1e-9) continue;
          const nz = n[2] / len;
          const zs = p.map((q) => q[2]);
          const flat = Math.abs(Math.abs(nz) - 1) < 1e-4 && (Math.max(...zs) < minZ + 1e-4 || Math.min(...zs) > maxZ - 1e-4);
          expect(flat || Math.abs(nz) < 1e-4, `${c.label}, ${part.name}: a face that's neither vertical nor the bed/top (nz=${nz.toFixed(4)})`).toBe(true);
        }
      }
    }
  }, 120_000);
});
