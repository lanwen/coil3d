import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { design } from "../src/core";
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
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

/** The largest angle (degrees) between neighbouring corners on the collar's outer rim at its tip. */
function widestFacet(positions: Float32Array): number {
  let tip = Infinity;
  for (let i = 2; i < positions.length; i += 3) tip = Math.min(tip, positions[i]);
  const rim: [number, number][] = [];
  for (let i = 0; i < positions.length; i += 3) if (Math.abs(positions[i + 2] - tip) < 1e-3) rim.push([positions[i], positions[i + 1]]);
  const outer = Math.max(...rim.map(([x, y]) => Math.hypot(x, y)));
  const angles = rim
    .filter(([x, y]) => Math.hypot(x, y) > outer - 0.05)
    .map(([x, y]) => (Math.atan2(y, x) * 180) / Math.PI)
    .sort((a, b) => a - b);
  let widest = 0;
  for (let i = 0; i < angles.length; i++) {
    const gap = i + 1 < angles.length ? angles[i + 1] - angles[i] : angles[0] + 360 - angles[i];
    widest = Math.max(widest, gap);
  }
  return widest;
}

describe("the cap's collar wall (issue #200)", () => {
  it.each([60, 90])("a %i mm round core: no facet is wider than 3 degrees", async (size) => {
    const d = await design(spec({ coreSize: { locked: true, dimension: "outer", value: size } }));
    const cap = d.parts.find((p) => p.role === "topCap")!;
    expect(widestFacet(cap.mesh.positions)).toBeLessThanOrEqual(MAX_FACET_DEG);
  });

  // Finer columns change where the L-slot cutters cross the wall; the cap must stay one solid.
  it.each([
    ["press", 60],
    ["snap", 60],
    ["bayonet", 60],
    ["bayonet", 33],
    ["bayonet", 90],
  ] as const)("a %s cap on a %i mm core is one connected solid", async (joint, size) => {
    const wasm = await Module();
    wasm.setup();
    const d = await design(spec({ joint, coreSize: { locked: true, dimension: "outer", value: size } }));
    const cap = d.parts.find((p) => p.role === "topCap")!;
    const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: cap.mesh.positions, triVerts: cap.mesh.indices }));
    try {
      expect(m.status()).toBe("NoError");
      expect(m.decompose().length).toBe(1);
    } finally {
      m.delete();
    }
  });
});
