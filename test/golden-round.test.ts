import { describe, expect, it } from "vitest";
import { design, parseHash } from "../src/core";

// Regression guard (PR #24 review): issue #6 generalises the round core's
// geometry construction (shapes.ts/wall.ts/manifold.ts) to share code with
// the new rounded-square/triangle shapes. This pins the round coil's
// solver numbers AND mesh volume, for a fixed hash, to the exact values
// produced by `main` before this PR (commit 812d95b, captured independently
// via a detached checkout running the unmodified code) -- not just an
// after-the-fact hand calculation, so a regression in either the solver
// or the geometry backend fails this test even if it doesn't change the
// analytic estimate in test/design.test.ts/test/geometry.test.ts.
//
// This intentionally does NOT catch a pure rotation about the coil's own
// axis (mesh volume is rotation-invariant by construction) -- see the
// note above test/geometry.test.ts's `describe` blocks for why that class
// of bug is an e2e-screenshot concern, not a vitest one.
function meshVolume(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  const { positions: v, indices: t } = mesh;
  let volume = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const c = t[i + 2] * 3;
    volume +=
      (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
        v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
        v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) /
      6;
  }
  return Math.abs(volume);
}

describe("round core matches main's golden numbers for a fixed hash (issue #6 regression)", () => {
  it("#v=1&L=2000&d=3.8&lock=outer,ly&size=60", async () => {
    const { spec, notice } = parseHash("#v=1&L=2000&d=3.8&lock=outer,ly&size=60");
    expect(notice).toBeUndefined();
    const d = await design(spec);

    expect(d.solution.outerSize).toBe(60);
    expect(d.solution.innerBore).toBe(54);
    expect(d.solution.height).toBe(51.099999999999994);
    expect(d.solution.layers).toBe(1);
    expect(d.solution.layerResults[0].turns).toBe(11);
    expect(d.solution.layerResults[0].perimeter).toBeCloseTo(193.27078004884407, 9);
    expect(d.solution.layerResults[0].length).toBeCloseTo(2126.456897024562, 6);
    expect(d.solution.totalWoundLength).toBeCloseTo(2126.456897024562, 6);
    expect(d.solution.totalWireLength).toBeCloseTo(2126.456897024562, 6);
    expect(d.solution.envelopeDiameter).toBeCloseTo(65.32, 9);
    expect(d.solution.flangeSize).toBeCloseTo(73.32, 9);
    expect(d.solution.minOuterSizeForBend).toBeCloseTo(28.88, 9);

    // Vertex/triangle counts are NOT pinned here: the raw wall mesh (before
    // the flange is fused on) has the exact same counts as main's (verified
    // directly, 9400 vertices/18800 triangles both ways) -- the ~0.4% delta
    // shows up only after manifold-3d's boolean union with the flange,
    // whose construction intentionally changed (issue #6: the flange is now
    // its own outline-shaped mesh, not `Manifold.cylinder().subtract()`, so
    // it can follow a non-round outline too). Volume is the meaningful,
    // stable invariant; manifold-3d's own dedup/welding vertex count is that
    // library's implementation detail, not a property of the physical part.
    //
    // Issue #8 bumped this golden number down from 27373.35113865865: every
    // core now ALWAYS gets the bottom flange's own inner-end fixing (rim
    // keyhole + recessed channel, see innerEnd.ts), which removes real,
    // intentional material -- not a regression this guard is meant to catch.
    expect(meshVolume(d.mesh)).toBeCloseTo(27315.823587649567, 3);
  });
});
