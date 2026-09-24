import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec } from "../src/core";

// Fixed print parameters mirrored from src/core/constants.ts (docs/research.md
// §2/§3), reimplemented independently here so these tests exercise ONLY the
// public `design()` interface, per the testing decisions in docs/research.md.
const WALL_THICKNESS = 3;
const CLEARANCE = 0.3;
const GROOVE_DEPTH_FACTOR = 0.3;
const MARGIN = 3;

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: false },
    height: { locked: false },
    layers: { locked: false },
    objective: "minVolume",
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

  it("reports under-constrained with a clear notice when all three dimensions are free", async () => {
    const spec = baseSpec({ coreSize: { locked: false }, height: { locked: false }, layers: { locked: false } });
    const d = await design(spec);
    expect(d.solution.diagnosis.freeCount).toBe(3);
    expect(d.solution.diagnosis.status).toBe("under-constrained");
    expect(d.solution.diagnosis.message).toMatch(/lock at least one dimension/i);
  });

  it("returns an alternate candidate side by side when exactly two dimensions are free", async () => {
    const spec = baseSpec({
      wire: { length: 3000, diameter: 3.8, type: "usb" },
      coreSize: { locked: false },
      height: { locked: false },
      layers: { locked: true, value: 2 },
      objective: "minVolume",
    });
    const d = await design(spec);
    expect(d.solution.diagnosis.freeCount).toBe(2);
    expect(d.solution.objectiveUsed).toBe("minVolume");
    expect(d.solution.alternate).toBeDefined();
    expect(d.solution.alternate?.objectiveUsed).toBe("aspectRatio");
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
