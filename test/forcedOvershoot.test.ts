import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, Design } from "../src/core";

// Issue #199: when the locks (or the bend limit) force a coil that holds
// more cable than the target, the design still holds the cable. Its status
// and its message must not depend on how many dimensions are free: "ok"
// ("under-constrained" with all three free, like every three-free design),
// with a note naming what keeps the coil from getting smaller. Only a
// shortfall is ever reported as not fitting.

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 150, diameter: 3.6, type: "stiff" }, // 23.4 mm bend radius: a core 64.5 mm across and 56 mm tall at least, for the inner end held in the bore
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

const OUTER_80: Partial<CoilSpec> = { coreSize: { locked: true, dimension: "outer", value: 80 } };
const HEIGHT_60: Partial<CoilSpec> = { height: { locked: true, value: 60 } };
const ONE_LAYER: Partial<CoilSpec> = { layers: { locked: true, value: 1 } };

function expectHoldsWithNote(d: Design, note: RegExp) {
  const s = d.solution;
  expect(s.totalWireLength).toBeGreaterThanOrEqual(s.targetWireLength);
  expect(s.diagnosis.status).toBe(s.diagnosis.freeCount === 3 ? "under-constrained" : "ok");
  const overshoot = d.notices.filter((n) => /more cable than you need/.test(n.message));
  expect(overshoot).toHaveLength(1);
  expect(overshoot[0].severity).toBe("note");
  expect(overshoot[0].message).toMatch(note);
  expect(d.warnings.some((w) => /bends tighter/i.test(w))).toBe(false);
}

describe("a forced overshoot gets the same status and note whatever the number of free dimensions (issue #199)", () => {
  // The inner end alone is over 100 mm of this stiff cable, and every turn around the locked 80 mm core is
  // 250 mm more: a smaller core would hold less.
  const lockedCore: Array<[string, Partial<CoilSpec>]> = [
    ["0 free", { ...OUTER_80, ...HEIGHT_60, ...ONE_LAYER }],
    ["1 free (height)", { ...OUTER_80, ...ONE_LAYER }],
    ["1 free (layers)", { ...OUTER_80, ...HEIGHT_60 }],
    ["2 free (height, layers)", { ...OUTER_80 }],
  ];
  for (const [name, locks] of lockedCore) {
    it(`locked 80 mm core, ${name}: ok, the note names the core size lock`, async () => {
      const d = await design(baseSpec(locks), "draft");
      expect(d.solution.outerSize).toBe(80);
      expect(d.solution.lengthDeltaPct).toBeGreaterThan(50);
      expectHoldsWithNote(d, /^Room for \d+% more cable than you need, because of the locked core size \(80 mm\)/);
    });
  }

  // The floor for the inner end held in the bore: 64.5 mm across, which is where its quarter bend and its plan arc fit.
  const SHORT: Partial<CoilSpec> = { wire: { length: 100, diameter: 3.6, type: "stiff" } };
  const sizeFloor: Array<[string, Partial<CoilSpec>]> = [
    ["core locked below the floor", { ...SHORT, coreSize: { locked: true, dimension: "outer", value: 30 }, ...ONE_LAYER }],
    ["2 free (size, height)", { ...SHORT, ...ONE_LAYER }],
    ["3 free", { ...SHORT }],
  ];
  for (const [name, locks] of sizeFloor) {
    it(`inner-end size floor, ${name}: holds the cable, the note names the inner end`, async () => {
      const d = await design(baseSpec(locks), "draft");
      expect(d.solution.outerSize).toBeCloseTo(d.solution.minOuterSizeForShape, 6);
      expectHoldsWithNote(d, /^Room for \d+% more cable than you need: the bore has to let this cable's inner end through at its 23\.4 mm bend radius, which needs a core of at least \d+\.\d mm.*smallest coil for this cable/);
    });
  }

  it("names every lock that could shrink and still hold the cable", async () => {
    const d = await design(baseSpec({ coreSize: { locked: true, dimension: "outer", value: 150 }, height: { locked: true, value: 80 }, layers: { locked: true, value: 3 } }), "draft");
    expectHoldsWithNote(d, /because of the locked core size \(150 mm\), height \(80 mm\) and 3 layers\. Unlock them/);
  });
});

describe("never ok when the capacity falls short of the target (AGENTS.md)", () => {
  it("a fully locked coil 1-2% short of the target is not ok", async () => {
    const locked = { ...OUTER_80, ...HEIGHT_60, ...ONE_LAYER };
    const held = (await design(baseSpec({ wire: { length: 100, diameter: 3.6, type: "stiff" }, ...locked }), "draft")).solution.totalWireLength;
    const length = Math.ceil(held * 1.015);
    const d = await design(baseSpec({ wire: { length, diameter: 3.6, type: "stiff" }, ...locked }), "draft");
    expect(d.solution.totalWireLength).toBeLessThan(length);
    expect(d.solution.diagnosis.status).toBe("over-constrained");
  });
});
