import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { CAP_LEAD_OUT_WALL_GAP, design, EDGE_CHAMFER, FLANGE_MARGIN, outlineOffsetAt, parseHash, RIM_SLOT_KEEP_OUT, RIM_SLOT_LABEL_KEEP_OUT, RIM_SLOT_NECK, THROUGH_MOUNT_EDGE_MARGIN } from "../src/core";
import type { CoilSpec, Design, ShapeSpec } from "../src/core";
import { rimSlotNeckWidth } from "./support/rimSlot";
import { distanceToLabel } from "./support/flange";
import type { XY } from "./support/types";

// Issue #241: the top cap's clips are gone; the cap and the base each get a
// rim slot the cable is pressed into from the edge. The slot's own shape is
// checked on the real meshes in test/cableClip.test.ts; this file checks
// what it does to the rest of the design: the margin, where the slots go and
// what they keep clear of.

/** The print-feedback design: 1720 mm of 3 mm cable, square 50, cap, snap. */
const FEEDBACK = "#s=eyJ2IjoyLCJMIjoxNzIwLCJkIjozLCJzaGFwZSI6InNxIiwic2l6ZSI6NTAsImxvY2siOlsib3V0ZXIiXSwiY2FwIjoib24iLCJqb2ludCI6InNuYXAifQ";

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 3000, diameter: 3, type: "usb" },
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
    ...overrides,
  };
}

/** The slot's cut where it lies inside the plate. */
function cutInside(d: Design, slot: { outline: XY[] }): XY[] {
  return slot.outline.filter((q) => outlineOffsetAt(d.flangeSpec.outline, q.x, q.y).offset <= d.flangeSpec.margin);
}

function pieces(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  const n = m.decompose().length;
  m.delete();
  return n;
}

describe("rim cable slots (issue #241)", () => {
  it("the cap no longer sets the margin: on the feedback design only the outer end's run up to the cap does", async () => {
    const spec = { ...parseHash(FEEDBACK).spec, base: "on" as const };
    const on = await design(spec, "draft");
    const off = await design({ ...spec, topCap: "off" }, "draft");
    // The cap clips set it at 9.8 mm. Now the plate covers the drawn cable plus the lip: with the cap on, the single
    // layer's outer end runs up to the cap clear of the wall (its centre a radius plus 0.3 mm out).
    const d = spec.wire.diameter;
    expect(on.flangeSpec.margin).toBeCloseTo(Math.max(off.flangeSpec.margin, d + CAP_LEAD_OUT_WALL_GAP + FLANGE_MARGIN), 6);
    expect(on.flangeSpec.margin).toBeLessThan(9.8 - 2);
    expect(on.warnings.some((w) => /cap's cable clip/.test(w))).toBe(false);
  });

  it("the base slot sits right below the cap slot when nothing on the base is in the way", async () => {
    const d = await design({ ...parseHash(FEEDBACK).spec, base: "on" }, "draft");
    const { base, cap } = d.rimSlots;
    expect(base).toBeDefined();
    expect(cap).toBeDefined();
    expect(Math.hypot(base!.seat.x - cap!.seat.x, base!.seat.y - cap!.seat.y)).toBeLessThan(1e-9);
  });

  // Fractional sizes and diameters, so a layout that only fits at whole
  // millimetres shows up.
  const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }];
  for (const shape of SHAPES) {
    for (const diameter of [2.3, 3.7, 5.2]) {
      for (const size of [41.3, 66.8]) {
        it(`shape=${shape.kind} d=${diameter} size=${size}: both slots, inside the plate, every part one solid`, async () => {
          const d = await design(baseSpec({ shape, wire: { length: 2500, diameter, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: size } }), "draft");
          for (const slot of [d.rimSlots.base, d.rimSlots.cap]) {
            expect(slot).toBeDefined();
            const seat = outlineOffsetAt(d.flangeSpec.outline, slot!.seat.x, slot!.seat.y).offset;
            // Its neck ends at the rim chamfer's foot, and the seat is clear of the wall.
            const R = (diameter + d.spec.tolerance) / 2;
            const neck = rimSlotNeckWidth(slot!);
            expect(seat + Math.sqrt(R * R - (neck / 2) ** 2) + RIM_SLOT_NECK).toBeCloseTo(d.flangeSpec.margin - EDGE_CHAMFER, 6);
            expect(seat - R).toBeGreaterThan(1);
            // Open at the rim.
            expect(Math.max(...slot!.outline.map((q) => outlineOffsetAt(d.flangeSpec.outline, q.x, q.y).offset))).toBeGreaterThan(d.flangeSpec.margin);
          }
          for (const part of d.parts) expect(pieces(part.mesh), part.name).toBe(1);
        });
      }
    }
  }

  it("the base slot keeps clear of the through-hole mount's screw heads", async () => {
    for (const shape of SHAPES) {
      const d = await design(baseSpec({ shape, mount: "through" }), "draft");
      const { holes, holeRadius } = d.mountLayout!.through!;
      expect(holes.length).toBeGreaterThan(0);
      for (const hole of holes) {
        for (const q of cutInside(d, d.rimSlots.base!)) {
          expect(Math.hypot(q.x - hole.x, q.y - hole.y), shape.kind).toBeGreaterThanOrEqual(holeRadius + THROUGH_MOUNT_EDGE_MARGIN + RIM_SLOT_KEEP_OUT - 0.05);
        }
      }
    }
  });

  it("the cap slot keeps clear of the engraved label", async () => {
    for (const shape of SHAPES) {
      // A short label, and the longest one that fits (most likely to reach the slot).
      const roomy = baseSpec({ shape, wire: { length: 6000, diameter: 3.8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 30 }, height: { locked: true, value: 60 }, layers: { locked: true, value: 6 } });
      const longest = (await design({ ...roomy, label: "W".repeat(40) }, "draft")).labelFit!.maxChars;
      for (const label of ["USB-C 2m", "W".repeat(longest)]) {
        const d = await design({ ...roomy, label }, "draft");
        const cut = cutInside(d, d.rimSlots.cap!);
        expect(distanceToLabel(d, { x: 0, y: 0 }), `${shape.kind}/${label}: the label fits and is engraved`).toBeLessThan(Infinity);
        for (const q of cut) expect(distanceToLabel(d, q), `${shape.kind}/${label}`).toBeGreaterThanOrEqual(RIM_SLOT_LABEL_KEEP_OUT - 0.3);
      }
    }
  });
});
