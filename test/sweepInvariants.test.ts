import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, Design, JointKind, MountKind, ShapeSpec } from "../src/core";
import { FLANGE_MARGIN } from "../src/core/constants";
import { outlineOffsetAt } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";
import { expectWithinBendLimit } from "./support/cableBend";
import { faceWebs, MIN_WEB, WEB_TOLERANCE } from "./support/faceWeb";
import { unsupportedOverhangs } from "./support/overhangs";

// Issue #274: the defects that were first seen in screenshots -- an overhang, the cable outside the plate, a kink in
// the drawn cable -- as invariants over one swept set of designs: shapes x 1-3 layers x cap on/off x base on/off, with
// the cable diameter stepping through 2-8 mm in fractions (and both ends of that range), some with a mount. Every
// design is built once at the final resolution, and each invariant reads it through design()'s public result. The
// cap's joint cycles through press, bayonet and snap, and the core is locked on every third case. The default run is
// one round (about 50 designs); for a longer sweep over fresh diameters and sizes:
//   COIL3D_SWEEP=8 pnpm exec vitest run test/sweepInvariants.test.ts

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 8.3 }, { kind: "tri", cornerRadius: 7.7 }];
const MOUNTS: MountKind[] = ["keyhole", "through", "skadis", "opengrid"];
const JOINTS: JointKind[] = ["press", "bayonet", "snap"];
const DIAMETER_MIN = 2;
const DIAMETER_MAX = 8;
const ROUNDS = Number(process.env.COIL3D_SWEEP ?? 1);
const GOLDEN_STEP = 0.6180339887;
const LOCKED_CORE_MIN = 32;
const LOCKED_CORE_SPAN = 58;
const SECOND_STEP = 0.7548776662;

interface Case {
  name: string;
  spec: CoilSpec;
}

function caseSpec(shape: ShapeSpec, layers: number, topCap: "on" | "off", base: "on" | "off", diameter: number, mount: MountKind, coreSize: CoilSpec["coreSize"] = { locked: false }, joint: JointKind = "press"): CoilSpec {
  return {
    wire: { length: Math.round(450 * layers * diameter), diameter, type: "usb" },
    shape,
    windingQuality: 0.7,
    coreSize,
    height: { locked: false },
    layers: { locked: true, value: layers },
    objective: "minVolume",
    base,
    topCap,
    joint,
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount,
    plateJoint: "glue",
  };
}

function sweepCases(): Case[] {
  const cases: Case[] = [];
  let step = 0;
  let baseOnCases = 0;
  for (const shape of SHAPES.flatMap((s) => Array.from({ length: ROUNDS }, () => s))) {
    for (const layers of [1, 2, 3]) {
      for (const topCap of ["on", "off"] as const) {
        for (const base of ["on", "off"] as const) {
          const diameter = Math.round((DIAMETER_MIN + (DIAMETER_MAX - DIAMETER_MIN) * ((++step * GOLDEN_STEP) % 1)) * 100) / 100;
          const mount = base === "on" && baseOnCases++ % 3 === 2 ? MOUNTS[Math.floor(baseOnCases / 3) % MOUNTS.length] : "none";
          const size = Math.round((LOCKED_CORE_MIN + LOCKED_CORE_SPAN * ((step * SECOND_STEP) % 1)) * 10) / 10;
          const coreSize: CoilSpec["coreSize"] = step % 3 === 1 ? { locked: true, dimension: "outer", value: size } : { locked: false };
          const core = coreSize.locked ? ` core=${size}` : "";
          const joint = topCap === "on" ? JOINTS[step % JOINTS.length] : "press";
          cases.push({
            name: `${shape.kind} layers=${layers} cap=${topCap} base=${base} d=${diameter}${core}${mount === "none" ? "" : ` mount=${mount}`}${joint === "press" ? "" : ` joint=${joint}`}`,
            spec: caseSpec(shape, layers, topCap, base, diameter, mount, coreSize, joint),
          });
        }
      }
    }
    for (const diameter of ROUNDS === 1 ? [DIAMETER_MIN, DIAMETER_MAX] : []) {
      cases.push({ name: `${shape.kind} layers=2 cap=on base=on d=${diameter} (range end)`, spec: caseSpec(shape, 2, "on", "on", diameter, "none") });
      cases.push({ name: `${shape.kind} layers=1 cap=off base=off d=${diameter} (range end)`, spec: caseSpec(shape, 1, "off", "off", diameter, "none") });
    }
  }
  return cases;
}

const CASES = sweepCases();
const designs = new Map<string, Promise<Design>>();
const designOf = (c: Case) => {
  let d = designs.get(c.name);
  if (!d) designs.set(c.name, (d = design(c.spec, "final")));
  return d;
};

describe("every printed part prints without supports, over the swept designs (issue #274)", () => {
  it.each(CASES)("$name", async (c) => {
    expect(unsupportedOverhangs(await designOf(c), c.name)).toEqual([]);
  });
});

describe("found by the sweep, still open (issue #274)", () => {
  it.skip("sq (corner radius 8.3), 2 layers, cap on, base off, press joint, 2.75 mm usb cable of 2475 mm, core outer 66.1 locked: the cap's top rim chamfer beside the rim slot leans 46.6 deg, 0.1 deg over the 46.5 deg limit", async () => {
    const spec = caseSpec({ kind: "sq", cornerRadius: 8.3 }, 2, "on", "off", 2.75, "none", { locked: true, dimension: "outer", value: 66.1 });
    expect(unsupportedOverhangs(await design(spec, "final"), "found case")).toEqual([]);
  });
});

/** The drawn cable's furthest reach outside the core's outline (its outer surface), the free tails left out. */
function reach(d: Design): { reach: number; where: string } {
  const r = d.spec.wire.diameter / 2;
  const o = d.flangeSpec.outline;
  let best = { reach: 0, where: "" };
  const scan = (points: ArrayLike<number>, what: string, keep: (z: number) => boolean = () => true) => {
    for (let i = 0; i < points.length; i += 3) {
      if (!keep(points[i + 2])) continue;
      const off = outlineOffsetAt(o, points[i], points[i + 1]).offset + r;
      if (off > best.reach) best = { reach: off, where: `${what} at z=${points[i + 2].toFixed(1)}` };
    }
  };
  for (const w of d.wirePaths) scan(w.points, `layer ${w.layer}`);
  d.layerTransitions.forEach((t, i) => scan(t, `transition ${i + 1}`));
  if (d.parts.some((p) => p.role === "topCap")) {
    const out = d.outerEndLeadOut;
    const zKey = out[out.length - 1];
    scan(out, "outer end", (z) => Math.abs(z - zKey) > 1e-4);
  }
  return best;
}

describe("a plate covers the drawn cable plus the lip, over the swept designs (issue #274)", () => {
  it.each(CASES)("$name", async (c) => {
    const d = await designOf(c);
    const hasPlate = d.spec.base !== "off" || d.parts.some((p) => p.role === "topCap");
    if (!hasPlate) {
      expect(d.flangeSpec.thickness, "a bare core has no flange").toBe(0);
      return;
    }
    const { reach: r, where } = reach(d);
    expect(r + FLANGE_MARGIN, `${where} reaches ${r.toFixed(2)} mm; margin ${d.flangeSpec.margin.toFixed(2)} mm`).toBeLessThanOrEqual(d.flangeSpec.margin + 1e-3);
  });
});

describe("the whole drawn cable respects the bend radius, over the swept designs (issue #274)", () => {
  it.each(CASES)("$name", async (c) => {
    const d = await designOf(c);
    if (d.solution.diagnosis.status !== "ok") return;
    expect(d.cablePath.length, "the cable is drawn").toBeGreaterThan(0);
    expectWithinBendLimit(d.cablePath, bendMultiplierOf(d.spec.wire) * d.spec.wire.diameter, c.name);
  });

  it("checks enough ok designs to mean something", async () => {
    const statuses = await Promise.all(CASES.map(async (c) => (await designOf(c)).solution.diagnosis.status));
    expect(statuses.filter((s) => s === "ok").length).toBeGreaterThanOrEqual(CASES.length * 0.75);
  });
});

describe("a bare core's face channels keep their roof and floor, over the swept designs (issue #254)", () => {
  it.each(CASES)("$name", async (c) => {
    const d = await designOf(c);
    if (c.spec.base !== "off" || !d.faceChannels?.inner) return;
    const { roof, floor } = faceWebs(d);
    for (const web of [...roof, ...floor]) expect(web, "material over the bottom roof and under the top floor along the channels").toBeGreaterThanOrEqual(MIN_WEB - WEB_TOLERANCE);
    expect(roof.length, "the bottom channel's roof is checked").toBeGreaterThan(2);
  });

  it("checks enough bare designs to mean something", async () => {
    const found = await Promise.all(CASES.filter((c) => c.spec.base === "off").map(async (c) => (await designOf(c)).faceChannels !== undefined));
    expect(found.filter(Boolean).length).toBeGreaterThanOrEqual(10);
  });
});

const CROSSING_CASES = CASES.filter((c) => c.spec.layers.locked && c.spec.layers.value === 3 && c.spec.topCap === "off");

describe("the outer end's crossing over an odd stack clears the cable and the core, over the swept designs (issue #286)", () => {
  let wasm: ManifoldToplevel;
  beforeAll(async () => {
    wasm = await Module();
    wasm.setup();
  });

  const at = (points: ArrayLike<number>, i: number) => [points[3 * i], points[3 * i + 1], points[3 * i + 2]];

  it("sweeps both bases and every shape", () => {
    expect(CROSSING_CASES.length).toBeGreaterThanOrEqual(6);
  });

  it.each(CROSSING_CASES)("$name", async (c) => {
    const d = await designOf(c);
    if (d.solution.diagnosis.status !== "ok") return;
    const outer = d.faceChannels?.outer;
    expect(outer, "the outer end is in the top channel").toBeDefined();
    const wire = d.spec.wire.diameter;
    const lead = d.outerEndLeadOut;
    const lowerTop = Math.max(...d.wirePaths.slice(0, -1).flatMap((w) => Array.from({ length: w.points.length / 3 }, (_, i) => w.points[3 * i + 2])));
    expect(outer!.level, "the crossing rides over the lower layers' top turns").toBeGreaterThanOrEqual(lowerTop + wire);

    const lower = d.wirePaths.slice(0, -1);
    const last = d.wirePaths.at(-1)!.points;
    const closest = (from: ArrayLike<number>, i: number, among: ArrayLike<number>[]) => {
      let best = Infinity;
      for (const points of among) for (let j = 0; j < points.length / 3; j++) best = Math.min(best, Math.hypot(from[3 * i] - points[3 * j], from[3 * i + 1] - points[3 * j + 1], from[3 * i + 2] - points[3 * j + 2]));
      return best;
    };
    const lowerPoints = lower.map((w) => w.points);
    const start = closest(last, last.length / 3 - 1, lowerPoints);
    const rampEnd = outer!.ramp!.length;
    for (let i = 1; i < rampEnd; i++) {
      expect(closest(lead, i, lowerPoints), `ramp sample ${i} against the lower layers (nested at ${start.toFixed(2)} mm)`).toBeGreaterThanOrEqual(Math.min(wire + d.spec.tolerance, start) - 0.15);
    }

    const wound = d.cablePath.length / 3 - lead.length / 3;
    let along = 0;
    const lengthAt: number[] = [0];
    for (let i = 1; i < d.cablePath.length / 3; i++) {
      along += Math.hypot(d.cablePath[3 * i] - d.cablePath[3 * i - 3], d.cablePath[3 * i + 1] - d.cablePath[3 * i - 2], d.cablePath[3 * i + 2] - d.cablePath[3 * i - 1]);
      lengthAt.push(along);
    }
    for (let k = 0; k < lead.length / 3; k += 3) {
      const i = wound + k;
      let near = Infinity;
      for (let j = 0; j < wound; j++) {
        if (lengthAt[i] - lengthAt[j] < 4 * wire) continue;
        near = Math.min(near, Math.hypot(d.cablePath[3 * i] - d.cablePath[3 * j], d.cablePath[3 * i + 1] - d.cablePath[3 * j + 1], d.cablePath[3 * i + 2] - d.cablePath[3 * j + 2]));
      }
      expect(near, `outer end sample ${k} against the rest of the cable`).toBeGreaterThanOrEqual(0.85 * wire - 0.15);
    }

    const core = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: d.mesh.positions, triVerts: d.mesh.indices }));
    const capsules: Array<InstanceType<ManifoldToplevel["Manifold"]>> = [];
    for (let i = 6; i + 1 < lead.length / 3; i += 2) {
      const [a, b] = [at(lead, i), at(lead, Math.min(i + 2, lead.length / 3 - 1))];
      capsules.push(wasm.Manifold.hull([wasm.Manifold.sphere(wire / 2, 10).translate(a as [number, number, number]), wasm.Manifold.sphere(wire / 2, 10).translate(b as [number, number, number])]));
    }
    expect(wasm.Manifold.union(capsules).intersect(core).volume(), "outer end volume inside the core (mm^3)").toBeLessThan(0.5);
  });
});
