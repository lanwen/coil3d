import { describe, expect, it } from "vitest";
import { DEFAULT_SPEC, design } from "../src/core";
import type { CoilSpec } from "../src/core";

// Issue #353: a locked height below one turn of the cable (plus, for a bare
// core, the end rings) is raised to `Solution.minHeight`, the same number the
// free solve uses as its lower bound. Everything goes through design().

type Shape = CoilSpec["shape"];
const SHAPES: Shape[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }, { kind: "pill", cornerRadius: 15 }];
const DIAMETERS = [2, 3.8, 8];
const CAP_BASE: Array<Pick<CoilSpec, "base" | "topCap">> = [
  { base: "on", topCap: "on" },
  { base: "on", topCap: "off" },
  { base: "off", topCap: "on" },
  { base: "off", topCap: "off" },
];
const ON_ON = { base: "on", topCap: "on" } as const;

function make(overrides: Partial<CoilSpec> & { d?: number; length?: number }): CoilSpec {
  const { d = 3.8, length = 300, ...rest } = overrides;
  return { ...DEFAULT_SPEC, wire: { ...DEFAULT_SPEC.wire, length, diameter: d }, ...rest };
}

// Below every floor, including the 2.4 mm one of a 2 mm cable with the cap and base on.
const BELOW_FLOOR = 1;
const lockedHeight = (value: number) => ({ height: { locked: true as const, value } });
const sizeFreeOneLayer = { coreSize: { locked: false as const }, layers: { locked: true as const, value: 1 } };
const raisedNote = (d: { notices: Array<{ message: string }> }) => d.notices.find((n) => /Height raised/.test(n.message));

describe("a locked height is raised to the cable's minimum", () => {
  for (const shape of SHAPES) {
    for (const d of DIAMETERS) {
      for (const cb of CAP_BASE) {
        it(`${shape.kind}, ${d} mm, base ${cb.base}, cap ${cb.topCap}`, async () => {
          const r = await design(make({ shape, d, ...cb, ...sizeFreeOneLayer, ...lockedHeight(BELOW_FLOOR) }), "draft");
          expect(r.solution.minHeight).toBeGreaterThan(d);
          expect(r.solution.height).toBeCloseTo(r.solution.minHeight, 6);
          expect(raisedNote(r)).toBeDefined();
          expect(r.solution.layerResults[0].turns).toBeGreaterThanOrEqual(1);
        });
      }
    }
  }

  it("pins the floor for the default shape", async () => {
    const floor = async (d: number, cb: Pick<CoilSpec, "base" | "topCap">) => (await design(make({ d, ...cb, ...sizeFreeOneLayer, ...lockedHeight(BELOW_FLOOR) }), "draft")).solution.minHeight;
    expect(await floor(2, ON_ON)).toBeCloseTo(2.4, 3);
    expect(await floor(3.8, ON_ON)).toBeCloseTo(4.2, 3);
    expect(await floor(8, ON_ON)).toBeCloseTo(8.4, 3);
    expect(await floor(3.8, { base: "on", topCap: "off" })).toBeCloseTo(20.716, 3);
    expect(await floor(8, { base: "off", topCap: "off" })).toBeCloseTo(36.003, 3);
  });

  it("agrees with the free solve", async () => {
    for (const d of DIAMETERS) {
      const r = await design(make({ d, ...ON_ON, coreSize: { locked: true, dimension: "outer", value: 120 }, height: { locked: false }, layers: { locked: true, value: 1 } }), "draft");
      expect(r.solution.height, `d=${d}`).toBeCloseTo(r.solution.minHeight, 3);
    }
  });

  it("builds a valid part from the raised value", async () => {
    const r = await design(make({ ...ON_ON, ...sizeFreeOneLayer, ...lockedHeight(BELOW_FLOOR) }), "draft");
    expect(r.solution.diagnosis.status).toBe("ok");
    expect(r.solution.height).toBeCloseTo(4.2, 2);
    expect(r.solution.totalWireLength).toBeGreaterThanOrEqual(300);
    expect(raisedNote(r)?.message).toMatch(/Height raised from 1\.0 mm to 4\.2 mm: the cable needs its 3\.8 mm plus 0\.4 mm clearance between the base and the cap/);
  });

  it("never reports ok below the floor", async () => {
    const lockSets: Array<Partial<CoilSpec>> = [
      sizeFreeOneLayer,
      { coreSize: { locked: false }, layers: { locked: true, value: 3 } },
      { coreSize: { locked: true, dimension: "outer", value: 36 }, layers: { locked: false } },
    ];
    for (const d of [3.8, 8]) {
      const floor = (await design(make({ d, length: 2000, ...ON_ON, ...sizeFreeOneLayer, ...lockedHeight(BELOW_FLOOR) }), "draft")).solution.minHeight;
      for (const h of [1, 3, floor - 0.1]) {
        for (const locks of lockSets) {
          const r = await design(make({ d, length: 2000, ...ON_ON, ...locks, ...lockedHeight(h) }), "draft");
          const label = `d=${d} h=${h} ${JSON.stringify(locks)}`;
          expect(r.solution.height, label).toBeGreaterThanOrEqual(r.solution.minHeight - 1e-9);
          if (r.solution.diagnosis.status === "ok") {
            expect(r.solution.totalWireLength, label).toBeGreaterThanOrEqual(2000 * (1 - 1e-6));
          }
        }
      }
    }
  });

  it("leaves a height above the floor alone", async () => {
    const floor = (await design(make({ ...ON_ON, ...sizeFreeOneLayer, ...lockedHeight(BELOW_FLOOR) }), "draft")).solution.minHeight;
    const r = await design(make({ ...ON_ON, ...sizeFreeOneLayer, ...lockedHeight(floor + 0.1) }), "draft");
    expect(r.solution.height).toBeCloseTo(floor + 0.1, 9);
    expect(raisedNote(r)).toBeUndefined();
  });

  it("reads the locked layer count, not the solved one", async () => {
    const withLayers = (n: number) => design(make({ base: "on", topCap: "off", coreSize: { locked: false }, layers: { locked: true, value: n }, ...lockedHeight(BELOW_FLOOR) }), "draft");
    expect((await withLayers(3)).solution.minHeight).toBeCloseTo(20.716, 3);
    expect((await withLayers(1)).solution.minHeight).toBeCloseTo(20.716, 3);
  });
});
