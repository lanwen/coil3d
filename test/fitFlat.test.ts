import { describe, expect, it } from "vitest";
import { DEFAULT_SPEC, design, parseHash } from "../src/core";
import type { CoilSpec } from "../src/core";
import { expectWithinBendLimit } from "./support/cableBend";
import { minBendRadius } from "./support/wire";

// Issue #374: a core one turn tall cannot nest a second layer, so it winds as a
// flat spiral. Locked 9.5 mm height, 25 locked layers, 2 m of 3.8 mm cable.
const REPRO_HASH = "#s=eyJ2IjoyLCJoIjo5LjUsImx5IjoyNSwibG9jayI6WyJoIiwibHkiXSwiY2FwIjoib24iLCJiYXNlIjoib24ifQ";
const FLAT_SPIRAL_ENVELOPE_MAX = 250;

describe("a locked one-turn-tall core winds a flat spiral", () => {
  it("the repro hash is ok, every layer holds a turn and the coil fits the bed", async () => {
    const spec = parseHash(REPRO_HASH).spec;
    const r = await design(spec, "final");
    const { solution } = r;
    expect(solution.diagnosis.status).toBe("ok");
    expect(solution.layers).toBe(25);
    expect(solution.layerResults.map((l) => l.turns)).toEqual(Array(25).fill(1));
    expect(r.wirePaths.length).toBe(solution.layers);
    expect(solution.totalWireLength).toBeGreaterThanOrEqual(spec.wire.length);
    expect(solution.envelopeDiameter).toBeLessThan(FLAT_SPIRAL_ENVELOPE_MAX);
    expect(r.fitsBed).toBe(true);
  });

  it("the 25 one-turn layers join with transitions inside the cable's bend limit", async () => {
    const spec = parseHash(REPRO_HASH).spec;
    const r = await design(spec, "final");
    expect(r.warnings.filter((w) => w.includes("bends tighter"))).toEqual([]);
    expectWithinBendLimit(r.cablePath, minBendRadius(spec.wire), "flat spiral repro");
  });

  it("the stack is flat: layers differ in radius, not in height", async () => {
    const r = await design(parseHash(REPRO_HASH).spec, "draft");
    const zRange = (points: Float32Array) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 2; i < points.length; i += 3) {
        lo = Math.min(lo, points[i]);
        hi = Math.max(hi, points[i]);
      }
      return [lo, hi];
    };
    const [lo1, hi1] = zRange(r.wirePaths[0].points);
    const [lo2, hi2] = zRange(r.wirePaths[1].points);
    expect(lo2).toBeCloseTo(lo1, 6);
    expect(hi2).toBeCloseTo(hi1, 6);
  });

  it("the repro has no winding-quality note: a flat spiral holds the same at every quality", async () => {
    const r = await design(parseHash(REPRO_HASH).spec, "draft");
    expect(r.notices.filter((n) => n.message.includes("winding quality"))).toEqual([]);
  });

  it("the capacity note names the winding end that falls short and quotes its capacity", async () => {
    const spec: CoilSpec = {
      ...DEFAULT_SPEC,
      wire: { ...DEFAULT_SPEC.wire, length: 100000 },
      coreSize: { locked: true, dimension: "outer", value: 60 },
      height: { locked: true, value: 50 },
      layers: { locked: true, value: 2 },
    };
    const r = await design(spec, "draft");
    const [tight, loose] = r.solution.capacityRange;
    expect(loose).toBeGreaterThan(tight);
    expect(r.solution.capacityMinWinding).toBe("nested");
    const note = r.notices.find((n) => n.message.includes("winding quality"));
    expect(note).toBeDefined();
    expect(note!.message).toContain("tightest winding quality (nested layers)");
    expect(note!.message).toContain(`capacity is only ${tight.toFixed(0)} mm`);
    expect(r.notices.some((n) => n.message.includes("loosest"))).toBe(false);
  });

  it("a flat spiral holds the same length at every winding quality", async () => {
    const spec = parseHash(REPRO_HASH).spec;
    const lengths: number[] = [];
    for (const windingQuality of [0, 0.4, 0.7, 1]) {
      lengths.push((await design({ ...spec, windingQuality } as CoilSpec, "draft")).solution.totalWireLength);
    }
    for (const length of lengths) expect(length).toBeCloseTo(lengths[0], 6);
    const range = (await design(spec, "draft")).solution.capacityRange;
    expect(range[0]).toBeCloseTo(range[1], 6);
  });

  it("the default design is not a flat spiral and keeps its nested layers", async () => {
    const r = await design(DEFAULT_SPEC, "draft");
    expect(r.solution.layerResults[0].turns).toBeGreaterThanOrEqual(2);
  });
});
