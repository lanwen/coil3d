import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilMesh, CoilSpec, Design, ShapeSpec } from "../src/core";
import { CAP_THICKNESS, MOUNT_PLATE_THICKNESS, RIM_SLOT_LABEL_KEEP_OUT, SCREW_MOUNT_HEAD_RADIUS, STRAP_NOTCH_KEEP_OUT, STRAP_NOTCH_WIDTH, THROUGH_MOUNT_EDGE_MARGIN } from "../src/core/constants";
import { layoutFlangeThroughHoles } from "../src/core/flangePads";
import { layoutInnerEnd, resolveChannelDepth } from "../src/core/innerEnd";
import type { XY } from "../src/core/innerEnd";
import { getLabelFont, labelLoops, resolveLabel } from "../src/core/label";
import { layoutKeyholeMount } from "../src/core/mount";
import { pegHoleRadius } from "../src/core/mountPlate";
import { skadisClipFootprints } from "../src/core/skadisClips";
import { outlineOffsetAt } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";
import { rayHits } from "./support/rays";
import { unsupportedOverhangs } from "./support/overhangs";

// Issue #240: with strapSlots on, the base and the cap each get two open
// notches cut into the rim, down to the wound cable's outer surface, so a
// velcro tie can run round the coil. The layout is one pair of notches shared
// by every plate; these tests check the pair on the real designs and meshes.

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2500, diameter: 3, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 50 },
    height: { locked: false },
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "on",
    base: "on",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
    strapSlots: true,
    ...overrides,
  };
}

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 12 }, { kind: "tri", cornerRadius: 12 }];
const PLATES = [
  { name: "base only", base: "on" as const, topCap: "off" as const },
  { name: "cap only", base: "off" as const, topCap: "on" as const },
  { name: "base and cap", base: "on" as const, topCap: "on" as const },
];

function pieces(mesh: CoilMesh): number {
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  const n = m.decompose().length;
  m.delete();
  return n;
}

const inPlateSamples = (d: Design, outline: XY[]): XY[] =>
  outline
    .flatMap((a, i) => {
      const b = outline[(i + 1) % outline.length];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.25));
      return Array.from({ length: n }, (_, k) => ({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }));
    })
    .filter((p) => outlineOffsetAt(d.flangeSpec.outline, p.x, p.y).offset <= d.flangeSpec.margin);

function distanceToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function insidePolygon(p: XY, poly: XY[]): boolean {
  let odd = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]];
    if (a.y > p.y !== b.y > p.y && p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)) odd = !odd;
  }
  return odd;
}

function distanceToPolygon(p: XY, poly: XY[]): number {
  if (insidePolygon(p, poly)) return 0;
  return Math.min(...poly.map((a, i) => distanceToSegment(p, a, poly[(i + 1) % poly.length])));
}

function nearest(d: Design, notch: XY[], poly: XY[]): number {
  return Math.min(...inPlateSamples(d, notch).map((p) => distanceToPolygon(p, poly)));
}

function nearestPoint(d: Design, notch: XY[], target: XY): number {
  return Math.min(...inPlateSamples(d, notch).map((p) => Math.hypot(p.x - target.x, p.y - target.y)));
}

function insideMesh(mesh: CoilMesh, x: number, y: number, z: number): boolean {
  const below = -1000;
  return rayHits(mesh, [x, y, below], [0, 0, 1]).filter((h) => below + h < z).length % 2 === 1;
}

function drawnReach(d: Design): number {
  const r = d.spec.wire.diameter / 2;
  let best = 0;
  const scan = (points: ArrayLike<number>) => {
    for (let i = 0; i < points.length; i += 3) best = Math.max(best, outlineOffsetAt(d.flangeSpec.outline, points[i], points[i + 1]).offset + r);
  };
  for (const w of d.wirePaths) scan(w.points);
  for (const t of d.layerTransitions) scan(t);
  return best;
}

const designs = new Map<string, Promise<Design>>();
function designOf(key: string, spec: CoilSpec): Promise<Design> {
  let d = designs.get(key);
  if (!d) designs.set(key, (d = design(spec)));
  return d;
}

describe("strap notches: the pair on every shape, plate combination and layer count", () => {
  for (const shape of SHAPES) {
    for (const plates of PLATES) {
      for (const layers of [1, 3]) {
        const name = `${shape.kind}, ${plates.name}, ${layers} layer${layers > 1 ? "s" : ""}`;
        const spec = baseSpec({ shape, base: plates.base, topCap: plates.topCap, layers: { locked: true, value: layers } });

        it(`${name}: two notches on each plate, every part one solid, nothing to support`, async () => {
          const d = await designOf(name, spec);
          expect(d.strapNotches.base).toHaveLength(plates.base === "on" ? 2 : 0);
          expect(d.strapNotches.cap).toHaveLength(plates.topCap === "on" ? 2 : 0);
          expect(d.notices.filter((n) => /strap/i.test(n.message))).toEqual([]);
          for (const part of d.parts) expect(pieces(part.mesh), part.name).toBe(1);
          expect(unsupportedOverhangs(d, name)).toEqual([]);
        });

        it(`${name}: the notches are cut in the same place in every plate, opposite each other, down to the cable and no further`, async () => {
          const d = await designOf(name, spec);
          const notches = plates.base === "on" ? d.strapNotches.base : d.strapNotches.cap;
          expect(notches).toHaveLength(2);
          if (shape.kind !== "tri") {
            expect(Math.hypot(notches[0].centre.x + notches[1].centre.x, notches[0].centre.y + notches[1].centre.y)).toBeLessThan(1e-6);
          } else {
            const [a, b] = notches.map((n) => n.centre);
            expect(Math.abs(a.x * b.y - a.y * b.x)).toBeLessThan(1e-6);
            expect(a.x * b.x + a.y * b.y).toBeLessThan(0);
          }
          const reach = drawnReach(d);
          for (const notch of notches) {
            const offsets = notch.outline.map((q) => outlineOffsetAt(d.flangeSpec.outline, q.x, q.y).offset);
            expect(Math.min(...offsets)).toBeGreaterThanOrEqual(reach - 1e-5);
            expect(Math.max(...offsets)).toBeGreaterThan(d.flangeSpec.margin);
            const floor = notch.outline.slice(notch.outline.length / 2);
            const width = floor.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - floor[i].x, q.y - floor[i].y), 0);
            expect(width).toBeCloseTo(STRAP_NOTCH_WIDTH, 1);
          }
          const thickness = d.flangeSpec.thickness;
          for (const notch of notches) {
            const into = (k: number) => ({ x: notch.centre.x + notch.axis.x * k, y: notch.centre.y + notch.axis.y * k });
            const open = into(1);
            const solid = into(-0.5);
            const core = d.parts.find((p) => p.role === "core")!.mesh;
            if (plates.base === "on") {
              expect(insideMesh(core, open.x, open.y, -thickness / 2), "base notch is open").toBe(false);
              expect(insideMesh(core, solid.x, solid.y, -thickness / 2), "base under the floor").toBe(true);
            }
            const cap = d.parts.find((p) => p.role === "topCap");
            if (cap) {
              const z = d.wallSpec.height + CAP_THICKNESS / 2;
              expect(insideMesh(cap.mesh, open.x, open.y, z), "cap notch is open").toBe(false);
              expect(insideMesh(cap.mesh, solid.x, solid.y, z), "cap under the floor").toBe(true);
            }
          }
        });

        it(`${name}: the notches keep clear of the rim slots, the label and the cable's ends`, async () => {
          const d = await designOf(name, spec);
          const notches = plates.base === "on" ? d.strapNotches.base : d.strapNotches.cap;
          const reach = drawnReach(d);
          for (const notch of notches) {
            for (const slot of [d.rimSlots.base, d.rimSlots.cap]) {
              if (slot) expect(nearest(d, notch.outline, slot.outline)).toBeGreaterThanOrEqual(STRAP_NOTCH_KEEP_OUT - 0.02);
            }
            for (const lead of [d.innerEndLeadIn, d.outerEndLeadOut]) {
              for (let i = 0; i < lead.length; i += 3) {
                const tail = { x: lead[i], y: lead[i + 1] };
                const offset = outlineOffsetAt(d.flangeSpec.outline, tail.x, tail.y).offset;
                if (offset <= reach || offset > d.flangeSpec.margin) continue;
                expect(nearestPoint(d, notch.outline, tail)).toBeGreaterThan(d.spec.wire.diameter / 2);
              }
            }
          }
        });
      }
    }
  }
});

describe("strap notches keep clear of the label and the face channels", () => {
  it("the cap's label, from the shortest to the longest that fits", async () => {
    for (const shape of SHAPES) {
      const roomy = baseSpec({ shape, wire: { length: 6000, diameter: 3.8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 30 }, height: { locked: true, value: 60 }, layers: { locked: true, value: 6 } });
      const longest = (await design({ ...roomy, label: "W".repeat(40) }, "draft")).labelFit!.maxChars;
      for (const label of ["USB-C 2m", "W".repeat(longest)]) {
        const d = await design({ ...roomy, label }, "draft");
        const resolved = (await resolveLabel(label, d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, true)).label;
        expect(resolved, `${shape.kind}/${label}`).toBeDefined();
        expect(d.strapNotches.cap, `${shape.kind}/${label}`).toHaveLength(2);
        const loops = labelLoops(await getLabelFont(), resolved!).map((loop) => loop.map(([x, y]) => ({ x, y })));
        for (const notch of d.strapNotches.cap) {
          for (const loop of loops) expect(nearest(d, notch.outline, loop), `${shape.kind}/${label}`).toBeGreaterThanOrEqual(RIM_SLOT_LABEL_KEEP_OUT - 0.3);
        }
      }
    }
  });

  it("the face channels' cuts, on a bare bottom face and under a top face", async () => {
    for (const shape of SHAPES) {
      for (const plates of [{ base: "off" as const, topCap: "on" as const }, { base: "on" as const, topCap: "off" as const }]) {
        const d = await design(baseSpec({ shape, ...plates, layers: { locked: true, value: 3 } }), "draft");
        const faces = d.faceChannels;
        expect(faces, shape.kind).toBeDefined();
        const notches = plates.base === "on" ? d.strapNotches.base : d.strapNotches.cap;
        expect(notches).toHaveLength(2);
        for (const end of [faces!.inner, faces!.outer]) {
          if (!end) continue;
          const points: XY[] = [end.hole, end.seat];
          for (const arc of end.arcs) {
            for (let i = 0; i <= 16; i++) {
              const a = arc.from + (arc.sweep * i) / 16;
              points.push({ x: arc.centre.x + arc.radius * Math.cos(a), y: arc.centre.y + arc.radius * Math.sin(a) });
            }
          }
          for (const notch of notches) {
            for (const p of points) expect(nearestPoint(d, notch.outline, p), `${shape.kind} ${end.face}`).toBeGreaterThanOrEqual(faces!.channelRadius + STRAP_NOTCH_KEEP_OUT - 0.05);
          }
        }
      }
    }
  });
});

describe("strap notches keep clear of the mounts", () => {
  for (const shape of SHAPES) {
    for (const size of [50, 70]) {
      it(`${shape.kind} ${size} mm: keyhole screw heads`, async () => {
        const d = await designOf(`keyhole ${shape.kind} ${size}`, baseSpec({ shape, mount: "keyhole", coreSize: { locked: true, dimension: "outer", value: size } }));
        expect(d.strapNotches.base).toHaveLength(2);
        const layout = layoutKeyholeMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, d.spec.keyholeRotation);
        expect(layout.slots.length).toBeGreaterThan(0);
        for (const notch of d.strapNotches.base) {
          for (const slot of layout.slots) {
            const worst = Math.min(...inPlateSamples(d, notch.outline).map((p) => distanceToSegment(p, slot.head, slot.shankEnd)));
            expect(worst).toBeGreaterThanOrEqual(SCREW_MOUNT_HEAD_RADIUS + STRAP_NOTCH_KEEP_OUT - 0.02);
          }
        }
      });

      it(`${shape.kind} ${size} mm: through holes`, async () => {
        const d = await designOf(`through ${shape.kind} ${size}`, baseSpec({ shape, mount: "through", coreSize: { locked: true, dimension: "outer", value: size } }));
        expect(d.strapNotches.base).toHaveLength(2);
        const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
        const innerEnd = layoutInnerEnd(d.flangeSpec.outline, d.flangeSpec.margin, d.spec.wire.diameter, d.spec.tolerance, bendRadius, resolveChannelDepth(d.spec.wire.diameter, d.flangeSpec.thickness));
        const { holes, holeRadius } = layoutFlangeThroughHoles(d.flangeSpec, innerEnd);
        expect(holes.length).toBeGreaterThan(0);
        for (const notch of d.strapNotches.base) {
          for (const hole of holes) expect(nearestPoint(d, notch.outline, hole)).toBeGreaterThanOrEqual(holeRadius + THROUGH_MOUNT_EDGE_MARGIN + STRAP_NOTCH_KEEP_OUT - 0.02);
        }
      });

      it(`${shape.kind} ${size} mm: SKÅDIS clips and their notches`, async () => {
        const d = await designOf(`skadis ${shape.kind} ${size}`, baseSpec({ shape, mount: "skadis", coreSize: { locked: true, dimension: "outer", value: size } }));
        const layout = d.flangeSpec.skadis;
        expect(layout?.clips.length).toBeGreaterThan(0);
        expect(d.strapNotches.base).toHaveLength(2);
        for (const notch of d.strapNotches.base) {
          for (const poly of [...skadisClipFootprints(layout!), ...layout!.notches]) {
            expect(nearest(d, notch.outline, poly)).toBeGreaterThanOrEqual(STRAP_NOTCH_KEEP_OUT - 0.02);
          }
        }
      });

      it(`${shape.kind} ${size} mm: SKÅDIS T-clips stay inside the core, away from the notches`, async () => {
        const d = await designOf(`tclip ${shape.kind} ${size}`, baseSpec({ shape, mount: "skadis-tclip", coreSize: { locked: true, dimension: "outer", value: size } }));
        const layout = d.flangeSpec.skadisTclip;
        expect(layout?.clips.length).toBeGreaterThan(0);
        expect(d.strapNotches.base).toHaveLength(2);
        const reach = drawnReach(d);
        for (const cutter of layout!.cutters.flat()) {
          for (const level of cutter.levels) {
            for (const p of level.poly) expect(outlineOffsetAt(d.flangeSpec.outline, p.x, p.y).offset).toBeLessThan(reach);
            for (const notch of d.strapNotches.base) expect(nearest(d, notch.outline, level.poly)).toBeGreaterThanOrEqual(STRAP_NOTCH_KEEP_OUT);
          }
        }
      });

      it(`${shape.kind} ${size} mm: openGrid mount plate, its pegs and its clips`, async () => {
        const d = await designOf(`opengrid ${shape.kind} ${size}`, baseSpec({ shape, mount: "opengrid", coreSize: { locked: true, dimension: "outer", value: size } }));
        expect(d.strapNotches.base).toHaveLength(2);
        for (const part of d.parts) expect(pieces(part.mesh), part.name).toBe(1);
        const plate = d.parts.find((p) => p.role === "mountPlate");
        expect(plate).toBeDefined();
        expect(unsupportedOverhangs(d, `opengrid ${shape.kind} ${size}`)).toEqual([]);
        const pegs = d.parts.filter((p) => p.role === "peg");
        for (const peg of pegs) {
          const xs = Array.from({ length: peg.mesh.positions.length / 3 }, (_, i) => ({ x: peg.mesh.positions[3 * i], y: peg.mesh.positions[3 * i + 1] }));
          const centre = { x: xs.reduce((s, p) => s + p.x, 0) / xs.length, y: xs.reduce((s, p) => s + p.y, 0) / xs.length };
          for (const notch of d.strapNotches.base) expect(nearestPoint(d, notch.outline, centre)).toBeGreaterThanOrEqual(pegHoleRadius(d.spec.tolerance) + STRAP_NOTCH_KEEP_OUT - 0.02);
        }
      });
    }
  }
});

describe("strap notches in the mount plate", () => {
  it("a plate that reaches past the cable gets the same notches, so a tie can run under it", async () => {
    const spec = baseSpec({ mount: "opengrid", coreSize: { locked: true, dimension: "outer", value: 50 } });
    const notched = await design(spec);
    const plain = await design({ ...spec, strapSlots: false });
    expect(notched.strapNotches.mountPlate).toHaveLength(2);
    expect(plain.strapNotches.mountPlate).toHaveLength(0);
    const plateOf = (d: Design) => d.parts.find((p) => p.role === "mountPlate")!.mesh;
    const volume = (mesh: CoilMesh) => {
      const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
      const v = m.volume();
      m.delete();
      return v;
    };
    expect(volume(plateOf(notched))).toBeLessThan(volume(plateOf(plain)) - 100);
    expect(pieces(plateOf(notched))).toBe(1);
    const plateBackZ = -notched.flangeSpec.thickness - MOUNT_PLATE_THICKNESS / 2;
    for (const notch of notched.strapNotches.mountPlate) {
      const open = { x: notch.centre.x + notch.axis.x, y: notch.centre.y + notch.axis.y };
      expect(insideMesh(plateOf(notched), open.x, open.y, plateBackZ)).toBe(false);
      expect(insideMesh(plateOf(plain), open.x, open.y, plateBackZ)).toBe(true);
    }
  });

  it("a plate that stops short of the cable is left whole", async () => {
    const d = await design(baseSpec({ mount: "opengrid", coreSize: { locked: true, dimension: "outer", value: 80 } }), "draft");
    expect(d.strapNotches.base).toHaveLength(2);
    expect(d.strapNotches.mountPlate).toHaveLength(0);
  });
});

describe("strap notches when they don't apply or don't fit", () => {
  it("with no plate there are no notches, and no error", async () => {
    const d = await design(baseSpec({ base: "off", topCap: "off" }), "draft");
    expect(d.strapNotches).toEqual({ base: [], cap: [], mountPlate: [] });
    expect(d.notices.filter((n) => n.severity === "problem")).toEqual([]);
    expect(d.notices.filter((n) => /strap/i.test(n.message))).toEqual([]);
  });

  it("on a core too small for the pair, a note says so, and every part is still one solid", async () => {
    const d = await design(baseSpec({ coreSize: { locked: true, dimension: "outer", value: 6 }, wire: { length: 300, diameter: 1.2, type: "usb" } }), "draft");
    expect(d.strapNotches).toEqual({ base: [], cap: [], mountPlate: [] });
    expect(d.notices.some((n) => n.severity === "note" && /strap slots/i.test(n.message))).toBe(true);
    for (const part of d.parts) expect(pieces(part.mesh), part.name).toBe(1);
  });

  it("with the toggle off the design has no notches and the meshes are the ones main builds", async () => {
    const golden: Record<string, [number, number]> = { round: [4910, 21740.452], sq: [8900, 22851.946], tri: [9254, 25705.227] };
    const goldenShapes: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }];
    for (const shape of goldenShapes) {
      const d = await design(baseSpec({ shape, strapSlots: false, wire: { length: 3000, diameter: 3, type: "usb" } }), "draft");
      expect(d.strapNotches).toEqual({ base: [], cap: [], mountPlate: [] });
      const core = d.parts[0].mesh;
      const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: core.positions, triVerts: core.indices }));
      const [triangles, volume] = golden[shape.kind];
      expect(core.indices.length / 3, shape.kind).toBe(triangles);
      expect(m.volume(), shape.kind).toBeCloseTo(volume, 2);
      m.delete();
      const omitted = await design({ ...baseSpec({ shape, wire: { length: 3000, diameter: 3, type: "usb" } }), strapSlots: undefined }, "draft");
      expect(Array.from(omitted.parts[0].mesh.positions), shape.kind).toEqual(Array.from(core.positions));
    }
  });

  it("the notches take material from each plate and leave the cable's winding area whole", async () => {
    for (const shape of SHAPES) {
      const on = await design(baseSpec({ shape }), "draft");
      const off = await design(baseSpec({ shape, strapSlots: false }), "draft");
      for (const [i, part] of on.parts.entries()) {
        const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: part.mesh.positions, triVerts: part.mesh.indices }));
        const o = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: off.parts[i].mesh.positions, triVerts: off.parts[i].mesh.indices }));
        expect(m.volume(), `${shape.kind} ${part.name}`).toBeLessThan(o.volume());
        const removed = o.volume() - m.volume();
        const depth = on.flangeSpec.margin + 2;
        const thickness = part.role === "topCap" ? CAP_THICKNESS : on.flangeSpec.thickness;
        const ceiling = 2 * STRAP_NOTCH_WIDTH * depth * thickness;
        expect(removed, `${shape.kind} ${part.name}`).toBeLessThan(ceiling);
        m.delete();
        o.delete();
      }
    }
  });
});
