// Issue #92: `radiusAtAngle`'s arc-vs-flat-side classification uses the
// wrong cutoff angle -- `asin(cornerRadius/Rc)`, the angle at which a ray
// from the centre is TANGENT to the corner arc's own circle, not the angle
// of the actual tangent POINT where that arc meets the flat side (see
// shapes.ts's `radiusAtAngle` for the fix and the derivation). The two
// coincide only in the limit cornerRadius -> 0; once `cornerRadius + offset`
// grows large relative to the corner's own centre radius `Rc`, the wrong
// cutoff over-extends the "on the corner arc" region well past the real
// tangent point, so angles that are actually on the flat side get the
// corner-circle formula instead -- concretely reproduced by wire.ts's own
// bridge comment (issue #90): apothem=31.45, cornerRadius=14.44, offset=4.2
// (a square) returned ~24.6mm at the flat side's own 45-degree midpoint,
// where the true boundary (this test's own independent oracle) sits at
// ~35.7mm.
//
// This test brute-forces the true boundary distance independently of
// `radiusAtAngle`'s own analytic formula and classification -- see
// test/support/bruteForceRadius.ts for how.

import { describe, expect, it } from "vitest";
import { makeOutline, offsetOutline, radiusAtAngle } from "../src/core/shapes";
import type { ShapeOutline } from "../src/core/shapes";
import { bruteForceRadiusAtAngle, coarseOutlineScan } from "./support/bruteForceRadius";

const ROUND = makeOutline("round", 60, 0);
const SQ = makeOutline("sq", 60, 10);
const TRI = makeOutline("tri", 60, 8);

const OFFSETS: Record<string, number[]> = {
  // Round degenerates to a single point (zero radius) at offset exactly
  // -cornerRadius (apothem === cornerRadius for round, by construction --
  // see shapes.ts's file header) -- no outline left to ray-intersect, and no
  // arc-vs-flat classification to check anyway (round has none). Stop a
  // hair short of it instead.
  round: [-ROUND.cornerRadius + 0.01, -ROUND.cornerRadius / 2, -1, 0, 1, 5, 15, 50],
  sq: [-SQ.cornerRadius, -SQ.cornerRadius / 2, -1, 0, 1, 5, 15, 50],
  tri: [-TRI.cornerRadius, -TRI.cornerRadius / 2, -1, 0, 1, 5, 15, 50],
};

// A non-round-number step so angles land at varied offsets from corner
// centres and side midpoints alike (not always exactly on a boundary).
const ANGLES: number[] = [];
for (let i = 0; i < 37; i++) ANGLES.push((2 * Math.PI * i) / 37);

describe("radiusAtAngle matches brute-force ray/outline intersection (issue #92)", () => {
  const cases: [string, ShapeOutline][] = [
    ["round", ROUND],
    ["sq", SQ],
    ["tri", TRI],
  ];

  for (const [name, base] of cases) {
    for (const offset of OFFSETS[name]) {
      it(`${name} at offset=${offset}mm matches the brute-force outline within 0.01mm at every sampled angle`, () => {
        const o = offsetOutline(base, offset);
        const scan = coarseOutlineScan(base, offset);
        for (const phi of ANGLES) {
          const expected = bruteForceRadiusAtAngle(scan, base, offset, phi);
          const actual = radiusAtAngle(o, phi);
          expect(Math.abs(actual - expected), `phi=${phi.toFixed(4)} rad, offset=${offset}: got ${actual}, expected ${expected}`).toBeLessThanOrEqual(0.01);
        }
      });
    }
  }
});
