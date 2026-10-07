import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, Design, ShapeSpec } from "../src/core";
import { FLANGE_MARGIN } from "../src/core/constants";
import { outlineOffsetAt } from "../src/core/shapes";

// The flange and the top cap must cover the drawn wound cable as it really
// runs, plus the FLANGE_MARGIN lip: the layers, the hops between them, and
// the outer end's run up to and under the cap (a lifted single-layer turn,
// and a climb outside a last layer that ends at the bottom). Only the free
// ends may leave the plate: the inner end's tail through the rim, and the
// outer end's tail (out from under the cap, or with no cap the whole
// tangential tail).

function spec(overrides: Partial<CoilSpec>): CoilSpec {
  return {
    wire: { length: 4000, diameter: 3, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: false },
    layers: { locked: true, value: 1 },
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

/** The drawn cable's furthest reach outside the core's outline (its outer surface), the free tails left out. */
function reach(d: Design): { reach: number; where: string } {
  const r = d.spec.wire.diameter / 2;
  const o = d.flangeSpec.outline;
  let best = { reach: 0, where: "" };
  const scan = (points: ArrayLike<number>, what: string, keep: (z: number) => boolean = () => true) => {
    for (let i = 0; i < points.length; i += 3) {
      if (!keep(points[i + 2])) continue;
      const off = outlineOffsetAt(o, points[i], points[i + 1]).offset + r;
      if (off > best.reach) best = { reach: off, where: `${what} at z=${points[i + 2].toFixed(1)}` };
    }
  };
  for (const w of d.wirePaths) scan(w.points, `layer ${w.layer}`);
  d.layerTransitions.forEach((t, i) => scan(t, `transition ${i + 1}`));
  if (d.parts.some((p) => p.role === "topCap")) {
    // The tail runs level under the cap, out past the rim: leave out its level samples.
    const out = d.outerEndLeadOut;
    const zKey = out[out.length - 1];
    scan(out, "outer end", (z) => Math.abs(z - zKey) > 1e-4);
  }
  return best;
}

describe("the flange and the cap cover the drawn wound cable plus the lip", () => {
  const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }];
  for (const shape of SHAPES) {
    for (const diameter of [3, 6]) {
      for (let layers = 1; layers <= 5; layers++) {
        for (const topCap of ["on", "off"] as const) {
          it(`shape=${shape.kind} d=${diameter} layers=${layers} cap=${topCap}`, async () => {
            const d = await design(spec({ shape, wire: { length: 1000 * layers * diameter, diameter, type: "usb" }, layers: { locked: true, value: layers }, topCap }), "draft");
            const { reach: r, where } = reach(d);
            expect(r + FLANGE_MARGIN, `${where} reaches ${r.toFixed(2)} mm; margin ${d.flangeSpec.margin.toFixed(2)} mm`).toBeLessThanOrEqual(d.flangeSpec.margin + 1e-3);
          });
        }
      }
    }
  }
});
