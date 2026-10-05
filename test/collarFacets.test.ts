import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import { ribNotchDegs } from "./support/ribNotch";
import type { CoilSpec } from "../src/core";

// Issue #200: the cap's collar is a cylinder built from straight facets. The
// line-art renderer reads a facet seam that is seen almost edge-on (next to the
// collar's side outline) as a depth step and draws it, so a coarse collar shows
// dotted vertical lines on its wall. Fine facets leave the seams within the
// outline's own line.

const MAX_FACET_DEG = 3;

function spec(overrides: Partial<CoilSpec>): CoilSpec {
  return {
    wire: { length: 6000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 60 },
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "on",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    base: "on",
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

/** The largest angle (degrees) between neighbouring corners on the collar's outer rim at its tip, apart from the notch for the inner end's rib. */
function widestFacet(positions: Float32Array, notch: { centre: number; half: number }): number {
  let tip = Infinity;
  for (let i = 2; i < positions.length; i += 3) tip = Math.min(tip, positions[i]);
  const rim: [number, number][] = [];
  for (let i = 0; i < positions.length; i += 3) if (Math.abs(positions[i + 2] - tip) < 1e-3) rim.push([positions[i], positions[i + 1]]);
  const outer = Math.max(...rim.map(([x, y]) => Math.hypot(x, y)));
  const aroundNotch = rim
    .filter(([x, y]) => Math.hypot(x, y) > outer - 0.05)
    .map(([x, y]) => ((((Math.atan2(y, x) * 180) / Math.PI - notch.centre) % 360) + 540) % 360 - 180)
    .filter((a) => Math.abs(a) > notch.half)
    .sort((a, b) => a - b);
  let widest = 0;
  for (let i = 0; i + 1 < aroundNotch.length; i++) if (!(aroundNotch[i] < 0 && aroundNotch[i + 1] > 0)) widest = Math.max(widest, aroundNotch[i + 1] - aroundNotch[i]);
  return Math.max(widest, aroundNotch[0] + 360 - aroundNotch[aroundNotch.length - 1]);
}

describe("the cap's collar wall (issue #200)", () => {
  it.each([60, 90])("a %i mm round core: no facet is wider than 3 degrees", async (size) => {
    const d = await design(spec({ coreSize: { locked: true, dimension: "outer", value: size } }));
    const cap = d.parts.find((p) => p.role === "topCap")!;
    expect(widestFacet(cap.mesh.positions, ribNotchDegs(d, 3))).toBeLessThanOrEqual(MAX_FACET_DEG);
  });

  // Finer columns change where the L-slot cutters cross the wall, and a cap
  // split into pieces by a single reflex flip only shows at a few core sizes
  // (issue #201: 28.31, 28.37 and 28.88 mm), so this sweeps off-grid sizes
  // across the range on every joint. (test/bayonet.test.ts sweeps 26 to 34 mm
  // in quarter-millimetre steps.)
  const SIZES = (from: number, to: number, step: number) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => Math.round((from + i * step) * 100) / 100);
  const cases: [string, number][] = [
    ...SIZES(20, 90, 2.3).map((size): [string, number] => ["bayonet", size]),
    ...[33, 28.31, 28.37, 28.88].map((size): [string, number] => ["bayonet", size]),
    ...SIZES(20.4, 90, 7.7).flatMap((size): [string, number][] => [["press", size], ["snap", size]]),
  ];

  it("every cap and core is one connected solid at any core size", async () => {
    const wasm = await Module();
    wasm.setup();
    const bad: string[] = [];
    for (const [joint, size] of cases) {
      const d = await design(spec({ joint: joint as CoilSpec["joint"], coreSize: { locked: true, dimension: "outer", value: size } }));
      for (const part of d.parts) {
        const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: part.mesh.positions, triVerts: part.mesh.indices }));
        const pieces = m.decompose();
        if (m.status() !== "NoError" || pieces.length !== 1) bad.push(`${joint} ${size} mm ${part.role}: ${pieces.length} pieces, ${m.status()}`);
        pieces.forEach((p) => p.delete());
        m.delete();
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);
});
