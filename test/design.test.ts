import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec } from "../src/core";
// mount.ts's layout is the SAME shared function both geometry backends cut
// from (manifold.ts, step/build.ts) -- calling it here on design()'s own
// PUBLIC `flangeSpec` (not a reimplementation) verifies the actual layout
// that was cut, per the PR review's request for "a vitest check through
// design()" of the slot geometry.
import { layoutKeyholeMount } from "../src/core/mount";
// Issue #54: independently verifies the ACTUAL resolved outline design()
// produced (`wallSpec.outline`), not a reimplemented formula -- same
// pattern as the mount.ts import above.
import { offsetPerimeter, sideLength } from "../src/core/shapes";

// Fixed print parameters mirrored from src/core/constants.ts (docs/design.md,
// Capacity math), reimplemented independently here so these tests exercise ONLY the
// public `design()` interface, per the testing rules in AGENTS.md.
const WALL_THICKNESS = 3;
const CLEARANCE = 0.3;
const GROOVE_DEPTH_FACTOR = 0.3;
const MARGIN = 3;
const FLANGE_THICKNESS = 3;
const MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT = 5; // SCREW_MOUNT_RECESS_DEPTH + SCREW_MOUNT_MIN_SHELF
const FLANGE_MARGIN = 4;

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: false },
    height: { locked: false },
    layers: { locked: false },
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

/** Forward capacity for a single layer, matching docs/design.md, Capacity math. */
function expectedSingleLayer(outerSize: number, height: number, wireDiameter: number) {
  const grooveDepth = GROOVE_DEPTH_FACTOR * wireDiameter;
  const o1 = wireDiameter / 2 - grooveDepth;
  const perimeter = 2 * Math.PI * (outerSize / 2 + o1);
  const pitch = wireDiameter + CLEARANCE;
  const usableHeight = height - 2 * MARGIN;
  const turns = Math.floor(usableHeight / pitch);
  const length = turns * Math.sqrt(perimeter * perimeter + pitch * pitch);
  return { perimeter, pitch, turns, length };
}

describe("design() solver (round core)", () => {
  it("matches a hand calculation for a fully-locked round core (0 free)", async () => {
    const outerSize = 64;
    const height = 40;
    const wireDiameter = 3.8;
    const expected = expectedSingleLayer(outerSize, height, wireDiameter);

    const spec = baseSpec({
      wire: { length: expected.length, diameter: wireDiameter, type: "usb" },
      coreSize: { locked: true, dimension: "outer", value: outerSize },
      height: { locked: true, value: height },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);

    expect(d.solution.diagnosis.freeCount).toBe(0);
    expect(d.solution.diagnosis.status).toBe("ok");
    expect(d.solution.layerResults).toHaveLength(1);
    expect(d.solution.layerResults[0].turns).toBe(expected.turns);
    expect(d.solution.layerResults[0].perimeter).toBeCloseTo(expected.perimeter, 6);
    expect(d.solution.totalWoundLength).toBeCloseTo(expected.length, 6);
    expect(d.solution.outerSize).toBe(outerSize);
    expect(d.solution.innerBore).toBeCloseTo(outerSize - 2 * WALL_THICKNESS, 6);
    expect(d.solution.height).toBe(height);
  });

  it("reports over-constrained and names the locks to release when the fully-locked geometry misses the target", async () => {
    const spec = baseSpec({
      wire: { length: 50, diameter: 3.8, type: "usb" }, // far too short for this core
      coreSize: { locked: true, dimension: "outer", value: 64 },
      height: { locked: true, value: 40 },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);
    expect(d.solution.diagnosis.status).toBe("over-constrained");
    expect(d.solution.diagnosis.message).toMatch(/release/i);
    expect(d.solution.diagnosis.message).toMatch(/outer size, height, or layers/i);
  });

  it("is monotonic: a longer cable needs a taller core (outer + layers locked, height free)", async () => {
    const lockedSpec = (length: number) =>
      baseSpec({
        wire: { length, diameter: 3.8, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 40 },
        height: { locked: false },
        layers: { locked: true, value: 1 },
      });

    const short = await design(lockedSpec(500));
    const long = await design(lockedSpec(3000));

    expect(short.solution.diagnosis.freeCount).toBe(1);
    expect(short.solution.diagnosis.status).toBe("ok");
    expect(long.solution.diagnosis.status).toBe("ok");
    expect(long.solution.height).toBeGreaterThan(short.solution.height);
  });

  it("is monotonic: a longer cable needs a bigger core (height + layers locked, outer size free)", async () => {
    const lockedSpec = (length: number) =>
      baseSpec({
        wire: { length, diameter: 3.8, type: "usb" },
        coreSize: { locked: false },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 1 },
      });

    const short = await design(lockedSpec(1000));
    const long = await design(lockedSpec(5000));

    expect(long.solution.outerSize).toBeGreaterThan(short.solution.outerSize);
  });

  it("reports under-constrained with a clear notice and 2-3 candidates (e.g. layers=1/2/min-volume) when all three dimensions are free", async () => {
    const spec = baseSpec({ coreSize: { locked: false }, height: { locked: false }, layers: { locked: false } });
    const d = await design(spec);
    expect(d.solution.diagnosis.freeCount).toBe(3);
    expect(d.solution.diagnosis.status).toBe("under-constrained");
    expect(d.solution.diagnosis.message).toMatch(/lock at least one dimension/i);

    // 2-3 candidates total (primary + 1-2 alternates), e.g. layers=1, layers=2
    // and the overall objective-best pick, per the ticket's example.
    const candidates = [d.solution, ...d.solution.alternates];
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.length).toBeLessThanOrEqual(3);
    const layerCounts = new Set(candidates.map((c) => c.layers));
    expect(layerCounts.size).toBe(candidates.length); // each candidate is a genuinely different layer count

    // Every returned candidate -- primary and alternates -- must cover the
    // target cable length; "under-constrained" is not an excuse to undershoot.
    for (const candidate of candidates) {
      expect(candidate.totalWireLength).toBeGreaterThanOrEqual(candidate.targetWireLength * (1 - 1e-6));
    }
  });

  it("returns 2-3 candidates side by side when exactly two dimensions are free, and every one covers the target", async () => {
    const spec = baseSpec({
      wire: { length: 3000, diameter: 3.8, type: "usb" },
      coreSize: { locked: true, dimension: "outer", value: 60 },
      height: { locked: false },
      layers: { locked: false },
      objective: "minVolume",
    });
    const d = await design(spec);
    expect(d.solution.diagnosis.freeCount).toBe(2);
    expect(d.solution.diagnosis.status).toBe("ok");
    expect(d.solution.objectiveUsed).toBe("minVolume");
    expect(d.solution.alternates.length).toBeGreaterThanOrEqual(1);
    expect(d.solution.alternates[0].objectiveUsed).toBe("aspectRatio");

    // The regression this guards: a 3000 mm / d=3.8 / outer=60 coil used to
    // resolve to ~2869 mm (-4.4%), reported as "ok" -- capacity must cover
    // the whole cable (tail >= 0) whenever the status is "ok".
    for (const candidate of [d.solution, ...d.solution.alternates]) {
      expect(candidate.totalWireLength).toBeGreaterThanOrEqual(candidate.targetWireLength * (1 - 1e-6));
    }
  });

  it("applies the bend-limit preset: usb and flex both clamp to 4x, stiff to 10x (docs/design.md, Decisions)", async () => {
    const specFor = (type: "usb" | "flex" | "stiff") =>
      baseSpec({
        wire: { length: 2000, diameter: 8, type },
        coreSize: { locked: false },
        height: { locked: true, value: 60 },
        layers: { locked: true, value: 1 },
      });

    const usb = await design(specFor("usb"));
    const flex = await design(specFor("flex"));
    const stiff = await design(specFor("stiff"));

    expect(usb.solution.minOuterSizeForBend).toBeCloseTo(flex.solution.minOuterSizeForBend, 6);
    expect(stiff.solution.minOuterSizeForBend).toBeGreaterThan(usb.solution.minOuterSizeForBend);
  });

  it("reports infeasible when the bend limit's minimum size already overshoots a short target (stiff cord)", async () => {
    const spec = baseSpec({
      wire: { length: 200, diameter: 8, type: "stiff" }, // 10x -> large minimum core, tiny target
      coreSize: { locked: false },
      height: { locked: true, value: 40 },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);
    expect(d.solution.diagnosis.status).toBe("infeasible");
    expect(d.solution.diagnosis.message).toMatch(/bend limit/i);
    expect(d.solution.diagnosis.message).toMatch(/cannot be made smaller/i);
  });

  it("rejects cords above 15 m with a warning and caps the target at 15000 mm", async () => {
    const spec = baseSpec({
      wire: { length: 20000, diameter: 3.8, type: "usb" },
      coreSize: { locked: true, dimension: "outer", value: 200 },
      height: { locked: false },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);
    expect(d.solution.targetWireLength).toBe(15000);
    expect(d.warnings.some((w) => /15\s*m|15000/i.test(w))).toBe(true);
  });

  it("always covers the target capacity when reporting ok, across each single free dimension", async () => {
    const specs: CoilSpec[] = [
      // size free (bisect over a continuous variable)
      baseSpec({
        wire: { length: 1234, diameter: 3.8, type: "usb" },
        coreSize: { locked: false },
        height: { locked: true, value: 55 },
        layers: { locked: true, value: 1 },
      }),
      // height free (bisect over a step-discontinuous turns-per-layer function --
      // the exact case that used to round down across the step and undershoot)
      baseSpec({
        wire: { length: 3000, diameter: 4, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: false },
        layers: { locked: true, value: 1 },
      }),
      baseSpec({
        wire: { length: 3000, diameter: 4, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: false },
        layers: { locked: true, value: 2 },
      }),
      // layers free (integer search)
      baseSpec({
        wire: { length: 5000, diameter: 3.8, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 50 },
        height: { locked: true, value: 50 },
        layers: { locked: false },
      }),
    ];

    for (const spec of specs) {
      const d = await design(spec);
      expect(d.solution.diagnosis.freeCount).toBe(1);
      expect(d.solution.diagnosis.status).toBe("ok");
      expect(d.solution.totalWireLength).toBeGreaterThanOrEqual(d.solution.targetWireLength * (1 - 1e-6));
    }
  });

  it("warns and reduces the bore when the locked core is too small for the fixed wall thickness", async () => {
    const spec = baseSpec({
      wire: { length: 50, diameter: 2, type: "usb" },
      coreSize: { locked: true, dimension: "outer", value: 4 },
      height: { locked: true, value: 30 },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);
    expect(d.warnings.some((w) => /too small/i.test(w))).toBe(true);
  });
});

describe("design() solver (min-volume objective and capacity range, issue #23)", () => {
  it("no longer prefers a squat many-layer stack with too few turns per layer (regression for the reported 6-layer/2-turn case)", async () => {
    const spec = baseSpec({
      wire: { length: 3000, diameter: 4, type: "usb" },
      coreSize: { locked: true, dimension: "outer", value: 60 },
      height: { locked: false },
      layers: { locked: false },
      objective: "minVolume",
    });
    const d = await design(spec);

    expect(d.solution.diagnosis.status).toBe("ok");
    expect(d.solution.objectiveUsed).toBe("minVolume");
    // This exact case used to resolve to 6 layers x ~16 mm height with only
    // 2 turns per layer and a 1681-3077 mm capacity range -- nobody would
    // wind a coil like that.
    expect(d.solution.layers).toBeLessThan(6);
    for (const layer of d.solution.layerResults) {
      expect(layer.turns).toBeGreaterThanOrEqual(5);
    }
    // Still covers the target at the chosen winding quality.
    expect(d.solution.totalWireLength).toBeGreaterThanOrEqual(d.solution.targetWireLength * (1 - 1e-6));
  });

  it("uses the true swept envelope volume (not a bounding circle), so a squat stack is avoided for non-round shapes too", async () => {
    const spec = baseSpec({
      shape: { kind: "sq", cornerRadius: 8 },
      wire: { length: 3000, diameter: 4, type: "usb" },
      coreSize: { locked: true, dimension: "outer", value: 60 },
      height: { locked: false },
      layers: { locked: false },
      objective: "minVolume",
    });
    const d = await design(spec);

    expect(d.solution.diagnosis.status).toBe("ok");
    for (const layer of d.solution.layerResults) {
      expect(layer.turns).toBeGreaterThanOrEqual(5);
    }
  });

  it("warns when the loosest winding quality's capacity falls short of the target, even though the chosen quality is 'ok'", async () => {
    const spec = baseSpec({
      wire: { length: 3000, diameter: 4, type: "usb" },
      coreSize: { locked: true, dimension: "outer", value: 60 },
      height: { locked: false },
      layers: { locked: false },
      objective: "minVolume",
    });
    const d = await design(spec);

    expect(d.solution.diagnosis.status).toBe("ok");
    expect(d.solution.capacityRange[0]).toBeLessThan(d.solution.targetWireLength);
    expect(d.warnings.some((w) => /loose winding may not fit/i.test(w))).toBe(true);
  });

  it("does not warn about the capacity range when capacity is quality-independent (single fully-locked layer)", async () => {
    const outerSize = 64;
    const height = 40;
    const wireDiameter = 3.8;
    const expected = expectedSingleLayer(outerSize, height, wireDiameter);
    const spec = baseSpec({
      wire: { length: expected.length, diameter: wireDiameter, type: "usb" },
      coreSize: { locked: true, dimension: "outer", value: outerSize },
      height: { locked: true, value: height },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);

    expect(d.solution.capacityRange[0]).toBeCloseTo(d.solution.capacityRange[1], 6);
    expect(d.warnings.some((w) => /loose winding may not fit/i.test(w))).toBe(false);
  });
});

describe("design() solver (rounded-square and rounded-triangle shapes, issue #6)", () => {
  it("uses the requested corner radius as-is when it's within the bend-limit/size range", async () => {
    // A big enough locked size that 15mm sits comfortably inside BOTH ends
    // of `cornerRadiusRange`: above the bend-limit floor (~14.4mm for this
    // wire, size-independent) and below the useful max issue #134 adds
    // (`solve.ts`'s `usefulMaxCornerRadius`, which grows with size) --
    // unlike the old, size-independent `outerSize/2` ceiling, 60mm would no
    // longer be big enough for this (see the sibling test below).
    const spec = baseSpec({
      shape: { kind: "sq", cornerRadius: 15 },
      coreSize: { locked: true, dimension: "outer", value: 100 },
      height: { locked: true, value: 40 },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);
    expect(d.solution.cornerRadius).toBeCloseTo(15, 6);
    expect(d.warnings.some((w) => /clamp/i.test(w))).toBe(false);
  });

  // Issue #134: at a small enough locked size, even a MODEST corner radius
  // request can exceed the useful max well before it hits the "effectively
  // round" bend-limit floor -- the point of `usefulMaxCornerRadius` is to
  // catch exactly this well short of a literal circle.
  it("clamps a corner radius that's within the OLD outerSize/2 ceiling but beyond the useful max (issue #134)", async () => {
    const spec = baseSpec({
      shape: { kind: "sq", cornerRadius: 15 },
      coreSize: { locked: true, dimension: "outer", value: 60 },
      height: { locked: true, value: 40 },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);
    // Still well short of a literal circle (half the RESOLVED, possibly
    // size-raised, outer size).
    expect(d.solution.cornerRadius).toBeLessThan(d.solution.outerSize / 2);
    expect(d.solution.cornerRadius).toBeLessThan(15);
    expect(d.solution.cornerRadius).toBeCloseTo(d.solution.cornerRadiusRange[1], 6);
    expect(d.warnings.some((w) => /clamped down/i.test(w))).toBe(true);
  });

  it("clamps the corner radius up to the bend-limit floor and warns, without becoming fully round", async () => {
    const spec = baseSpec({
      wire: { length: 2000, diameter: 3.8, type: "usb" },
      shape: { kind: "sq", cornerRadius: 1 }, // far tighter than the wire can bend around
      coreSize: { locked: true, dimension: "outer", value: 100 }, // big enough that the bend floor < apothem
      height: { locked: true, value: 40 },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);
    expect(d.solution.cornerRadius).toBeGreaterThan(1);
    expect(d.solution.cornerRadius).toBeLessThan(d.solution.outerSize / 2);
    expect(d.warnings.some((w) => /clamped up/i.test(w))).toBe(true);
    expect(d.warnings.some((w) => /effectively round/i.test(w))).toBe(false);
  });

  // Issue #54: a locked size this small used to just silently clamp the
  // corner radius up to the apothem (warning "effectively round" below) --
  // the shape choice did nothing visible. The solver now raises the
  // EFFECTIVE size instead, so a locked-too-small tri/sq still comes back
  // genuinely non-round (see the "keeps square/triangle distinct" describe
  // block below for the full sweep).
  it("raises a too-small locked size instead of letting the shape silently become round, and warns why", async () => {
    const spec = baseSpec({
      wire: { length: 2000, diameter: 3.8, type: "usb" },
      shape: { kind: "tri", cornerRadius: 5 },
      coreSize: { locked: true, dimension: "outer", value: 20 }, // apothem 10mm < the ~14.4mm bend-limit floor for this wire -- below the threshold that forces a round core
      height: { locked: true, value: 40 },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);
    expect(d.solution.outerSize).toBeGreaterThan(20);
    expect(d.solution.outerSize).toBeCloseTo(d.solution.minOuterSizeForShape, 6);
    expect(d.warnings.some((w) => /core size raised/i.test(w))).toBe(true);
    // The whole point: it's no longer effectively round.
    expect(d.warnings.some((w) => /effectively round/i.test(w))).toBe(false);
    expect(d.solution.cornerRadius).toBeLessThan(d.solution.outerSize / 2);
  });

  it("computes the bore as a true inward offset, not outer - 2*wall, so the bore's own corner radius shrinks with it", async () => {
    // Regression guard for an early bug ("inner
    // = outer - 2*wall is wrong for triangles"): the reported inner "size"
    // scalar is the same either way (apothem shrinks uniformly), so this is
    // checked at the mesh level instead -- see test/geometry.test.ts's
    // "true offset outline, not a bounding circle" case for the outline math.
    const spec = baseSpec({
      shape: { kind: "tri", cornerRadius: 15 },
      coreSize: { locked: true, dimension: "outer", value: 60 },
      height: { locked: true, value: 40 },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);
    expect(d.solution.innerBore).toBeCloseTo(60 - 2 * WALL_THICKNESS, 6);
  });

  it("reports a smaller envelope for a rounded square than the round-core (bounding-circle) size at the same outer size", async () => {
    const size = 60;
    const round = await design(
      baseSpec({ shape: { kind: "round" }, coreSize: { locked: true, dimension: "outer", value: size }, height: { locked: true, value: 40 }, layers: { locked: true, value: 1 } }),
    );
    const square = await design(
      baseSpec({
        shape: { kind: "sq", cornerRadius: 15 },
        coreSize: { locked: true, dimension: "outer", value: size },
        height: { locked: true, value: 40 },
        layers: { locked: true, value: 1 },
      }),
    );
    // A rounded square's true circumscribed envelope (corner-arc midpoint)
    // is bigger than the round core's (same apothem, but the square's
    // corners bulge out further) -- yet still well short of the old
    // bounding-circle-across-a-sharp-corner overestimate, checked in
    // test/geometry.test.ts.
    expect(square.solution.envelopeDiameter).toBeGreaterThan(round.solution.envelopeDiameter);
  });
});

// Issue #54: "for a rounded square or triangle and a small core size (or a
// stiff cable with a big bend radius), the corner radius gets clamped up to
// the apothem and the core is just a circle, so choosing the shape does
// nothing visible." The solver now enforces a per-shape minimum outer size
// (`Solution.minOuterSizeForShape`, solve.ts's `minOuterSizeForShapeFlats`):
// below it, a LOCKED size is silently raised (with a warning); a FREE size
// never searches below it. This sweeps every wire-type preset x sq/tri,
// each requested well under any reasonable floor, and checks the actual
// resolved outline (design()'s own `wallSpec.outline`, not a reimplemented
// formula) against the ticket's own threshold.
describe("design() keeps square/triangle distinct at small sizes (issue #54)", () => {
  const WIRE_PRESETS: Array<{ type: "usb" | "flex" | "stiff"; diameter: number }> = [
    { type: "usb", diameter: 3.8 },
    { type: "flex", diameter: 2.5 },
    { type: "stiff", diameter: 3.8 },
  ];
  const SHAPES: Array<"sq" | "tri"> = ["sq", "tri"];

  it.each(WIRE_PRESETS)("for wire type=$type (d=$diameter mm): sq/tri outlines keep straight flats >= max(2*d, 15% of perimeter), even when a tiny size is requested", async ({ type, diameter }) => {
    for (const kind of SHAPES) {
      const d = await design(
        baseSpec({
          wire: { length: 2000, diameter, type },
          shape: { kind, cornerRadius: 1 }, // an intentionally tight request; the bend limit floors it regardless (solve.ts's `bendCornerRadiusFloor`)
          coreSize: { locked: true, dimension: "outer", value: 5 }, // deliberately far below any reasonable floor
          height: { locked: true, value: 40 },
          layers: { locked: true, value: 1 },
        }),
      );
      const outline = d.wallSpec.outline;
      const flat = sideLength(outline);
      const threshold = Math.max(2 * diameter, 0.15 * offsetPerimeter(outline, 0));
      expect(flat, `${kind}/${type}: straight flat length`).toBeGreaterThanOrEqual(threshold - 1e-6);
      // The AC's other half: "the effective core size is never below the
      // shape's minimum" -- surfaced on Solution for the UI to clamp its
      // size control against, not just satisfied incidentally here.
      expect(d.solution.outerSize).toBeGreaterThanOrEqual(d.solution.minOuterSizeForShape - 1e-6);
      expect(d.warnings.some((w) => /core size raised/i.test(w))).toBe(true);
    }
  });

  it("never raises the size for round (round has no flats to keep, so minOuterSizeForShape falls back to the bend-limit floor)", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 2000, diameter: 3.8, type: "stiff" },
        shape: { kind: "round" },
        coreSize: { locked: true, dimension: "outer", value: 5 },
        height: { locked: true, value: 40 },
        layers: { locked: true, value: 1 },
      }),
    );
    expect(d.solution.minOuterSizeForShape).toBeCloseTo(d.solution.minOuterSizeForBend, 6);
    expect(d.warnings.some((w) => /core size raised/i.test(w))).toBe(false);
  });

  it("a FREE size never resolves below the shape's own minimum either (not just a locked one)", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 200, diameter: 3.8, type: "stiff" }, // a short target, so an unconstrained search would otherwise pick a tiny core
        shape: { kind: "tri", cornerRadius: 1 },
        coreSize: { locked: false },
        height: { locked: true, value: 40 },
        layers: { locked: true, value: 1 },
      }),
    );
    expect(d.solution.outerSize).toBeGreaterThanOrEqual(d.solution.minOuterSizeForShape - 1e-6);
    const flat = sideLength(d.wallSpec.outline);
    const threshold = Math.max(2 * 3.8, 0.15 * offsetPerimeter(d.wallSpec.outline, 0));
    expect(flat).toBeGreaterThanOrEqual(threshold - 1e-6);
  });
});

// Issue #134: "with the square or triangle shape corner radius after some
// point doesn't change anything and makes it look like a circle" -- the
// slider used to run all the way up to `outerSize/2` (an exact circle), so
// a long stretch of it changed nothing anyone would notice well before that
// point. `Solution.cornerRadiusRange[1]` (solve.ts's `usefulMaxCornerRadius`)
// is now the largest corner radius that still reads as a square/triangle,
// by the SAME "flat >= max(2 wire diameters, 15% of perimeter)" criterion
// issue #54 already established on the minimum-SIZE side (`sideLength`/
// `offsetPerimeter` below, exercised through the public `design()`
// interface only, per the testing rules in AGENTS.md -- never a
// reimplemented or directly-imported copy of `usefulMaxCornerRadius`
// itself).
describe("design() useful corner-radius maximum (issue #134)", () => {
  const WIRE = { length: 2000, diameter: 3.8, type: "usb" as const };

  it.each(["sq", "tri"] as const)(
    "%s: cornerRadiusRange[1] keeps the straight flat at the SAME threshold issue #54 enforces on the minimum size, at a range of outer sizes",
    async (kind) => {
      // Every size here is comfortably above `minOuterSizeForShapeFlats` for
      // this wire/shape, so none of these triggers a "core size raised"
      // side effect -- each resolves at exactly the locked size.
      for (const outerSize of [80, 120, 200, 320]) {
        const d = await design({
          ...baseSpec({ wire: WIRE }),
          shape: { kind, cornerRadius: d0(kind, outerSize) },
          coreSize: { locked: true, dimension: "outer", value: outerSize },
          height: { locked: true, value: 40 },
          layers: { locked: true, value: 1 },
        });
        expect(d.solution.outerSize).toBeCloseTo(outerSize, 6);

        const useful = d.solution.cornerRadiusRange[1];
        // Sitting right AT the useful max: the flat is still at or above
        // the threshold (never collapses past it).
        const atMax = await design({
          ...baseSpec({ wire: WIRE }),
          shape: { kind, cornerRadius: useful },
          coreSize: { locked: true, dimension: "outer", value: outerSize },
          height: { locked: true, value: 40 },
          layers: { locked: true, value: 1 },
        });
        const flatAtMax = sideLength(atMax.wallSpec.outline);
        const thresholdAtMax = Math.max(2 * WIRE.diameter, 0.15 * offsetPerimeter(atMax.wallSpec.outline, 0));
        expect(flatAtMax, `${kind} @ ${outerSize}mm: flat at the useful max`).toBeGreaterThanOrEqual(thresholdAtMax - 1e-6);

        // Just past it: the flat would have dropped BELOW the threshold --
        // this is what makes `useful` a true maximum, not just "a" legal
        // value. (This is the assertion that fails against the OLD
        // `outerSize/2` ceiling: a request of `useful + 1` used to be
        // honored as-is, no matter how thin the resulting flat.)
        const pastMax = await design({
          ...baseSpec({ wire: WIRE }),
          shape: { kind, cornerRadius: useful + 1 },
          coreSize: { locked: true, dimension: "outer", value: outerSize },
          height: { locked: true, value: 40 },
          layers: { locked: true, value: 1 },
        });
        expect(pastMax.solution.cornerRadius, `${kind} @ ${outerSize}mm: a request above the useful max is clamped back down to it`).toBeCloseTo(useful, 3);
        expect(pastMax.warnings.some((w) => /clamped down/i.test(w))).toBe(true);
      }
    },
  );

  it.each(["sq", "tri"] as const)("%s: cornerRadiusRange[1] is monotone increasing in core size", async (kind) => {
    const sizes = [70, 90, 130, 180, 260, 400];
    const useful: number[] = [];
    for (const outerSize of sizes) {
      const d = await design({
        ...baseSpec({ wire: WIRE }),
        shape: { kind, cornerRadius: 1 }, // request itself is irrelevant; only cornerRadiusRange is read
        coreSize: { locked: true, dimension: "outer", value: outerSize },
        height: { locked: true, value: 40 },
        layers: { locked: true, value: 1 },
      });
      expect(d.solution.outerSize).toBeCloseTo(outerSize, 6); // none of these triggers a size raise
      useful.push(d.solution.cornerRadiusRange[1]);
    }
    for (let i = 1; i < useful.length; i++) {
      expect(useful[i], `${kind}: useful max at ${sizes[i]}mm vs. ${sizes[i - 1]}mm`).toBeGreaterThan(useful[i - 1]);
    }
  });
});

// A request comfortably inside whatever this outer size's useful max is
// likely to be (a hair above the bend-limit floor) -- just needs to be a
// LEGAL, non-clamped starting point for the "past the useful max" probe
// above; the exact value doesn't matter, only that `useful + 1` (computed
// from the ACTUAL resolved solution) is what gets tested against it.
function d0(_kind: "sq" | "tri", outerSize: number): number {
  return Math.max(1, outerSize * 0.05);
}

describe("design() screw-keyhole wall mount (issue #13)", () => {
  it("defaults to no mount, with the flange thickness derived from the cable diameter (issue #43) and no keyhole warnings", async () => {
    const d = await design(
      baseSpec({
        coreSize: { locked: true, dimension: "outer", value: 60 },
        height: { locked: true, value: 40 },
        layers: { locked: true, value: 1 },
      }),
    );
    expect(d.spec.mount).toBe("none");
    expect(d.flangeSpec.mount).toBe("none");
    // Issue #43: thickness now tracks the cable's own diameter (roughly
    // idealChannelDepth + a small shelf -- INNER_CHANNEL_DEPTH_FACTOR=1.0,
    // INNER_CHANNEL_MIN_SHELF=1.5mm, constants.ts, reimplemented
    // independently here) so the wound cable's first turn lies flush --
    // this is the new baseline every design gets, mount or not, so it's no
    // longer pinned to a fixed FLANGE_THICKNESS, but never below it either.
    const INNER_CHANNEL_DEPTH_FACTOR = 1.0;
    const INNER_CHANNEL_MIN_SHELF = 1.5;
    const expectedThickness = Math.max(FLANGE_THICKNESS, INNER_CHANNEL_DEPTH_FACTOR * d.spec.wire.diameter + INNER_CHANNEL_MIN_SHELF);
    expect(d.flangeSpec.thickness).toBeCloseTo(expectedThickness, 9);
    expect(d.warnings.some((w) => /keyhole/i.test(w))).toBe(false);
    // The channel-driven baseline itself isn't a "thickness increased"
    // event (that stays reserved for extra growth a MOUNT causes on top of
    // it -- see the next test).
    expect(d.warnings.some((w) => /thickness increased/i.test(w))).toBe(false);
  });

  it("bumps the flange's margin (and warns), and its thickness only as far as the recess itself needs, to fit the recessed mount, on a comfortably large core", async () => {
    const baseGeometry = { coreSize: { locked: true, dimension: "outer", value: 100 } as const, height: { locked: true, value: 60 } };
    const none = await design(baseSpec({ ...baseGeometry, mount: "none" }));
    const d = await design(baseSpec({ ...baseGeometry, mount: "keyhole" }));

    expect(d.flangeSpec.mount).toBe("keyhole");
    // Issue #122: the recess sits on its own pad, away from the channel, so
    // the flange is only as thick as the deeper of the two -- here the
    // 3.8 mm cable's channel (5.3 mm) already covers the 5 mm recess.
    expect(d.flangeSpec.thickness).toBeCloseTo(Math.max(none.flangeSpec.thickness, MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT), 9);
    expect(d.flangeSpec.margin).toBeGreaterThan(none.flangeSpec.margin);
    expect(d.warnings.some((w) => /thickness increased/i.test(w))).toBe(d.flangeSpec.thickness > none.flangeSpec.thickness);
    // A thin cable's channel doesn't: the pads then grow to the recess's 5 mm (and it warns).
    const thinNone = await design(baseSpec({ ...baseGeometry, wire: { length: 2000, diameter: 2, type: "usb" }, mount: "none" }));
    const thin = await design(baseSpec({ ...baseGeometry, wire: { length: 2000, diameter: 2, type: "usb" }, mount: "keyhole" }));
    expect(thin.flangeSpec.thickness).toBeGreaterThan(thinNone.flangeSpec.thickness);
    expect(thin.flangeSpec.thickness).toBeCloseTo(MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT, 9);
    expect(thin.warnings.some((w) => /thickness increased/i.test(w))).toBe(true);
    expect(d.warnings.some((w) => /margin increased/i.test(w))).toBe(true);
    // The mount fits at this size: no "too narrow"/skip warning.
    expect(d.warnings.some((w) => /too narrow/i.test(w))).toBe(false);
    // Test-audit report, C-C: moved from test/innerEnd.test.ts's own "the
    // mount's own recess grows the flange thickness further, so the channel
    // still reaches its ideal depth" (issue #43), which otherwise duplicated
    // this test's own thickness/margin assertions on the identical
    // core=100/height=60/none-vs-keyhole spec. Issue #43: the flange grows
    // enough for the full-depth inner-end channel PLUS the mount's own
    // recess, so neither design should ever warn about a shallow channel.
    expect(none.warnings.some((w) => /channel is only .* mm deep/i.test(w))).toBe(false);
    expect(d.warnings.some((w) => /channel is only .* mm deep/i.test(w))).toBe(false);
  });

  it("warns (without crashing) and skips the cut when the caller feeds layoutKeyholeMount a margin it already knows is too narrow", async () => {
    // design() itself now ALWAYS grows the margin enough to fit (mount.ts's
    // `requiredFlangeMargin` has no ceiling -- a tiny/sharp core just gets a
    // bigger flange, warned about below), so this exercises the underlying
    // defensive fallback directly: `layoutKeyholeMount` must still degrade
    // gracefully, not throw or emit invalid geometry, if it's ever handed a
    // margin narrower than what its own sizing would have chosen.
    const d = await design(baseSpec({ coreSize: { locked: true, dimension: "outer", value: 6 }, height: { locked: true, value: 20 } }));
    const { outline, boreOutline } = d.flangeSpec;
    const layout = layoutKeyholeMount(outline, boreOutline, 0.1);
    expect(layout.slots).toHaveLength(0);
    expect(layout.warning).toMatch(/too narrow/i);
  });

  it("still grows the margin (and warns) to fit the mount even on a tiny, sharp core -- never silently gives up", async () => {
    const d = await design(
      baseSpec({
        wire: { length: 20, diameter: 1, type: "usb" },
        coreSize: { locked: true, dimension: "outer", value: 6 },
        height: { locked: true, value: 20 },
        mount: "keyhole",
      }),
    );
    expect(d.flangeSpec.mount).toBe("keyhole");
    expect(d.flangeSpec.margin).toBeGreaterThan(FLANGE_MARGIN);
    expect(d.warnings.some((w) => /margin increased/i.test(w))).toBe(true);
    expect(d.warnings.some((w) => /too narrow/i.test(w))).toBe(false);

    const layout = layoutKeyholeMount(d.flangeSpec.outline, d.flangeSpec.boreOutline, d.flangeSpec.margin);
    expect(layout.slots.length).toBeGreaterThan(0);
  });

  // PR review regression (issue #13): the wall-view screenshot showed both
  // slots of a 2-slot layout stacked on top of each other near one edge,
  // instead of side by side above the centre -- a level hang needs the
  // centre of mass directly BELOW the slot(s), which these geometric
  // invariants pin down precisely. Both slots' own CHANNELS point along
  // literal WALL_UP (mount.ts's file header: checked directly, in the
  // flange's own XY, not projected), while their shared ANCHOR is
  // symmetric about the shape's own best axis (mount.ts's `bestAxisDeg`:
  // literal vertical for round, a tilted one for square/triangle, chosen to
  // minimise the flange bulge it needs -- so ITS hang is level too).
  describe.each([
    { label: "round", shape: { kind: "round" } as const },
    { label: "sq", shape: { kind: "sq", cornerRadius: 15 } as const },
    { label: "tri", shape: { kind: "tri", cornerRadius: 15 } as const },
  ])("keyhole slot placement hangs level ($label core)", ({ shape }) => {
    /** Projects a point onto an axis' own "up"/"side" basis (mount.ts's `makeSlotAt`-style theta, degrees from WALL_UP). */
    function project(p: { x: number; y: number }, axisDeg: number) {
      const a = (axisDeg * Math.PI) / 180;
      const up = { x: Math.sin(a), y: Math.cos(a) };
      const side = { x: Math.cos(a), y: -Math.sin(a) };
      return { up: p.x * up.x + p.y * up.y, side: p.x * side.x + p.y * side.y };
    }
    const anchorOf = (slot: { head: { x: number; y: number }; shankEnd: { x: number; y: number } }) => ({
      x: (slot.head.x + slot.shankEnd.x) / 2,
      y: (slot.head.y + slot.shankEnd.y) / 2,
    });

    it("places 2 slots symmetric about the shape's own best axis, above centre, each channel pointing literally up", async () => {
      const d = await design(
        baseSpec({
          shape,
          coreSize: { locked: true, dimension: "outer", value: 100 },
          height: { locked: true, value: 60 },
          layers: { locked: true, value: 1 },
          mount: "keyhole",
        }),
      );
      const { outline, boreOutline, margin } = d.flangeSpec;
      const layout = layoutKeyholeMount(outline, boreOutline, margin);
      expect(layout.slots).toHaveLength(2); // this flange is well above SCREW_MOUNT_TWO_SLOT_FLANGE_THRESHOLD

      for (const slot of layout.slots) {
        // Each channel points literally WALL_UP: same x, shankEnd higher than head (mount.ts's file header, requirement 3).
        expect(slot.shankEnd.x).toBeCloseTo(slot.head.x, 9);
        expect(slot.shankEnd.y).toBeGreaterThan(slot.head.y);
        // Above the centre of mass (the outline is centred on the origin).
        expect(slot.head.y).toBeGreaterThan(0);
      }

      // The 2 anchors are mirror images of each other about the PUBLIC
      // `d.mountAxisDeg` -- not a value re-derived by calling `bestAxisDeg`
      // again (test-audit report, C-B/B3: that would only show `bestAxisDeg`
      // agreeing with itself, still passing even if it chose a wrong axis).
      expect(d.mountAxisDeg).not.toBeUndefined();
      const axisDeg = d.mountAxisDeg!;
      const [a, b] = layout.slots.map((slot) => project(anchorOf(slot), axisDeg));
      expect(a.side).toBeCloseTo(-b.side, 6);
      expect(a.up).toBeCloseTo(b.up, 6);
      // Not on the axis itself (2 DISTINCT slots, not one doubled up).
      expect(Math.abs(a.side)).toBeGreaterThan(1);

      // MountLayout surfaces the SAME axis it actually used (issue #13 PR
      // review round 2), and design() re-surfaces it on the Design itself:
      // a consumer (the viewer's wall presets) needs this to show the
      // mount's real hung orientation -- see mount.ts's own doc comment.
      expect(layout.axisDeg).toBeCloseTo(axisDeg, 9);
    });

    it("places a single slot centred on the shape's own best axis, above centre, channel pointing literally up, on a modest flange", async () => {
      const d = await design(
        baseSpec({
          shape,
          // A thinner cable than this file's usual 3.8mm default (issue
          // #54): sq/tri now enforce a minimum outer size that keeps their
          // straight sides meaningfully long at the wire's bend limit
          // (solve.ts's `minOuterSizeForShapeFlats`), and the DEFAULT 3.8mm
          // cable's own floor for sq lands right at this test's
          // `SCREW_MOUNT_TWO_SLOT_FLANGE_THRESHOLD` boundary -- an unrelated
          // interaction this test isn't about. A thinner cable keeps the
          // floor well under 40 mm for every shape, so this "modest flange"
          // case stays modest and the single-slot path under test is
          // actually exercised (issue #54's own coverage lives in
          // design.test.ts's "keeps square/triangle distinct" describe block).
          wire: { length: 2000, diameter: 2, type: "usb" },
          coreSize: { locked: true, dimension: "outer", value: 40 },
          height: { locked: true, value: 40 },
          layers: { locked: true, value: 1 },
          mount: "keyhole",
        }),
      );
      const { outline, boreOutline, margin } = d.flangeSpec;
      const layout = layoutKeyholeMount(outline, boreOutline, margin);
      expect(layout.slots).toHaveLength(1); // below SCREW_MOUNT_TWO_SLOT_FLANGE_THRESHOLD

      const slot = layout.slots[0];
      expect(slot.shankEnd.x).toBeCloseTo(slot.head.x, 9);
      expect(slot.shankEnd.y).toBeGreaterThan(slot.head.y);
      expect(slot.head.y).toBeGreaterThan(0);

      // Centred exactly on the PUBLIC `d.mountAxisDeg` (side offset 0) --
      // not a re-derived `bestAxisDeg` call (see the 2-slot test above).
      expect(d.mountAxisDeg).not.toBeUndefined();
      const axisDeg = d.mountAxisDeg!;
      const anchor = project(anchorOf(slot), axisDeg);
      expect(anchor.side).toBeCloseTo(0, 6);
      expect(anchor.up).toBeGreaterThan(0);

      expect(layout.axisDeg).toBeCloseTo(axisDeg, 9);
    });
  });

  it("design()'s mountAxisDeg is undefined without the keyhole mount, but defined once requiredFlangeMargin grows the flange to fit it", async () => {
    const none = await design(baseSpec({ coreSize: { locked: true, dimension: "outer", value: 100 }, height: { locked: true, value: 60 } }));
    expect(none.mountAxisDeg).toBeUndefined();

    const tooSmall = await design(baseSpec({ coreSize: { locked: true, dimension: "outer", value: 6 }, height: { locked: true, value: 20 }, mount: "keyhole" }));
    expect(tooSmall.mountAxisDeg).not.toBeUndefined(); // requiredFlangeMargin grows the flange to fit -- see the "tiny, sharp core" test above
  });
});

// Issue #63 (PR #59 review): the result panel's flange/height numbers must
// match the ACTUAL built parts, not the solver's own envelope-based
// estimates -- verified here directly against `design()`'s own mesh
// vertices (never a re-derivation of the formula design.ts/solve.ts use),
// across round/sq/tri, with and without a mount, capped and uncapped.
describe("design() real overall height / flange extent match the built parts (issue #63)", () => {
  /** min/max per axis over every vertex of every part, in the shared assembly frame (types.ts's `Part` doc: no printTransform needed to measure the assembled design). */
  function assembledBBox(parts: { mesh: { positions: Float32Array } }[]) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const part of parts) {
      const p = part.mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    return { minX, maxX, minY, maxY, minZ, maxZ };
  }

  /** min/max X/Y over just the core part's own bottom-flange vertices (z in [-thickness, 0], the flange's own z-slab -- see design.ts/manifold.ts's z=[-thickness,0] convention). */
  function flangeBBox(core: { mesh: { positions: Float32Array } }, thickness: number) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const p = core.mesh.positions;
    const eps = 1e-6;
    for (let i = 0; i < p.length; i += 3) {
      const z = p[i + 2];
      if (z < -thickness - eps || z > eps) continue;
      const x = p[i], y = p[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { width: maxX - minX, depth: maxY - minY };
  }

  const TOLERANCE_MM = 0.5;

  for (const shape of [{ kind: "round" as const }, { kind: "sq" as const, cornerRadius: 15 }, { kind: "tri" as const, cornerRadius: 15 }]) {
    for (const mount of ["none", "keyhole"] as const) {
      for (const topCap of ["off", "on"] as const) {
        it(`${shape.kind}, mount=${mount}, cap=${topCap}: overallHeight and flangeExtent match the built parts within ${TOLERANCE_MM} mm`, async () => {
          const d = await design(
            baseSpec({
              shape,
              coreSize: { locked: true, dimension: "outer", value: 70 },
              height: { locked: true, value: 55 },
              layers: { locked: true, value: 2 },
              mount,
              topCap,
            }),
          );
          expect(d.solution.overallHeight).toBeDefined();
          expect(d.solution.flangeExtent).toBeDefined();

          const overall = assembledBBox(d.parts);
          const realOverallHeight = overall.maxZ - overall.minZ;
          expect(d.solution.overallHeight!).toBeCloseTo(realOverallHeight, 0); // toBeCloseTo(_, 0) is +-0.5
          expect(Math.abs(d.solution.overallHeight! - realOverallHeight)).toBeLessThan(TOLERANCE_MM);

          const core = d.parts.find((p) => p.role === "core")!;
          const flange = flangeBBox(core, d.flangeSpec.thickness);
          const { acrossFlats, acrossCorners } = d.solution.flangeExtent!;
          // Every real flange vertex's per-axis extent lies between the
          // shape's own narrowest (across flats) and widest (across
          // corners) real extent -- exact for round/square (this shape
          // registry's square places its corners exactly on the X/Y axes,
          // see shapes.ts's `polygonVertex`), a true bound for triangle
          // (whose axis-aligned bbox mixes flats and corners).
          expect(flange.width).toBeGreaterThan(acrossFlats - TOLERANCE_MM);
          expect(flange.width).toBeLessThan(acrossCorners + TOLERANCE_MM);
          expect(flange.depth).toBeGreaterThan(acrossFlats - TOLERANCE_MM);
          expect(flange.depth).toBeLessThan(acrossCorners + TOLERANCE_MM);
          if (shape.kind !== "tri") {
            // Round and square are both symmetric under a 90-degree
            // rotation, so their axis-aligned bbox lands exactly on one of
            // the two named extents in both X and Y.
            expect(Math.min(Math.abs(flange.width - acrossFlats), Math.abs(flange.width - acrossCorners))).toBeLessThan(TOLERANCE_MM);
            expect(Math.min(Math.abs(flange.depth - acrossFlats), Math.abs(flange.depth - acrossCorners))).toBeLessThan(TOLERANCE_MM);
          }
        });
      }
    }
  }
});

// Issue #65 (result panel review): the wound cable's own outer size
// (`envelopeDiameter`, always a circumscribed/across-corners extent, see
// capacity.ts) must never exceed the flange's own across-corners extent --
// design.ts's flange margin is deliberately sized to clear it (flange.ts's
// `resolveFlangeSizing`'s `baseMargin`), so this is the invariant a "cable
// sticks out past the flange" warning would guard; it's a genuine
// mathematical guarantee of that sizing (never just true by luck for these
// particular specs), so it's checked across round/sq/tri, with and without
// a mount, and across a spread of cable sizes -- and the warning itself
// must correspondingly never appear.
describe("design() cable outer size never exceeds the flange (issue #65)", () => {
  for (const shape of [{ kind: "round" as const }, { kind: "sq" as const, cornerRadius: 15 }, { kind: "tri" as const, cornerRadius: 15 }]) {
    for (const mount of ["none", "keyhole"] as const) {
      for (const wireDiameter of [1.5, 3.8, 8]) {
        it(`${shape.kind}, mount=${mount}, wire=${wireDiameter}mm: envelope stays within the flange's across-corners extent, no warning`, async () => {
          const d = await design(
            baseSpec({
              shape,
              wire: { length: 2000, diameter: wireDiameter, type: "usb" },
              coreSize: { locked: true, dimension: "outer", value: 70 },
              height: { locked: true, value: 55 },
              layers: { locked: true, value: 2 },
              mount,
            }),
          );
          expect(d.solution.flangeExtent).toBeDefined();
          expect(d.solution.envelopeDiameter).toBeLessThanOrEqual(d.solution.flangeExtent!.acrossCorners);
          expect(d.warnings.some((w) => w.includes("stick out past the flange"))).toBe(false);
        });
      }
    }
  }
});
