import { describe, expect, it } from "vitest";
import { design, TOLERANCE_MAX, TOLERANCE_MIN } from "../src/core";
import type { CoilSpec, Design, JointKind, MountKind, ShapeSpec } from "../src/core";
import { unsupportedOverhangs } from "./support/overhangs";

// Issue #168: AGENTS.md's printability rule -- every printed part prints flat on the bed without supports (the check itself is in ./support/overhangs.ts).

function baseSpec(overrides: Partial<CoilSpec>): CoilSpec {
  return {
    wire: { length: 4000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 50 },
    layers: { locked: true, value: 2 },
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

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 12 }, { kind: "tri", cornerRadius: 12 }];
const JOINTS: JointKind[] = ["press", "bayonet", "snap"];
const MOUNTS: MountKind[] = ["keyhole", "through", "skadis", "skadis-tclip", "opengrid"];

// Three sizes and cable diameters, the bigger two with a label on the cap.
const SIZES: Array<{ label: string; overrides: Partial<CoilSpec> }> = [
  { label: "40 mm, 2.5 mm cable", overrides: { coreSize: { locked: true, dimension: "outer", value: 40 }, height: { locked: true, value: 40 }, wire: { length: 3000, diameter: 2.5, type: "usb" } } },
  { label: "60 mm, 3.8 mm cable, label", overrides: { label: "USB-C 2m" } },
  {
    label: "90 mm, 5 mm cable, label",
    overrides: { coreSize: { locked: true, dimension: "outer", value: 90 }, height: { locked: true, value: 60 }, wire: { length: 5000, diameter: 5, type: "usb" }, label: "HDMI 3m" },
  },
];

interface Case {
  name: string;
  spec: CoilSpec;
}

const CASES: Case[] = [];
for (const shape of SHAPES) {
  for (const joint of JOINTS) {
    for (const size of SIZES) CASES.push({ name: `${shape.kind}, ${joint}, ${size.label}`, spec: baseSpec({ shape, joint, ...size.overrides }) });
  }
  for (const mount of MOUNTS) CASES.push({ name: `${shape.kind}, snap, mount ${mount}`, spec: baseSpec({ shape, joint: "snap", mount }) });
  // The snap joint at both ends of the tolerance range, and on a bore too small for its core-side relief (a plain collar then).
  for (const tolerance of [TOLERANCE_MIN, TOLERANCE_MAX]) CASES.push({ name: `${shape.kind}, snap, tolerance ${tolerance}`, spec: baseSpec({ shape, joint: "snap", tolerance }) });
  CASES.push({
    name: `${shape.kind}, snap, tiny bore`,
    spec: baseSpec({
      shape: shape.kind === "round" ? shape : { kind: shape.kind, cornerRadius: 6 },
      joint: "snap",
      coreSize: { locked: true, dimension: "outer", value: shape.kind === "tri" ? 14 : 10 },
      height: { locked: true, value: 20 },
      wire: { length: 500, diameter: 1.2, type: "usb" },
    }),
  });
}
// The base clip's opening scales with the cable: thin and thick cables, and a loose print on a thin one.
for (const [diameter, tolerance] of [[2, 0.2], [2, TOLERANCE_MAX], [5, 0.2], [8, 0.4]]) {
  CASES.push({ name: `round, press, cable ${diameter} mm, tolerance ${tolerance}`, spec: baseSpec({ wire: { length: 3000, diameter, type: "flex" }, tolerance, height: { locked: false } }) });
}
CASES.push({ name: "sq, press, mount keyhole rotated 45", spec: baseSpec({ shape: SHAPES[1], mount: "keyhole", keyholeRotation: 45 }) });
CASES.push({ name: "round, press, mount opengrid, snap plate joint", spec: baseSpec({ mount: "opengrid", plateJoint: "snap" }) });
// Issue #207: the heavy-cable SKÅDIS layout (two top clips) and the latch off.
CASES.push({ name: "round, press, mount skadis, heavy cable", spec: baseSpec({ mount: "skadis", wire: { length: 10000, diameter: 8, type: "flex" }, layers: { locked: true, value: 4 }, height: { locked: false } }) });
CASES.push({ name: "round, press, mount skadis, no latch", spec: baseSpec({ mount: "skadis", skadisLatch: false }) });

const designs = new Map<string, Promise<Design>>();
const designOf = (c: Case) => {
  let d = designs.get(c.name);
  if (!d) designs.set(c.name, (d = design(c.spec)));
  return d;
};

describe("issue #168: every printed part prints without supports (overhangs <= 45 deg, only narrow bridges)", () => {
  it.each(CASES)("$name", async (c) => {
    const d = await designOf(c);
    const failures = unsupportedOverhangs(d, c.name);
    expect(failures).toEqual([]);
  });
});
