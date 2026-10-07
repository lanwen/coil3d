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
    wire: { length: 150, diameter: 3.6, type: "stiff" }, // 23.4 mm bend radius: a 46.1 mm round core at least
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: false },
    height: { locked: false },
    layers: { locked: false },
    objective: "minVolume",
    topCap: "auto",
    base: "on",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

const OUTER_80: Partial<CoilSpec> = { coreSize: { locked: true, dimension: "outer", value: 80 } };
const HEIGHT_12: Partial<CoilSpec> = { height: { locked: true, value: 12 } }; // room for one turn only
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
  // One turn around the locked 80 mm core already holds 254 mm of the 150 mm
  // cable; a smaller core would hold less.
  const lockedCore: Array<[string, Partial<CoilSpec>]> = [
    ["0 free", { ...OUTER_80, ...HEIGHT_12, ...ONE_LAYER }],
    ["1 free (height)", { ...OUTER_80, ...ONE_LAYER }],
    ["1 free (layers)", { ...OUTER_80, ...HEIGHT_12 }],
    ["2 free (height, layers)", { ...OUTER_80 }],
  ];
  for (const [name, locks] of lockedCore) {
    it(`locked 80 mm core, ${name}: ok, the note names the core size lock`, async () => {
      const d = await design(baseSpec(locks), "draft");
      expect(d.solution.outerSize).toBe(80);
      expect(d.solution.lengthDeltaPct).toBeGreaterThan(50);
      expectHoldsWithNote(d, /^Room for 69% more cable than you need, because of the locked core size \(80 mm\)\. Unlock it/);
    });
  }

  // The bend limit's 46.1 mm floor: one turn already holds 147 mm of the 100 mm cable.
  const SHORT: Partial<CoilSpec> = { wire: { length: 100, diameter: 3.6, type: "stiff" } };
  const bendFloor: Array<[string, Partial<CoilSpec>]> = [
    ["0 free (core locked below the floor)", { ...SHORT, coreSize: { locked: true, dimension: "outer", value: 30 }, ...HEIGHT_12, ...ONE_LAYER }],
    ["1 free (size)", { ...SHORT, ...HEIGHT_12, ...ONE_LAYER }],
    ["2 free (size, height)", { ...SHORT, ...ONE_LAYER }],
    ["2 free (size, layers)", { ...SHORT, ...HEIGHT_12 }],
    ["3 free", { ...SHORT }],
  ];
  for (const [name, locks] of bendFloor) {
    it(`bend-limit size floor, ${name}: holds the cable, the note names the bend limit`, async () => {
      const d = await design(baseSpec(locks), "draft");
      expect(d.solution.outerSize).toBeCloseTo(46.08, 1);
      expectHoldsWithNote(d, /^Room for 47% more cable than you need: this cable's 23\.4 mm bend radius needs a core of at least 46\.1 mm.*smallest coil for this cable/);
    });
  }

  it("names every lock that could shrink and still hold the cable", async () => {
    // 3 layers on a 150 mm core, 40 mm tall: one layer at a lower height would do.
    const d = await design(baseSpec({ coreSize: { locked: true, dimension: "outer", value: 150 }, height: { locked: true, value: 40 }, layers: { locked: true, value: 3 } }), "draft");
    expectHoldsWithNote(d, /because of the locked core size \(150 mm\), height \(40 mm\) and 3 layers\. Unlock them/);
  });
});

describe("never ok when the capacity falls short of the target (AGENTS.md)", () => {
  it("a fully locked coil 1-2% short of the target is not ok", async () => {
    // The locked 80 mm, one-turn coil holds 254 mm.
    const d = await design(baseSpec({ wire: { length: 257, diameter: 3.6, type: "stiff" }, ...OUTER_80, ...HEIGHT_12, ...ONE_LAYER }), "draft");
    expect(d.solution.totalWireLength).toBeLessThan(257);
    expect(d.solution.diagnosis.status).toBe("over-constrained");
  });
});
