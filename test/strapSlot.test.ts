import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SPEC, design, parseHash } from "../src/core";
import type { CoilMesh, CoilSpec, Design, ShapeSpec } from "../src/core";
import { CAP_THICKNESS, MOUNT_PLATE_EDGE_MARGIN, MOUNT_PLATE_THICKNESS, RIM_SLOT_LABEL_KEEP_OUT, SCREW_MOUNT_HEAD_RADIUS, STRAP_SLOT_INNER_WALL, STRAP_SLOT_KEEP_OUT, STRAP_SLOT_LENGTH, STRAP_SLOT_MIN_SEPARATION_FRACTION, STRAP_SLOT_OUTER_WALL, STRAP_SLOT_PLATE_REACH, STRAP_SLOT_WIDTH, THROUGH_MOUNT_EDGE_MARGIN } from "../src/core/constants";
import { layoutFlangeThroughHoles } from "../src/core/flangePads";
import { layoutInnerEnd, resolveChannelDepth } from "../src/core/innerEnd";
import type { XY } from "../src/core/innerEnd";
import { getLabelFont, labelLoops, resolveLabel } from "../src/core/label";
import { layoutKeyholeMount } from "../src/core/mount";
import { pegHoleRadius } from "../src/core/mountPlate";
import { skadisClipFootprints } from "../src/core/skadisClips";
import { offsetPerimeter, outlineOffsetAt, parameterAtOffsetArc, pointAt } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";
import type { StrapSlot } from "../src/core/strapSlot";
import { rayHits } from "./support/rays";
import { unsupportedOverhangs } from "./support/overhangs";


// Issue #314: with strapSlots on, the base and the cap each get two closed
// slots in the plate beside the wound cable, so a hook-and-loop tie can go
// through a slot and over the rim to hold the cable lead against the plate.
// Each plate gets its own pair (a glued mount plate shares the base's); these
// tests check the pairs on the real designs and meshes.

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const FREE_CORE = { locked: false } as const;
const LOCKED_CORE = { locked: true, dimension: "outer", value: 50 } as const;

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2500, diameter: 3, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: FREE_CORE,
    height: { locked: true, value: 40 },
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
const CABLE_LENGTHS = [5000, 9000];
const SLOT_AREA = (STRAP_SLOT_LENGTH - STRAP_SLOT_WIDTH) * STRAP_SLOT_WIDTH + Math.PI * (STRAP_SLOT_WIDTH / 2) ** 2;
const TOLERANCE_MM = 0.01;

function manifoldOf(mesh: CoilMesh) {
  return new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
}

function pieces(mesh: CoilMesh): number {
  const m = manifoldOf(mesh);
  const n = m.decompose().length;
  m.delete();
  return n;
}

function genus(mesh: CoilMesh): number {
  const m = manifoldOf(mesh);
  const g = m.genus();
  m.delete();
  return g;
}

function volume(mesh: CoilMesh): number {
  const m = manifoldOf(mesh);
  const v = m.volume();
  m.delete();
  return v;
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

function nearest(d: Design, slot: XY[], poly: XY[]): number {
  return Math.min(...inPlateSamples(d, slot).map((p) => distanceToPolygon(p, poly)));
}

function nearestPoint(d: Design, slot: XY[], target: XY): number {
  return Math.min(...inPlateSamples(d, slot).map((p) => Math.hypot(p.x - target.x, p.y - target.y)));
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

function offsetsOf(d: Design, slot: StrapSlot): number[] {
  return slot.outline.map((q) => outlineOffsetAt(d.flangeSpec.outline, q.x, q.y).offset);
}

function slotLength(d: Design, slot: StrapSlot): number {
  const offsets = offsetsOf(d, slot);
  const lo = Math.min(...offsets);
  const hi = Math.max(...offsets);
  const chain = (target: number) => {
    const points = slot.outline.filter((_, i) => Math.abs(offsets[i] - target) < 1e-3);
    return points.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x - points[i].x, q.y - points[i].y), 0);
  };
  return (chain(lo) + chain(hi)) / 2 + (hi - lo);
}

const along = (slot: StrapSlot, k: number): XY => ({ x: slot.centre.x + slot.axis.x * k, y: slot.centre.y + slot.axis.y * k });

function slotsOf(d: Design, plates: { base: string; topCap: string }): StrapSlot[] {
  return plates.base === "on" ? d.strapSlots.base : d.strapSlots.cap;
}

const designs = new Map<string, Promise<Design>>();
function designOf(key: string, spec: CoilSpec): Promise<Design> {
  let d = designs.get(key);
  if (!d) designs.set(key, (d = design(spec)));
  return d;
}

describe("strap slots: the pair on every shape, plate combination and layer count", () => {
  for (const shape of SHAPES) {
    for (const plates of PLATES) {
      for (const layers of [1, 3]) {
        const name = `${shape.kind}, ${plates.name}, ${layers} layer${layers > 1 ? "s" : ""}`;
        const spec = baseSpec({ shape, base: plates.base, topCap: plates.topCap, layers: { locked: true, value: layers } });

        it(`${name}: two slots on each plate, each part one solid with one more hole per slot, nothing to support`, async () => {
          const d = await designOf(name, spec);
          const plain = await designOf(`${name} off`, { ...spec, strapSlots: false });
          expect(d.strapSlots.base).toHaveLength(plates.base === "on" ? 2 : 0);
          expect(d.strapSlots.cap).toHaveLength(plates.topCap === "on" ? 2 : 0);
          expect(d.notices.filter((n) => /strap slots.*left out/i.test(n.message))).toEqual([]);
          for (const part of d.parts) expect(pieces(part.mesh), part.name).toBe(1);
          const counts = [d.strapSlots.base.length, d.strapSlots.cap.length];
          for (const [i, part] of d.parts.entries()) expect(genus(part.mesh) - genus(plain.parts[i].mesh), part.name).toBe(counts[i]);
          expect(unsupportedOverhangs(d, name)).toEqual([]);
        });

        it(`${name}: each slot is closed, walls at least ${STRAP_SLOT_INNER_WALL} and ${STRAP_SLOT_OUTER_WALL} mm, at least ${STRAP_SLOT_WIDTH} mm wide and ${STRAP_SLOT_LENGTH} mm long, and the margin has room for it`, async () => {
          const d = await designOf(name, spec);
          const reach = drawnReach(d);
          expect(d.flangeSpec.margin - reach).toBeGreaterThanOrEqual(STRAP_SLOT_PLATE_REACH - TOLERANCE_MM);
          for (const slot of slotsOf(d, plates)) {
            const offsets = offsetsOf(d, slot);
            const [lo, hi] = [Math.min(...offsets), Math.max(...offsets)];
            expect(lo - reach, "wall on the cable side").toBeGreaterThanOrEqual(STRAP_SLOT_INNER_WALL - TOLERANCE_MM);
            expect(d.flangeSpec.margin - hi, "wall on the rim side").toBeGreaterThanOrEqual(STRAP_SLOT_OUTER_WALL - TOLERANCE_MM);
            expect(hi - lo, "width").toBeGreaterThanOrEqual(STRAP_SLOT_WIDTH - TOLERANCE_MM);
            expect(slotLength(d, slot), "length").toBeGreaterThanOrEqual(STRAP_SLOT_LENGTH - TOLERANCE_MM);
          }
        });

        it(`${name}: the slots are through-holes in the plates with plate left at the rim beside them`, async () => {
          const d = await designOf(name, spec);
          expect(slotsOf(d, plates)).toHaveLength(2);
          const plateMeshes = [
            ...(plates.base === "on" ? [{ slots: d.strapSlots.base, mesh: d.parts.find((p) => p.role === "core")!.mesh }] : []),
            ...(plates.topCap === "on" ? [{ slots: d.strapSlots.cap, mesh: d.parts.find((p) => p.role === "topCap")!.mesh }] : []),
          ];
          const above = (mesh: CoilMesh, p: XY) => rayHits(mesh, [p.x, p.y, -1000], [0, 0, 1]);
          for (const { slots, mesh } of plateMeshes) {
            expect(slots).toHaveLength(2);
            for (const slot of slots) {
              expect(above(mesh, slot.centre), "through the slot's centre").toEqual([]);
              expect(above(mesh, along(slot, STRAP_SLOT_WIDTH / 2 + STRAP_SLOT_OUTER_WALL / 2)).length, "rim-side wall").toBeGreaterThan(0);
              expect(above(mesh, along(slot, -(STRAP_SLOT_WIDTH / 2 + STRAP_SLOT_INNER_WALL / 2))).length, "cable-side wall").toBeGreaterThan(0);
            }
          }
        });

        it(`${name}: the slots keep clear of their plate's rim slot and the cable's ends on that plate`, async () => {
          const d = await designOf(name, spec);
          const reach = drawnReach(d);
          const wire = d.spec.wire.diameter;
          const onPlate = {
            base: (z: number) => z <= wire,
            cap: (z: number) => z >= d.solution.height - wire,
          };
          for (const plate of ["base", "cap"] as const) {
            for (const slot of d.strapSlots[plate]) {
              const rimSlot = d.rimSlots[plate];
              if (rimSlot) expect(nearest(d, slot.outline, rimSlot.outline), plate).toBeGreaterThanOrEqual(STRAP_SLOT_KEEP_OUT - 0.02);
              for (const lead of [d.innerEndLeadIn, d.outerEndLeadOut]) {
                for (let i = 0; i < lead.length; i += 3) {
                  if (!onPlate[plate](lead[i + 2])) continue;
                  const tail = { x: lead[i], y: lead[i + 1] };
                  const offset = outlineOffsetAt(d.flangeSpec.outline, tail.x, tail.y).offset;
                  if (offset <= reach || offset > d.flangeSpec.margin) continue;
                  expect(nearestPoint(d, slot.outline, tail), plate).toBeGreaterThan(wire / 2);
                }
              }
            }
          }
        });
      }
    }
  }
});

describe("strap slots: where the pair goes", () => {
  it("half a turn apart, the first pair beside the outer cable end's rim slot", async () => {
    for (const shape of SHAPES) {
      const d = await designOf(`${shape.kind}, cap only, 1 layer`, baseSpec({ shape, base: "off", topCap: "on", layers: { locked: true, value: 1 } }));
      const [a, b] = d.strapSlots.cap;
      if (shape.kind !== "tri") {
        expect(Math.hypot(a.centre.x + b.centre.x, a.centre.y + b.centre.y), shape.kind).toBeLessThan(1e-6);
      } else {
        expect(Math.hypot(a.centre.x - b.centre.x, a.centre.y - b.centre.y), shape.kind).toBeGreaterThan(2 * STRAP_SLOT_LENGTH);
      }
      const gap = Math.min(...d.strapSlots.cap.map((slot) => nearest(d, slot.outline, d.rimSlots.cap!.outline)));
      expect(gap, shape.kind).toBeLessThan(STRAP_SLOT_KEEP_OUT + 2);
    }
  });
});

describe("strap slots keep clear of the label and the face channels", () => {
  it("the cap's label, from the shortest to the longest that fits", async () => {
    for (const shape of SHAPES) {
      const roomy = baseSpec({ shape, wire: { length: 6000, diameter: 3.8, type: "usb" }, height: { locked: true, value: 60 }, layers: { locked: true, value: 6 } });
      const longest = (await design({ ...roomy, label: "W".repeat(40) }, "draft")).labelFit!.maxChars;
      for (const label of ["USB-C 2m", "W".repeat(longest)]) {
        const d = await design({ ...roomy, label }, "draft");
        const resolved = (await resolveLabel(label, d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, true)).label;
        expect(resolved, `${shape.kind}/${label}`).toBeDefined();
        expect(d.strapSlots.cap, `${shape.kind}/${label}`).toHaveLength(2);
        const loops = labelLoops(await getLabelFont(), resolved!).map((loop) => loop.map(([x, y]) => ({ x, y })));
        for (const slot of d.strapSlots.cap) {
          for (const loop of loops) expect(nearest(d, slot.outline, loop), `${shape.kind}/${label}`).toBeGreaterThanOrEqual(RIM_SLOT_LABEL_KEEP_OUT - 0.3);
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
        const slots = slotsOf(d, plates);
        expect(slots).toHaveLength(2);
        for (const end of [faces!.inner, faces!.outer]) {
          if (!end) continue;
          const points: XY[] = [end.hole, end.seat];
          for (const arc of end.arcs) {
            for (let i = 0; i <= 16; i++) {
              const a = arc.from + (arc.sweep * i) / 16;
              points.push({ x: arc.centre.x + arc.radius * Math.cos(a), y: arc.centre.y + arc.radius * Math.sin(a) });
            }
          }
          for (const slot of slots) {
            for (const p of points) expect(nearestPoint(d, slot.outline, p), `${shape.kind} ${end.face}`).toBeGreaterThanOrEqual(faces!.channelRadius + STRAP_SLOT_KEEP_OUT - 0.05);
          }
        }
      }
    }
  });
});

describe("strap slots keep clear of the mounts", () => {
  for (const shape of SHAPES) {
    for (const length of CABLE_LENGTHS) {
      const free = (mount: CoilSpec["mount"]) => baseSpec({ shape, mount, wire: { length, diameter: 3, type: "usb" } });
      const tag = `${shape.kind} ${length / 1000} m`;

      it(`${tag}: keyhole screw heads`, async () => {
        const d = await designOf(`keyhole ${tag}`, free("keyhole"));
        expect(d.strapSlots.base).toHaveLength(2);
        const layout = layoutKeyholeMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin, d.spec.keyholeRotation);
        expect(layout.slots.length).toBeGreaterThan(0);
        for (const slot of d.strapSlots.base) {
          for (const keyhole of layout.slots) {
            const worst = Math.min(...inPlateSamples(d, slot.outline).map((p) => distanceToSegment(p, keyhole.head, keyhole.shankEnd)));
            expect(worst).toBeGreaterThanOrEqual(SCREW_MOUNT_HEAD_RADIUS + STRAP_SLOT_KEEP_OUT - 0.02);
          }
        }
      });

      it(`${tag}: through holes`, async () => {
        const d = await designOf(`through ${tag}`, free("through"));
        expect(d.strapSlots.base).toHaveLength(2);
        const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
        const innerEnd = layoutInnerEnd(d.flangeSpec.outline, d.flangeSpec.margin, d.spec.wire.diameter, d.spec.tolerance, bendRadius, resolveChannelDepth(d.spec.wire.diameter, d.flangeSpec.thickness));
        const { holes, holeRadius } = layoutFlangeThroughHoles(d.flangeSpec, innerEnd);
        expect(holes.length).toBeGreaterThan(0);
        for (const slot of d.strapSlots.base) {
          for (const hole of holes) expect(nearestPoint(d, slot.outline, hole)).toBeGreaterThanOrEqual(holeRadius + THROUGH_MOUNT_EDGE_MARGIN + STRAP_SLOT_KEEP_OUT - 0.05);
        }
      });

      it(`${tag}: SKÅDIS clips and their notches`, async () => {
        const d = await designOf(`skadis ${tag}`, free("skadis"));
        const layout = d.flangeSpec.skadis;
        expect(layout?.clips.length).toBeGreaterThan(0);
        expect(d.strapSlots.base).toHaveLength(2);
        for (const slot of d.strapSlots.base) {
          for (const poly of [...skadisClipFootprints(layout!), ...layout!.notches]) {
            expect(nearest(d, slot.outline, poly)).toBeGreaterThanOrEqual(STRAP_SLOT_KEEP_OUT - 0.02);
          }
        }
      });

      it(`${tag}: SKÅDIS T-clips and their cutters`, async () => {
        const d = await designOf(`tclip ${tag}`, free("skadis-tclip"));
        const layout = d.flangeSpec.skadisTclip;
        expect(layout?.clips.length).toBeGreaterThan(0);
        expect(d.strapSlots.base).toHaveLength(2);
        const reach = drawnReach(d);
        for (const cutter of layout!.cutters.flat()) {
          for (const level of cutter.levels) {
            for (const p of level.poly) expect(outlineOffsetAt(d.flangeSpec.outline, p.x, p.y).offset).toBeLessThan(reach);
            for (const slot of d.strapSlots.base) expect(nearest(d, slot.outline, level.poly)).toBeGreaterThanOrEqual(STRAP_SLOT_KEEP_OUT);
          }
        }
      });

      it(`${tag}: openGrid mount plate, its pegs and its clips`, async () => {
        const d = await designOf(`opengrid ${tag}`, free("opengrid"));
        expect(d.strapSlots.base).toHaveLength(2);
        for (const part of d.parts) expect(pieces(part.mesh), part.name).toBe(1);
        expect(d.parts.find((p) => p.role === "mountPlate")).toBeDefined();
        expect(unsupportedOverhangs(d, `opengrid ${tag}`)).toEqual([]);
        for (const peg of d.parts.filter((p) => p.role === "peg")) {
          const xs = Array.from({ length: peg.mesh.positions.length / 3 }, (_, i) => ({ x: peg.mesh.positions[3 * i], y: peg.mesh.positions[3 * i + 1] }));
          const centre = { x: xs.reduce((s, p) => s + p.x, 0) / xs.length, y: xs.reduce((s, p) => s + p.y, 0) / xs.length };
          for (const slot of d.strapSlots.base) expect(nearestPoint(d, slot.outline, centre)).toBeGreaterThanOrEqual(pegHoleRadius(d.spec.tolerance) + STRAP_SLOT_KEEP_OUT - 0.02);
        }
      });
    }
  }
});

describe("strap slots in the mount plate", () => {
  it("a plate that reaches into the slots is cut with them, so the tie passes the plate as well as the base", async () => {
    const d = await design(baseSpec({ shape: { kind: "sq", cornerRadius: 12 }, mount: "opengrid" }));
    expect(d.strapSlots.mountPlate).toHaveLength(2);
    expect(d.strapSlots.mountPlate).toEqual(d.strapSlots.base);
    expect(d.flangeSpec.margin - MOUNT_PLATE_EDGE_MARGIN).toBeGreaterThan(drawnReach(d) + STRAP_SLOT_INNER_WALL);
    const plate = d.parts.find((p) => p.role === "mountPlate")!.mesh;
    expect(pieces(plate)).toBe(1);
    const plateBackZ = -d.flangeSpec.thickness - MOUNT_PLATE_THICKNESS / 2;
    for (const slot of d.strapSlots.mountPlate) {
      expect(insideMesh(plate, slot.centre.x, slot.centre.y, plateBackZ), "open at the slot's centre").toBe(false);
      const lip = along(slot, -(STRAP_SLOT_WIDTH / 2 + STRAP_SLOT_INNER_WALL / 2));
      expect(insideMesh(plate, lip.x, lip.y, plateBackZ), "plate under the cable-side wall").toBe(true);
    }
  });
});

describe("strap slots when the margin has to grow", () => {
  it("a square r12 with the core size left free grows to at least 6 mm of plate past the cable, base and cap alike", async () => {
    const shape: ShapeSpec = { kind: "sq", cornerRadius: 12 };
    const on = await design(baseSpec({ shape }), "draft");
    const off = await design(baseSpec({ shape, strapSlots: false }), "draft");
    expect(on.flangeSpec.margin - drawnReach(on)).toBeGreaterThanOrEqual(STRAP_SLOT_PLATE_REACH - TOLERANCE_MM);
    expect(on.flangeSpec.margin).toBeGreaterThan(off.flangeSpec.margin);
    expect(on.notices.some((n) => n.severity === "note" && /margin increased.*strap slots/i.test(n.message))).toBe(true);
    expect(off.notices.some((n) => /strap/i.test(n.message))).toBe(false);
  });

  it("a cap on its own grows the same way", async () => {
    const d = await design(baseSpec({ shape: { kind: "tri", cornerRadius: 12 }, base: "off" }), "draft");
    expect(d.strapSlots.cap).toHaveLength(2);
    expect(d.flangeSpec.margin - drawnReach(d)).toBeGreaterThanOrEqual(STRAP_SLOT_PLATE_REACH - TOLERANCE_MM);
  });

  it("the default design with two layers and the core size locked still gets slots: the margin grows and the core keeps its size", async () => {
    const spec: CoilSpec = { ...DEFAULT_SPEC, base: "on", topCap: "on", layers: { locked: true, value: 2 }, strapSlots: true };
    expect(spec.coreSize.locked).toBe(true);
    const on = await design(spec, "draft");
    const off = await design({ ...spec, strapSlots: false }, "draft");
    expect(on.strapSlots.base).toHaveLength(2);
    expect(on.strapSlots.cap).toHaveLength(2);
    expect(on.solution.outerSize).toBe(off.solution.outerSize);
    expect(on.flangeSpec.margin).toBeGreaterThan(off.flangeSpec.margin);
    expect(on.flangeSpec.margin - drawnReach(on)).toBeGreaterThanOrEqual(STRAP_SLOT_PLATE_REACH - TOLERANCE_MM);
    expect(on.notices.filter((n) => /left out/i.test(n.message))).toEqual([]);
  });

  it("every shape with the core size locked grows its margin and keeps its core size", async () => {
    for (const shape of SHAPES) {
      const on = await design(baseSpec({ shape, coreSize: LOCKED_CORE }), "draft");
      const off = await design(baseSpec({ shape, coreSize: LOCKED_CORE, strapSlots: false }), "draft");
      expect(on.strapSlots.base, shape.kind).toHaveLength(2);
      expect(on.strapSlots.cap, shape.kind).toHaveLength(2);
      expect(on.solution.outerSize, shape.kind).toBe(off.solution.outerSize);
      expect(on.flangeSpec.margin - drawnReach(on), shape.kind).toBeGreaterThanOrEqual(STRAP_SLOT_PLATE_REACH - TOLERANCE_MM);
    }
  });

  it("with the core size locked but a mount that already makes room, the slots are cut and the margin is the mount's", async () => {
    const d = await design(baseSpec({ shape: { kind: "sq", cornerRadius: 12 }, mount: "keyhole", topCap: "off", coreSize: LOCKED_CORE }), "draft");
    const plain = await design(baseSpec({ shape: { kind: "sq", cornerRadius: 12 }, mount: "keyhole", topCap: "off", coreSize: LOCKED_CORE, strapSlots: false }), "draft");
    expect(d.strapSlots.base).toHaveLength(2);
    expect(d.flangeSpec.margin).toBe(plain.flangeSpec.margin);
    expect(d.notices.filter((n) => /strap/i.test(n.message))).toEqual([]);
  });
});

describe("strap slots when they don't apply or don't fit", () => {
  it("with no plate there are no slots, and no error", async () => {
    const d = await design(baseSpec({ base: "off", topCap: "off" }), "draft");
    expect(d.strapSlots).toEqual({ base: [], cap: [], mountPlate: [] });
    expect(d.notices.filter((n) => n.severity === "problem")).toEqual([]);
    expect(d.notices.filter((n) => /strap/i.test(n.message))).toEqual([]);
  });

  it("when a plate has no clear pair, a note names that plate, and the other plate keeps its slots", async () => {
    const small = { ...DEFAULT_SPEC, coreSize: { locked: true, dimension: "outer", value: 20 }, base: "on", topCap: "on", mount: "keyhole", strapSlots: true } as const;
    const d = await design(small, "draft");
    expect(d.strapSlots.base).toEqual([]);
    expect(d.strapSlots.cap).toHaveLength(2);
    expect(d.strapSlotsNote).toMatch(/strap slots don't fit anywhere round the rim of the base,/i);
    expect(d.notices.filter((n) => /strap slots/i.test(n.message))).toEqual([{ severity: "note", message: d.strapSlotsNote }]);
    for (const part of d.parts) expect(pieces(part.mesh), part.name).toBe(1);
    const off = await design({ ...small, strapSlots: false }, "draft");
    expect(off.strapSlotsNote).toBeUndefined();
  });

  it("with the toggle off the design has no slots and the meshes are the ones main builds", async () => {
    // Issue #321 added the wall's 0.5 mm columns at the groove's two ends on every design: 4910, 8900 and 9254 triangles before, and the volumes moved by under 0.06 %.
    const golden: Record<string, [number, number]> = { round: [6868, 21752.664674428674], sq: [10328, 22865.01246339057], tri: [10624, 25693.480450518793] };
    const goldenShapes: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }];
    for (const shape of goldenShapes) {
      const lockedSpec = baseSpec({ shape, coreSize: LOCKED_CORE, height: { locked: false }, wire: { length: 3000, diameter: 3, type: "usb" } });
      const d = await design({ ...lockedSpec, strapSlots: false }, "draft");
      expect(d.strapSlots).toEqual({ base: [], cap: [], mountPlate: [] });
      const core = d.parts[0].mesh;
      const [triangles, expected] = golden[shape.kind];
      expect(core.indices.length / 3, shape.kind).toBe(triangles);
      expect(volume(core), shape.kind).toBeCloseTo(expected, 2);
      const omitted = await design({ ...lockedSpec, strapSlots: undefined }, "draft");
      expect(Array.from(omitted.parts[0].mesh.positions), shape.kind).toEqual(Array.from(core.positions));
    }
  });

  it("the slots take at most their own area from each plate (the rim's chamfer takes the rest)", async () => {
    for (const shape of SHAPES) {
      const spec = baseSpec({ shape, mount: "keyhole", coreSize: LOCKED_CORE });
      const on = await design(spec, "draft");
      const off = await design({ ...spec, strapSlots: false }, "draft");
      expect(on.strapSlots.base, shape.kind).toHaveLength(2);
      for (const [i, part] of on.parts.entries()) {
        const thickness = part.role === "topCap" ? CAP_THICKNESS : on.flangeSpec.thickness;
        const removed = volume(off.parts[i].mesh) - volume(part.mesh);
        expect(removed, `${shape.kind} ${part.name}`).toBeGreaterThan(0.5 * 2 * SLOT_AREA * thickness);
        expect(removed, `${shape.kind} ${part.name}`).toBeLessThan(1.05 * 2 * SLOT_AREA * thickness);
      }
    }
  });
});

const HASH_WITH_NO_OPPOSITE_PAIR = "#s=eyJ2IjoyLCJzaXplIjozOCwiY2FwIjoib24iLCJtb3VudCI6InRocm91Z2giLCJzdHJhcCI6dHJ1ZX0";

function arcApart(d: Design, a: XY, b: XY): { apart: number; perimeter: number } {
  const outline = d.flangeSpec.outline;
  const offset = outlineOffsetAt(outline, a.x, a.y).offset;
  const perimeter = offsetPerimeter(outline, offset);
  const step = 0.25;
  const samples = Array.from({ length: Math.ceil(perimeter / step) }, (_, i) => pointAt(outline, parameterAtOffsetArc(outline, offset, i * step), offset));
  const indexOf = (p: XY) => samples.reduce((best, q, i) => (Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(samples[best].x - p.x, samples[best].y - p.y) ? i : best), 0);
  const along = Math.abs(indexOf(a) - indexOf(b)) * step;
  return { apart: Math.min(along, perimeter - along), perimeter };
}

describe("strap slots when the base and the cap keep-outs leave no opposite pair (issue #316)", () => {
  it("a 38 mm round core with a base, a through-hole mount and a cap gets a pair on each plate, no note, and the cap's pair is exactly opposite", async () => {
    const spec = parseHash(HASH_WITH_NO_OPPOSITE_PAIR).spec;
    const d = await design(spec);
    expect(d.strapSlots.base).toHaveLength(2);
    expect(d.strapSlots.cap).toHaveLength(2);
    expect(d.strapSlotsNote).toBeUndefined();
    expect(d.notices.filter((n) => /strap slots/i.test(n.message))).toEqual([]);
    const [a, b] = d.strapSlots.cap;
    const { apart, perimeter } = arcApart(d, a.centre, b.centre);
    expect(Math.abs(apart - perimeter / 2)).toBeLessThan(1);
    expect(d.strapSlots.base).not.toEqual(d.strapSlots.cap);

    const plain = await design({ ...spec, strapSlots: false });
    for (const [i, part] of d.parts.entries()) {
      const slots = part.role === "core" ? d.strapSlots.base : d.strapSlots.cap;
      expect(pieces(part.mesh), part.name).toBe(1);
      expect(genus(part.mesh) - genus(plain.parts[i].mesh), part.name).toBe(slots.length);
      for (const slot of slots) expect(rayHits(part.mesh, [slot.centre.x, slot.centre.y, -1000], [0, 0, 1]), part.name).toEqual([]);
      expect(unsupportedOverhangs(d, part.name)).toEqual([]);
    }
  });

  const CASES: { name: string; shape: ShapeSpec; size: number; base: "on" | "off"; topCap: "on" | "off"; mount: CoilSpec["mount"] }[] = [
    { name: "round 30, base and cap, no mount", shape: { kind: "round" }, size: 30, base: "on", topCap: "on", mount: "none" },
    { name: "round 30, base only, keyhole", shape: { kind: "round" }, size: 30, base: "on", topCap: "off", mount: "keyhole" },
    { name: "round 40, cap, through-hole mount", shape: { kind: "round" }, size: 40, base: "off", topCap: "on", mount: "through" },
    { name: "sq 40, cap, SKADIS", shape: { kind: "sq", cornerRadius: 12 }, size: 40, base: "off", topCap: "on", mount: "skadis" },
    { name: "tri 40, cap, keyhole", shape: { kind: "tri", cornerRadius: 12 }, size: 40, base: "off", topCap: "on", mount: "keyhole" },
  ];

  for (const { name, shape, size, base, topCap, mount } of CASES) {
    it(`${name}: every plate has a pair at least a third of the way round, and no note`, async () => {
      const d = await design({ ...DEFAULT_SPEC, shape, coreSize: { locked: true, dimension: "outer", value: size }, base, topCap, mount, strapSlots: true }, "draft");
      const plates = [
        ...(mount !== "none" || base === "on" ? [{ name: "base", slots: d.strapSlots.base }] : []),
        ...(topCap === "on" ? [{ name: "cap", slots: d.strapSlots.cap }] : []),
      ];
      expect(d.strapSlotsNote, name).toBeUndefined();
      for (const plate of plates) {
        expect(plate.slots, `${name} ${plate.name}`).toHaveLength(2);
        const { apart, perimeter } = arcApart(d, plate.slots[0].centre, plate.slots[1].centre);
        expect(apart, `${name} ${plate.name}`).toBeGreaterThanOrEqual(perimeter * STRAP_SLOT_MIN_SEPARATION_FRACTION - 1);
      }
    });
  }
});
