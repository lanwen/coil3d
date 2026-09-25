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

    // Issue #68: layer 2 is TRAVERSE-wound -- it descends instead of
    // climbing (see wire.ts's `buildWirePaths` doc comment), so its own
    // chronological END (its last sample, not its first) is the one that
    // sits right next to layer 1's own start, one phase-shift's worth of
    // pitch away. At quality=1 the ideal half-pitch shift applies (docs/
    // research.md §3).
    const pitch = 3.8 + 0.3;
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
// height) coordinates around the coil axis (wire.ts's `cylindricalBridge`).
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
// Bounds (found empirically, see PR #77's description for the full sweep):
// legitimate bridges never exceed ~15 degrees of sweep beyond the maximum
// half-turn (180 degrees) an orthocyclic phase shift can ever require
// (`phaseShiftTurns` caps at exactly half a turn), and never deviate
// radially by more than ~15% of the bridge's own larger endpoint radius
// (observed up to ~14.7% for a thin-wire, many-layer, large-core design)
// -- both WAY under what the regression produced (a ~180-degree accidental
// EXTRA sweep, i.e. close to 360 total, and a radial dip of ~85% of the
// endpoint radius, collapsing nearly to the coil's own axis). The radial
// bound is relative to the bridge's own radius, not an absolute "N x wire
// diameter": a thin wire on a large core legitimately needs a few mm of
// slack that would fail a fixed small absolute bound despite being a
// perfectly ordinary, correctly-behaved bridge (verified separately against
// several wire diameters and core sizes before picking this bound).
const MAX_BRIDGE_SWEEP_DEG = 210; // 180 (max possible phase shift) + slack
const MAX_BRIDGE_RADIAL_DEVIATION_FRACTION = 0.2; // of the bridge's own larger endpoint radius

function radiusAt3(points: Float32Array, i: number): number {
  return Math.hypot(points[i * 3], points[i * 3 + 1]);
}
function angleDegAt(points: Float32Array, i: number): number {
  return (Math.atan2(points[i * 3 + 1], points[i * 3]) * 180) / Math.PI;
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

/** Asserts a bridge (a layer transition or the outer lead-out) stays close to its own two endpoints' radii and doesn't sweep an unreasonable amount of angle in between -- see the guard's own doc comment above for why. */
function expectBridgeHugsTheSurface(bridge: Float32Array, label: string) {
  const sampleCount = bridge.length / 3;
  const r0 = radiusAt3(bridge, 0);
  const rLast = radiusAt3(bridge, sampleCount - 1);
  const rLo = Math.min(r0, rLast);
  const rHi = Math.max(r0, rLast);

  let maxDeviation = 0;
  for (let i = 0; i < sampleCount; i++) {
    const r = radiusAt3(bridge, i);
    maxDeviation = Math.max(maxDeviation, r - rHi, rLo - r);
  }
  expect(maxDeviation / rHi, `${label}: radial deviation as a fraction of its own larger endpoint radius`).toBeLessThan(
    MAX_BRIDGE_RADIAL_DEVIATION_FRACTION,
  );
  expect(angularSweepDeg(bridge), `${label}: angular sweep around the axis`).toBeLessThan(MAX_BRIDGE_SWEEP_DEG);
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
            expectBridgeHugsTheSurface(d.layerTransitions[i], `transition ${i + 1}`);
          }
          expectContinuousJoin(d.wirePaths.at(-1)!.points, d.outerEndLeadOut, "last layer -> outer lead-out");
          expectBridgeHugsTheSurface(d.outerEndLeadOut, "outer lead-out");
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
    for (const [i, t] of d.layerTransitions.entries()) expectBridgeHugsTheSurface(t, `transition ${i + 1}`);
    expectBridgeHugsTheSurface(d.outerEndLeadOut, "outer lead-out");
  });

  it("the design that originally caught the PR #77 regression (a big rounded-square core, skadis mount, 1 layer) still hugs the surface", async () => {
    // This is what the almost-360-degree-loop bug looked like in practice:
    // a single-layer square core with a large, off-centre-cornered outline
    // (see wire.ts's `cylindricalBridge` doc comment), where the outer
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
    expectBridgeHugsTheSurface(d.outerEndLeadOut, "outer lead-out");
  });

  it("the outer-end lead-out reaches the top cap's own rim keyhole position, even when the top cap is off (1 layer)", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 3000, diameter: 3.8, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 30 },
        height: { locked: true, value: 40 },
        layers: { locked: true, value: 1 },
        topCap: "auto",
      }),
    );
    expect(d.parts.some((p) => p.role === "topCap")).toBe(false); // auto: off for a single layer
    expect(d.outerEndLeadOut.length).toBeGreaterThanOrEqual(6);

    const n = d.outerEndLeadOut.length / 3;
    const lastX = d.outerEndLeadOut[(n - 1) * 3];
    const lastY = d.outerEndLeadOut[(n - 1) * 3 + 1];
    const lastZ = d.outerEndLeadOut[(n - 1) * 3 + 2];
    // Same (x, y) as the bottom flange's own keyhole (both are the SAME
    // outline/margin/wireDiameter/tolerance formula at t=0, see
    // wire.ts's `buildOuterEndLeadOut` doc comment), well above the core's
    // own top rim.
    expect(lastX).toBeCloseTo(d.innerEndLeadIn[0], 3);
    expect(lastY).toBeCloseTo(d.innerEndLeadIn[1], 3);
    expect(lastZ).toBeGreaterThan(d.solution.height);
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
