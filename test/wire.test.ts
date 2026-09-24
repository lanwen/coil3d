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
    topCap: "auto",
    joint: "press",
    tolerance: 0.2,
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

  it("a rounded-square core's wire follows the true offset outline, not a circle (issue #6 follow-up)", async () => {
    // A big outer size and a corner radius comfortably clear of the
    // bend-limit floor (see solve.ts's "became round" clamp): otherwise the
    // solver rounds the corner radius up toward the apothem and the outline
    // is indistinguishable from a circle, defeating the point of this test.
    const d = await design(
      baseSpec({
        shape: { kind: "sq", cornerRadius: 20 },
        coreSize: { locked: true, dimension: "outer", value: 80 },
      }),
    );
    expect(d.warnings.some((w) => /clamped/i.test(w))).toBe(false);
    const [layer1] = d.wirePaths;
    const sampleCount = layer1.points.length / 3;
    const radii = Array.from({ length: sampleCount }, (_, i) => radiusAt(layer1.points, i));

    // A circle has a constant radius at every sample; a rounded square's
    // offset outline does not (flat sides sit closer to the axis than the
    // rounded corners) -- this is the regression this test guards.
    const minRadius = Math.min(...radii);
    const maxRadius = Math.max(...radii);
    expect(maxRadius - minRadius).toBeGreaterThan(1);

    // The inscribed radius (mid-flat-side) and the true circumscribed radius
    // (corner-arc midpoint) are exact, independent of the outline math
    // (docs/research.md §2 "inscribedRadius"/"circumscribedRadius", n=4 for
    // a square): apothem = outerSize/2, Rc = (apothem - cornerRadius)/cos(pi/4).
    const offset = d.solution.layerResults[0].offset;
    const apothem = d.solution.outerSize / 2;
    const cornerRadius = d.solution.cornerRadius;
    const expectedMin = apothem + offset;
    const Rc = (apothem - cornerRadius) / Math.cos(Math.PI / 4);
    const expectedMax = Rc + cornerRadius + offset;
    expect(minRadius).toBeCloseTo(expectedMin, 1);
    expect(maxRadius).toBeCloseTo(expectedMax, 1);
  });

  it("a rounded-triangle core's wire also follows the true offset outline", async () => {
    const d = await design(
      baseSpec({
        shape: { kind: "tri", cornerRadius: 20 },
        coreSize: { locked: true, dimension: "outer", value: 80 },
      }),
    );
    expect(d.warnings.some((w) => /clamped/i.test(w))).toBe(false);
    const [layer1] = d.wirePaths;
    const sampleCount = layer1.points.length / 3;
    const radii = Array.from({ length: sampleCount }, (_, i) => radiusAt(layer1.points, i));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(1);
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
    // At least the documented final-resolution floor (issue #4 review:
    // >= 96 samples/turn so the tube reads smooth, not faceted) ...
    expect(sampleCount).toBeGreaterThanOrEqual(layer1.turns * 90);
    // ... but bounded, not unbounded (the arc-length target can push this
    // higher for a big perimeter, so this just guards against a runaway).
    expect(sampleCount).toBeLessThan(layer1.turns * 200);
  });

  it("final resolution samples far more densely per turn than draft (issue #7 budget)", async () => {
    const spec = baseSpec({
      wire: { length: 2000, diameter: 3.8, type: "usb" },
      coreSize: { locked: true, dimension: "outer", value: 30 },
      height: { locked: true, value: 40 },
      layers: { locked: true, value: 1 },
    });
    const draft = await design(spec, "draft");
    const final = await design(spec, "final");
    const samplesPerTurn = (d: typeof draft) => d.wirePaths[0].points.length / 3 / d.wirePaths[0].turns;
    expect(samplesPerTurn(final)).toBeGreaterThan(samplesPerTurn(draft) * 2);
    expect(samplesPerTurn(final)).toBeGreaterThanOrEqual(90);
  });
});
