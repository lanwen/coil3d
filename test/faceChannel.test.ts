import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, Design, ShapeSpec, WireSpec } from "../src/core";
import { FACE_TAIL_HANG } from "../src/core/constants";
import { outlineOffsetAt } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";
import { expectWithinBendLimit } from "./support/cableBend";
import { unsupportedOverhangs } from "./support/overhangs";
import { faceWebs, MIN_WEB, WEB_TOLERANCE } from "./support/faceWeb";

// Issue #254, part 2: a bare core's cable ends leave the winding onto a flat end face, run in a channel that sweeps in
// to a hole at the centre, and turn through it. Everything here goes through design(): the drawn cable
// (innerEndLeadIn, outerEndLeadOut, cablePath), the mesh, and the solver's numbers.

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const SHAPES: Array<[string, ShapeSpec]> = [
  ["round", { kind: "round" }],
  ["square", { kind: "sq", cornerRadius: 12 }],
  ["triangle", { kind: "tri", cornerRadius: 12 }],
];

const CABLES: Array<[string, WireSpec]> = [
  ["USB 3.8 mm", { length: 2500, diameter: 3.8, type: "usb" }],
  ["HDMI 7 mm", { length: 2500, diameter: 7, type: "usb" }],
  ["stiff 3.6 mm", { length: 2500, diameter: 3.6, type: "stiff" }],
];

function spec(shape: ShapeSpec, wire: WireSpec, layers: number, topCap: "on" | "off"): CoilSpec {
  return {
    wire,
    shape,
    windingQuality: 0.7,
    coreSize: { locked: false },
    height: { locked: false },
    layers: { locked: true, value: layers },
    objective: "minVolume",
    base: "off",
    topCap,
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
  };
}

const designs = new Map<string, Promise<Design>>();
function bare(shapeName: string, cableName: string, layers: number, topCap: "on" | "off"): Promise<Design> {
  const key = [shapeName, cableName, layers, topCap].join("/");
  let d = designs.get(key);
  if (!d) {
    const shape = SHAPES.find(([n]) => n === shapeName)![1];
    const wire = CABLES.find(([n]) => n === cableName)![1];
    designs.set(key, (d = design(spec(shape, wire, layers, topCap), "draft")));
  }
  return d;
}

const point = (path: Float32Array, i: number): [number, number, number] => [path[3 * i], path[3 * i + 1], path[3 * i + 2]];
const count = (path: Float32Array) => path.length / 3;

function pathLength(path: Float32Array): number {
  let sum = 0;
  for (let i = 1; i < count(path); i++) {
    const [a, b] = [point(path, i - 1), point(path, i)];
    sum += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return sum;
}

describe.each(SHAPES.flatMap(([shapeName]) => CABLES.map(([cableName]) => [shapeName, cableName] as const)))("%s core, %s", (shapeName, cableName) => {
  it("bends the whole cable, winding to both ends, within the cable's bend radius", async () => {
    for (const [layers, topCap] of [[1, "off"], [2, "on"]] as const) {
      const d = await bare(shapeName, cableName, layers, topCap);
      const mbr = bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter;
      expect(d.faceChannels, `${layers} layer(s), cap ${topCap}`).toBeDefined();
      expectWithinBendLimit(d.innerEndLeadIn, mbr, "inner end");
      if (d.faceChannels?.outer) expectWithinBendLimit(d.outerEndLeadOut, mbr, "outer end");
      expectWithinBendLimit(d.cablePath, mbr, "the whole cable");
    }
  });

  it("starts on the end turn and ends inside the hole: the inner end up the bore, the outer end down it", async () => {
    const d = await bare(shapeName, cableName, 1, "off");
    const layout = d.faceChannels!;
    const first = d.wirePaths[0].points;
    const lead = d.innerEndLeadIn;
    expect(point(lead, count(lead) - 1)).toEqual(point(first, 0));
    const clearance = d.spec.wire.diameter / 2;
    const tail = point(lead, 0);
    expect(tail[2], "the inner end rises to the top face").toBeCloseTo(d.solution.height, 4);
    expect(outlineOffsetAt(layout.holeOutline, tail[0], tail[1]).offset, "the inner end stands inside the hole").toBeLessThanOrEqual(-clearance);

    const last = d.wirePaths[0].points;
    const out = d.outerEndLeadOut;
    expect(point(out, 0)).toEqual(point(last, count(last) - 1));
    const hang = point(out, count(out) - 1);
    expect(hang[2], "the outer end hangs down").toBeLessThan(point(out, 0)[2] - 2 * d.spec.wire.diameter);
    expect(outlineOffsetAt(layout.holeOutline, hang[0], hang[1]).offset, "the outer end stands inside the hole").toBeLessThanOrEqual(-clearance);
  });

  it("keeps the cable clear of the core from the channel on to its free end", async () => {
    for (const [layers, topCap] of [[1, "off"], [2, "on"]] as const) {
      const d = await bare(shapeName, cableName, layers, topCap);
      const core = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: d.mesh.positions, triVerts: d.mesh.indices }));
      const ends = [d.innerEndLeadIn, ...(d.faceChannels?.outer ? [d.outerEndLeadOut] : [])];
      for (const path of ends) {
        const capsules: Array<InstanceType<ManifoldToplevel["Manifold"]>> = [];
        const r = d.spec.wire.diameter / 2;
        const skip = 6;
        for (let i = skip; i + 1 < count(path); i += 2) {
          const [a, b] = [point(path, i), point(path, Math.min(i + 2, count(path) - 1))];
          capsules.push(wasm.Manifold.hull([wasm.Manifold.sphere(r, 12).translate(a), wasm.Manifold.sphere(r, 12).translate(b)]));
        }
        const hit = wasm.Manifold.union(capsules).intersect(core);
        expect(hit.volume(), `${layers} layer(s), cap ${topCap}: cable volume inside the core (mm^3)`).toBeLessThan(0.5);
      }
    }
  });

  it("leaves at least 1.2 mm of material over the bottom channel's roof and under the top channel's floor", async () => {
    const { roof, floor } = faceWebs(await bare(shapeName, cableName, 1, "off"));
    expect(roof.length).toBeGreaterThan(2);
    expect(floor.length).toBeGreaterThan(2);
    expect(Math.min(...roof), "over the bottom channel's roof").toBeGreaterThanOrEqual(MIN_WEB - WEB_TOLERANCE);
    expect(Math.min(...floor), "under the top channel's floor").toBeGreaterThanOrEqual(MIN_WEB - WEB_TOLERANCE);
  });

  it("counts the channel in the cable length: the solver's length is the wound cable plus both drawn ends", async () => {
    const d = await bare(shapeName, cableName, 1, "off");
    const { inner, outer } = d.faceChannels!;
    expect(d.solution.totalWireLength - d.solution.totalWoundLength).toBeCloseTo(inner.length + outer!.length, 6);
    expect(pathLength(d.innerEndLeadIn)).toBeCloseTo(inner.length, -0.5);
    expect(Math.abs(pathLength(d.innerEndLeadIn) - inner.length) / inner.length).toBeLessThan(0.005);
    const hung = Math.abs(point(d.outerEndLeadOut, count(d.outerEndLeadOut) - 1)[2] - outer!.tailEnd);
    expect(hung).toBeLessThan(1e-3);
    expect(Math.abs(pathLength(d.outerEndLeadOut) - FACE_TAIL_HANG - outer!.length) / outer!.length).toBeLessThan(0.005);
  });
});

describe("the face rings (issue #254)", () => {
  it("fills the centre with a bottom ring and, for one layer with no cap, a top ring, and nothing else", async () => {
    const bottomOnly = await bare("round", "USB 3.8 mm", 2, "on");
    expect(bottomOnly.faceChannels!.topThickness).toBeUndefined();
    expect(bottomOnly.faceChannels!.outer).toBeUndefined();
    const both = await bare("round", "USB 3.8 mm", 1, "off");
    expect(both.faceChannels!.topThickness).toBeGreaterThan(0);
    expect(both.faceChannels!.outer).toBeDefined();
  });

  it("opens a hole that passes an HDMI plug's 22.4 mm", async () => {
    for (const [shapeName] of SHAPES) {
      for (const [cableName] of CABLES) {
        const d = await bare(shapeName, cableName, 1, "off");
        const hole = d.faceChannels!.holeOutline;
        const inscribed = hole.apothem;
        expect(inscribed, `${shapeName}, ${cableName}`).toBeGreaterThanOrEqual(11.2 + d.spec.tolerance - 1e-9);
      }
    }
  });

  it("keeps the funnel under the top ring steep enough on a wide triangle, where the hole's sides are shorter than the bore's", async () => {
    const wide: CoilSpec = { ...spec({ kind: "tri", cornerRadius: 7.7 }, { length: Math.round(450 * 4.81), diameter: 4.81, type: "usb" }, 1, "off"), coreSize: { locked: true, dimension: "outer", value: 73.9 } };
    expect(unsupportedOverhangs(await design(wide, "final"), "wide triangle")).toEqual([]);
  }, 60_000);

  it("leaves the base alone: no face channels with the base on", async () => {
    const d = await design({ ...spec({ kind: "round" }, CABLES[0][1], 1, "off"), base: "on" }, "draft");
    expect(d.faceChannels).toBeUndefined();
  });

  it("sizes the core so the channel fits, and says so when a locked size is raised", async () => {
    const d = await design({ ...spec({ kind: "round" }, CABLES[0][1], 1, "off"), coreSize: { locked: true, dimension: "outer", value: 30 } }, "draft");
    expect(d.solution.outerSize).toBeGreaterThan(30);
    expect(d.faceChannels).toBeDefined();
    expect(d.notices.some((n) => /Core size raised/.test(n.message))).toBe(true);
    expect(d.notices.filter((n) => n.severity === "problem")).toEqual([]);
  });
});

const FLOOR_SHAPES: Array<[string, ShapeSpec]> = [
  ["round", { kind: "round" }],
  ["square, small corner", { kind: "sq", cornerRadius: 8 }],
  ["square, big corner", { kind: "sq", cornerRadius: 25 }],
  ["triangle, small corner", { kind: "tri", cornerRadius: 5 }],
  ["triangle, big corner", { kind: "tri", cornerRadius: 20 }],
];

describe.each(FLOOR_SHAPES.flatMap(([name, shape]) => (["usb", "stiff"] as const).map((type) => [name, shape, type] as const)))("a core raised to the solver's floors (issue #254): %s, %s cable", (_name, shape, type) => {
  it("fits both cable ends at every diameter, layer count, cap and tolerance", async () => {
    const failures: string[] = [];
    for (const diameter of [1.6, 3.8, 5.5, 8]) {
      for (const layers of [1, 2]) {
        for (const topCap of ["off", "on"] as const) {
          for (const tolerance of [0.1, 0.4]) {
            const asked: CoilSpec = { ...spec(shape, { length: 2000, diameter, type }, layers, topCap), coreSize: { locked: true, dimension: "outer", value: 5 }, height: { locked: true, value: 5 }, tolerance, print: { bedX: 1000, bedY: 1000, bedZ: 1000 } };
            const d = await design(asked, "draft");
            const problems = d.notices.filter((n) => n.severity === "problem").map((n) => n.message);
            if (!d.faceChannels || problems.length > 0) failures.push(`d=${diameter} layers=${layers} cap=${topCap} tolerance=${tolerance}: size ${d.solution.outerSize.toFixed(1)}, height ${d.solution.height.toFixed(1)}: ${problems.join(" ") || "no face channels"}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
