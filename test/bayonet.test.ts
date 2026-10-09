import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilMesh, CoilSpec, Design, ShapeSpec } from "../src/core";
import { BAYONET_LUG_COUNT } from "../src/core/constants";
import { applyRigidTransform } from "../src/core/transform";

// Issue #167: the bayonet (twist lock) top cap, through design() only. The
// core's lugs must line up with the collar's entry slots when the cap is
// turned to its entry angle, slide up them as it drops on, turn clockwise
// into the lock, and then hold: no lift, no turning past the stop. Round cores only; anything else
// falls back to the press-fit collar with a warning.

function spec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 6000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 60 },
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "on",
    base: "on",
    joint: "bayonet",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

/** The cap turns this far, clockwise seen from above, from its entry angle into the lock. */
const TWIST_DEG = 180 / BAYONET_LUG_COUNT;
/** Interference below this (mm^3) is tessellation noise, not a collision. */
const NOISE = 0.5;

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

type Manifold = InstanceType<ManifoldToplevel["Manifold"]>;
const toManifold = (mesh: CoilMesh): Manifold => new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));

/** Volume (mm^3) the cap shares with the core after turning it `rotateDeg` (counter-clockwise from above) about the axis and lifting it `lift` mm off its seat. */
function overlap(core: Manifold, cap: Manifold, rotateDeg: number, lift: number): number {
  const moved = cap.rotate([0, 0, rotateDeg]).translate([0, 0, lift]);
  const both = moved.intersect(core);
  const v = both.volume();
  both.delete();
  moved.delete();
  return v;
}

/** Where a ray from the axis, at height z and angle aDeg, crosses the part's surface: sorted distances from the axis. */
function rayHits(mesh: CoilMesh, z: number, aDeg: number): number[] {
  const m = toManifold(mesh);
  const polys = m.slice(z).toPolygons();
  m.delete();
  const dx = Math.cos((aDeg * Math.PI) / 180);
  const dy = Math.sin((aDeg * Math.PI) / 180);
  const hits: number[] = [];
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const den = dx * (by - ay) - dy * (bx - ax);
      if (Math.abs(den) < 1e-12) continue;
      const t = (ax * (by - ay) - ay * (bx - ax)) / den;
      const u = (ax * dy - ay * dx) / den;
      if (t > 0 && u >= 0 && u <= 1) hits.push(t);
    }
  return hits.sort((a, b) => a - b);
}

function partsOf(d: Design): { core: Manifold; cap: Manifold } {
  return { core: toManifold(d.parts.find((p) => p.role === "core")!.mesh), cap: toManifold(d.parts.find((p) => p.role === "topCap")!.mesh) };
}

const ROUND_CASES: Array<{ label: string; overrides: Partial<CoilSpec> }> = [
  { label: "60 mm core, 2 layers", overrides: {} },
  { label: "the issue's repro (everything free)", overrides: { coreSize: { locked: false }, height: { locked: false }, layers: { locked: false }, wire: { length: 2000, diameter: 3.8, type: "usb" }, topCap: "on" } },
  { label: "tight tolerance 0.05", overrides: { tolerance: 0.05 } },
  { label: "loose tolerance 0.4", overrides: { tolerance: 0.4 } },
  { label: "loosest tolerance 0.8", overrides: { tolerance: 0.8 } },
  { label: "small 24 mm core", overrides: { coreSize: { locked: true, dimension: "outer", value: 24 }, height: { locked: true, value: 40 }, wire: { length: 3000, diameter: 3.8, type: "usb" } } },
];

describe("bayonet on a round core (issue #167)", () => {
  it.each(ROUND_CASES)("$label: each part is one solid, and the cap twists on and locks", async ({ overrides }) => {
    const d = await design(spec(overrides));
    expect(d.parts.map((p) => p.role)).toEqual(["core", "topCap"]);
    expect(d.warnings.join("\n")).not.toMatch(/too small for the twist lock|needs a round core/i);
    const { core, cap } = partsOf(d);
    try {
      for (const [name, m] of [["core", core], ["top-cap", cap]] as const) {
        expect(m.status(), name).toBe("NoError");
        expect(m.decompose().length, `${name}: one connected solid`).toBe(1);
      }
      expect(core.genus(), "the lugs only add to the bore").toBe(1);

      // Locked (as designed and drawn): seated with no interference ...
      expect(overlap(core, cap, 0, 0)).toBeLessThan(NOISE);
      // ... it holds: lifting it, or turning it on past the stop, collides
      // (once the clearance -- more at a looser tolerance -- is taken up).
      expect(overlap(core, cap, 0, 3)).toBeGreaterThan(1);
      expect(overlap(core, cap, -10, 0)).toBeGreaterThan(NOISE);

      // Entry: turned TWIST_DEG counter-clockwise, the slots sit over the
      // lugs, so the cap lifts straight out (= drops straight in) ...
      for (let lift = 0; lift <= 9; lift += 0.5) expect(overlap(core, cap, TWIST_DEG, lift), `entry angle, lifted ${lift} mm`).toBeLessThan(NOISE);
      // ... and seated, it turns all the way from entry to lock.
      for (let a = TWIST_DEG; a >= 0; a -= 5) expect(overlap(core, cap, a, 0), `seated, turned ${a} deg`).toBeLessThan(NOISE);
      // Half way round the lugs are under the rim, so it can't come out there.
      expect(overlap(core, cap, TWIST_DEG / 2, 3)).toBeGreaterThan(1);
    } finally {
      core.delete();
      cap.delete();
    }
  });

  it("the lugs and the L-slots are really there, at the lock and entry angles", async () => {
    const [bay, press] = await Promise.all([design(spec()), design(spec({ joint: "press" }))]);
    const h = bay.solution.height;
    const rIn = bay.wallSpec.boreOutline.apothem;
    const bore = (d: Design, z: number, a: number) => rayHits(d.parts[0].mesh, z, a)[0];
    const collar = (d: Design, z: number, a: number) => Math.max(...rayHits(d.parts[1].mesh, z, a).filter((r) => r < rIn));
    for (let k = 0; k < BAYONET_LUG_COUNT; k++) {
      const lug = (360 * k) / BAYONET_LUG_COUNT;
      // The core: a lug stands in the bore just under the rim; between lugs the bore is untouched.
      expect(bore(press, h - 2, lug) - bore(bay, h - 2, lug), `lug ${k}`).toBeGreaterThan(1.5);
      expect(Math.abs(bore(bay, h - 2, lug + TWIST_DEG) - bore(press, h - 2, lug + TWIST_DEG)), `between lugs ${k}`).toBeLessThan(0.05);
      // The cap's collar, near its tip: the entry slot is TWIST_DEG clockwise of the lug's locked angle, nothing at the lug itself.
      expect(collar(bay, h - 6, lug) - collar(bay, h - 6, lug - TWIST_DEG), `entry slot ${k}`).toBeGreaterThan(1);
      // ... and at the lug's height the groove runs from that slot to the lug, with plain collar after its stop.
      for (const a of [lug, lug - TWIST_DEG / 2, lug - TWIST_DEG]) expect(collar(bay, h - 1.5, lug + 30) - collar(bay, h - 1.5, a), `groove ${k} at ${a} deg`).toBeGreaterThan(1);
      expect(Math.abs(collar(bay, h - 6, lug) - collar(bay, h - 1.5, lug + 30)), `collar past the stop ${k}`).toBeLessThan(0.05);
    }
    // Press fit has none of it.
    expect(Math.abs(collar(press, h - 6, 0) - collar(press, h - 6, -TWIST_DEG))).toBeLessThan(0.05);
  });

  it("nothing under the cap catches the wound cable through the whole twist", async () => {
    // A round coil turns into itself: if every bit of the cap below its
    // plate that isn't the collar or a lug stays outside the wound cable's
    // envelope radius, it stays outside at every angle of the twist. Issue
    // #241: the cap's clips are gone, so nothing hangs there at all.
    for (const overrides of ROUND_CASES.map((c) => c.overrides)) {
      const d = await design(spec(overrides));
      const h = d.solution.height;
      const envelope = d.solution.envelopeDiameter / 2;
      const p = d.parts[1].mesh.positions;
      let nearest = Infinity;
      for (let i = 0; i < p.length; i += 3) {
        if (p[i + 2] > h - 0.01) continue; // the plate itself
        const r = Math.hypot(p[i], p[i + 1]);
        if (r < d.wallSpec.outline.apothem) continue; // the collar, inside the core
        nearest = Math.min(nearest, r);
      }
      expect(nearest, "nothing under the cap outside the bore").toBe(Infinity);
      expect(nearest).toBeGreaterThanOrEqual(envelope);
    }
  });

  it("adds no overhang steeper than 45 degrees to either part in its print orientation", async () => {
    // Downward-facing area steeper than 45 degrees, off the bed, in print
    // orientation. The bayonet's lugs and L-slots have only flat-up, 45
    // degree or vertical faces, so it must match press fit's own.
    const steep = (d: Design, role: "core" | "topCap") => {
      const part = d.parts.find((q) => q.role === role)!;
      const { positions: v, indices: t } = applyRigidTransform(part.mesh, part.printTransform);
      let minZ = Infinity;
      for (let i = 2; i < v.length; i += 3) minZ = Math.min(minZ, v[i]);
      let area = 0;
      for (let i = 0; i < t.length; i += 3) {
        const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
        if (Math.min(v[a + 2], v[b + 2], v[c + 2]) < minZ + 0.05) continue;
        const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
        const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0 && nz / len < -Math.SQRT1_2 - 0.02) area += len / 2;
      }
      return area;
    };
    const [bay, press] = await Promise.all([design(spec()), design(spec({ joint: "press" }))]);
    for (const role of ["core", "topCap"] as const) expect(steep(bay, role), role).toBeLessThan(steep(press, role) + 2);
  });
});

describe("bayonet falls back to the press-fit collar (issue #167)", () => {
  const volumes = (d: Design) => d.parts.map((p) => toManifold(p.mesh)).map((m) => [m.volume(), m.delete()][0] as number);

  it.each<{ label: string; overrides: Partial<CoilSpec>; warning: RegExp }>([
    { label: "square core", overrides: { shape: { kind: "sq", cornerRadius: 15 } as ShapeSpec }, warning: /needs a round core/ },
    { label: "triangle core", overrides: { shape: { kind: "tri", cornerRadius: 12 } as ShapeSpec, coreSize: { locked: true, dimension: "outer", value: 113 } }, warning: /needs a round core/ },
    { label: "tiny round core", overrides: { wire: { length: 500, diameter: 1.2, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 8 }, height: { locked: true, value: 20 } }, warning: /too small/ },
  ])("$label: builds exactly the press-fit parts, warns, and keeps joint=bayonet in the spec", async ({ overrides, warning }) => {
    const [bay, press] = await Promise.all([design(spec(overrides)), design(spec({ ...overrides, joint: "press" }))]);
    expect(bay.spec.joint).toBe("bayonet");
    expect(bay.warnings.join("\n")).toMatch(warning);
    expect(press.warnings.join("\n")).not.toMatch(/twist lock/i);
    expect(volumes(bay)).toEqual(volumes(press));
  });

  it("says nothing about the twist lock when there is no top cap", async () => {
    const d = await design(spec({ shape: { kind: "sq", cornerRadius: 15 }, topCap: "off" }));
    expect(d.warnings.join("\n")).not.toMatch(/twist lock/i);
  });
});

// Issue #201: a flip across a quad that was a hair reflex left an inverted
// triangle, and at a few core sizes that cut the cap into two or three pieces.
// The sizes are the ones found by sweeping 28.3 to 29.5 mm in 0.01 mm steps
// (on 3000 mm of 3.8 mm cable, 40 mm high); the sweep around them checks that
// it was not just those three.
describe("every part of a round bayonet design is one solid at any core size (issue #201)", () => {
  const sizes = [28.31, 28.37, 28.88];
  for (let size = 26; size <= 34; size += 0.25) sizes.push(size);

  it.each(sizes)("outer size %f mm", async (size) => {
    const d = await design(
      spec({ coreSize: { locked: true, dimension: "outer", value: size }, height: { locked: true, value: 40 }, wire: { length: 3000, diameter: 3.8, type: "usb" } }),
    );
    for (const part of d.parts) {
      const m = toManifold(part.mesh);
      try {
        expect(m.status(), part.role).toBe("NoError");
        const pieces = m.decompose();
        expect(pieces.length, `${part.role}: one connected solid`).toBe(1);
        pieces.forEach((p) => p.delete());
      } finally {
        m.delete();
      }
    }
  });
});
