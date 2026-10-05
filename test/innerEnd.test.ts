import { describe, expect, it } from "vitest";
import { baseClipOpeningFraction, layoutInnerEnd } from "../src/core/innerEnd";

// innerEnd.ts's flange channel and clip layout is pure math. design() no longer cuts it (the inner end is held
// in the bore, test/centreEnds.test.ts), so what stays here is the layout's own arithmetic.

describe("inner-end clip layout (issues #8, #115, #117)", () => {
  it("the base clip's opening scales with the cable: a few percent under its diameter, never past the 45 degree overhang limit", () => {
    for (let d = 2; d <= 8; d += 0.25) {
      for (const tolerance of [0.05, 0.2, 0.4, 0.8]) {
        const fraction = baseClipOpeningFraction(d, tolerance);
        expect((Math.acos(fraction) * 180) / Math.PI, `d=${d} tol=${tolerance}`).toBeLessThanOrEqual(45);
        const opening = fraction * (d + tolerance);
        if (tolerance <= 0.2) expect(d - opening, `d=${d} tol=${tolerance}`).toBeCloseTo(0.08 * d, 9);
        expect(opening, `d=${d} tol=${tolerance}`).toBeGreaterThan(0.75 * d);
      }
    }
  });

  it("warns when the flange margin is too narrow for the lead-in, and says how wide it must be", () => {
    const outline = { n: 4, apothem: 30, cornerRadius: 30 };
    const layout = layoutInnerEnd(outline, 4, 3.8, 0.2, 15.2);
    expect(layout.requiredMargin).toBeGreaterThan(4);
    expect(layout.warning).toMatch(/too narrow.*bend radius/i);
    expect(layout.warning).toContain(layout.requiredMargin.toFixed(1));
    expect(layoutInnerEnd(outline, layout.requiredMargin + 1e-6, 3.8, 0.2, 15.2).warning).toBeUndefined();
  });
});
