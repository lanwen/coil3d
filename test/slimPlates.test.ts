import { describe, expect, it } from "vitest";
import { design, parseHash } from "../src/core";
import type { CoilSpec, Design, ShapeSpec } from "../src/core";
import { FLANGE_MARGIN } from "../src/core/constants";
import { layoutFlangeThroughHoles } from "../src/core/flangePads";
import { layoutInnerEnd, requiredRimSlotMargin, resolveChannelDepth } from "../src/core/innerEnd";
import { outlineOffsetAt } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";

// Issue #239: the base flange and the top cap reach only a small lip past the
// wound cable, and the through-hole mount moves in toward the core (under the
// winding if need be, countersunk). Checked through design().

/** The print-feedback design: 1720 mm of 3 mm cable, square 50, cap, snap. */
const FEEDBACK = "#s=eyJ2IjoyLCJMIjoxNzIwLCJkIjozLCJzaGFwZSI6InNxIiwic2l6ZSI6NTAsImxvY2siOlsib3V0ZXIiXSwiY2FwIjoib24iLCJqb2ludCI6InNuYXAifQ";

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 6000, diameter: 3, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 50 },
    height: { locked: false },
    layers: { locked: true, value: 4 },
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

/**
 * The drawn cable's outer surface, as an offset outside the core's outline: the layers and, with the cap on, the
 * outer end's run up to the cap (with an even layer count it climbs outside the last layer). The free tail out from
 * under the cap is left out.
 */
function woundOffset(d: Design): number {
  let wound = 0;
  const scan = (points: ArrayLike<number>, keep: (z: number) => boolean = () => true) => {
    for (let i = 0; i < points.length; i += 3) if (keep(points[i + 2])) wound = Math.max(wound, outlineOffsetAt(d.flangeSpec.outline, points[i], points[i + 1]).offset);
  };
  for (const layer of d.wirePaths) scan(layer.points);
  if (d.parts.some((p) => p.role === "topCap")) {
    const out = d.outerEndLeadOut;
    const zKey = out[out.length - 1];
    scan(out, (z) => Math.abs(z - zKey) > 1e-4);
  }
  return wound + d.spec.wire.diameter / 2;
}

describe("slim base and cap (issue #239)", () => {
  it("the feedback design: the margin is set by the inner end's lead-in, no longer by a 4 mm pad or the cap", async () => {
    const d = await design({ ...parseHash(FEEDBACK).spec, base: "on" }, "draft");
    // 9.8 mm with the cap clips, 6.1 mm with a 4 mm lip; the wound cable reaches 2.1 mm.
    expect(d.flangeSpec.margin).toBeLessThan(5.5);
    expect(d.flangeSpec.margin).toBeGreaterThan(requiredRimSlotMargin(3, d.spec.tolerance));
    expect(d.warnings.some((w) => /margin increased to .* inner cable end/i.test(w))).toBe(true);
  });

  // Fractional sizes, so a fit that only works at whole millimetres shows up.
  const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }];
  for (const shape of SHAPES) {
    for (const [layers, size] of [
      [3, 47.3],
      [4, 62.8],
    ] as const) {
      it(`shape=${shape.kind}, ${layers} layers, size ${size}: the plate reaches a ${FLANGE_MARGIN} mm lip past the drawn cable`, async () => {
        const d = await design(baseSpec({ shape, layers: { locked: true, value: layers }, coreSize: { locked: true, dimension: "outer", value: size } }), "draft");
        expect(d.solution.layers).toBe(layers);
        const wound = woundOffset(d);
        // The drawn cable's outer surface is the envelope the plate is sized from, give or take the winding's own
        // nesting (the solver's envelope is the loosest winding's).
        expect(d.flangeSpec.margin - wound).toBeGreaterThanOrEqual(FLANGE_MARGIN - 1e-4);
        // Unless something else needs more room, and says so.
        if (!d.warnings.some((w) => /margin increased/i.test(w))) expect(d.flangeSpec.margin - wound).toBeLessThan(FLANGE_MARGIN + 0.75);
      });
    }
  }

  it("through-holes sit as close to the core as the collar pad allows, under the winding of a multi-layer coil", async () => {
    for (const shape of SHAPES) {
      const d = await design(baseSpec({ shape, mount: "through", layers: { locked: true, value: 5 }, wire: { length: 8000, diameter: 3, type: "usb" } }), "draft");
      const f = d.flangeSpec;
      const bendRadius = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
      const innerEnd = layoutInnerEnd(f.outline, f.margin, d.spec.wire.diameter, d.spec.tolerance, bendRadius, resolveChannelDepth(d.spec.wire.diameter, f.thickness));
      const { holes, holeRadius } = layoutFlangeThroughHoles(f, innerEnd);
      expect(holes.length, shape.kind).toBeGreaterThanOrEqual(2);
      const wound = woundOffset(d);
      for (const h of holes) {
        const o = outlineOffsetAt(f.outline, h.x, h.y).offset;
        expect(o - holeRadius, `${shape.kind}: under the wound cable`).toBeLessThan(wound);
        expect(o + holeRadius, `${shape.kind}: well in from the rim`).toBeLessThan(f.margin - 2);
      }
    }
  });
});
