import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, Objective, ShapeSpec, Solution } from "../src/core";

// Issue #195: with free dimensions, every candidate the solver offers (the
// pick and its alternates, for either objective) is "tight": no free
// dimension could shrink and still hold the cable. So its capacity overshoots
// the target by less than the smallest step the free dimensions can take:
//   - a free core size above its floor: ~0 (size is continuous);
//   - otherwise a free height: less than one turn on every layer (dropping
//     the height across the next turn boundary loses at most one turn per
//     layer);
//   - otherwise a free layer count: less than the outermost layer.
// Only the solved numbers matter here, so designs are built at draft
// resolution (the solver's output doesn't depend on it).

function baseSpec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: { length: 2000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: false },
    height: { locked: false },
    layers: { locked: false },
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

/** The solver's smallest core size (src/core/constants.ts SIZE_LO_FLOOR), or the shape's own bend/flat floor if larger. */
const SIZE_LO_FLOOR = 5;

function overshootLimit(spec: CoilSpec, c: Solution): { limit: number; why: string } | undefined {
  const wound = c.layerResults.filter((l) => l.turns > 0);
  if (!spec.coreSize.locked && c.outerSize > Math.max(SIZE_LO_FLOOR, c.minOuterSizeForShape) + 1e-6) return { limit: 1e-3 * c.targetWireLength, why: "a free size above its floor" };
  if (!spec.height.locked) return { limit: wound.reduce((s, l) => s + l.length / l.turns, 0), why: "one turn on every layer" };
  if (!spec.layers.locked) return { limit: wound.at(-1)!.length, why: "the outermost layer" };
  return undefined;
}

function expectTight(spec: CoilSpec, candidates: Solution[]) {
  for (const c of candidates) {
    const overshoot = c.totalWireLength - c.targetWireLength;
    expect(overshoot, "covers the target").toBeGreaterThanOrEqual(-1e-6 * c.targetWireLength);
    const bound = overshootLimit(spec, c);
    if (!bound) continue;
    const where = `${c.objectiveUsed} candidate ${c.outerSize.toFixed(1)} mm x ${c.height.toFixed(1)} mm x ${c.layers} layers: +${c.lengthDeltaPct.toFixed(0)}%`;
    expect(overshoot, `${where}, overshoot below ${bound.why} (${bound.limit.toFixed(0)} mm)`).toBeLessThan(bound.limit);
  }
}

describe("solver candidates never overshoot the target by more than one step of a free dimension (issue #195)", () => {
  it("the reported case: default cable, all three dimensions free, even proportions (+111%)", async () => {
    const spec = baseSpec({ objective: "aspectRatio" });
    const d = await design(spec, "draft");
    expect(d.solution.diagnosis.status).toBe("under-constrained");
    expectTight(spec, [d.solution, ...d.solution.alternates]);
  });

  const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 8 }, { kind: "tri", cornerRadius: 8 }];
  const WIRES: Array<CoilSpec["wire"]> = [
    { length: 0, diameter: 3.8, type: "usb" },
    { length: 0, diameter: 3.6, type: "stiff" },
  ];
  const FREE: Array<{ name: string; locks: Partial<CoilSpec> }> = [
    { name: "size+height (1 layer)", locks: { layers: { locked: true, value: 1 } } },
    { name: "size+height (3 layers)", locks: { layers: { locked: true, value: 3 } } },
    { name: "layers+size (height 40)", locks: { height: { locked: true, value: 40 } } },
    { name: "layers+height (outer 60)", locks: { coreSize: { locked: true, dimension: "outer", value: 60 } } },
    { name: "all three", locks: {} },
  ];
  const OBJECTIVES: Objective[] = ["minVolume", "aspectRatio"];
  for (const shape of SHAPES) {
    for (const wire of WIRES) {
      for (const length of [1000, 2000, 5000]) {
        for (const { name, locks } of FREE) {
          for (const objective of OBJECTIVES) {
            it(`shape=${shape.kind} ${wire.type} ${length} mm, ${name} free, ${objective}`, async () => {
              const spec = baseSpec({ shape, wire: { ...wire, length }, objective, ...locks });
              const d = await design(spec, "draft");
              if (d.solution.diagnosis.status !== "ok" && d.solution.diagnosis.status !== "under-constrained") return;
              expectTight(spec, [d.solution, ...d.solution.alternates]);
            });
          }
        }
      }
    }
  }
});
