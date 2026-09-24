import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec } from "../src/core";

// Issue #4 acceptance criteria: `design()` returns the schematic wound-cable
// path per layer (orthocyclic offset and half-pitch shift), consistent with
// the solver's layers and turns. These tests exercise ONLY the public
// `design()` interface, per the testing decisions in docs/research.md.

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 30 },
    height: { locked: true, value: 40 },
    layers: { locked: true, value: 1 },
    objective: "minVolume",
    ...overrides,
  };
}

/** Radial distance from the coil axis (mm). */
function radiusAt(points: Float32Array, i: number): number {
  return Math.hypot(points[i * 3], points[i * 3 + 1]);
}

function zAt(points: Float32Array, i: number): number {
  return points[i * 3 + 2];
}

describe("design().wirePaths (issue #4)", () => {
  it("returns one path per layer with turns > 0, matching solution.layerResults", async () => {
    const d = await design(baseSpec());
    expect(d.solution.layerResults.length).toBeGreaterThan(0);
    expect(d.wirePaths).toHaveLength(d.solution.layerResults.length);
    for (const [i, path] of d.wirePaths.entries()) {
      expect(path.layer).toBe(d.solution.layerResults[i].layer);
      expect(path.turns).toBe(d.solution.layerResults[i].turns);
      expect(path.points.length % 3).toBe(0);
      expect(path.points.length).toBeGreaterThanOrEqual(6); // at least 2 samples
    }
  });

  it("the layer-1 path sits at the solved radial offset for the whole run", async () => {
    const d = await design(baseSpec());
    const [layer1] = d.wirePaths;
    const expectedRadius = d.solution.outerSize / 2 + d.solution.layerResults[0].offset;
    const sampleCount = layer1.points.length / 3;
    for (let i = 0; i < sampleCount; i++) {
      expect(radiusAt(layer1.points, i)).toBeCloseTo(expectedRadius, 3);
    }
  });

  it("climbs monotonically in z across the run, spanning roughly turns * pitch", async () => {
    const wireDiameter = 3.8;
    const clearance = 0.3;
    const d = await design(baseSpec({ wire: { length: 2000, diameter: wireDiameter, type: "usb" } }));
    const [layer1] = d.wirePaths;
    const sampleCount = layer1.points.length / 3;
    for (let i = 1; i < sampleCount; i++) {
      expect(zAt(layer1.points, i)).toBeGreaterThan(zAt(layer1.points, i - 1));
    }
    const span = zAt(layer1.points, sampleCount - 1) - zAt(layer1.points, 0);
    const pitch = wireDiameter + clearance;
    expect(span).toBeCloseTo(layer1.turns * pitch, 1);
  });

  it("a second orthocyclic layer sits at a larger radius (radialPitch offset) and is phase-shifted from layer 1", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 6000, diameter: 3.8, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 30 },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 2 },
        windingQuality: 1, // fully orthocyclic: the nominal half-pitch shift
      }),
    );
    expect(d.solution.layers).toBe(2);
    expect(d.wirePaths).toHaveLength(2);
    const [layer1, layer2] = d.wirePaths;

    const r1 = radiusAt(layer1.points, 0);
    const r2 = radiusAt(layer2.points, 0);
    expect(r2).toBeGreaterThan(r1);
    expect(r2 - r1).toBeCloseTo(d.solution.layerResults[1].offset - d.solution.layerResults[0].offset, 3);

    // At quality=1 the ideal half-pitch shift applies: layer 2 starts half a
    // pitch (in z) above layer 1's own start (docs/research.md §3).
    const pitch = 3.8 + 0.3;
    const z1 = zAt(layer1.points, 0);
    const z2 = zAt(layer2.points, 0);
    expect(z2 - z1).toBeCloseTo(pitch / 2, 3);
  });

  it("winding quality 0 (stacked) applies no phase shift between layers", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 6000, diameter: 3.8, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 30 },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 2 },
        windingQuality: 0,
      }),
    );
    const [layer1, layer2] = d.wirePaths;
    expect(zAt(layer2.points, 0)).toBeCloseTo(zAt(layer1.points, 0), 3);
  });

  it("omits layers with zero turns (a locked height too short to wind even one turn)", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 50, diameter: 3.8, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 30 },
        height: { locked: true, value: 5 }, // usable height (minus margins) is below one pitch
        layers: { locked: true, value: 1 },
      }),
    );
    expect(d.solution.layerResults[0].turns).toBe(0);
    expect(d.wirePaths).toHaveLength(0);
  });

  it("a many-turn coil still returns a bounded, densely-sampled path (no runaway sample count)", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 15000, diameter: 1.2, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 20 },
        height: { locked: true, value: 400 },
        layers: { locked: true, value: 1 },
      }),
    );
    const [layer1] = d.wirePaths;
    expect(layer1.turns).toBeGreaterThan(100);
    const sampleCount = layer1.points.length / 3;
    expect(sampleCount).toBeGreaterThan(layer1.turns); // at least one sample per turn
    expect(sampleCount).toBeLessThan(layer1.turns * 25); // but capped, not unbounded
  });
});
