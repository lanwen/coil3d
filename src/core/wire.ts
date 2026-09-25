// The schematic wound-cable path per layer (issue #4, docs/research.md §5
// "Wire schematic"). This does NOT model the physical wire as its own solid
// (it is never exported); it is a dense centerline sample the viewer lofts
// into tube geometry, so the wound cable reads as a distinct body in the
// line-art renderer.
//
// Reuses the exact numbers the solver and the wall already computed --
// `LayerResult.offset`/`.turns`/`.perimeter` (capacity.ts) and the wall's own
// groove `pitch`/`zStart` (wall.ts's `createWallProfile`, shared so layer 1's
// wire sits centered in the printed groove) -- so this can never drift from
// the solved geometry it is meant to illustrate. The (x, y) position at each
// sample comes from `shapes.ts`'s `pointAt(outline, t, offset)`, the same
// arc-length-parameterised outline function the wall's own helix and the
// STEP B-spline fit both sample, so a rounded-square or rounded-triangle
// core's wire follows the real offset outline, not a circle.
//
// Issue #68 ("one continuous cable"): a real coil is TRAVERSE-wound -- the
// core spins in one direction for the entire wind, never reversing, while
// layer 2 nests into layer 1's valleys by continuing to rotate the SAME way
// but reversing which way the wire climbs in Z (up for layer 1, down for
// layer 2, up again for layer 3, ...), so each new layer picks up right
// where the previous one left off instead of restarting near the bottom
// flange every time (the bug: "several cable beginnings"). `buildWirePaths`
// below bakes that alternation directly into each layer's own Z formula
// (odd layers climb, even layers descend) while (x, y) keeps the exact same
// monotonically-increasing `phi` every layer already used -- so layer 1's
// own samples, and everything that already depended on them (the layer-1
// invariants tests, the inner-end lead-in below), are completely unchanged.
// `buildLayerTransitions`/`buildOuterEndLeadOut` then bridge the small
// remaining gap (a phase-shift's worth of angle and z) between consecutive
// layers' now-adjacent ends, and from the last layer's end to the top cap's
// own rim keyhole, with a Hermite curve pinned to each side's own exact
// endpoint and tangent -- so gap is exactly zero and the tangent direction
// at every join matches the adjoining curve's own, by construction.

import {
  DRAFT_WIRE_MAX_ARC_LENGTH,
  DRAFT_WIRE_MIN_SAMPLES_PER_TURN,
  FINAL_WIRE_MAX_ARC_LENGTH,
  FINAL_WIRE_MIN_SAMPLES_PER_TURN,
} from "./constants";
import { clamp01 } from "./capacity";
import type { XY } from "./innerEnd";
import { pointAt } from "./shapes";
import { createWallProfile, type WallSpec } from "./wall";
import type { LayerResult, Resolution } from "./types";
import type { WireLayerPath } from "./types";

// A hard safety backstop on total samples per layer, so a pathological input
// (well outside the solver's practical bounds) can't allocate unbounded
// memory: if the arc-length target would exceed it, density is scaled back
// (never below MIN_SAMPLES_PER_TURN_FLOOR) rather than sampling that densely.
// Realistic designs never get close to this (a few hundred turns at 96+
// samples/turn is a few tens of thousands of samples).
const MAX_TOTAL_SAMPLES_PER_LAYER = 300_000;
const MIN_SAMPLES_PER_TURN_FLOOR = 8;

/**
 * Samples per turn for the given per-turn helix length (arc length of one
 * full wound turn, `sqrt(perimeter^2 + pitch^2)`): at least `minPerTurn`
 * (so even a tiny turn is smooth), and enough to keep consecutive samples
 * at most `maxArcLength` mm apart along the curve (so a big, slow-curving
 * turn -- a large square or triangle core -- still gets a dense sample
 * along its straight sides, not just its corners).
 */
function samplesPerTurn(helixLength: number, minPerTurn: number, maxArcLength: number): number {
  return Math.max(minPerTurn, Math.ceil(helixLength / maxArcLength));
}

/**
 * Each new layer nests into the valleys of the layer directly below it, an
 * offset of up to half a pitch (docs/research.md §3 "Orthocyclic winding").
 * Nesting into a half-pitch-shifted layer's valleys shifts by another half
 * pitch, so the cumulative shift alternates between 0 and half a pitch
 * (mod 1 pitch) rather than growing layer over layer -- hence `% 2`, not a
 * running total. `quality` (0..1) blends this toward 0 (stacked, no shift)
 * exactly like `radialPitch` blends the radial offset (capacity.ts).
 */
function phaseShiftTurns(layer: number, quality: number): number {
  return ((layer - 1) % 2) * clamp01(quality) * 0.5;
}

/**
 * Build the schematic wire centerline for every wound layer.
 *
 * `resolution` (issue #7) gates sample density exactly like the mesh's own
 * draft/final column counts: "draft" is cheap enough to stay responsive
 * while the user is still dragging a slider, "final" is dense enough for a
 * smooth on-screen tube (the wire path is never exported, so there is no
 * third, even-denser "for export" tier the way the mesh has one for STL/STEP).
 *
 * Traverse winding (issue #68, see file header): odd layers (1, 3, 5, ...)
 * climb in Z exactly as before (`zStart + pitch*phi`, unchanged -- every
 * existing layer-1 invariant, and the inner-end lead-in's own connection
 * into it, still holds bit-for-bit). Even layers (2, 4, ...) use the exact
 * same `phi` sequence (same (x, y), same monotonically-increasing angle --
 * the core keeps spinning the SAME way) but mirror the Z formula about that
 * layer's own midpoint, so it DESCENDS instead: sample 0 (chronologically
 * this layer's very first turn) lands at that layer's own TOP -- right next
 * to where the previous (climbing) layer just finished -- and the last
 * sample lands at the bottom, right where the next (climbing) layer will
 * start. Every layer's array is still ordered start-to-end chronologically,
 * so `buildLayerTransitions` below can bridge ANY two adjacent layers the
 * same way, with no odd/even branching of its own: always the end of one
 * array to the start of the next.
 */
export function buildWirePaths(layerResults: LayerResult[], wallSpec: WallSpec, windingQuality: number, resolution: Resolution): WireLayerPath[] {
  const profile = createWallProfile(wallSpec);
  const { pitch, zStart } = profile;
  const { outline } = wallSpec;
  const [minPerTurn, maxArcLength] =
    resolution === "draft" ? [DRAFT_WIRE_MIN_SAMPLES_PER_TURN, DRAFT_WIRE_MAX_ARC_LENGTH] : [FINAL_WIRE_MIN_SAMPLES_PER_TURN, FINAL_WIRE_MAX_ARC_LENGTH];
  const paths: WireLayerPath[] = [];

  for (const { layer, turns, offset, perimeter } of layerResults) {
    if (turns <= 0) continue;

    const helixLength = Math.hypot(perimeter, pitch);
    let perTurn = samplesPerTurn(helixLength, minPerTurn, maxArcLength);
    if (turns * perTurn > MAX_TOTAL_SAMPLES_PER_LAYER) {
      perTurn = Math.max(MIN_SAMPLES_PER_TURN_FLOOR, Math.floor(MAX_TOTAL_SAMPLES_PER_LAYER / turns));
    }

    const shift = phaseShiftTurns(layer, windingQuality);
    const sampleCount = Math.max(2, Math.round(turns * perTurn) + 1);
    // Odd layers (1-indexed): climb, unchanged. Even layers: descend --
    // mirror the climbing Z about this layer's own start+end mean, i.e.
    // `zStart + pitch*(2*shift + turns - phi)` (see the doc comment above).
    const climbs = (layer - 1) % 2 === 0;

    const points = new Float32Array(sampleCount * 3);
    for (let i = 0; i < sampleCount; i++) {
      const phi = (turns * i) / (sampleCount - 1) + shift;
      const p = pointAt(outline, phi, offset);
      points[i * 3] = p.x;
      points[i * 3 + 1] = p.y;
      points[i * 3 + 2] = climbs ? zStart + pitch * phi : zStart + pitch * (2 * shift + turns - phi);
    }

    paths.push({ layer, turns, points });
  }

  return paths;
}

/** A 3D point (mm), used only by the Hermite bridges below -- never exposed on the public `Design`. */
interface XYZ {
  x: number;
  y: number;
  z: number;
}

/**
 * How densely to sample each bridge (layer-to-layer transition, the
 * outer-end lead-out, and the inner-end lead-in's own second bridge): short
 * curves, but dense enough to loft a smooth tube AND to keep the FIRST/LAST
 * sampled segment's direction a close approximation of the curve's true
 * (exact) endpoint derivative -- the tangent-angle continuity check (issue
 * #68 AC, test/wire.test.ts) samples that same first/last segment, so too
 * coarse a bridge would measure a bigger angle than the curve, built from an
 * exact derivative match, actually has.
 */
const BRIDGE_SAMPLES = 64;

function samplePoint(points: Float32Array, i: number): XYZ {
  return { x: points[i * 3], y: points[i * 3 + 1], z: points[i * 3 + 2] };
}

/** Unit vector from `a` to `b` (falls back to +Z for a degenerate zero-length pair, which never actually loses direction -- the caller always scales it back down to zero via `chord` in that same case). */
function unitTangent(a: XYZ, b: XYZ): XYZ {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  return len > 1e-9 ? { x: dx / len, y: dy / len, z: dz / len } : { x: 0, y: 0, z: 1 };
}

/** The standard cubic Hermite basis weights at `s` in [0, 1] for (value0, derivative0, value1, derivative1). */
function hermiteBasis(s: number): [number, number, number, number] {
  const s2 = s * s;
  const s3 = s2 * s;
  return [2 * s3 - 3 * s2 + 1, s3 - 2 * s2 + s, -2 * s3 + 3 * s2, s3 - s2];
}

/**
 * A short ramp from `p0` (unit exit tangent `t0`) to `p1` (unit entry
 * tangent `t1`), sampled densely, built in CYLINDRICAL coordinates (radius,
 * angle, z) around the coil axis rather than raw Cartesian space -- three
 * independent 1D Hermite curves, one per channel, each pinned to that
 * channel's own value AND derivative at both ends (the radial/tangential/
 * axial components of `t0`/`t1` in that point's own local frame, scaled by
 * the Cartesian chord length, the standard Hermite tangent-magnitude
 * convention). Converting back to Cartesian (`r*cos(theta), r*sin(theta),
 * z`) reconstructs `p0`/`p1` and their tangent directions EXACTLY (to
 * floating-point precision), for the same reason `hermiteBridge` (the
 * plain-Cartesian version this replaced) did -- but with one crucial
 * difference: `radius(s)` is now interpolated DIRECTLY, so it stays close
 * to `r0`/`r1` throughout, instead of implicitly following the straight
 * Cartesian chord between two points that can sit far apart in angle (up to
 * half a turn, at a full orthocyclic phase shift) -- a chord between two
 * points that far apart around a circle cuts deep into the middle, which
 * made an earlier version of this bridge visibly dip in toward the coil's
 * own axis instead of hugging its surface. `theta(s)` takes the SHORTEST
 * angular path between the two points (at most half a turn either way) --
 * NOT a "always forward, spindle never reverses" rule an earlier version of
 * this function tried to enforce: for a non-round outline, a corner arc's
 * own local centre sits off the global axis (shapes.ts's `evalOutline`), so
 * two samples that share the same winding parameter `t` (a "physically
 * forward" step of essentially zero) can still land at a GLOBAL angle
 * (`atan2`) that drifts slightly BACKWARD -- forcing that case to still go
 * "forward" swept nearly an entire extra turn all the way around the coil,
 * a dramatic, wrong-looking loop for what should be the shortest of hops.
 * The shortest-path rule sidesteps that failure mode entirely, and is
 * indistinguishable from the forward-only rule in the one case that
 * originally motivated it (the layer-to-layer phase shift, capped at half a
 * turn either way by `phaseShiftTurns`).
 */
function cylindricalBridge(p0: XYZ, t0: XYZ, p1: XYZ, t1: XYZ, samples: number): Float32Array {
  const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z) || 1;
  const r0 = Math.hypot(p0.x, p0.y);
  const r1 = Math.hypot(p1.x, p1.y);
  const theta0 = Math.atan2(p0.y, p0.x);
  const rawTheta1 = Math.atan2(p1.y, p1.x);
  const twoPi = 2 * Math.PI;
  const shortestDelta = (((rawTheta1 - theta0 + Math.PI) % twoPi) + twoPi) % twoPi - Math.PI;
  const theta1 = theta0 + shortestDelta;

  // Decompose a unit tangent into this point's own local (radial,
  // tangential, z) basis -- `dr/ds`, `r*dtheta/ds` and `dz/ds` respectively.
  const decompose = (t: XYZ, r: number, theta: number) => {
    const ur = { x: Math.cos(theta), y: Math.sin(theta) };
    const ut = { x: -Math.sin(theta), y: Math.cos(theta) };
    const dr = t.x * ur.x + t.y * ur.y;
    const dTangential = t.x * ut.x + t.y * ut.y;
    return { dr, dTheta: dTangential / Math.max(r, 1e-6), dz: t.z };
  };
  const d0 = decompose(t0, r0, theta0);
  const d1 = decompose(t1, r1, theta1);

  const points = new Float32Array(samples * 3);
  for (let i = 0; i < samples; i++) {
    const s = i / (samples - 1);
    const [h00, h10, h01, h11] = hermiteBasis(s);
    const r = h00 * r0 + h10 * d0.dr * chord + h01 * r1 + h11 * d1.dr * chord;
    const theta = h00 * theta0 + h10 * d0.dTheta * chord + h01 * theta1 + h11 * d1.dTheta * chord;
    const z = h00 * p0.z + h10 * d0.dz * chord + h01 * p1.z + h11 * d1.dz * chord;
    points[i * 3] = r * Math.cos(theta);
    points[i * 3 + 1] = r * Math.sin(theta);
    points[i * 3 + 2] = z;
  }
  return points;
}

/**
 * The short ramp bridging the chronological end of one wound layer to the
 * start of the next (issue #68 AC: "smooth layer-to-layer transitions -- a
 * short ramp at the end of each layer up to the next"). Every layer's own
 * `points` array is already ordered start-to-end chronologically (see
 * `buildWirePaths`'s doc comment), so this needs no odd/even case of its
 * own: always the last sample of `paths[i]` to the first sample of
 * `paths[i + 1]`, one bridge per adjacent pair. Empty layers were already
 * dropped by `buildWirePaths`, so `paths` may skip a layer number; the
 * bridge still connects whichever two layers actually ended up adjacent in
 * the array, which is the best a schematic can do for that edge case.
 */
export function buildLayerTransitions(paths: WireLayerPath[]): Float32Array[] {
  const transitions: Float32Array[] = [];
  for (let i = 0; i + 1 < paths.length; i++) {
    const a = paths[i].points;
    const b = paths[i + 1].points;
    const aCount = a.length / 3;
    const bCount = b.length / 3;
    if (aCount < 2 || bCount < 2) continue;

    const p0 = samplePoint(a, aCount - 1);
    const t0 = unitTangent(samplePoint(a, aCount - 2), p0);
    const p1 = samplePoint(b, 0);
    const t1 = unitTangent(p1, samplePoint(b, 1));
    transitions.push(cylindricalBridge(p0, t0, p1, t1, BRIDGE_SAMPLES));
  }
  return transitions;
}

/**
 * The outer-end lead-out (issue #68, docs/research.md "Wire ends": "Outer
 * end: keyhole in the top cap rim"): from the chronological end of the last
 * wound layer to the top cap's own rim keyhole -- `hole`, in the shared
 * assembly frame's XY (identical formula to the bottom flange's own
 * `InnerEndLayout.hole`, `innerEnd.ts`'s `layoutInnerEnd`, since both
 * keyholes are cut from the SAME outline/margin/wireDiameter/tolerance at
 * the same t=0 reference point -- see `manifold.ts`'s `buildKeyholeCutter`),
 * at `topZ` (the assembled height the top cap's keyhole actually sits at).
 * The target tangent points straight up (+Z): the cable is drawn leaving
 * through the rim keyhole, not skimming across the cap's face. Computed
 * unconditionally (not gated on the top cap actually being enabled) so the
 * schematic's own "outer end" is always well-defined, exactly like the
 * bottom's `channelPath`/`buildInnerEndLeadIn` never depends on any OTHER
 * part either.
 */
export function buildOuterEndLeadOut(paths: WireLayerPath[], hole: XY, topZ: number): Float32Array {
  if (paths.length === 0) return new Float32Array(0);
  const last = paths[paths.length - 1].points;
  const count = last.length / 3;
  if (count < 2) return new Float32Array(0);

  const p0 = samplePoint(last, count - 1);
  const t0 = unitTangent(samplePoint(last, count - 2), p0);
  const p1: XYZ = { x: hole.x, y: hole.y, z: topZ };
  const t1: XYZ = { x: 0, y: 0, z: 1 };
  return cylindricalBridge(p0, t0, p1, t1, BRIDGE_SAMPLES);
}

/**
 * The inner-end lead-in centerline (issue #8, docs/research.md "Wire ends"):
 * `innerEnd.ts`'s own `channelPath` (keyhole-to-groove order), flattened flat
 * at z=0 (the flange's inner face -- the channel is a shallow recess there,
 * not a helix). Deliberately kept OUT of `buildWirePaths`'s own per-layer
 * `WireLayerPath.points` (layer 1's path there sits at one constant radial
 * offset for its WHOLE run and climbs z monotonically at a constant pitch --
 * invariants test/wire.test.ts checks precisely -- which a flat, varying-
 * radius lead-in prefix would break): a separate small curve the viewer
 * draws alongside layer 1's own tube instead, so the wound-cable schematic
 * still reads as one continuous line from the keyhole through the channel
 * into the groove, without disturbing layer 1's own solved geometry.
 *
 * `channelPath`'s own last sample is the fillet's tangent point (issue #8's
 * "tangent ramp"), not literally layer 1's own wire centerline: it sits at
 * the WALL's nominal (ungrooved) surface, one fillet radius short of t=0,
 * while layer 1's sampled centerline (`layer1.points[0]`) sits at t=0
 * exactly, at its own solved (usually inward, embedded-in-the-groove) radial
 * offset -- a real few-mm gap innerEnd.ts's cutter construction deliberately
 * leaves (it only has to cut a valid trench, not reach a specific
 * schematic's centerline). Issue #68 tightens this: when `layer1` is given,
 * a second Hermite bridge (see `buildLayerTransitions`'s own comment) closes
 * that exact gap, tangent to each side's own real direction, so the combined
 * curve this returns has ZERO gap into `wirePaths[0]`, not just "close".
 * Never touches innerEnd.ts's own `channelPath`/`channelRibbon` -- those
 * still drive the REAL printed trench (manifold.ts/step/build.ts), which
 * must stay exactly as issue #8 shipped it.
 */
export function buildInnerEndLeadIn(channelPath: XY[], layer1?: WireLayerPath): Float32Array {
  const flat = new Float32Array(channelPath.length * 3);
  for (let i = 0; i < channelPath.length; i++) {
    flat[i * 3] = channelPath[i].x;
    flat[i * 3 + 1] = channelPath[i].y;
    flat[i * 3 + 2] = 0;
  }
  if (!layer1 || layer1.points.length < 6 || channelPath.length < 2) return flat;

  const p0 = samplePoint(flat, channelPath.length - 1);
  const t0 = unitTangent(samplePoint(flat, channelPath.length - 2), p0);
  const p1 = samplePoint(layer1.points, 0);
  const t1 = unitTangent(p1, samplePoint(layer1.points, 1));
  const bridge = cylindricalBridge(p0, t0, p1, t1, BRIDGE_SAMPLES);

  // Drop the bridge's own first sample: it's identical to `flat`'s last
  // sample (both are `p0`), so keeping it would insert a zero-length
  // segment at the seam.
  const combined = new Float32Array(flat.length + bridge.length - 3);
  combined.set(flat, 0);
  combined.set(bridge.subarray(3), flat.length);
  return combined;
}
