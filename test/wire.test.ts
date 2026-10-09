import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec } from "../src/core";
import { outlineOffsetAt } from "../src/core/shapes";

// Issue #4 acceptance criteria: `design()` returns the schematic wound-cable
// path per layer (orthocyclic offset and half-pitch shift), consistent with
// the solver's layers and turns. These tests exercise ONLY the public
// `design()` interface, per the testing rules in AGENTS.md.

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 30 },
    height: { locked: true, value: 40 },
    layers: { locked: true, value: 1 },
    objective: "minVolume",
    topCap: "on",
    base: "on",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

/** Radial distance from the coil axis (mm). */
function radiusAt(points: Float32Array, i: number): number {
  return Math.hypot(points[i * 3], points[i * 3 + 1]);
}

/** The leading samples of a layer's path, before its last `taperTurns` (where the cable leaves the fading groove). */
function untilTail(d: Awaited<ReturnType<typeof design>>, points: Float32Array, turns: number): number[] {
  const count = points.length / 3;
  const last = (turns - d.wallSpec.taperTurns) / turns;
  return Array.from({ length: count }, (_, i) => i).filter((i) => i / (count - 1) <= last);
}

/** The least distance between two cable samples that lie more than `apart` mm from each other along the cable. */
function closestApproach(path: Float32Array, apart: number): number {
  const n = path.length / 3;
  const along = new Float64Array(n);
  for (let i = 1; i < n; i++) along[i] = along[i - 1] + Math.hypot(path[i * 3] - path[i * 3 - 3], path[i * 3 + 1] - path[i * 3 - 2], path[i * 3 + 2] - path[i * 3 - 1]);
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (along[j] - along[i] <= apart) continue;
      best = Math.min(best, Math.hypot(path[i * 3] - path[j * 3], path[i * 3 + 1] - path[j * 3 + 1], path[i * 3 + 2] - path[j * 3 + 2]));
    }
  }
  return best;
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

  it("the layer-1 path sits at the solved radial offset until its groove fades out", async () => {
    const d = await design(baseSpec());
    const [layer1] = d.wirePaths;
    const expectedRadius = d.solution.outerSize / 2 + d.solution.layerResults[0].offset;
    const kept = untilTail(d, layer1.points, layer1.turns);
    expect(kept.length).toBeGreaterThan(layer1.points.length / 3 / 2);
    for (const i of kept) {
      expect(radiusAt(layer1.points, i)).toBeCloseTo(expectedRadius, 3);
    }
  });

  it("the layer-1 path ends 0.3 r under the core's top face, in its groove, so it never grazes the top face (issue #224)", async () => {
    // A free height: the solver spends the height on the cable, so its last turn ends as close under the top as allowed.
    for (const shape of [{ kind: "round" }, { kind: "sq", cornerRadius: 20 }, { kind: "tri", cornerRadius: 20 }] as const) {
      const d = await design(baseSpec({ shape, coreSize: { locked: true, dimension: "outer", value: 85 }, height: { locked: false } }));
      const [layer1] = d.wirePaths;
      const r = d.wallSpec.wireDiameter / 2;
      const count = layer1.points.length / 3;
      for (let i = 0; i < count; i++) expect(zAt(layer1.points, i) + 1.3 * r, `${shape.kind} sample ${i}`).toBeLessThanOrEqual(d.wallSpec.height + 1e-4);
      expect(zAt(layer1.points, count - 1) + 1.3 * r, `${shape.kind}: the last turn ends just under the top`).toBeCloseTo(d.wallSpec.height, 3);
      const { offset } = outlineOffsetAt(d.wallSpec.outline, layer1.points[(count - 1) * 3], layer1.points[(count - 1) * 3 + 1]);
      expect(offset, `${shape.kind}: still in the groove`).toBeCloseTo(d.solution.layerResults[0].offset, 3);
    }
  });

  it("with more layers, layer 1's last turn and the hop to layer 2 also stay 0.3 r under the core's top face, without crowding the cable (issue #228)", async () => {
    for (const shape of [{ kind: "round" }, { kind: "sq", cornerRadius: 20 }, { kind: "tri", cornerRadius: 20 }] as const) {
      const d = await design(baseSpec({ shape, wire: { length: 4000, diameter: 3.8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 85 }, height: { locked: false }, layers: { locked: true, value: 2 } }));
      expect(d.wirePaths.length, `${shape.kind}: two layers`).toBe(2);
      const r = d.wallSpec.wireDiameter / 2;
      // (The hop turns the climb round, so it rises a few micrometres past layer 1's end.)
      for (const points of [d.wirePaths[0].points, d.layerTransitions[0]]) {
        for (let i = 0; i < points.length / 3; i++) expect(zAt(points, i) + 1.3 * r, `${shape.kind} sample ${i}`).toBeLessThanOrEqual(d.wallSpec.height + 0.01);
      }
      // Turns of the wound cable that are not neighbours along its length stay about a cable diameter apart (the layers
      // nest, so a little under). From layer 1's start on: the inner end's lead-in runs along the flange face from the
      // first turn, under layer 2's lowest turn.
      expect(closestApproach(d.cablePath.slice(d.innerEndLeadIn.length - 3), 40), shape.kind).toBeGreaterThanOrEqual(0.88 * d.wallSpec.wireDiameter);
    }
  });

  it("layer 1 stays in its groove to the end under more layers (issue #228)", async () => {
    // Three layers at 120 mm on a 63 mm core: lifting layer 1's end would crowd layers 2 and 3.
    const d = await design(baseSpec({ wire: { length: 12096, diameter: 3.8, type: "usb" }, coreSize: { locked: true, dimension: "outer", value: 120 }, height: { locked: true, value: 63 }, layers: { locked: true, value: 3 } }));
    const [layer1] = d.wirePaths;
    const last = layer1.points.length / 3 - 1;
    expect(zAt(layer1.points, last) + d.wallSpec.wireDiameter / 2).toBeLessThan(d.wallSpec.height);
    expect(radiusAt(layer1.points, last)).toBeCloseTo(d.solution.outerSize / 2 + d.solution.layerResults[0].offset, 3);
  });

  it("a rounded-square core's wire follows the true offset outline, not a circle (issue #6 follow-up)", async () => {
    // A big outer size and a corner radius comfortably clear of BOTH the
    // bend-limit floor and the useful-max ceiling (see solve.ts's "became
    // round" clamp and, issue #134, `usefulMaxCornerRadius`): otherwise the
    // solver clamps the corner radius and the outline is indistinguishable
    // from a circle, defeating the point of this test.
    const d = await design(
      baseSpec({
        shape: { kind: "sq", cornerRadius: 20 },
        coreSize: { locked: true, dimension: "outer", value: 140 },
      }),
    );
    expect(d.warnings.some((w) => /clamped/i.test(w))).toBe(false);
    const [layer1] = d.wirePaths;
    const radii = untilTail(d, layer1.points, layer1.turns).map((i) => radiusAt(layer1.points, i));

    // A circle has a constant radius at every sample; a rounded square's
    // offset outline does not (flat sides sit closer to the axis than the
    // rounded corners) -- this is the regression this test guards.
    const minRadius = Math.min(...radii);
    const maxRadius = Math.max(...radii);
    expect(maxRadius - minRadius).toBeGreaterThan(1);

    // The inscribed radius (mid-flat-side) and the true circumscribed radius
    // (corner-arc midpoint) are exact, independent of the outline math
    // (docs/design.md, Shapes; n=4 for
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
    const d = await design(baseSpec({ wire: { length: 2000, diameter: wireDiameter, type: "usb" } }));
    const [layer1] = d.wirePaths;
    const sampleCount = layer1.points.length / 3;
    for (let i = 1; i < sampleCount; i++) {
      expect(zAt(layer1.points, i)).toBeGreaterThan(zAt(layer1.points, i - 1));
    }
    const span = zAt(layer1.points, sampleCount - 1) - zAt(layer1.points, 0);
    expect(span).toBeCloseTo(layer1.turns * d.wallSpec.pitch, 1);
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

    // Issue #68: layer 2 is TRAVERSE-wound -- it descends instead of
    // climbing (see wire.ts's `layerRun`), so its own
    // chronological END (its last sample, not its first) is the one that
    // sits right next to layer 1's own start, one phase-shift's worth of
    // pitch away. At quality=1 the ideal half-pitch shift applies (docs/
    // design.md, Capacity math).
    const { pitch } = d.wallSpec;
    const z1 = zAt(layer1.points, 0);
    const layer2Last = layer2.points.length / 3 - 1;
    const z2 = zAt(layer2.points, layer2Last);
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
    const layer2Last = layer2.points.length / 3 - 1;
    expect(zAt(layer2.points, layer2Last)).toBeCloseTo(zAt(layer1.points, 0), 3);
  });

  it("traverse winding (issue #68): even layers descend in z instead of climbing", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 6000, diameter: 3.8, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 30 },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 3 },
      }),
    );
    expect(d.wirePaths).toHaveLength(3);
    const [layer1, layer2, layer3] = d.wirePaths;
    const sampleCount = (p: (typeof d.wirePaths)[number]) => p.points.length / 3;

    // Layer 1 (odd) still climbs, exactly as before.
    for (let i = 1; i < sampleCount(layer1); i++) {
      expect(zAt(layer1.points, i)).toBeGreaterThan(zAt(layer1.points, i - 1));
    }
    // Layer 2 (even) descends: it starts near the top (right next to where
    // layer 1 just finished) and ends near the bottom (right next to where
    // layer 3 starts) -- the core keeps spinning the same way the whole
    // time, only the Z direction alternates (see wire.ts's file header).
    for (let i = 1; i < sampleCount(layer2); i++) {
      expect(zAt(layer2.points, i)).toBeLessThan(zAt(layer2.points, i - 1));
    }
    // Layer 3 (odd) climbs again.
    for (let i = 1; i < sampleCount(layer3); i++) {
      expect(zAt(layer3.points, i)).toBeGreaterThan(zAt(layer3.points, i - 1));
    }
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

// Issue #68 acceptance criteria: "design() returns one continuous polyline
// (or joined segments with matching endpoints and tangent continuity) from
// the inner end to the outer end" -- checked here across every join (the
// inner-end lead-in into layer 1, every layer-to-layer transition, and the
// last layer into the outer-end lead-out), for 1-6 layers and all 3 shapes.

/** xyz at sample `i`. */
function pointAt3(points: Float32Array, i: number): [number, number, number] {
  return [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
}
function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function unitVector(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  const d: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...d) || 1;
  return [d[0] / len, d[1] / len, d[2] / len];
}
function angleBetweenDeg(u: [number, number, number], v: [number, number, number]): number {
  const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  return (Math.acos(dot) * 180) / Math.PI;
}

/** Asserts the join from the end of `before` to the start of `after` has a gap under 0.1 mm and a tangent-direction change under 20 degrees (issue #68 AC). */
function expectContinuousJoin(before: Float32Array, after: Float32Array, label: string) {
  const beforeCount = before.length / 3;
  const endBefore = pointAt3(before, beforeCount - 1);
  const startAfter = pointAt3(after, 0);
  expect(distance(endBefore, startAfter), `${label}: gap`).toBeLessThan(0.1);

  const tangentBefore = unitVector(pointAt3(before, beforeCount - 2), endBefore);
  const tangentAfter = unitVector(startAfter, pointAt3(after, 1));
  expect(angleBetweenDeg(tangentBefore, tangentAfter), `${label}: tangent angle`).toBeLessThan(20);
}

// Guards against a specific PR #77 review bug class: `layerTransitions`/
// `outerEndLeadOut` are Hermite curves built in cylindrical (radius, angle,
// height) coordinates around the coil axis (the pre-#115 wire.ts's `cylindricalBridge`).
// `expectContinuousJoin` above only checks the two exact ENDPOINTS -- gap and
// tangent direction are satisfied there by construction, no matter what the
// curve does in BETWEEN them. The bug this catches lived entirely in that
// middle stretch and was invisible to the endpoint checks: an earlier
// "always advance the angle forward, never backward" rule could force a
// bridge to sweep almost a full extra turn around the coil (for a non-round
// outline, two points that are only a hair apart in true winding progress
// can still read as slightly BACKWARD in raw global angle, since a corner
// arc's own local centre sits off the global axis -- shapes.ts's
// `evalOutline`), and an unclamped radius channel could similarly overshoot
// on the way between two nearby radii. Both read fine at the sampled
// endpoints (gap/tangent) but rendered as a dramatic loop bulging away from
// the coil's own surface in between. Caught originally by rendering
// screenshots and diffing against `origin/main`, not by any vitest check --
// this is that missing check.
//
// Issue #115 changed what a legitimate bridge looks like: a transition (or
// the cap lead-out) is now deliberately as long as it has to be to stay
// within the cable's bend radius -- wire.ts searches up to 1.5 turns for a
// transition and 4 turns for the cap lead-out (a tall coil with an even
// layer count climbs its whole height to the cap) -- and it always advances
// FORWARD around the axis, the way the core turns (the old fixed-phase
// layer starts made a transition turn back on itself, the hook this issue
// reports). So the guard is now: never backwards, and never more than the
// search allows (an accidental extra loop would exceed it).
const MAX_TRANSITION_SWEEP_DEG = 1.5 * 360 + 30;
const MAX_LEAD_OUT_SWEEP_DEG = 4 * 360 + 30;

function radiusAt3(points: Float32Array, i: number): number {
  return Math.hypot(points[i * 3], points[i * 3 + 1]);
}
function angleAt(points: Float32Array, i: number): number {
  return Math.atan2(points[i * 3 + 1], points[i * 3]);
}
function angleDegAt(points: Float32Array, i: number): number {
  return (angleAt(points, i) * 180) / Math.PI;
}

/** The bridge's own total angular travel around the axis (degrees), unwrapped so a run of samples that individually stay within +-180 degrees of each other doesn't get miscounted at the wrap. */
function angularSweepDeg(points: Float32Array): number {
  const sampleCount = points.length / 3;
  let unwrapped = angleDegAt(points, 0);
  let min = unwrapped;
  let max = unwrapped;
  let prevRaw = unwrapped;
  for (let i = 1; i < sampleCount; i++) {
    const raw = angleDegAt(points, i);
    let delta = raw - prevRaw;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    unwrapped += delta;
    prevRaw = raw;
    min = Math.min(min, unwrapped);
    max = Math.max(max, unwrapped);
  }
  return max - min;
}

// Issue #90: the OLD radial-deviation guard above (a fixed fraction of the
// bridge's own two endpoint radii, straight-line Cartesian) is exactly the
// "circle-like" check the issue is about -- it doesn't know a rounded
// triangle's true boundary swings from `apothem` (a flat side's own
// midpoint) out to a much bigger circumscribed radius (a corner's own
// midpoint), so it can't tell a bridge that's correctly HUGGING that real
// shape apart from one that's incorrectly bulging away from it. Replaced by
// an outline-aware band -- but NOT a hand-rolled re-derivation of
// shapes.ts's own `radiusAtAngle` formula: that function's arc-vs-flat-side
// classification (which GLOBAL angle a ray from the axis subtends) turns out
// to itself misclassify a point once a corner's `cornerRadius + offset`
// grows large relative to the shape's own `Rc` (the same failure this issue
// is about, just relocated into the test's own "expected" oracle instead of
// the code under test -- a fully independent square-shape re-derivation
// exposed exactly the same blow-up). The reliable ground truth is instead
// each REAL, already-solved layer's own sampled centerline
// (`design()`'s public `wirePaths`, arc-length-parameterised via
// `pointAt`, never via a global angle): for a given angle, the closest
// sample on a layer immediately adjacent to the bridge under test tells you
// where the TRUE offset boundary actually sits there.

/** The sample of `path` whose own angle around the axis is closest to `theta` (wrapping through +-180 degrees) -- `path` is one of `design()`'s own densely-sampled `wirePaths[i].points`, spanning many full turns, so some sample is always close by. */
function radiusNearAngle(path: Float32Array, theta: number): number {
  const sampleCount = path.length / 3;
  const twoPi = 2 * Math.PI;
  const target = ((theta % twoPi) + twoPi) % twoPi;
  let bestIndex = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < sampleCount; i++) {
    const a = ((angleAt(path, i) % twoPi) + twoPi) % twoPi;
    let delta = Math.abs(a - target);
    if (delta > Math.PI) delta = twoPi - delta;
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return radiusAt3(path, bestIndex);
}

/**
 * Issue #90 AC: a layer-transition bridge's radial distance from the CORE
 * OUTLINE at each sample's OWN angle -- not a plain circle -- stays between
 * the two adjoining (already-solved, real) layers' own offsets, plus at
 * most half a wire diameter of slack. `before`/`after` are those two real
 * layers' OWN sampled centerlines (`radiusNearAngle` above), so this needs
 * no independent re-derivation of the outline's geometry at all.
 */
function expectTransitionHugsTheOutline(bridge: Float32Array, before: Float32Array, after: Float32Array, wireDiameter: number, label: string) {
  const sampleCount = bridge.length / 3;
  const tolerance = 0.5 * wireDiameter;
  let maxDeviation = 0;
  for (let i = 0; i < sampleCount; i++) {
    const r = radiusAt3(bridge, i);
    const theta = angleAt(bridge, i);
    const rBefore = radiusNearAngle(before, theta);
    const rAfter = radiusNearAngle(after, theta);
    const bandLo = Math.min(rBefore, rAfter);
    const bandHi = Math.max(rBefore, rAfter);
    maxDeviation = Math.max(maxDeviation, r - bandHi, bandLo - r);
  }
  expect(maxDeviation, `${label}: radial deviation from the outline-offset band`).toBeLessThanOrEqual(tolerance);
}

/** The most any step between consecutive samples goes BACKWARDS around the axis (degrees; 0 when it only ever advances). */
function largestBackwardStepDeg(points: Float32Array): number {
  let worst = 0;
  for (let i = 1; i < points.length / 3; i++) {
    let delta = angleDegAt(points, i) - angleDegAt(points, i - 1);
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    worst = Math.max(worst, -delta);
  }
  return worst;
}

/** Asserts a bridge (a layer transition or the outer lead-out) only advances around the axis, and not by more than wire.ts's own search allows (issues #77, #115) -- see the guard's own doc comment above. */
function expectBridgeSweepIsBounded(bridge: Float32Array, label: string, maxSweepDeg = MAX_TRANSITION_SWEEP_DEG) {
  expect(largestBackwardStepDeg(bridge), `${label}: turns back around the axis`).toBeLessThan(1e-3);
  expect(angularSweepDeg(bridge), `${label}: angular sweep around the axis`).toBeLessThan(maxSweepDeg);
}

describe("design() is one continuous cable, inner end to outer end (issue #68)", () => {
  for (const shapeKind of ["round", "sq", "tri"] as const) {
    for (let layers = 1; layers <= 6; layers++) {
      // windingQuality=1 maximizes each layer-to-layer phase shift (a full
      // half-turn, `phaseShiftTurns`'s own cap) -- the case that most
      // exercises a bridge's own angular sweep, so it's included alongside
      // the default 0.7 rather than only tested separately.
      for (const windingQuality of [0.7, 1]) {
        it(`shape=${shapeKind} layers=${layers} quality=${windingQuality}: every join has zero gap/small tangent change, and every bridge hugs the surface`, async () => {
          const d = await design(
            baseSpec({
              shape: shapeKind === "round" ? { kind: "round" } : { kind: shapeKind, cornerRadius: 10 },
              wire: { length: 3000, diameter: 3.8, type: "usb" },
              coreSize: { locked: true, dimension: "outer", value: 30 },
              height: { locked: true, value: 60 },
              layers: { locked: true, value: layers },
              windingQuality,
            }),
          );
          expect(d.solution.layers).toBe(layers);
          expect(d.wirePaths).toHaveLength(layers);
          expect(d.wirePaths.every((p) => p.turns > 0)).toBe(true);
          expect(d.layerTransitions).toHaveLength(layers - 1);

          expectContinuousJoin(d.innerEndLeadIn, d.wirePaths[0].points, "inner lead-in -> layer 1");
          for (let i = 0; i + 1 < d.wirePaths.length; i++) {
            expectContinuousJoin(d.wirePaths[i].points, d.layerTransitions[i], `layer ${i + 1} -> transition ${i + 1}`);
            expectContinuousJoin(d.layerTransitions[i], d.wirePaths[i + 1].points, `transition ${i + 1} -> layer ${i + 2}`);
            expectBridgeSweepIsBounded(d.layerTransitions[i], `transition ${i + 1}`);
            expectTransitionHugsTheOutline(d.layerTransitions[i], d.wirePaths[i].points, d.wirePaths[i + 1].points, 3.8, `transition ${i + 1}`);
          }
          expectContinuousJoin(d.wirePaths.at(-1)!.points, d.outerEndLeadOut, "last layer -> outer lead-out");
          expectBridgeSweepIsBounded(d.outerEndLeadOut, "outer lead-out", MAX_LEAD_OUT_SWEEP_DEG);
        });
      }
    }
  }

  it("a thin wire on a large, many-layer core doesn't trip the surface-hugging guard (a legitimate few-mm bulge, not the PR #77 regression)", async () => {
    const d = await design(
      baseSpec({
        shape: { kind: "sq", cornerRadius: 20 },
        wire: { length: 3000, diameter: 1.2, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 100 },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 6 },
        windingQuality: 0.55,
      }),
    );
    expect(d.layerTransitions.length).toBeGreaterThan(0);
    for (const [i, t] of d.layerTransitions.entries()) {
      expectBridgeSweepIsBounded(t, `transition ${i + 1}`);
      expectTransitionHugsTheOutline(t, d.wirePaths[i].points, d.wirePaths[i + 1].points, 1.2, `transition ${i + 1}`);
    }
    expectBridgeSweepIsBounded(d.outerEndLeadOut, "outer lead-out", MAX_LEAD_OUT_SWEEP_DEG);
  });

  it("the design that originally caught the PR #77 regression (a big rounded-square core, skadis mount, 1 layer) still hugs the surface", async () => {
    // This is what the almost-360-degree-loop bug looked like in practice:
    // a single-layer square core with a large, off-centre-cornered outline
    // (the pre-#115 wire.ts's `cylindricalBridge`), where the outer
    // lead-out's own two endpoints sit at a GLOBAL angle that drifts
    // slightly "backward" despite representing essentially zero true
    // winding progress -- forcing "always forward" swept the bridge almost
    // all the way around the coil instead of the tiny hop it actually
    // needed. Found by rendering screenshots and diffing against
    // `origin/main`, not by any vitest check that existed at the time.
    const d = await design(
      baseSpec({
        shape: { kind: "sq", cornerRadius: 15 },
        wire: { length: 2000, diameter: 3.8, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 100 },
        height: { locked: false },
        layers: { locked: true, value: 1 },
        mount: "skadis",
      }),
    );
    expect(d.layerTransitions).toHaveLength(0); // 1 layer: only the outer lead-out is at risk here
    expectBridgeSweepIsBounded(d.outerEndLeadOut, "outer lead-out", MAX_LEAD_OUT_SWEEP_DEG);
  });

  it("with the top cap on, the cable runs level just under the cap, under the cap's rim slot, and out past the rim (issues #117, #241)", async () => {
    for (const layers of [2, 3]) {
      const d = await design(
        baseSpec({
          wire: { length: 3000, diameter: 3.8, type: "usb" },
          coreSize: { locked: true, dimension: "outer", value: 30 },
          height: { locked: true, value: 40 },
          layers: { locked: true, value: layers },
          topCap: "on",
        }),
      );
      const slot = d.rimSlots.cap!;
      expect(slot).toBeDefined();
      const out = d.outerEndLeadOut;
      const n = out.length / 3;
      // Its last samples run level, the cable's top a hair under the cap's
      // underside (z = height, assembly frame), from right under the slot.
      let first = n - 1;
      while (first > 0 && Math.abs(out[first * 3 - 1] - out[n * 3 - 1]) < 1e-6) first--;
      expect(out[n * 3 - 1] + 3.8 / 2).toBeCloseTo(d.solution.height - 0.1, 4);
      const start = pointAt3(out, first);
      expect(Math.atan2(Math.sin(Math.atan2(start[1], start[0]) - Math.atan2(slot.seat.y, slot.seat.x)), Math.cos(Math.atan2(start[1], start[0]) - Math.atan2(slot.seat.y, slot.seat.x)))).toBeCloseTo(0, 6);
      // The slot's cut reaches past the rim...
      const rimRadius = d.solution.flangeExtent!.acrossFlats / 2;
      expect(Math.max(...slot.outline.map((q) => Math.hypot(q.x, q.y)))).toBeGreaterThan(rimRadius);
      // ...and the cable's free end is outside it.
      const end = pointAt3(out, n - 1);
      expect(Math.hypot(end[0], end[1])).toBeGreaterThan(rimRadius + 5);
    }
  });

  it("has no layer transitions for a single-layer design, and both lead-in/lead-out are still present", async () => {
    const d = await design(baseSpec());
    expect(d.wirePaths).toHaveLength(1);
    expect(d.layerTransitions).toHaveLength(0);
    expect(d.innerEndLeadIn.length).toBeGreaterThanOrEqual(6);
    expect(d.outerEndLeadOut.length).toBeGreaterThanOrEqual(6);
  });

  it("is empty (no layers, no lead-in/lead-out) when no layer has any turns", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 50, diameter: 3.8, type: "usb" },
        height: { locked: true, value: 5 },
      }),
    );
    expect(d.wirePaths).toHaveLength(0);
    expect(d.layerTransitions).toHaveLength(0);
    expect(d.outerEndLeadOut.length).toBe(0);
  });
});
