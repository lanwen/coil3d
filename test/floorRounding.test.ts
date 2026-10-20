import { describe, expect, it } from "vitest";
import { DEFAULT_SPEC, design } from "../src/core";
import type { CoilSpec } from "../src/core";

// Issue #358: a locked height below the floor is raised to exactly
// `Solution.minHeight`. That height must wind at least one turn on layer 1
// for every cable diameter, including the ones where the floor's rounding
// used to land a hair under one pitch.

const ON_ON = { base: "on", topCap: "on" } as const;
const CAP_OFF = { base: "on", topCap: "off" } as const;
const BASE_OFF = { base: "off", topCap: "off" } as const;
const BELOW_FLOOR = { locked: true as const, value: 1 };

function atFloor(d: number, cb: Pick<CoilSpec, "base" | "topCap">, layers: CoilSpec["layers"] = { locked: true, value: 1 }): CoilSpec {
  return { ...DEFAULT_SPEC, ...cb, layers, height: BELOW_FLOOR, coreSize: { locked: false }, wire: { ...DEFAULT_SPEC.wire, diameter: d } };
}

async function floorTurns(spec: CoilSpec) {
  const r = await design(spec, "draft");
  expect(r.solution.height, `d=${spec.wire.diameter}`).toBeCloseTo(r.solution.minHeight, 9);
  return r.solution.layerResults[0].turns;
}

describe("the height floor winds a turn on layer 1", () => {
  it("fuzz case 1197: tri, 7.41 mm flex, base on, cap on, bayonet", async () => {
    const spec: CoilSpec = JSON.parse(
      '{"wire":{"length":952,"diameter":7.41,"type":"flex"},"shape":{"kind":"tri","cornerRadius":14.88},"windingQuality":0.63,"coreSize":{"locked":false},"height":{"locked":true,"value":15.98},"layers":{"locked":false},"objective":"minVolume","topCap":"on","joint":"bayonet","tolerance":0.33,"print":{"bedX":256,"bedY":256,"bedZ":256},"mount":"through","plateJoint":"snap","keyholeRotation":45,"throughHoleDiameter":3.54,"base":"on","strapSlots":false}',
    );
    const r = await design(spec, "draft");
    expect(r.solution.layerResults[0].turns).toBeGreaterThanOrEqual(1);
    expect(r.solution.diagnosis.status).toBe("ok");
    expect(r.wirePaths.length).toBeGreaterThan(0);
  });

  const BANDS: Array<[number, number]> = [[1, 5], [5, 10], [10, 15]];
  async function emptyAt(cb: Pick<CoilSpec, "base" | "topCap">, layers: CoilSpec["layers"], from: number, to: number, stepMm: number) {
    const empty: number[] = [];
    for (let i = Math.round(from * 100); i <= Math.round(to * 100); i += Math.round(stepMm * 100)) {
      const d = i / 100;
      if ((await floorTurns(atFloor(d, cb, layers))) < 1) empty.push(d);
    }
    return empty;
  }

  for (const [from, to] of BANDS) {
    it(`every 0.05 mm cable diameter from ${from} to ${to} mm, base on and cap on`, async () => {
      expect(await emptyAt(ON_ON, { locked: true, value: 1 }, from, to, 0.05)).toEqual([]);
    }, 300_000);
  }

  it("every 0.43 mm cable diameter from 1 to 15 mm, base on and cap off", async () => {
    expect(await emptyAt(CAP_OFF, { locked: true, value: 1 }, 1, 15, 0.43)).toEqual([]);
  }, 300_000);

  it("every 0.43 mm cable diameter from 1 to 15 mm, base off and cap off", async () => {
    expect(await emptyAt(BASE_OFF, { locked: true, value: 1 }, 1, 15, 0.43)).toEqual([]);
  }, 300_000);

  it("every 0.37 mm cable diameter from 1 to 15 mm with three layers locked, base on and cap off", async () => {
    expect(await emptyAt(CAP_OFF, { locked: true, value: 3 }, 1, 15, 0.37)).toEqual([]);
  }, 300_000);
});
