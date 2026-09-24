import { describe, expect, it } from "vitest";
import { design } from "../src/core";

describe("design() solver (round core, single layer)", () => {
  it("solves turns/wound length/leftover tail/height from length, diameter and core size", async () => {
    const spec = { wireLength: 1000, wireDiameter: 4, coreSize: 40 };
    const d = await design(spec);

    // Mirror the core's own constants to compute the expected values
    // independently (docs/research.md §3).
    const grooveDepth = 0.3 * spec.wireDiameter;
    const wireOffset = spec.wireDiameter / 2 - grooveDepth;
    const centerlineRadius = spec.coreSize / 2 + wireOffset;
    const perimeter = 2 * Math.PI * centerlineRadius;
    const pitch = spec.wireDiameter + 0.3;
    const expectedTurns = Math.floor(spec.wireLength / perimeter);
    const expectedWound = expectedTurns * perimeter;
    const expectedTail = spec.wireLength - expectedWound;
    const expectedHeight = 2 * 3 + expectedTurns * pitch;

    expect(d.turns).toBe(expectedTurns);
    expect(d.perimeter).toBeCloseTo(perimeter, 6);
    expect(d.pitch).toBeCloseTo(pitch, 6);
    expect(d.woundLength).toBeCloseTo(expectedWound, 6);
    expect(d.leftoverTail).toBeCloseTo(expectedTail, 6);
    expect(d.height).toBeCloseTo(expectedHeight, 6);
    expect(d.warnings).toEqual([]);
  });

  it("reports leftover tail strictly less than one turn's worth of cable", async () => {
    const d = await design({ wireLength: 2000, wireDiameter: 3.8, coreSize: 30 });
    expect(d.leftoverTail).toBeGreaterThanOrEqual(0);
    expect(d.leftoverTail).toBeLessThan(d.perimeter);
    expect(d.turns).toBeGreaterThan(0);
  });

  it("warns and clamps to one turn when the cable is shorter than the core's circumference", async () => {
    const d = await design({ wireLength: 10, wireDiameter: 3.8, coreSize: 30 });
    expect(d.turns).toBe(1);
    expect(d.warnings.some((w) => /shorter than one turn/i.test(w))).toBe(true);
  });

  it("warns when the core is too small for the fixed wall thickness", async () => {
    const d = await design({ wireLength: 500, wireDiameter: 2, coreSize: 4 });
    expect(d.warnings.some((w) => /too small/i.test(w))).toBe(true);
    expect(d.boreRadius).toBeGreaterThan(0);
  });
});
