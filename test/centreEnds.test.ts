import Module from "manifold-3d";
import type { Manifold, ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SPEC, design } from "../src/core";
import { CENTRE_CONNECTOR_PASSAGE, CENTRE_GRIP_LENGTH } from "../src/core/constants";
import type { CoilMesh, CoilSpec, Design } from "../src/core";
import { pointAt } from "../src/core/shapes";
import type { ShapeSpec } from "../src/core";

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function solid(mesh: CoilMesh): Manifold {
  return new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
}

function inAir(m: Manifold, x: number, y: number, z: number): boolean {
  const probe = wasm.Manifold.cube([0.4, 0.4, 0.4], true).translate([x, y, z]);
  const volume = m.intersect(probe).volume();
  probe.delete();
  return volume < 1e-6;
}

function spec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return { ...DEFAULT_SPEC, topCap: "off", ...overrides };
}

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }];
const MBR_MULTIPLIER = { usb: 2.6, flex: 2.6, stiff: 6.5 } as const;

function polygonAround(design: Design): { x: number; y: number }[] {
  const bore = design.wallSpec.boreOutline;
  return Array.from({ length: 720 }, (_, i) => {
    const p = pointAt(bore, i / 720, 0);
    return { x: p.x, y: p.y };
  });
}

function distanceToPolygon(p: { x: number; y: number }, poly: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

function inside(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let odd = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (poly[i].y > p.y !== poly[j].y > p.y && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) odd = !odd;
  }
  return odd;
}

function freeCircleDiameter(d: Design): number {
  const bore = polygonAround(d);
  const rib = d.centreInnerEnd.rib;
  let best = 0;
  for (let x = -40; x <= 40; x += 0.25) {
    for (let y = -40; y <= 40; y += 0.25) {
      const p = { x, y };
      if (!inside(p, bore)) continue;
      const free = inside(p, rib) ? 0 : Math.min(distanceToPolygon(p, bore), distanceToPolygon(p, rib));
      best = Math.max(best, free);
    }
  }
  return 2 * best;
}

describe("a centre-held inner end (issue #254, part 2)", () => {
  it("is the default: a bare core, one solid, the cable's inner end drawn from the top of the bore", async () => {
    expect(DEFAULT_SPEC.base).toBe("off");
    const d = await design(DEFAULT_SPEC);
    expect(d.parts.map((p) => p.name)).toEqual(["core"]);
    const m = solid(d.mesh);
    expect(m.decompose().length).toBe(1);
    expect(m.genus()).toBe(1);
    expect(d.centreInnerEnd.feasible).toBe(true);
    const lead = d.innerEndLeadIn;
    expect(lead.length).toBeGreaterThan(30);
    expect(lead[2]).toBeGreaterThan(d.solution.height);
  });

  it.each(SHAPES)("is one solid with the base on or off, cap on or off, for $kind", async (shape) => {
    for (const base of ["off", "on"] as const) {
      for (const topCap of ["off", "on"] as const) {
        const d = await design(spec({ shape, base, topCap, layers: { locked: true, value: 2 } }));
        for (const part of d.parts) {
          const pieces = solid(part.mesh).decompose();
          expect(pieces.length, `${shape.kind} base ${base} cap ${topCap} ${part.name}`).toBe(1);
        }
      }
    }
  });

  it.each(SHAPES)("leaves the cable's whole in-core path in air: down the bore, across the open bottom, out under the wall, for $kind", async (shape) => {
    const d = await design(spec({ shape }));
    const m = solid(d.mesh);
    const path = d.centreInnerEnd.path;
    const ends = d.wirePaths[0].points;
    const groove = { x: ends[0], y: ends[1] };
    let checked = 0;
    for (let i = 0; i < path.length - 3; i += 2) {
      const p = path[i];
      if (p.z > d.solution.height) continue;
      expect(inAir(m, p.x, p.y, p.z), `path point ${i} at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
    const last = path[path.length - 1];
    expect(last.x).toBeCloseTo(groove.x, 3);
    expect(last.y).toBeCloseTo(groove.y, 3);
  });

  it.each(SHAPES)("runs low on the bed under the core with room for the cable: the channel there is at least d + tolerance tall, for $kind", async (shape) => {
    const d = await design(spec({ shape }));
    const m = solid(d.mesh);
    const { diameter } = d.spec.wire;
    const needed = diameter + d.spec.tolerance;
    const low = d.centreInnerEnd.path.filter((p) => p.z < needed / 2 + 0.6 && p.z > needed / 2 - 0.05);
    expect(low.length).toBeGreaterThan(8);
    for (const p of low) {
      for (let z = 0.15; z < needed - 0.15; z += 0.5) expect(inAir(m, p.x, p.y, z), `column at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${z.toFixed(1)}`).toBe(true);
    }
  });

  it("holds the cable in a keyhole: the neck is narrower than the cable, the seat wider", async () => {
    for (const diameter of [2, 3, 3.8, 6, 8]) {
      const d = await design(spec({ wire: { length: 2000, diameter, type: "usb" } }));
      const end = d.centreInnerEnd;
      expect(end.neckWidth).toBeLessThan(diameter);
      expect(end.neckWidth).toBeGreaterThan(0.9 * diameter);
      expect(2 * end.seatRadius).toBeGreaterThan(diameter);
    }
  });

  it("holds the cable straight up and down for at least the grip length", async () => {
    const d = await design(spec());
    const { seat, path } = d.centreInnerEnd;
    const vertical = path.filter((p) => Math.hypot(p.x - seat.x, p.y - seat.y) < 1e-6);
    const span = Math.max(...vertical.map((p) => p.z)) - Math.min(...vertical.map((p) => p.z));
    const top = d.solution.height;
    expect(Math.min(...vertical.map((p) => p.z))).toBeLessThanOrEqual(top - CENTRE_GRIP_LENGTH);
    expect(span).toBeGreaterThanOrEqual(CENTRE_GRIP_LENGTH);
  });

  it.each([
    { type: "usb" as const, diameter: 3 },
    { type: "usb" as const, diameter: 3.8 },
    { type: "usb" as const, diameter: 6 },
    { type: "stiff" as const, diameter: 3 },
  ])("keeps a free circle in the bore of a $type $diameter mm cable at least 22.4 mm across with the rib in it", async ({ type, diameter }) => {
    for (const shape of SHAPES) {
      const d = await design(spec({ shape, wire: { length: 2000, diameter, type } }));
      expect(freeCircleDiameter(d), `${shape.kind} ${type} ${diameter}`).toBeGreaterThanOrEqual(CENTRE_CONNECTOR_PASSAGE - 0.3);
    }
  });

  it("puts the rib on a flat of a square or triangle bore", async () => {
    for (const shape of SHAPES.slice(1)) {
      const d = await design(spec({ shape, coreSize: { locked: true, dimension: "outer", value: 60 } }));
      expect(d.centreInnerEnd.ribOnFlat, shape.kind).toBe(true);
    }
  });

  it("counts the cable the core holds exactly: wound length plus the inner end's own length", async () => {
    for (const shape of SHAPES) {
      for (const base of ["off", "on"] as const) {
        const d = await design(spec({ shape, base, layers: { locked: true, value: 2 } }));
        const s = d.solution;
        expect(s.totalWireLength - s.totalWoundLength, `${shape.kind} base ${base}`).toBeCloseTo(d.centreInnerEnd.length, 6);
        expect(s.totalWireLength).toBeGreaterThanOrEqual(s.targetWireLength);
      }
    }
  });

  it("draws the cable at the length the solver counted", async () => {
    const d = await design(spec());
    const path = d.centreInnerEnd.path;
    let drawn = 0;
    for (let i = 1; i < path.length; i++) {
      if (path[i - 1].z < d.solution.height) drawn += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z);
    }
    expect(drawn).toBeGreaterThan(0.97 * d.centreInnerEnd.length);
    expect(drawn).toBeLessThan(1.03 * d.centreInnerEnd.length);
  });

  it("never reports ok when the locked size and height hold less cable than the target", async () => {
    const short = await design(spec({ coreSize: { locked: true, dimension: "outer", value: 36 }, height: { locked: true, value: 45 }, layers: { locked: true, value: 1 }, wire: { length: 6000, diameter: 3.8, type: "usb" } }));
    expect(short.solution.totalWireLength).toBeLessThan(6000);
    expect(short.solution.diagnosis.status).not.toBe("ok");
    const roomy = await design(spec({ coreSize: { locked: true, dimension: "outer", value: 36 }, height: { locked: true, value: 45 }, layers: { locked: true, value: 1 }, wire: { length: 1000, diameter: 3.8, type: "usb" } }));
    expect(roomy.solution.totalWireLength).toBeGreaterThanOrEqual(1000);
    expect(roomy.solution.diagnosis.status).toBe("ok");
  });

  it("grows the core to let the inner end through, whatever the cable's bend radius", async () => {
    for (const type of Object.keys(MBR_MULTIPLIER) as (keyof typeof MBR_MULTIPLIER)[]) {
      for (const diameter of [2, 3.8, 6]) {
        const d = await design(spec({ coreSize: { locked: true, dimension: "outer", value: 20 }, wire: { length: 1500, diameter, type } }));
        expect(d.centreInnerEnd.feasible, `${type} ${diameter}`).toBe(true);
        expect(d.solution.innerBore - 0).toBeGreaterThan(CENTRE_CONNECTOR_PASSAGE);
      }
    }
  });
});
