import { describe, expect, it } from "vitest";
import { DEFAULT_SPEC, design } from "../src/core";
import type { CoilSpec } from "../src/core";

// Issues #357 and #374: since the locked-height floor (#353) layer 1 always carries at
// least one turn, so the cable always has a wound path with an inner-end
// lead-in and an outer-end lead-out, and no locked layer stays empty. This is an invariant guard over design().

type Shape = CoilSpec["shape"];
const SHAPES: Shape[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 10 }, { kind: "tri", cornerRadius: 10 }, { kind: "pill", cornerRadius: 15 }];
const DIAMETERS = [2, 3.8, 8];
const OFF_ROUND_DIAMETERS = [1.37, 5.83, 7.41, 11.09];
const BASE_CAP: Array<Pick<CoilSpec, "base" | "topCap">> = [
  { base: "on", topCap: "on" },
  { base: "on", topCap: "off" },
  { base: "off", topCap: "on" },
  { base: "off", topCap: "off" },
];
const LAYERS: Array<CoilSpec["layers"]> = [{ locked: true, value: 1 }, { locked: true, value: 3 }, { locked: false }];
const CORES: Array<CoilSpec["coreSize"]> = [{ locked: false }, { locked: true, dimension: "outer", value: 60 }, { locked: true, dimension: "outer", value: 120 }];
const WELL_BELOW = 1;

function make(shape: Shape, d: number, cb: Pick<CoilSpec, "base" | "topCap">, layers: CoilSpec["layers"], height: CoilSpec["height"], coreSize: CoilSpec["coreSize"], length = 300): CoilSpec {
  return { ...DEFAULT_SPEC, shape, ...cb, layers, height, coreSize, wire: { ...DEFAULT_SPEC.wire, length, diameter: d } };
}

async function expectCable(spec: CoilSpec, label: string) {
  const r = await design(spec, "draft");
  expect(r.solution.layerResults[0].turns, label).toBeGreaterThanOrEqual(1);
  for (const layer of r.solution.layerResults) expect(layer.turns, `${label}, layer ${layer.layer}`).toBeGreaterThanOrEqual(1);
  expect(r.wirePaths.length, label).toBe(r.solution.layers);
  expect(r.wirePaths[0].turns, label).toBeGreaterThanOrEqual(1);
  expect(r.innerEndLeadIn.length, label).toBeGreaterThanOrEqual(6);
  expect(r.outerEndLeadOut.length, label).toBeGreaterThanOrEqual(6);
  expect(r.cablePath.length, label).toBeGreaterThan(r.wirePaths[0].points.length);
  return r;
}

function combos() {
  const out: Array<{ shape: Shape; d: number; cb: Pick<CoilSpec, "base" | "topCap">; layers: CoilSpec["layers"]; core: CoilSpec["coreSize"]; tag: string }> = [];
  const add = (shape: Shape, d: number, cb: Pick<CoilSpec, "base" | "topCap">, layers: CoilSpec["layers"]) => {
    const core = CORES[out.length % CORES.length];
    const coreTag = core.locked ? `core ${core.value}` : "core free";
    out.push({ shape, d, cb, layers, core, tag: `${shape.kind}, ${d} mm, base ${cb.base}, cap ${cb.topCap}, layers ${layers.locked ? layers.value : "free"}, ${coreTag}` });
  };
  SHAPES.forEach((shape, si) => {
    DIAMETERS.forEach((d, di) => {
      LAYERS.forEach((layers, li) => {
        if (si === 0) BASE_CAP.forEach((cb) => add(shape, d, cb, layers));
        else if (li === (si + di) % LAYERS.length) add(shape, d, BASE_CAP[(si + di + li) % BASE_CAP.length], layers);
      });
    });
  });
  OFF_ROUND_DIAMETERS.forEach((d, oi) => {
    BASE_CAP.forEach((cb, ci) => add(SHAPES[(oi + ci) % SHAPES.length], d, cb, LAYERS[(oi + ci) % LAYERS.length]));
  });
  return out;
}

describe("layer 1 always has a turn and the cable always has both ends", () => {
  for (const { shape, d, cb, layers, core, tag } of combos()) {
    it(`${tag}, locked heights around the floor`, async () => {
      const raised = await expectCable(make(shape, d, cb, layers, { locked: true, value: WELL_BELOW }, core), `${tag}, height ${WELL_BELOW}`);
      const floor = raised.solution.minHeight;
      expect(raised.solution.height, tag).toBeCloseTo(floor, 6);
      for (const height of [floor, floor + 0.05, floor + 0.5]) {
        await expectCable(make(shape, d, cb, layers, { locked: true, value: height }, core), `${tag}, height ${height}`);
      }
    });
    it(`${tag}, free height`, async () => {
      await expectCable(make(shape, d, cb, layers, { locked: false }, core), `${tag}, free height`);
    });
  }
});

describe("a long cable that needs several layers keeps layer 1 wound", () => {
  for (const cb of [BASE_CAP[0], BASE_CAP[3]]) {
    for (const core of [CORES[0]]) {
      it(`base ${cb.base}, cap ${cb.topCap}, free layers and height, core ${core.locked ? core.value : "free"}`, async () => {
        const r = await expectCable(make(SHAPES[0], 3.8, cb, { locked: false }, { locked: false }, core, 3000), "3000 mm");
        expect(r.solution.layers).toBeGreaterThan(1);
      });
    }
  }
});

describe("the 7.41 mm cable of fuzz case 1197", () => {
  it("keeps layer 1 wound at the raised height", async () => {
    const spec: CoilSpec = JSON.parse(
      '{"wire":{"length":952,"diameter":7.41,"type":"flex"},"shape":{"kind":"tri","cornerRadius":14.88},"windingQuality":0.63,"coreSize":{"locked":false},"height":{"locked":true,"value":15.98},"layers":{"locked":false},"objective":"minVolume","topCap":"on","joint":"bayonet","tolerance":0.33,"print":{"bedX":256,"bedY":256,"bedZ":256},"mount":"through","plateJoint":"snap","keyholeRotation":45,"throughHoleDiameter":3.54,"base":"on","strapSlots":false}',
    );
    const r = await expectCable(spec, "case 1197");
    expect(r.solution.diagnosis.status).toBe("ok");
  });
});
