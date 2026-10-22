import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design, JOINT_ENGAGE_DEPTH, SKADIS_LATCH_FACE_DEG, SKADIS_LATCH_TOOTH_DEPTH, SKADIS_TCLIP_FIN_HEIGHT, SKADIS_TCLIP_FIN_TOP_GAP, SKADIS_TCLIP_HANDLE_THICKNESS, SKADIS_TCLIP_NOTCH_DEPTH, SKADIS_TCLIP_NOTCH_FLOOR, SKADIS_TCLIP_NOTCH_LEAD, SKADIS_TCLIP_NOTCH_WIDTH, SKADIS_TCLIP_RECESS_DEPTH, SKADIS_TCLIP_WIDTH, SKADIS_TONGUE_LENGTH } from "../src/core";
import type { CoilMesh, CoilSpec, Design, Part } from "../src/core";
import { meshVolume } from "./support/mesh";

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
const CAP_CHAMFER = 0.4; // mm, SKADIS_CLIP_CAP_CHAMFER
const ARC_FACET_MAX_DEG = 12.5; // a fillet's facets turn at most 11.25 degrees
const BOARDS = [
  { label: "tight 4.8 x 14.8 slot, 5.2 mm board", slotWidth: 4.8, slotLength: 14.8, thickness: 5.2 },
  { label: "nominal 5 x 15 slot, 5 mm board", slotWidth: 5, slotLength: 15, thickness: 5 },
  { label: "nominal 5 x 15 slot, thin 4 mm board", slotWidth: 5, slotLength: 15, thickness: 4 },
];

// A contact measure: the shift at which the clip and the board overlap by more than this volume. The latch's real
// lift is shorter than the 1 mm the docs give (#364); these are main's values before the fillets (#361).
const CONTACT_VOLUME = 1e-3;
const CONTACT_TOLERANCE = 0.05;
const BASELINE_REACH: Record<string, { lift: number; drop: number }> = {
  [BOARDS[0].label]: { lift: 0.434, drop: 0.025 },
  [BOARDS[1].label]: { lift: 0.88, drop: 0.024 },
  [BOARDS[2].label]: { lift: 0.88, drop: 0.029 },
};

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
  const side = (Math.max(...sides) + Math.min(...sides)) / 2;
  return { bottom: Math.min(...ups), top: Math.max(...ups), side, halfWidth: (Math.max(...sides) - Math.min(...sides)) / 2, outline: pts.map((_, i) => [sides[i] - side, ups[i]] as const) };
}

/** Where a slot's centre is when the stem's outline rests on its rounded bottom end, as the real chamfered corners do. */
const slotUpOf = (stem: ReturnType<typeof stemOf>, slotWidth: number, slotLength: number) => tclipSeat(stem.outline, slotWidth, slotLength);

/** Where a stem with this half width rests, below its slot's centre: its lower corners on the slot's rounded end. */
/** The unchamfered stem's seat, kept for the insertion test: conservative, as the chamfers only widen the passage. */
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

// Bottom clips whose stem sits close to a corner that a fillet would round: 0.07 mm from the bight's back edge, and 0.61 mm short of the jaw tip.
// There the bight or the jaw grows to leave a 1.1 mm board-face edge between two fillets.
const spec3 = (size: number) => ({ coreSize: { locked: true as const, dimension: "outer" as const, value: size }, wire: { length: 2000, diameter: 3.8, type: "flex" as const } });
const SHORT_EDGE_CASES = [
  { label: "round 157.5 (stem 0.07 mm from the bight's back edge)", overrides: spec3(157.5), clips: 3 },
  { label: "round 160 (stem 0.61 mm short of the jaw tip)", overrides: spec3(160), clips: 3 },
];

const CASES: Array<{ label: string; overrides: Partial<CoilSpec>; clips: number }> = [
  { label: "round 60", overrides: { coreSize: { locked: true, dimension: "outer", value: 60 } }, clips: 3 },
  { label: "round 85", overrides: {}, clips: 3 },
  { label: "round 120", overrides: { coreSize: { locked: true, dimension: "outer", value: 120 } }, clips: 3 },
  { label: "square 85", overrides: { shape: { kind: "sq", cornerRadius: 10 } }, clips: 3 },
  { label: "triangle 85", overrides: { shape: { kind: "tri", cornerRadius: 10 } }, clips: 3 },
  { label: "round 85, 10 m of 8 mm cable (heavy: two top clips)", overrides: { wire: { length: 10000, diameter: 8, type: "flex" }, layers: { locked: true, value: 4 } }, clips: 4 },
  ...SHORT_EDGE_CASES,
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
    const nominalSeat = (s: (typeof stems)[number]) => slotUpOf(s, 5, 15);
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
      const lift = 0.01;
      const slab = buildBoard(wasm, f, frontZ, { up: slotUpOf(origin, board.slotWidth, board.slotLength), side: origin.side }, board, radius);
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

  it("lift and seat baseline: how far a seated top clip lifts before the slot stops it, and how far it can drop (unchanged by #361)", async () => {
    const wasm = await getWasm();
    const d = await design(baseSpec());
    const f = frameOf(d.mountAxisDeg!);
    const frontZ = d.pegboard!.frontZ;
    const top = clipsOf(d).find((p) => p.name.includes("-top-"))!;
    const m = manifoldOf(wasm, top.mesh);
    const stem = stemOf(m, frontZ - 3, f);
    for (const board of BOARDS) {
      const slab = buildBoard(wasm, f, frontZ, { up: slotUpOf(stem, board.slotWidth, board.slotLength), side: stem.side }, board, 80);
      const firstContact = (from: number, to: number) => {
        let miss = from;
        let hit = to;
        for (let i = 0; i < 24; i++) {
          const mid = (miss + hit) / 2;
          const moved = shifted(m, f, mid, 0, 0);
          if (overlap(moved, slab) > CONTACT_VOLUME) hit = mid;
          else miss = mid;
          moved.delete();
        }
        return hit;
      };
      const expected = BASELINE_REACH[board.label];
      expect(slotUpOf(stem, board.slotWidth, board.slotLength) - (stem.bottom + seatOf(board.slotWidth, board.slotLength, stem.halfWidth)), `${board.label}: the chamfered stem sits deeper in its slot by the chamfer`).toBeCloseTo(CAP_CHAMFER, 2);
      expect(Math.abs(firstContact(0, 3) - expected.lift), `${board.label}: lift`).toBeLessThan(CONTACT_TOLERANCE);
      expect(Math.abs(-firstContact(0, -3) - expected.drop), `${board.label}: drop`).toBeLessThan(CONTACT_TOLERANCE);
      slab.delete();
    }
    m.delete();
  }, 120_000);

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
    const slab = buildBoard(wasm, f, frontZ, { up: slotUpOf(stem, 5, 15), side: stem.side }, BOARDS[1], 80);
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

  // Issue #222: the jaws grip the flange's plain plate -- the same base as the through-hole mount -- so a clip doesn't
  // depend on how thick the flange is under the wall and the channel, and no clip meets the thickened parts around them.
  it("the rim's notch floor is rounded round the bight's inside fillets at an even gap, so the coil stays clear of every jaw face", async () => {
    const wasm = await getWasm();
    for (const c of CASES) {
      const d = await design(baseSpec(c.overrides));
      const f = frameOf(d.mountAxisDeg!);
      const angle = (Math.atan2(f.up.x, f.up.y) * 180) / Math.PI;
      const { thickness, plateThickness, skadis } = d.flangeSpec;
      const plate = Math.min(plateThickness ?? thickness, thickness);
      const relief = plate / 4;
      const core = manifoldOf(wasm, d.parts.find((p) => p.role === "core")!.mesh);
      for (const clip of skadis!.clips) {
        const strip = wasm.Manifold.cube([0.1, 1000, 100], true).rotate([0, 0, -angle]).translate([clip.side * f.side.x, clip.side * f.side.y, -50]);
        const section = core.intersect(strip);
        strip.delete();
        const { vertProperties } = section.getMesh();
        for (const cornerZ of [-thickness, -thickness + plate]) {
          let nearest = Infinity;
          for (let i = 0; i < vertProperties.length; i += 3) {
            const u = vertProperties[i] * f.up.x + vertProperties[i + 1] * f.up.y;
            nearest = Math.min(nearest, Math.hypot(u - clip.floor, vertProperties[i + 2] - cornerZ));
          }
          expect(nearest, `${c.label}, ${clip.role} clip at ${clip.side.toFixed(1)}: the rim's corner at z=${cornerZ.toFixed(2)} is rounded off`).toBeGreaterThan(0.9 * relief * (Math.SQRT2 - 1));
        }
        section.delete();
      }
      for (const part of clipsOf(d)) {
        const m = manifoldOf(wasm, part.mesh);
        for (const dz of [-0.1, 0.1]) {
          const nearer = shifted(core, f, 0, 0, dz);
          expect(overlap(nearer, m), `${c.label}, ${part.name}: the coil ${dz < 0 ? "down" : "up"} by 0.1 mm meets the clip`).toBeLessThan(1e-3);
          nearer.delete();
        }
        m.delete();
      }
      core.delete();
    }
  }, 180_000);

  it("the clip is the same part on every core, and clears the thick parts of the flange (no pad under it)", async () => {
    const wasm = await getWasm();
    const volumes: number[] = [];
    for (const [label, wire, layers] of [
      ["thin cable, plain 3 mm flange", { length: 1000, diameter: 1.2, type: "usb" as const }, 1],
      ["3.8 mm cable", { length: 2000, diameter: 3.8, type: "usb" as const }, 1],
      ["8 mm cable, 9.5 mm flange", { length: 10000, diameter: 8, type: "flex" as const }, 4],
    ] as const) {
      const d = await design(baseSpec({ wire, layers: { locked: true, value: layers } }));
      const top = clipsOf(d).find((p) => p.name.includes("-top-"))!;
      volumes.push(meshVolume(top.mesh));
      const core = manifoldOf(wasm, d.parts.find((p) => p.role === "core")!.mesh);
      for (const part of clipsOf(d)) {
        const m = manifoldOf(wasm, part.mesh);
        expect(overlap(core, m), `${label}, ${part.name}: clip intersects the core`).toBeLessThan(1e-3);
        m.delete();
      }
      core.delete();
    }
    // To 0.005 mm^3 of about 1345: the meshes sit at different places, and their volumes differ by float noise alone.
    expect(volumes[1], "the top clip is the same part for a 3.8 mm and a thin cable").toBeCloseTo(volumes[0], 2);
    expect(volumes[2], "the top clip is the same part for an 8 mm cable").toBeCloseTo(volumes[0], 2);
  }, 120_000);

  it("clips keep clear of the inner-end channel's pad across cables, shapes and sizes (they lie on the plate, below the pad's flare)", async () => {
    const wasm = await getWasm();
    for (const kind of ["round", "sq", "tri"] as const) {
      // (A triangle with a thick cable has little rim clear of the channel's wide pad: it warns and leaves the clips out, so those sizes start higher.)
      const cases: Array<[number, number, number]> = kind === "tri" ? [[100, 5, 1500], [100, 6.5, 3000], [120, 10, 4000], [85, 3.8, 2000]] : [[60, 5, 1500], [85, 8, 4000], [100, 6.5, 3000], [120, 10, 4000], [85, 3.8, 2000]];
      for (const [size, diameter, length] of cases) {
        const d = await design(baseSpec({ shape: kind === "round" ? { kind } : { kind, cornerRadius: 10 }, coreSize: { locked: true, dimension: "outer", value: size }, wire: { length, diameter, type: "flex" } }), "draft");
        const label = `${kind} ${size}, ${diameter} mm cable`;
        const core = manifoldOf(wasm, d.parts.find((p) => p.role === "core")!.mesh);
        expect(clipsOf(d).length, `${label}: clips`).toBeGreaterThanOrEqual(2);
        for (const part of clipsOf(d)) {
          const m = manifoldOf(wasm, part.mesh);
          expect(overlap(core, m), `${label}, ${part.name}: clip intersects the core`).toBeLessThan(1e-3);
          m.delete();
        }
        core.delete();
      }
    }
  }, 180_000);

  it("every profile corner is filleted but the latch's catching face and the tongue's retaining face, which stay sharp", async () => {
    const wasm = await getWasm();
    const scenarios = [...CASES.map((c) => ({ label: c.label, overrides: c.overrides })), { label: "round 85, no latch", overrides: { skadisLatch: false } }];
    for (const c of scenarios) {
      const d = await design(baseSpec(c.overrides), "draft");
      for (const part of clipsOf(d)) {
        const ring = midOutline(wasm, part);
        const turns = turnsOf(ring);
        const runs = arcRuns(turns);
        const sharp = turns.filter((t) => Math.abs(t.turn) > ARC_FACET_MAX_DEG);
        const latch = part.name.includes("-top-") && c.overrides.skadisLatch !== false;
        const label = `${c.label}, ${part.name}`;
        // Corners joined tangent to tangent (the jaw's and the lip's rounded tips, the slit's end, the arm's end) are one arc run.
        const expectedRuns = latch ? 15 : 8;
        expect(runs.length, `${label}: filleted corners`).toBeGreaterThanOrEqual(expectedRuns);
        expect(sharp.length, `${label}: sharp corners`).toBe(latch ? 4 : 2);
        const rightAngles = sharp.filter((t) => Math.abs(Math.abs(t.turn) - 90) < 1);
        expect(rightAngles.length, `${label}: the retaining face's two ends`).toBe(2);
        expect(Math.hypot(rightAngles[0].at[0] - rightAngles[1].at[0], rightAngles[0].at[1] - rightAngles[1].at[1]), `${label}: the retaining face spans the tongue`).toBeCloseTo(SKADIS_TONGUE_LENGTH, 2);
        if (latch) {
          const faceEnds = sharp.filter((t) => Math.abs(Math.abs(t.turn) - (90 - SKADIS_LATCH_FACE_DEG)) < 1);
          expect(faceEnds.length, `${label}: the catching face's two ends`).toBe(2);
          expect(Math.hypot(faceEnds[0].at[0] - faceEnds[1].at[0], faceEnds[0].at[1] - faceEnds[1].at[1]), `${label}: the catching face`).toBeCloseTo(SKADIS_LATCH_TOOTH_DEPTH / Math.cos((SKADIS_LATCH_FACE_DEG * Math.PI) / 180), 2);
          expect(Math.sign(faceEnds[0].turn), `${label}: one end convex, one concave`).not.toBe(Math.sign(faceEnds[1].turn));
        }
      }
    }
  }, 120_000);

  it.each(SHORT_EDGE_CASES)("$label: every convex corner of a bottom clip still has a 0.55 mm fillet", async ({ overrides }) => {
    const wasm = await getWasm();
    const d = await design(baseSpec(overrides));
    const bottoms = clipsOf(d).filter((p) => p.name.includes("-bottom-"));
    expect(bottoms.length).toBeGreaterThan(0);
    for (const part of bottoms) {
      const convex = arcRuns(turnsOf(midOutline(wasm, part))).filter((r) => r.turn > 0);
      expect(convex.length, `${part.name}: filleted convex corners`).toBeGreaterThan(0);
      expect(Math.min(...convex.map((r) => r.radius)), `${part.name}: smallest convex fillet`).toBeGreaterThan(0.55 - 0.01);
    }
  }, 120_000);

  // Fuzz cases 1124, 1615 and 2111 (issue #361): a fillet limited by a cap or its other edge left a flat of about 0.02 mm next to its neighbour's fillet.
  const FLAT_CASES: CoilSpec[] = [
    { ...baseSpec(), wire: { length: 8823, diameter: 7.26, type: "stiff" }, windingQuality: 0.66, coreSize: { locked: true, dimension: "outer", value: 36.62 }, layers: { locked: false }, objective: "aspectRatio", topCap: "on", tolerance: 0.18, plateJoint: "snap", label: "Lamp 5 m", base: "off", strapSlots: false },
    { ...baseSpec(), wire: { length: 3741, diameter: 7.49, type: "flex" }, shape: { kind: "sq", cornerRadius: 16.8 }, windingQuality: 0.52, coreSize: { locked: true, dimension: "outer", value: 85.25 }, height: { locked: true, value: 62.06 }, layers: { locked: true, value: 2 }, objective: "aspectRatio", topCap: "on", joint: "bayonet", tolerance: 0.24, base: "on", strapSlots: false },
    { ...baseSpec(), wire: { length: 6874, diameter: 4.08, type: "flex" }, shape: { kind: "sq", cornerRadius: 14.32 }, windingQuality: 0.66, coreSize: { locked: true, dimension: "outer", value: 63.18 }, height: { locked: true, value: 58.67 }, layers: { locked: false }, tolerance: 0.36, base: "on", strapSlots: false },
  ];
  it.each(FLAT_CASES.map((spec, i) => ({ spec, label: `fuzz case ${[1124, 1615, 2111][i]}` })))("$label: neighbouring fillets leave no flat shorter than a facet", async ({ spec }) => {
    const wasm = await getWasm();
    const d = await design(spec, "draft");
    for (const part of clipsOf(d)) {
      const shortest = Math.min(...turnsOf(midOutline(wasm, part)).map((t) => t.edge));
      expect(shortest, `${part.name}: shortest edge`).toBeGreaterThan(0.05);
    }
  }, 120_000);

  it("the cap edges are chamfered 0.4 mm at 45 degrees: the outline 0.2 mm above the bed is the mid outline moved 0.2 mm in", async () => {
    const wasm = await getWasm();
    for (const c of CASES) {
      const d = await design(baseSpec(c.overrides), "draft");
      for (const part of clipsOf(d)) {
        const m = manifoldOf(wasm, printPosed(part));
        const box = m.boundingBox();
        const mid = m.slice((box.min[2] + box.max[2]) / 2).toPolygons();
        const near = m.slice(box.min[2] + CAP_CHAMFER / 2).toPolygons();
        m.delete();
        const label = `${c.label}, ${part.name}`;
        expect(mid.length, `${label}: one mid outline`).toBe(1);
        expect(near.length, `${label}: one outline near the bed`).toBe(1);
        expect(polygonArea(near[0]), `${label}: smaller than mid`).toBeLessThan(polygonArea(mid[0]));
        const [a, b] = longestEdge(mid[0] as Ring);
        const centre = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        expect(distanceToRing(centre, near[0] as Ring), `${label}: the long edge has moved in by half the chamfer`).toBeCloseTo(CAP_CHAMFER / 2, 2);
      }
    }
  }, 120_000);

  it("prints without supports: every clip is one solid, lying on its flat face with every other face vertical or a 45 degree chamfer within 0.4 mm of a cap", async () => {
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
        const slanted = new Set<number>();
        const walls = new Set<number>();
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
          const chamfer = Math.abs(Math.abs(nz) - Math.SQRT1_2) < 1e-3 && (Math.max(...zs) < minZ + CAP_CHAMFER + 1e-3 || Math.min(...zs) > maxZ - CAP_CHAMFER - 1e-3);
          expect(flat || chamfer || Math.abs(nz) < 1e-4, `${c.label}, ${part.name}: a face that's neither vertical, nor the bed/top, nor a chamfer at a cap (nz=${nz.toFixed(4)})`).toBe(true);
          if (chamfer) slanted.add(t / 3);
          if (Math.abs(nz) < 1e-4) walls.add(t / 3);
        }
        expect([...slanted].sort((a, b) => a - b), `${c.label}, ${part.name}: the chamfer triangles the viewer skips the creases of`).toEqual([...(part.mesh.rimTriangles?.chamfer ?? [])].sort((a, b) => a - b));
        expect([...walls].sort((a, b) => a - b), `${c.label}, ${part.name}: the walls the viewer inks the chamfers' lower crease against`).toEqual([...(part.mesh.rimTriangles?.land ?? [])].sort((a, b) => a - b));
      }
    }
  }, 120_000);
});

type Ring = Array<[number, number]>;
type Turn = { turn: number; at: [number, number]; edge: number };

function midOutline(wasm: Wasm, part: Part): Ring {
  const m = manifoldOf(wasm, printPosed(part));
  const box = m.boundingBox();
  const polys = m.slice((box.min[2] + box.max[2]) / 2).toPolygons();
  m.delete();
  expect(polys.length, `${part.name}: one outline`).toBe(1);
  return polys[0] as Ring;
}

/** The signed turn at each real vertex of a counter-clockwise outline (left is positive), and the length of the edge after it; the mesh's split points on straight edges and facets are left out. */
function turnsOf(outline: Ring): Turn[] {
  const angle = (p: Ring[number], q: Ring[number], r: Ring[number]) =>
    (Math.atan2((q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]), (q[0] - p[0]) * (r[0] - q[0]) + (q[1] - p[1]) * (r[1] - q[1])) * 180) / Math.PI;
  let ring = outline.filter((q, i) => Math.hypot(q[0] - outline[(i + 1) % outline.length][0], q[1] - outline[(i + 1) % outline.length][1]) > 1e-6);
  ring = ring.filter((q, i) => Math.abs(angle(ring[(i + ring.length - 1) % ring.length], q, ring[(i + 1) % ring.length])) > 0.05);
  const n = ring.length;
  return ring.map((q, i) => ({ turn: angle(ring[(i + n - 1) % n], q, ring[(i + 1) % n]), at: q, edge: Math.hypot(ring[(i + 1) % n][0] - q[0], ring[(i + 1) % n][1] - q[1]) }));
}

/** Runs of at least 4 consecutive vertices that each turn by a fillet's facet angle or less, the same way: the faceted arcs. */
function arcRuns(turns: Turn[]): Array<{ turn: number; radius: number }> {
  const n = turns.length;
  const gentle = (t: Turn) => Math.abs(t.turn) > 1 && Math.abs(t.turn) <= ARC_FACET_MAX_DEG;
  const start = turns.findIndex((t) => !gentle(t));
  const runs: Array<{ turn: number; radius: number }> = [];
  let run: Turn[] = [];
  const close = () => {
    if (run.length >= 4) {
      const facet = Math.max(...run.map((t) => Math.abs(t.turn)));
      const radii: number[] = [];
      for (let i = 0; i + 1 < run.length; i++) {
        if (Math.abs(run[i].turn) < 0.75 * facet || Math.abs(run[i + 1].turn) < 0.75 * facet) continue;
        const chord = Math.hypot(run[i].at[0] - run[i + 1].at[0], run[i].at[1] - run[i + 1].at[1]);
        radii.push(chord / (2 * Math.sin(((facet * Math.PI) / 180) / 2)));
      }
      runs.push({ turn: Math.sign(run[0].turn), radius: Math.min(...radii) });
    }
    run = [];
  };
  const differs = (x: number, y: number) => Math.abs(x - y) > 0.05 * Math.max(x, y);
  for (let k = 1; k <= n; k++) {
    const idx = (start + k) % n;
    const t = turns[idx];
    if (gentle(t) && (run.length === 0 || Math.sign(run[0].turn) === Math.sign(t.turn))) run.push(t);
    else {
      close();
      if (gentle(t)) run.push(t);
    }
    const before = run[run.length - 2];
    if (before && differs(t.edge, before.edge) && differs(t.edge, turns[(idx + 1) % n].edge)) close();
  }
  close();
  return runs;
}

function polygonArea(ring: ReadonlyArray<ReadonlyArray<number>>): number {
  return Math.abs(ring.reduce((sum, p, i) => sum + p[0] * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * p[1], 0)) / 2;
}

function longestEdge(ring: Ring): [Ring[number], Ring[number]] {
  let best: [Ring[number], Ring[number]] = [ring[0], ring[1]];
  let length = 0;
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len > length) [best, length] = [[p, q], len];
  });
  return best;
}

function distanceToRing(point: number[], ring: Ring): number {
  return Math.min(
    ...ring.map((p, i) => {
      const q = ring[(i + 1) % ring.length];
      const len2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - p[0]) * (q[0] - p[0]) + (point[1] - p[1]) * (q[1] - p[1])) / len2));
      return Math.hypot(point[0] - (p[0] + t * (q[0] - p[0])), point[1] - (p[1] + t * (q[1] - p[1])));
    }),
  );
}

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

// Issues #213, #221: the T-clips (after the CC BY 4.0 Skadis T-Clip System),
// in slots through a floor in the core's bore, against the same fact-built
// boards. Each clip's stem is found by slicing its mesh through the board;
// the twist is checked by turning the real clip mesh about its own axis.
const tclip = (o: Partial<CoilSpec>): Partial<CoilSpec> => ({ mount: "skadis-tclip", ...o });
const size = (value: number) => ({ coreSize: { locked: true as const, dimension: "outer" as const, value } });
const TCLIP_CASES: Array<{ label: string; overrides: Partial<CoilSpec>; clips: number }> = [
  { label: "round 40", overrides: tclip(size(40)), clips: 1 },
  { label: "round 60", overrides: tclip(size(60)), clips: 1 },
  { label: "round 75", overrides: tclip(size(75)), clips: 2 },
  { label: "round 85", overrides: tclip({}), clips: 3 },
  { label: "round 120", overrides: tclip(size(120)), clips: 3 },
  { label: "round 85, with a cap", overrides: tclip({ topCap: "on" }), clips: 3 },
  { label: "square 60", overrides: tclip({ shape: { kind: "sq", cornerRadius: 10 }, ...size(60) }), clips: 1 },
  { label: "square 70", overrides: tclip({ shape: { kind: "sq", cornerRadius: 10 }, ...size(70) }), clips: 2 },
  { label: "square 85", overrides: tclip({ shape: { kind: "sq", cornerRadius: 10 } }), clips: 3 },
  { label: "triangle 50", overrides: tclip({ shape: { kind: "tri", cornerRadius: 10 }, ...size(50) }), clips: 1 },
  { label: "triangle 85", overrides: tclip({ shape: { kind: "tri", cornerRadius: 10 } }), clips: 3 },
  { label: "round 85, heavy cable (still 3)", overrides: tclip({ wire: { length: 10000, diameter: 8, type: "flex" }, layers: { locked: true, value: 4 }, topCap: "on" }), clips: 3 },
];

/** A T-clip's stem, sliced through the board: its axis (the middle of its extent) and its outline round that axis, in (side, up). */
function tclipStemOf(clip: M, z: number, f: Frame) {
  const pts = clip.slice(z).toPolygons().flat();
  const ups = pts.map((p) => p[0] * f.up.x + p[1] * f.up.y);
  const sides = pts.map((p) => p[0] * f.side.x + p[1] * f.side.y);
  const axisUp = (Math.max(...ups) + Math.min(...ups)) / 2;
  const side = (Math.max(...sides) + Math.min(...sides)) / 2;
  return { axisUp, side, outline: pts.map((_, i) => [sides[i] - side, ups[i] - axisUp] as const) };
}

const maxZOf = (mesh: CoilMesh) => {
  let z = -Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) z = Math.max(z, mesh.positions[i]);
  return z;
};

/** How far below its slot's centre a stem with this outline rests: its lowest points on the slot's rounded bottom end. */
function tclipSeat(outline: ReadonlyArray<readonly [number, number]>, slotWidth: number, slotLength: number): number {
  const r = slotWidth / 2;
  const h = slotLength / 2 - r;
  return Math.min(...outline.map(([s, u]) => u + h + Math.sqrt(r * r - s * s)));
}

/** `m` turned by `deg` (counter-clockwise seen from the room, +z) about the vertical line through `axis`, then moved. */
function turned(m: M, axis: { x: number; y: number }, deg: number, f: Frame, dUp: number, dz: number): M {
  return m
    .translate([-axis.x, -axis.y, 0])
    .rotate([0, 0, deg])
    .translate([axis.x + dUp * f.up.x, axis.y + dUp * f.up.y, dz]);
}

describe("the SKÅDIS T-clips lock onto a real SKÅDIS board from inside the bore (issues #213, #221)", () => {
  it.each(TCLIP_CASES)("$label: $clips clip(s) on the lattice, seated clear of the board and the floor, stems on the slot bottoms, the coil on the fins, clamped", async ({ overrides, clips: count }) => {
    const wasm = await getWasm();
    const d = await design(baseSpec(overrides));
    const parts = clipsOf(d);
    expect(parts.length).toBe(count);
    const f = frameOf(d.mountAxisDeg!);
    const frontZ = d.pegboard!.frontZ;
    expect(frontZ, "the flange and the floor lie flat on the board").toBeCloseTo(-d.flangeSpec.thickness, 6);
    const core = manifoldOf(wasm, d.parts.find((p) => p.role === "core")!.mesh);
    expect(core.decompose().length, "the core with its floor is one solid").toBe(1);
    const clips = parts.map((p) => ({ part: p, m: manifoldOf(wasm, p.mesh) }));
    const stems = clips.map(({ m }) => tclipStemOf(m, frontZ - 2.5, f));
    const slotUp = (s: (typeof stems)[number], slotWidth = 5, slotLength = 15) => s.axisUp + tclipSeat(s.outline, slotWidth, slotLength);
    const origin = stems[0];
    for (const s of stems) {
      const a = (s.side - origin.side) / LATTICE;
      const b = (slotUp(s) - slotUp(origin)) / LATTICE;
      expect(Math.abs(a - Math.round(a)), "side offset on the 20 mm lattice").toBeLessThan(1e-3);
      expect(Math.abs(b - Math.round(b)), "up offset on the 20 mm lattice").toBeLessThan(1e-3);
      expect(Math.abs(Math.round(a) + Math.round(b)) % 2, "same one of the two interleaved grids").toBe(0);
      const u = slotUp(s);
      expect(d.pegboard!.slots.some((p) => Math.hypot(p.x - (u * f.up.x + s.side * f.side.x), p.y - (u * f.up.y + s.side * f.side.y)) < 1e-3), "a drawn slot round every clip").toBe(true);
    }
    // Where they go: 1 straight above the centre; 3 as 1 above the centre and 2 below it, side by side.
    if (count === 1) {
      expect(Math.abs(origin.side), "the one clip is straight above the centre").toBeLessThan(1e-3);
      expect(origin.axisUp, "the one clip is above the centre").toBeGreaterThan(0);
    }
    if (count === 3) {
      const [top, ...bottom] = [...stems].sort((p, q) => q.axisUp - p.axisUp);
      expect(Math.abs(top.side), "the top clip is straight above the centre").toBeLessThan(1e-3);
      for (const b of bottom) expect(b.axisUp, "the bottom clips are below the top one").toBeLessThan(top.axisUp - 1);
      expect(bottom[0].axisUp, "the bottom clips are level").toBeCloseTo(bottom[1].axisUp, 3);
      expect(bottom[0].side + bottom[1].side, "the bottom clips are either side of the centre").toBeCloseTo(0, 3);
    }
    const radius = Math.max(...stems.map((s) => Math.hypot(s.axisUp, s.side))) + 30;
    for (const { part, m } of clips) expect(overlap(m, core), `${part.name}: intersects the core`).toBeLessThan(1e-3);
    for (const board of BOARDS) {
      const slab = buildBoard(wasm, f, frontZ, { up: slotUp(origin, board.slotWidth, board.slotLength), side: origin.side }, board, radius);
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
      // The coil 0.3 mm lower rests on the fin (the recess's edge); pulled 0.2 mm off the board, the floor meets the fin (the clamp).
      expect(overlap(shifted(core, f, -0.3, 0, 0), m), `${part.name}: the floor doesn't rest on the fin`).toBeGreaterThan(1e-3);
      expect(overlap(shifted(core, f, 0, 0, 0.2), m), `${part.name}: the fin doesn't clamp the floor`).toBeGreaterThan(1e-3);
      m.delete();
    }
    core.delete();
  }, 120_000);

  it.each(TCLIP_CASES.slice(0, 5))("$label: twist lock -- in upright through the tightest slot, a quarter turn clockwise past the floor, the board and the other clips, stopped beyond it, then the drop", async ({ overrides }) => {
    const wasm = await getWasm();
    const d = await design(baseSpec(overrides));
    const f = frameOf(d.mountAxisDeg!);
    const frontZ = d.pegboard!.frontZ;
    const core = manifoldOf(wasm, d.parts.find((p) => p.role === "core")!.mesh);
    const capPart = d.parts.find((p) => p.role === "topCap");
    const cap = capPart && manifoldOf(wasm, capPart.mesh);
    const board = BOARDS[0];
    const clips = clipsOf(d).map((part) => {
      const m = manifoldOf(wasm, part.mesh);
      const stem = tclipStemOf(m, frontZ - 2.5, f);
      const axis = { x: stem.axisUp * f.up.x + stem.side * f.side.x, y: stem.axisUp * f.up.y + stem.side * f.side.y };
      return { part, m, stem, axis, rise: tclipSeat(stem.outline, board.slotWidth, board.slotLength) };
    });
    for (const [i, { part, m, stem, axis, rise }] of clips.entries()) {
      const slotUp = stem.axisUp + rise;
      const slab = buildBoard(wasm, f, frontZ, { up: slotUp, side: stem.side }, board, Math.hypot(slotUp, stem.side) + 10);
      // The clip goes in and turns at the slot's centre, the coil (and its cap) held up with it (they drop together once turned).
      const raisedCore = shifted(core, f, rise, 0, 0);
      const raisedCap = cap && shifted(cap, f, rise, 0, 0);
      // The other clips, already in: upright or turned, at their slots' centres.
      const others = clips.filter((_, j) => j !== i).flatMap((o) => [turned(o.m, o.axis, 0, f, o.rise, 0), turned(o.m, o.axis, 90, f, o.rise, 0)]);
      const clear = (pose: M, what: string) => {
        expect(overlap(pose, slab), `${part.name}: ${what} hits the board`).toBeLessThan(1e-3);
        expect(overlap(pose, raisedCore), `${part.name}: ${what} hits the core`).toBeLessThan(1e-3);
        if (raisedCap) expect(overlap(pose, raisedCap), `${part.name}: ${what} hits the cap`).toBeLessThan(1e-3);
        for (const o of others) expect(overlap(pose, o), `${part.name}: ${what} hits another clip`).toBeLessThan(1e-3);
        pose.delete();
      };
      // Upright (a quarter turn back, counter-clockwise from the room), pushed in from the room side.
      for (const dz of [16, 12, 8, 4, 2, 0]) clear(turned(m, axis, 90, f, rise, dz), `going in upright (dz=${dz})`);
      // Turned clockwise, upright to across, at the slot's centre.
      for (const deg of [75, 60, 45, 30, 15, 0]) clear(turned(m, axis, deg, f, rise, 0), `turning (${deg} deg to go)`);
      // Let go: clip and coil drop together onto the slot's bottom, the T bar sliding down behind the board.
      for (const k of [0.75, 0.5, 0.25]) expect(overlap(turned(m, axis, 0, f, rise * k, 0), slab), `${part.name}: dropping hits the board`).toBeLessThan(1e-3);
      // The recess stops the fin past a quarter turn, and past upright.
      const over = turned(m, axis, -15, f, rise, 0);
      expect(overlap(over, raisedCore), `${part.name}: turns past a quarter turn`).toBeGreaterThan(1e-3);
      over.delete();
      const back = turned(m, axis, 105, f, rise, 0);
      expect(overlap(back, raisedCore), `${part.name}: turns back past upright`).toBeGreaterThan(1e-3);
      back.delete();
      for (const o of others) o.delete();
      raisedCore.delete();
      raisedCap?.delete();
      // Turned back upright while dropped, it can't be pulled out: the T bar is below the slot's full width.
      const stuck = turned(m, axis, 90, f, 0, 3);
      expect(overlap(stuck, slab), `${part.name}: comes out without being lifted`).toBeGreaterThan(1e-3);
      stuck.delete();
      slab.delete();
    }
    for (const { m } of clips) m.delete();
    cap?.delete();
    core.delete();
  }, 240_000);

  it.each(TCLIP_CASES)("$label: a fingertip or pliers reach each fin's top straight down, and the fin is 12 mm tall unless the room is lower", async ({ overrides }) => {
    const wasm = await getWasm();
    const d = await design(baseSpec(overrides));
    const f = frameOf(d.mountAxisDeg!);
    const frontZ = d.pegboard!.frontZ;
    const top = Math.max(...d.parts.filter((p) => p.role === "core" || p.role === "topCap").map((p) => maxZOf(p.mesh)));
    const solids = d.parts.filter((p) => p.role === "core" || p.role === "topCap").map((p) => manifoldOf(wasm, p.mesh));
    for (const part of clipsOf(d)) {
      const m = manifoldOf(wasm, part.mesh);
      const stem = tclipStemOf(m, frontZ - 2.5, f);
      const finTop = maxZOf(part.mesh);
      // A fingertip, 15 mm across, comes straight down onto the fin's top round its axis.
      const column = wasm.Manifold.cylinder(top + 10 - finTop, 7.5, 7.5, 64).translate([stem.axisUp * f.up.x + stem.side * f.side.x, stem.axisUp * f.up.y + stem.side * f.side.y, finTop + 0.5]);
      for (const solid of solids) expect(overlap(column, solid), `${part.name}: the core or the cap is in the way of the fin's top`).toBeLessThan(1e-3);
      const ring = d.faceChannels;
      const coreTop = Math.max(...d.parts.filter((p) => p.role === "core").map((p) => maxZOf(p.mesh)));
      const ceiling = ring?.topThickness !== undefined ? ring.height - ring.topThickness - ring.funnelDepth : coreTop - (d.solution.topCapEnabled ? JOINT_ENGAGE_DEPTH : 0);
      const room = ceiling - SKADIS_TCLIP_FIN_TOP_GAP;
      const expected = Math.max(SKADIS_TCLIP_HANDLE_THICKNESS - SKADIS_TCLIP_RECESS_DEPTH, Math.min(SKADIS_TCLIP_FIN_HEIGHT, room));
      expect(finTop, `${part.name}: the fin's top is the room's height, at most 12 mm`).toBeCloseTo(expected, 3);
      if (ring?.topThickness !== undefined) expect(finTop, `${part.name}: the fin's top is under the ring's funnel`).toBeLessThanOrEqual(ring.height - ring.topThickness - ring.funnelDepth);
      column.delete();
      m.delete();
    }
    for (const s of solids) s.delete();
  }, 120_000);

  const TALL_FIN_CASES: Array<{ label: string; overrides: Partial<CoilSpec> }> = [
    { label: "round 85, no cap", overrides: tclip({ topCap: "off", height: { locked: true, value: 60 }, layers: { locked: false } }) },
    { label: "round 120, no cap", overrides: tclip({ topCap: "off", height: { locked: true, value: 60 }, layers: { locked: false }, ...size(120) }) },
    { label: "pill, no cap", overrides: tclip({ topCap: "off", shape: { kind: "pill", cornerRadius: 15 }, height: { locked: true, value: 40 }, layers: { locked: false }, ...size(120) }) },
    { label: "round 40, deep and narrow", overrides: tclip({ topCap: "off", height: { locked: true, value: 70 }, layers: { locked: false }, ...size(40) }) },
    { label: "round 85, deep, with a cap", overrides: tclip({ topCap: "on", height: { locked: true, value: 70 }, layers: { locked: false } }) },
  ];

  it.each(TALL_FIN_CASES)("$label: the fins stand 12 mm above the floor's top, on a core taller than that, with no long-reach note", async ({ overrides }) => {
    const d = await design(baseSpec(overrides));
    const coreTop = Math.max(...d.parts.filter((p) => p.role === "core").map((p) => maxZOf(p.mesh)));
    expect(coreTop, "the core is taller than a fin").toBeGreaterThan(SKADIS_TCLIP_FIN_HEIGHT + SKADIS_TCLIP_FIN_TOP_GAP + JOINT_ENGAGE_DEPTH);
    const clips = clipsOf(d);
    expect(clips.length).toBeGreaterThan(0);
    for (const part of clips) expect(maxZOf(part.mesh), `${part.name}: the fin's top`).toBeCloseTo(SKADIS_TCLIP_FIN_HEIGHT, 3);
    expect(d.notices.some((n) => /fins sit|long reach/.test(n.message))).toBe(false);
  }, 120_000);

  const FLAT_BLADE_ALLOWANCE = 0.3; // mm, past the notch's wall, where a probe must hit the prong
  const MIN_PRONG_WIDTH = 3; // mm, so a prong stays stout enough to take a turning blade
  const FLAT_FACE_HALF = 1.4; // mm, half the fin's thickness inside the faces' 0.6 mm chamfers

  /** The share of a box, in the clip's mounted pose, that is clip material: `at` is its offset along the fin from the axis, `half` and `thick` its half extents along and through the fin. */
  function finFill(wasm: Wasm, clip: M, f: Frame, axis: { axisUp: number; side: number }, box: { at: number; half: number; thick: number; z0: number; z1: number }): number {
    const cube = wasm.Manifold.cube([2 * box.half, 2 * box.thick, box.z1 - box.z0], true)
      .translate([0, 0, (box.z0 + box.z1) / 2])
      .rotate([0, 0, -(Math.atan2(f.up.x, f.up.y) * 180) / Math.PI])
      .translate([(axis.side + box.at) * f.side.x + axis.axisUp * f.up.x, (axis.side + box.at) * f.side.y + axis.axisUp * f.up.y, 0]);
    const filled = overlap(clip, cube) / cube.volume();
    cube.delete();
    return filled;
  }

  const NOTCH_CASES = [
    ...TCLIP_CASES,
    { label: "thin core under a cap (fin at its 3 mm minimum)", overrides: tclip({ wire: { length: 300, diameter: 2, type: "usb" }, topCap: "on" }), clips: 3 },
  ];

  it.each(NOTCH_CASES)("$label: every fin has a 1.2 mm wide, 3 mm deep notch across its top through its full thickness, and stays full width below it", async ({ overrides }) => {
    const wasm = await getWasm();
    const d = await design(baseSpec(overrides));
    const f = frameOf(d.mountAxisDeg!);
    const frontZ = d.pegboard!.frontZ;
    for (const part of clipsOf(d)) {
      const m = manifoldOf(wasm, part.mesh);
      const axis = tclipStemOf(m, frontZ - 2.5, f);
      const finTop = maxZOf(part.mesh);
      const depth = Math.min(SKADIS_TCLIP_NOTCH_DEPTH, finTop - SKADIS_TCLIP_NOTCH_FLOOR);
      const wallHalf = SKADIS_TCLIP_NOTCH_WIDTH / 2;
      const through = SKADIS_TCLIP_WIDTH / 2 + 0.2;
      const floorZ = finTop - depth;
      const fill = (at: number, half: number, thick: number, z0: number, z1: number) => finFill(wasm, m, f, axis, { at, half, thick, z0, z1 });
      const inNotch = wallHalf - 0.05;
      expect(fill(0, inNotch, through, floorZ + 0.05, finTop + 1), `${part.name}: nothing in the notch, through the full thickness`).toBeLessThan(1e-3);
      expect(fill(0, inNotch, FLAT_FACE_HALF, floorZ - 0.4, floorZ - 0.05), `${part.name}: the notch's floor is ${depth} mm below the fin's top`).toBeCloseTo(1, 3);
      for (const sign of [1, -1]) {
        const wallZ = finTop - depth / 2;
        expect(fill(sign * (wallHalf + FLAT_BLADE_ALLOWANCE), 0.05, FLAT_FACE_HALF, wallZ - 0.1, wallZ + 0.1), `${part.name}: a prong stands ${FLAT_BLADE_ALLOWANCE} mm past the wall on side ${sign}`).toBeCloseTo(1, 3);
      }
      for (const sign of [1, -1]) {
        const leadIn = SKADIS_TCLIP_NOTCH_LEAD;
        expect(fill(sign * (wallHalf + leadIn + MIN_PRONG_WIDTH / 2), MIN_PRONG_WIDTH / 2, FLAT_FACE_HALF, finTop - 0.2, finTop - 0.1), `${part.name}: the prong on side ${sign} keeps ${MIN_PRONG_WIDTH} mm of flat top past its lead-in chamfer`).toBeCloseTo(1, 3);
      }
      const lowZ = SKADIS_TCLIP_NOTCH_FLOOR - 0.2;
      expect(fill(0, inNotch, FLAT_FACE_HALF, lowZ - 0.1, lowZ + 0.1), `${part.name}: full width 2 mm above the floor's top`).toBeCloseTo(1, 3);
      m.delete();
    }
  }, 240_000);

  it("a bore with room for fewer than 3 clips says how the coil hangs; one with none leaves them out and suggests the rim clips", async () => {
    const two = await design(baseSpec(tclip(size(75))));
    expect(two.notices.some((n) => n.severity === "note" && /room for 2 SKÅDIS T-clips/.test(n.message))).toBe(true);
    const one = await design(baseSpec(tclip(size(40))));
    expect(one.notices.some((n) => n.severity === "note" && /room for 1 SKÅDIS T-clip.*lift the coil/.test(n.message))).toBe(true);
    const three = await design(baseSpec(tclip({})));
    expect(three.notices.some((n) => /room for [12] SKÅDIS/.test(n.message))).toBe(false);
    const none = await design(baseSpec(tclip({ wire: { length: 1000, diameter: 2, type: "usb" }, topCap: "on", ...size(20) })));
    expect(clipsOf(none)).toHaveLength(0);
    expect(none.notices.some((n) => n.severity === "problem" && /too small for SKÅDIS T-clips.*rim clips/.test(n.message))).toBe(true);
    expect(none.notices.some((n) => /floor is thick enough/.test(n.message)), "no floor note without clips").toBe(false);
  }, 120_000);

  it("the T-clips print without supports: one solid each, lying on the flat face, no overhang steeper than 45 degrees", async () => {
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
        let bed = 0;
        for (let t = 0; t < indices.length; t += 3) {
          const p = [0, 1, 2].map((k) => [positions[3 * indices[t + k]], positions[3 * indices[t + k] + 1], positions[3 * indices[t + k] + 2]]);
          const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
          const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
          const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const len = Math.hypot(n[0], n[1], n[2]);
          if (len < 1e-9) continue;
          const nz = n[2] / len;
          const onBed = nz < -1 + 1e-4 && Math.max(...p.map((q) => q[2])) < minZ + 1e-4;
          if (onBed) bed += len / 2;
          expect(onBed || nz >= -Math.SQRT1_2 - 1e-4, `${c.label}, ${part.name}: an overhang steeper than 45 degrees (nz=${nz.toFixed(4)})`).toBe(true);
        }
        expect(bed, `${c.label}, ${part.name}: a real face on the bed`).toBeGreaterThan(50);
      }
    }
  }, 120_000);
});
