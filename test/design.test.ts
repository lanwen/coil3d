import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec } from "../src/core";
// mount.ts's layout is the SAME shared function both geometry backends cut
// from (manifold.ts, step/build.ts) -- calling it here on design()'s own
// PUBLIC `flangeSpec` (not a reimplementation) verifies the actual layout
// that was cut, per the PR review's request for "a vitest check through
// design()" of the slot geometry.
import { bestAxisDeg, layoutKeyholeMount } from "../src/core/mount";
import { SCREW_MOUNT_TWO_SLOT_ANGLE } from "../src/core/constants";

// Fixed print parameters mirrored from src/core/constants.ts (docs/research.md
// §2/§3), reimplemented independently here so these tests exercise ONLY the
// public `design()` interface, per the testing decisions in docs/research.md.
const WALL_THICKNESS = 3;
const CLEARANCE = 0.3;
const GROOVE_DEPTH_FACTOR = 0.3;
const MARGIN = 3;
const FLANGE_THICKNESS = 3;
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

/** Forward capacity for a single layer, matching docs/research.md §3. */
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

  it("applies the bend-limit preset: usb and flex both clamp to 4x, stiff to 10x (docs/research.md §1)", async () => {
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
    const spec = baseSpec({
      shape: { kind: "sq", cornerRadius: 15 },
      coreSize: { locked: true, dimension: "outer", value: 60 },
      height: { locked: true, value: 40 },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);
    expect(d.solution.cornerRadius).toBeCloseTo(15, 6);
    expect(d.warnings.some((w) => /clamp/i.test(w))).toBe(false);
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

  it("warns that the shape became effectively round when the bend limit needs a bigger corner radius than the core allows", async () => {
    const spec = baseSpec({
      wire: { length: 2000, diameter: 3.8, type: "usb" },
      shape: { kind: "tri", cornerRadius: 5 },
      coreSize: { locked: true, dimension: "outer", value: 20 }, // apothem 10mm < the ~14.4mm bend-limit floor for this wire -- below spikes/s1 RESULT.md's round-forcing threshold
      height: { locked: true, value: 40 },
      layers: { locked: true, value: 1 },
    });
    const d = await design(spec);
    expect(d.warnings.some((w) => /effectively round/i.test(w))).toBe(true);
    expect(d.solution.cornerRadius).toBeCloseTo(d.solution.outerSize / 2, 1);
  });

  it("computes the bore as a true inward offset, not outer - 2*wall, so the bore's own corner radius shrinks with it", async () => {
    // Regression guard for spikes/s5-solver/RESULT.md's flagged bug ("inner
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

  it("bumps the flange's thickness and margin (and warns) to fit the recessed mount, on a comfortably large core", async () => {
    const baseGeometry = { coreSize: { locked: true, dimension: "outer", value: 100 } as const, height: { locked: true, value: 60 } };
    const none = await design(baseSpec({ ...baseGeometry, mount: "none" }));
    const d = await design(baseSpec({ ...baseGeometry, mount: "keyhole" }));

    expect(d.flangeSpec.mount).toBe("keyhole");
    expect(d.flangeSpec.thickness).toBeGreaterThan(FLANGE_THICKNESS);
    expect(d.flangeSpec.thickness).toBeGreaterThan(none.flangeSpec.thickness);
    expect(d.flangeSpec.margin).toBeGreaterThan(none.flangeSpec.margin);
    expect(d.warnings.some((w) => /thickness increased/i.test(w))).toBe(true);
    expect(d.warnings.some((w) => /margin increased/i.test(w))).toBe(true);
    // The mount fits at this size: no "too narrow"/skip warning.
    expect(d.warnings.some((w) => /too narrow/i.test(w))).toBe(false);
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

      // The 2 anchors are mirror images of each other about the shape's own best axis.
      const axisDeg = bestAxisDeg(boreOutline, SCREW_MOUNT_TWO_SLOT_ANGLE);
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
      expect(d.mountAxisDeg).toBeCloseTo(axisDeg, 9);
    });

    it("places a single slot centred on the shape's own best axis, above centre, channel pointing literally up, on a modest flange", async () => {
      const d = await design(
        baseSpec({
          shape,
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

      // Centred exactly on the shape's own best axis (side offset 0).
      const axisDeg = bestAxisDeg(boreOutline, 0);
      const anchor = project(anchorOf(slot), axisDeg);
      expect(anchor.side).toBeCloseTo(0, 6);
      expect(anchor.up).toBeGreaterThan(0);

      expect(layout.axisDeg).toBeCloseTo(axisDeg, 9);
      expect(d.mountAxisDeg).toBeCloseTo(axisDeg, 9);
    });
  });

  it("design()'s mountAxisDeg is undefined without the keyhole mount, and also when the mount doesn't fit at all", async () => {
    const none = await design(baseSpec({ coreSize: { locked: true, dimension: "outer", value: 100 }, height: { locked: true, value: 60 } }));
    expect(none.mountAxisDeg).toBeUndefined();

    const tooSmall = await design(baseSpec({ coreSize: { locked: true, dimension: "outer", value: 6 }, height: { locked: true, value: 20 }, mount: "keyhole" }));
    expect(tooSmall.mountAxisDeg).not.toBeUndefined(); // requiredFlangeMargin grows the flange to fit -- see the "tiny, sharp core" test above
  });
});
