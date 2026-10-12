import Module from "manifold-3d";
import { describe, expect, it } from "vitest";
import { DEFAULT_PILL_RADIUS, DEFAULT_SPEC, design } from "../src/core";
import type { CoilMesh, CoilSpec, Design, MountKind } from "../src/core";
import { circumscribedRadius, offsetPerimeter } from "../src/core/shapes";
import { bendMultiplierOf } from "../src/core/types";
import { unsupportedOverhangs } from "./support/overhangs";

// Issue #320: the pill (stadium) core. Through design() only. The pill is a 2-gon: two half-circle ends of radius r
// joined by straight sides, the size is the overall length, ends included.

const wasm = await Module();
wasm.setup();

const WIRE = { length: 2000, diameter: 3.8, type: "usb" as const };
const GROOVE_DEPTH_FACTOR = 0.4;
const BEND_LIMIT_RADIUS = bendMultiplierOf(WIRE) * WIRE.diameter - (WIRE.diameter / 2 - GROOVE_DEPTH_FACTOR * WIRE.diameter);

function spec(overrides: Partial<CoilSpec> = {}): CoilSpec {
  return {
    wire: WIRE,
    shape: { kind: "pill", cornerRadius: 15 },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 120 },
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

function solids(mesh: CoilMesh): number {
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  const pieces = m.decompose();
  const n = m.status() === "NoError" ? pieces.length : -1;
  pieces.forEach((p) => p.delete());
  m.delete();
  return n;
}

function extent(mesh: CoilMesh): { x: number; y: number } {
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (const axis of [0, 1]) {
      lo[axis] = Math.min(lo[axis], mesh.positions[i + axis]);
      hi[axis] = Math.max(hi[axis], mesh.positions[i + axis]);
    }
  }
  return { x: hi[0] - lo[0], y: hi[1] - lo[1] };
}

const coreOf = (d: Design) => d.parts.find((p) => p.role === "core")!;
const noteMatching = (d: Design, pattern: RegExp) => d.notices.some((n) => pattern.test(n.message));

describe("a pill core's capacity follows its own perimeter (issue #320)", () => {
  it("a fully locked pill holds turns x the stadium perimeter 4h + 2 pi (r + offset), and is never 'ok' below the target", async () => {
    const length = 120;
    const radius = 15;
    const d = await design(spec({ coreSize: { locked: true, dimension: "outer", value: length }, height: { locked: true, value: 40 }, layers: { locked: true, value: 1 } }));
    const o1 = WIRE.diameter / 2 - GROOVE_DEPTH_FACTOR * WIRE.diameter;
    const perimeter = 4 * (length / 2 - radius) + 2 * Math.PI * (radius + o1);
    const layer = d.solution.layerResults[0];
    expect(layer.perimeter).toBeCloseTo(perimeter, 6);
    expect(layer.perimeter).toBeCloseTo(offsetPerimeter(d.wallSpec.outline, o1), 6);
    expect(d.solution.totalWoundLength).toBeCloseTo(layer.turns * Math.hypot(perimeter, d.wallSpec.pitch), 6);
    expect(d.solution.diagnosis.status === "ok").toBe(d.solution.totalWireLength >= WIRE.length * (1 - 1e-6));
  });

  it("reports over-constrained, not ok, when the locked pill cannot hold the cable", async () => {
    const d = await design(spec({ wire: { ...WIRE, length: 9000 }, height: { locked: true, value: 30 }, layers: { locked: true, value: 1 } }));
    expect(d.solution.totalWireLength).toBeLessThan(9000);
    expect(d.solution.diagnosis.status).toBe("over-constrained");
  });
});

describe("a pill core's solver rules (issue #320)", () => {
  it("a free size keeps the pill at least twice as long as it is wide, so it never comes out round", async () => {
    const d = await design(spec({ shape: { kind: "pill", cornerRadius: DEFAULT_PILL_RADIUS }, coreSize: { locked: false }, height: { locked: true, value: 40 }, layers: { locked: true, value: 1 }, topCap: "on" }));
    expect(d.solution.diagnosis.status).toBe("ok");
    expect(d.solution.outerSize).toBeGreaterThanOrEqual(4 * DEFAULT_PILL_RADIUS - 1e-6);
    expect(d.wallSpec.outline.n).toBe(2);
    expect(d.wallSpec.outline.cornerRadius).toBeCloseTo(DEFAULT_PILL_RADIUS, 6);
    expect(d.wallSpec.outline.halfStraight!).toBeGreaterThanOrEqual(DEFAULT_PILL_RADIUS - 1e-6);
  });

  it("a locked length shorter than the diameter clamps the radius to half the length, which is a round core, with a note", async () => {
    const d = await design(spec({ shape: { kind: "pill", cornerRadius: 60 }, coreSize: { locked: true, dimension: "outer", value: 80 } }));
    expect(d.solution.cornerRadius).toBeCloseTo(40, 6);
    expect(d.solution.cornerRadiusRange[1]).toBeCloseTo(40, 6);
    expect(d.wallSpec.outline.n).toBe(4);
    expect(noteMatching(d, /End radius clamped down to 40\.0 mm: at half the core length the pill is round/)).toBe(true);
    const { x, y } = extent(coreOf(d).mesh);
    expect(Math.abs(x - y)).toBeLessThan(0.5);
  });

  it("a radius below the cable's bend limit is raised to it, with a note, and the slider floor is that radius", async () => {
    const d = await design(spec({ shape: { kind: "pill", cornerRadius: 1 } }));
    expect(d.solution.cornerRadius).toBeCloseTo(BEND_LIMIT_RADIUS, 6);
    expect(d.solution.cornerRadiusRange[0]).toBeCloseTo(BEND_LIMIT_RADIUS, 6);
    expect(noteMatching(d, /End radius clamped up to .* to respect the bend limit/)).toBe(true);
  });

  it("with face channels (top cap off) a narrow pill never makes the solver run away: the radius is raised to the round core's channel floor", async () => {
    const d = await design(spec({ shape: { kind: "pill", cornerRadius: 15 }, coreSize: { locked: false }, topCap: "off", height: { locked: true, value: 50 }, layers: { locked: true, value: 1 } }));
    expect(d.faceChannels).toBeDefined();
    expect(d.solution.outerSize).toBeLessThan(200);
    expect(d.solution.cornerRadius).toBeGreaterThan(15);
    expect(noteMatching(d, /End radius raised to .* so the cable's ends can pass the centre hole/)).toBe(true);
    expect(d.solution.cornerRadiusRange[0]).toBeCloseTo(d.solution.cornerRadius, 6);
  });

  it("with face channels, the radius floor holds at every length: a pill at the floor plans channels from just over round up to long", async () => {
    const floorProbe = await design(spec({ shape: { kind: "pill", cornerRadius: 1 }, coreSize: { locked: true, dimension: "outer", value: 200 }, topCap: "off", height: { locked: true, value: 50 }, layers: { locked: true, value: 1 } }));
    const floor = floorProbe.solution.cornerRadius;
    for (const length of [2 * floor + 1, 2 * floor + 40, 200]) {
      const d = await design(spec({ shape: { kind: "pill", cornerRadius: floor }, coreSize: { locked: true, dimension: "outer", value: length }, topCap: "off", height: { locked: true, value: 50 }, layers: { locked: true, value: 1 } }));
      expect(d.faceChannels, `length ${length}`).toBeDefined();
      expect(d.solution.outerSize).toBeCloseTo(length, 6);
    }
  });

  it("a locked inner size is the bore's overall length", async () => {
    const d = await design(spec({ coreSize: { locked: true, dimension: "inner", value: 100 } }));
    expect(2 * circumscribedRadius(d.wallSpec.boreOutline, 0)).toBeCloseTo(100, 6);
    expect(d.solution.innerBore).toBeCloseTo(100, 6);
    expect(d.wallSpec.boreOutline.n).toBe(2);
  });

  it("the default radius is a 40 mm wide pill", () => {
    expect(DEFAULT_PILL_RADIUS).toBe(20);
    expect(DEFAULT_SPEC.shape.kind).toBe("round");
  });
});

interface MountCase {
  name: string;
  overrides: Partial<CoilSpec>;
}

const ON_BASE: Partial<CoilSpec> = { topCap: "on", base: "on" };
const CASES: MountCase[] = [
  { name: "bare core, cap off", overrides: { topCap: "off", base: "off" } },
  { name: "base, cap off", overrides: { topCap: "off" } },
  { name: "base and cap, press", overrides: ON_BASE },
  { name: "base and cap, snap", overrides: { ...ON_BASE, joint: "snap" } },
  { name: "base and cap, strap slots", overrides: { ...ON_BASE, strapSlots: true } },
  { name: "base and cap, label", overrides: { ...ON_BASE, label: "Lamp 2 m" } },
  ...(["keyhole", "through", "skadis", "skadis-tclip", "opengrid"] as MountKind[]).flatMap((mount): MountCase[] => [
    { name: `mount ${mount}, cap on`, overrides: { ...ON_BASE, mount } },
    { name: `mount ${mount}, cap off`, overrides: { topCap: "off", mount } },
  ]),
  { name: "mount skadis-tclip, snap", overrides: { ...ON_BASE, joint: "snap", mount: "skadis-tclip" } },
];

describe("every pill part is one solid and prints without supports (issue #320)", () => {
  it.each(CASES)("$name", async ({ name, overrides }) => {
    const d = await design(spec(overrides));
    expect(d.solution.diagnosis.status, name).not.toBe("over-constrained");
    for (const part of d.parts) expect(solids(part.mesh), `${name}: ${part.name}`).toBe(1);
    expect(unsupportedOverhangs(d, name)).toEqual([]);
  });
});

describe("the long axis of a pill hangs horizontal on every wall mount (issue #320)", () => {
  it.each(["keyhole", "through", "skadis", "skadis-tclip", "opengrid"] as MountKind[])("mount %s", async (mount) => {
    const d = await design(spec({ mount }));
    if (mount !== "through") expect(d.mountAxisDeg, "the mount axis").toBe(0);
    const { x, y } = extent(coreOf(d).mesh);
    expect(x, "the core's x-extent is its length").toBeGreaterThan(y);
  });
});

describe("a pill's label sits on the long flat of the cap (issue #320)", () => {
  const roomy = (label: string) =>
    design(spec({ coreSize: { locked: true, dimension: "outer", value: 120 }, shape: { kind: "pill", cornerRadius: 15 }, wire: { length: 6000, diameter: 3.8, type: "usb" }, height: { locked: true, value: 60 }, layers: { locked: true, value: 6 }, label }));

  it("a text longer than a round core of the same width could carry fits along the flat", async () => {
    const d = await roomy("Living room reading lamp 2 m");
    expect(d.labelFit).toEqual({ fits: true, maxChars: "Living room reading lamp 2 m".length });
    expect(d.warnings.some((w) => /doesn't fit/.test(w))).toBe(false);
  });

  it("a text too long even for the flat is hidden with a warning", async () => {
    const text = "This label text is way too long to ever fit on this pill's cap either";
    const d = await roomy(text);
    expect(d.labelFit?.fits).toBe(false);
    expect(d.warnings.some((w) => w.includes(text) && /doesn't fit/.test(w))).toBe(true);
  });
});

describe("strap slots on a pill (issue #320)", () => {
  it("the two slots are half a perimeter apart: the stadium is point-symmetric, so they sit on opposite ends", async () => {
    const d = await design(spec({ ...ON_BASE, strapSlots: true }));
    for (const plate of [d.strapSlots.base, d.strapSlots.cap]) {
      expect(plate).toHaveLength(2);
      const [a, b] = plate;
      expect(a.centre.x + b.centre.x).toBeCloseTo(0, 3);
      expect(a.centre.y + b.centre.y).toBeCloseTo(0, 3);
      expect(Math.abs(a.centre.x)).toBeGreaterThan(d.wallSpec.outline.halfStraight!);
    }
  });
});

describe("SKÅDIS rim clips on a pill (issue #320)", () => {
  it.each([
    { length: 120, radius: 15 },
    { length: 160, radius: 25 },
    { length: 200, radius: 25 },
  ])("a locked $length mm pill with r $radius gets rim clips, not the 'too small or too crowded' warning", async ({ length, radius }) => {
    const d = await design(spec({ ...ON_BASE, mount: "skadis", shape: { kind: "pill", cornerRadius: radius }, coreSize: { locked: true, dimension: "outer", value: length } }));
    const clips = d.parts.filter((p) => p.role === "mountClip");
    expect(clips.length).toBeGreaterThanOrEqual(2);
    expect(d.warnings.some((w) => /SKÅDIS rim clips, so they were left out/.test(w))).toBe(false);
    expect(d.mountAxisDeg).toBe(0);
    expect(unsupportedOverhangs(d, `skadis ${length}`)).toEqual([]);
  });

  it("a free-size pill grows its flange until clips fit", async () => {
    const d = await design(spec({ ...ON_BASE, mount: "skadis", shape: { kind: "pill", cornerRadius: DEFAULT_PILL_RADIUS }, coreSize: { locked: false } }));
    expect(d.parts.filter((p) => p.role === "mountClip").length).toBeGreaterThanOrEqual(2);
  });
});
