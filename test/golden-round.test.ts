import { describe, expect, it } from "vitest";
import { design, parseHash } from "../src/core";
import { encodeHashDoc } from "../e2e/hashDoc";

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
  it("L=2000, d=3.8, outer size 60", async () => {
    const { spec, notice } = parseHash(encodeHashDoc({ L: 2000, d: 3.8, size: 60 }));
    expect(notice).toBeUndefined();
    const d = await design(spec);

    expect(d.solution.outerSize).toBe(60);
    expect(d.solution.innerBore).toBeCloseTo(53.96, 9);
    expect(d.solution.height).toBeCloseTo(55.894438344487675, 9);
    expect(d.solution.layers).toBe(1);
    expect(d.solution.layerResults[0].turns).toBe(11);
    expect(d.solution.layerResults[0].perimeter).toBeCloseTo(190.88316963211582, 9);
    expect(d.solution.layerResults[0].length).toBeCloseTo(2100.339882796659, 6);
    expect(d.solution.totalWoundLength).toBeCloseTo(2100.339882796659, 6);
    expect(d.solution.totalWireLength).toBeCloseTo(2100.339882796659, 6);
    expect(d.solution.envelopeDiameter).toBeCloseTo(64.56, 9);
    expect(d.solution.flangeSize).toBeCloseTo(67.56, 9); // issue #239: the envelope plus a 1.5 mm lip each side (was 4)
    expect(d.solution.minOuterSizeForBend).toBeCloseTo(29.64, 9);

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
    //
    // Issue #43 bumped it back UP from 27315.823587649567: the bottom
    // flange's own thickness is no longer a fixed 3mm -- it's now derived
    // from the 3.8mm cable's own diameter (idealChannelDepth + a shelf,
    // design.ts) so the wound cable's first turn lies flush instead of
    // riding over a bump, which adds real, intentional material of its own
    // (a thicker flange), not a regression this guard is meant to catch.
    //
    // Issue #115 bumped it UP again from 31705.93202629695: the inner cable
    // end now leaves the groove start along a straight tangential chord
    // that must hold the keyhole past the end of its bend-radius-limited
    // drop into the channel, which needs a wider flange margin here (6.7 mm
    // -> 10.2 mm for this 3.8 mm USB cable's 15.2 mm bend radius) -- real,
    // intentional material, with its own "Flange margin increased" warning.
    //
    // Issue #117 bumped it UP again from 36108.31213927501: the keyhole became
    // a clip along the cable whose lips must sit past the end of the drop and
    // a wall inside the rim, so the margin grows again (10.2 mm -> 11.8 mm),
    // and the swept round channel no longer cuts a through-hole -- real,
    // intentional material, with the same warning.
    //
    // Issue #122 bumped it DOWN from 38287.458428563026: the bottom flange is
    // now a 3 mm plate, only 5.3 mm (this cable's channel depth + shelf) on
    // pads under the wall and along the channel -- material intentionally
    // removed, not a regression.
    //
    // Issue #133 bumped it UP from 33646.19380608499: the channel pad now
    // blends into that collar -- a fillet on the wall side, a tapering tail
    // on the other -- instead of meeting it in a sharp corner.
    //
    // Issue #219 bumped it DOWN from 33772.23933421279 (by 0.43 mm^3): every
    // ring of the channel's bore now puts its vertices at the same angles, so
    // along the clip's lips the round bore is sampled at about 11 degrees
    // instead of 16. The finer polygon lies closer to the circle, so the
    // channel cuts a hair more -- the same channel, sampled more finely.
    //
    // Issue #229 bumped it DOWN from 33771.81426147255 (by 253.58 mm^3): the flange's outer edge is chamfered 1 mm on
    // both faces, which takes 2 x 0.5 mm^2 of section along the 41.8 mm radius rim (about 260 mm^3), less the rim
    // where the channel leaves and its pad keeps the square edge (the pads reach 1 mm into the plate now, FLANGE_PAD_EMBED).
    //
    // The base clip's lips bumped it DOWN from 33518.23794984431 (by 3.21 mm^3): the opening is 0.5 mm wider (3.5 mm
    // instead of 3.0 mm on this 3.8 mm cable) and its edge is chamfered, over the clip's 5.7 mm length.
    //
    // The deeper groove moved every number above on purpose (from main's 54 mm bore, 51.1 mm height, 193.27 mm
    // perimeter, 2126.46 mm length, 65.32/73.32 mm envelope/flange, 28.88 mm bend floor): the cable's centre now sits
    // 0.38 mm out from the ridges (0.1 d, was 0.76 mm), so the perimeter, envelope and bend floor shrink by that much;
    // the 4.66 mm pitch (was 4.1) and the first turn starting on the flange face set the height; and the 1.52 mm deep
    // groove needs a 3.02 mm wall (was 3), so the bore shrinks a hair. The volume went UP from 33515.030333815084 with
    // the taller wall and the wider flange margin (14.0 mm, was 11.8: the cable now shifts clear of the wall on the face
    // before it drops into the channel).
    //
    // Issue #241 bumped it DOWN from 34726.67926875156 (by 48.48 mm^3): the rim cable slot, a keyhole cut through
    // the 3 mm plate (a 4 mm seat, a 3.5 mm neck and its lead-in through the rim chamfer), and the pads reaching
    // 0.25 mm below the rim chamfer's foot (fuzz case 1097). The margin is unchanged (the inner end sets it).
    //
    // Issue #239 bumped it UP from 34678.197056711804 (by 421.63 mm^3): the inner end's clip keeps 1.5 mm of flange to
    // the rim instead of 1 mm (the rim chamfer plus half a millimetre), and the inner end sets this margin, so it grows
    // by 0.5 mm all round.
    expect(meshVolume(d.mesh)).toBeCloseTo(35099.827662282645, 3);
  });
});
