import { afterEach, describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec, Design, JointKind, MountKind, ShapeSpec } from "../src/core";
import { resolveCapJoint } from "../src/core/joints";

// Issue #259: a free-size design grows its core (or the flange margin) until the chosen mount and joint fit, instead of
// dropping holes, clips or the twist lock. Swept through design(): every shape, cable diameters 2-8 mm in fractional
// steps, a short and a longer cable, and every mount and joint. A locked size keeps skip-and-warn (last describe).

// Hand the event loop back after each design: this file runs over a minute, and without a pause vitest's worker can't answer its own status calls in time.
afterEach(() => new Promise((resolve) => setTimeout(resolve, 0)));

const SHAPES: ShapeSpec[] = [{ kind: "round" }, { kind: "sq", cornerRadius: 8.3 }, { kind: "tri", cornerRadius: 7.7 }];
const MOUNTS: MountKind[] = ["through", "keyhole", "skadis", "skadis-tclip", "opengrid"];
const JOINTS: JointKind[] = ["bayonet", "snap"];

interface Cable {
  diameter: number;
  length: number;
  type: "usb" | "stiff";
}

const usb = (diameter: number, length: number): Cable => ({ diameter, length, type: "usb" });
const stiff = (diameter: number): Cable => ({ diameter, length: 150, type: "stiff" });

const CABLES: Cable[] = [
  usb(2, 150),
  usb(2.7, 150),
  usb(2.7, 900),
  usb(3.45, 150),
  usb(4.2, 150),
  usb(4.2, 900),
  usb(5.35, 150),
  usb(6.6, 150),
  usb(6.6, 900),
  usb(8, 150),
  stiff(2.3),
  stiff(4.9),
  stiff(7.7),
];

const SLOW_MOUNTS: MountKind[] = ["skadis", "opengrid"];

const LAYERS: CoilSpec["layers"][] = [{ locked: true, value: 1 }, { locked: true, value: 2 }, { locked: false }];

function spec(shape: ShapeSpec, cable: Cable, index: number, mount: MountKind, joint: JointKind): CoilSpec {
  return {
    wire: { length: cable.length, diameter: cable.diameter, type: cable.type },
    shape,
    windingQuality: 0.7,
    coreSize: { locked: false },
    height: { locked: false },
    layers: LAYERS[index % LAYERS.length],
    objective: "minVolume",
    base: "on",
    topCap: index % 2 === 0 ? "on" : "off",
    joint,
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount,
    plateJoint: "glue",
  };
}

const SKIPPED = /through-hole\(s\) skipped|too narrow to fit|too small|too crowded|left out|press-fit collar/i;

const NEEDS_ROUND = /Twist lock needs a round core/;

function expectNothingSkipped(d: Design, label: string) {
  const bayonetOnCorner = d.spec.joint === "bayonet" && d.spec.shape.kind !== "round";
  expect(d.warnings.filter((w) => SKIPPED.test(w) && !(bayonetOnCorner && NEEDS_ROUND.test(w))), label).toEqual([]);
  const parts = (role: string) => d.parts.filter((p) => p.role === role).length;
  const mount = d.spec.mount;
  if (mount === "skadis") expect(parts("mountClip"), `${label}: SKÅDIS rim clips`).toBeGreaterThanOrEqual(2);
  if (mount === "skadis-tclip") expect(parts("mountClip"), `${label}: SKÅDIS T-clips`).toBeGreaterThanOrEqual(1);
  if (mount === "opengrid") {
    expect(parts("mountPlate"), `${label}: mount plate`).toBe(1);
    expect(parts("peg"), `${label}: plate pegs`).toBe(2);
  }
  if (d.spec.topCap === "on" && !bayonetOnCorner) {
    expect(resolveCapJoint(d.spec, d.wallSpec).joint, `${label}: the chosen joint`).toBe(d.spec.joint);
  }
}

interface Case {
  name: string;
  spec: CoilSpec;
}

const MOUNT_CASES: Case[] = SHAPES.flatMap((shape) =>
  MOUNTS.flatMap((mount) =>
    CABLES.flatMap((cable, i) => {
      if (SLOW_MOUNTS.includes(mount) && i % 4 >= 2) return [];
      const s = spec(shape, cable, i, mount, ["press", "bayonet", "snap"][i % 3] as JointKind);
      return [{ name: `${shape.kind} ${mount} d=${cable.diameter} ${cable.length} mm ${cable.type}, cap ${s.topCap}, joint ${s.joint}, layers ${s.layers.locked ? s.layers.value : "free"}`, spec: s }];
    }),
  ),
);

const JOINT_CASES: Case[] = SHAPES.flatMap((shape) =>
  JOINTS.filter((joint) => joint !== "bayonet" || shape.kind === "round").flatMap((joint) =>
    CABLES.map((cable, i) => {
      const s = { ...spec(shape, cable, i, "none", joint), topCap: "on" as const };
      return { name: `${shape.kind} ${joint} d=${cable.diameter} ${cable.length} mm ${cable.type}, layers ${s.layers.locked ? s.layers.value : "free"}`, spec: s };
    }),
  ),
);

describe("a free-size design never skips a feature of its mount (issue #259)", () => {
  it.each(MOUNT_CASES)("$name", async (c) => {
    expectNothingSkipped(await design(c.spec), c.name);
  });
});

describe("a free-size design never falls back from its joint (issue #259)", () => {
  it.each(JOINT_CASES)("$name", async (c) => {
    expectNothingSkipped(await design(c.spec), c.name);
  });

  it("a square or triangle core can't take the twist lock at any size, and says so", async () => {
    for (const shape of SHAPES.filter((s) => s.kind !== "round")) {
      const d = await design({ ...spec(shape, CABLES[0], 0, "none", "bayonet"), topCap: "on" });
      expect(d.warnings.some((w) => /Twist lock needs a round core/.test(w)), shape.kind).toBe(true);
    }
  });
});

describe("the solver says what it grew, and a locked size is left alone (issue #259)", () => {
  const SHORT: Cable = { diameter: 2.7, length: 150, type: "usb" };

  it("raises a free core for the twist lock, and tells the user", async () => {
    const d = await design({ ...spec(SHAPES[0], SHORT, 0, "none", "bayonet"), topCap: "on" });
    expect(d.warnings.some((w) => /the bore needs room for the twist lock, which takes a core of at least [\d.]+ mm/.test(w)), d.warnings.join(" | ")).toBe(true);
    expect(d.solution.outerSize).toBeGreaterThan(d.solution.minOuterSizeForShape);
  });

  it("raises a free core for the SKÅDIS T-clips, and tells the user", async () => {
    const d = await design({ ...spec(SHAPES[0], SHORT, 0, "skadis-tclip", "press"), topCap: "on" });
    expect(d.warnings.some((w) => /the bore needs room for the SKÅDIS T-clips, which takes a core of at least [\d.]+ mm/.test(w)), d.warnings.join(" | ")).toBe(true);
  });

  it("grows the flange margin, not the core, when the through-holes only clash with the cable's channel", async () => {
    const d = await design({ ...spec(SHAPES[1], { diameter: 7, length: 800, type: "usb" }, 0, "through", "press"), layers: { locked: true, value: 1 } });
    expect(d.warnings.some((w) => /Flange margin increased to [\d.]+ mm to fit the through-hole mount/.test(w))).toBe(true);
    expect(d.warnings.filter((w) => SKIPPED.test(w))).toEqual([]);
  });

  it("a locked core that is too small keeps the skip and the warning", async () => {
    const small = { locked: true as const, dimension: "outer" as const, value: 8 };
    const joint = await design({ ...spec(SHAPES[0], SHORT, 0, "none", "bayonet"), topCap: "on", coreSize: small });
    expect(joint.warnings.some((w) => /too small for the twist lock/.test(w))).toBe(true);
    expect(joint.solution.outerSize).toBeLessThan(25);
    const tclips = await design({ ...spec(SHAPES[0], SHORT, 0, "skadis-tclip", "press"), topCap: "on", coreSize: { ...small, value: 12 } });
    expect(tclips.parts.filter((p) => p.role === "mountClip")).toHaveLength(0);
    expect(tclips.warnings.some((w) => /too small for SKÅDIS T-clips/.test(w))).toBe(true);
  });
});
