import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilMesh, CoilSpec, JointKind, MountKind, Part, Resolution, ShapeSpec } from "../src/core";
import { collarSegments } from "../src/core/manifold";
import { WELD_EPSILON, weldShortEdges } from "../src/core/weld";
import { yieldToEventLoop } from "./support/yieldToEventLoop";

// Issue #208: the mesh clean-up passes (weld.ts, flatFaces.ts) must keep every
// part one connected solid. Their failures only showed at a few fractional
// sizes (issue #201: a bayonet cap at 28.31, 28.37 and 28.88 mm), which grid
// sweeps step over, so this samples seeded random specs instead: shapes,
// corner radii, joints, mounts, sizes, heights, cables and collar facet counts.
// Issue #219: every part must also have no edge under the weld's limit and no
// zero-thickness fold.
//
// The default run is a fixed sample. For a long run, set the case count (and,
// to continue elsewhere, the first case index):
//   COIL3D_FUZZ=5000 pnpm exec vitest run test/meshFuzz.test.ts
//   COIL3D_FUZZ=2500 COIL3D_FUZZ_FROM=2500 pnpm exec vitest run test/meshFuzz.test.ts
// Each case is seeded by its index alone, so a failure prints the index and
// the spec, and reruns on its own with COIL3D_FUZZ=1 COIL3D_FUZZ_FROM=<index>.

const SEED = 0x208;
const DEFAULT_CASES = 60;
const COUNT = Number(process.env.COIL3D_FUZZ ?? DEFAULT_CASES);
const FROM = Number(process.env.COIL3D_FUZZ_FROM ?? 0);

/** mulberry32: a small, well-mixed 32-bit PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FuzzCase {
  spec: CoilSpec;
  resolution: Resolution;
  segments: { round: number; other: number };
}

function sample(index: number): FuzzCase {
  const r = prng(Math.imul(SEED ^ index, 0x9e3779b9) ^ index);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const between = (lo: number, hi: number, decimals = 2) => Math.round((lo + r() * (hi - lo)) * 10 ** decimals) / 10 ** decimals;
  const kind = pick(["round", "round", "sq", "tri"] as const);
  const shape: ShapeSpec = kind === "round" ? { kind } : { kind, cornerRadius: between(0, 20) };
  const mount = pick<MountKind>(["none", "none", "keyhole", "through", "skadis", "skadis-tclip", "opengrid"]);
  const spec: CoilSpec = {
    wire: { length: between(500, 10000, 0), diameter: between(1.5, 8), type: pick(["usb", "flex", "stiff"] as const) },
    shape,
    windingQuality: between(0.5, 0.9),
    coreSize: r() < 0.8 ? { locked: true, dimension: pick(["outer", "inner"] as const), value: between(20, 110) } : { locked: false },
    height: r() < 0.6 ? { locked: true, value: between(15, 90) } : { locked: false },
    layers: r() < 0.6 ? { locked: true, value: 1 + Math.floor(r() * 4) } : { locked: false },
    objective: pick(["minVolume", "aspectRatio"] as const),
    topCap: r() < 0.85 ? "on" : "auto",
    joint: pick<JointKind>(["press", "snap", "bayonet"]),
    tolerance: between(0.1, 0.4),
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount,
    plateJoint: pick(["glue", "snap"] as const),
    keyholeRotation: pick([0, 45] as const),
    throughHoleDiameter: between(2.5, 8),
  };
  if (r() < 0.15) spec.label = pick(["USB-C 2m", "HDMI", "Lamp 5 m", "ok"]);
  const resolution = r() < 0.15 ? "draft" : "final";
  // The shipped counts most of the time, others to show the passes don't depend on them.
  const segments = r() < 0.5 ? { round: 144, other: 48 } : { round: pick([96, 120, 144, 192]), other: pick([48, 96, 120, 144]) };
  // Issue #254: drawn last, so the cases before it stay what they were. A bare core is a third of them (a mount forces the base back on).
  spec.base = r() < 0.33 ? "off" : "on";
  return { spec, resolution, segments };
}

/**
 * The weld's limit as seen in a part: design() moves the cap up to its seat after the weld, and rounding the
 * float32 positions there can shorten an edge of exactly the limit by a few hundred-thousandths of a millimetre.
 */
const SHORT_EDGE = WELD_EPSILON - 1e-4;

/** How many edges of `mesh` are shorter than `limit` mm, each counted once. */
function edgesShorterThan(mesh: CoilMesh, limit: number): number {
  const { positions: P, indices: I } = mesh;
  let count = 0;
  for (let t = 0; t < I.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [I[t + k], I[t + ((k + 1) % 3)]];
      if (a < b && Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]) < limit) count++;
    }
  }
  return count;
}

/** Normals this close to opposite (8 degrees, the flip pass's own fold guard) mean the surface folds back on itself. */
const FOLD_COS = Math.cos((8 * Math.PI) / 180);
/** The smallest triangle height (mm) whose normal the fold check trusts. */
const MIN_HEIGHT = 1e-3;

/**
 * How many edges of `mesh` are zero-thickness folds (issue #219): two triangles of real height on the edge that
 * face apart, within 8 degrees of opposite. That is a sheet of no volume doubling back over itself, or two
 * coincident triangles of opposite winding. A real part has no wedge that sharp.
 */
function foldEdges(mesh: CoilMesh): number {
  const { positions: P, indices: I } = mesh;
  const normals = new Float64Array(I.length);
  const real = new Uint8Array(I.length / 3);
  for (let t = 0; t < I.length / 3; t++) {
    const [a, b, c] = [3 * I[3 * t], 3 * I[3 * t + 1], 3 * I[3 * t + 2]];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const w = [P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    // A needle under a micrometre high, a few float32 roundings from flat, has no normal to trust.
    real[t] = len > MIN_HEIGHT * Math.max(Math.hypot(...u), Math.hypot(...v), Math.hypot(...w)) ? 1 : 0;
    if (real[t]) normals.set([n[0] / len, n[1] / len, n[2] / len], 3 * t);
  }
  const onEdge = new Map<string, number[]>();
  for (let t = 0; t < I.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [I[3 * t + k], I[3 * t + ((k + 1) % 3)]];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const ts = onEdge.get(key);
      if (ts) ts.push(t);
      else onEdge.set(key, [t]);
    }
  }
  let count = 0;
  for (const ts of onEdge.values()) {
    const folded = ts.some((t1, i) =>
      ts.slice(i + 1).some((t2) => real[t1] && real[t2] && normals[3 * t1] * normals[3 * t2] + normals[3 * t1 + 1] * normals[3 * t2 + 1] + normals[3 * t1 + 2] * normals[3 * t2 + 2] < -FOLD_COS),
    );
    if (folded) count++;
  }
  return count;
}

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

/** The number of connected solids in `mesh`, or -1 when manifold-3d does not take it as a valid solid. */
function solids(mesh: CoilMesh): number {
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  const pieces = m.decompose();
  const n = m.status() === "NoError" ? pieces.length : -1;
  pieces.forEach((p) => p.delete());
  m.delete();
  return n;
}

/** What is wrong with a part (issues #208, #219): not one solid, edges under the weld's limit, or zero-thickness folds. */
function problems(part: Part): string[] {
  const out: string[] = [];
  const n = solids(part.mesh);
  if (n !== 1) out.push(`${part.name} is ${n < 0 ? "not a valid solid" : `${n} solids`}`);
  const short = edgesShorterThan(part.mesh, SHORT_EDGE);
  if (short > 0) out.push(`${part.name} has ${short} edges under ${SHORT_EDGE} mm`);
  const folds = foldEdges(part.mesh);
  if (folds > 0) out.push(`${part.name} has ${folds} zero-thickness fold edges`);
  return out;
}

function spec(overrides: Partial<CoilSpec>): CoilSpec {
  return {
    wire: { length: 6000, diameter: 3.8, type: "usb" },
    shape: { kind: "round" },
    windingQuality: 0.7,
    coreSize: { locked: true, dimension: "outer", value: 60 },
    height: { locked: true, value: 60 },
    layers: { locked: true, value: 2 },
    objective: "minVolume",
    topCap: "on",
    joint: "press",
    tolerance: 0.2,
    print: { bedX: 256, bedY: 256, bedZ: 256 },
    mount: "none",
    plateJoint: "glue",
    ...overrides,
  };
}

/** `design(s)` built with `other` columns on a non-round cap collar instead of the shipped 48. */
async function withCollarSegments(other: number, s: CoilSpec) {
  const shipped = collarSegments.other;
  collarSegments.other = other;
  try {
    return await design(s);
  } finally {
    collarSegments.other = shipped;
  }
}

// The two cases seen while issue #200 tried finer collars on square and
// triangular caps, and two the fuzz below found with the shipped counts. All
// four came from the flip pass: it flipped across a zero-width slit (points on
// one line, at the foot of the snap collar's flare), and between two sheets of
// one plane that face apart (on the core's flange, around a keyhole), and
// manifold-3d then cut a sheet of no volume off the part; and it made edges
// shorter than the weld's limit, or ones that were already there.
describe("mesh clean-up reproductions (issue #208)", () => {
  it("a square snap cap on a 63.5 mm core is one solid with 120 collar facets", async () => {
    const d = await withCollarSegments(
      120,
      spec({ shape: { kind: "sq", cornerRadius: 12 }, joint: "snap", coreSize: { locked: true, dimension: "outer", value: 63.5 }, wire: { length: 3000, diameter: 3.8, type: "usb" }, layers: { locked: false } }),
    );
    for (const part of d.parts) expect(solids(part.mesh), part.role).toBe(1);
  });

  it("a triangular snap cap keeps no edge under the weld's limit with 144 collar facets", async () => {
    const d = await withCollarSegments(144, spec({ shape: { kind: "tri", cornerRadius: 12 }, joint: "snap" }));
    const cap = d.parts.find((p) => p.role === "topCap")!;
    // The flip made an edge a hair under the limit (0.019999 mm), so this one is checked against the limit itself.
    expect(edgesShorterThan(cap.mesh, WELD_EPSILON)).toBe(0);
    expect(solids(cap.mesh)).toBe(1);
  });

  it("a round core with a keyhole mount is one solid (found by the fuzz)", async () => {
    const d = await design(
      spec({
        wire: { length: 8974, diameter: 5.08, type: "usb" },
        windingQuality: 0.6,
        coreSize: { locked: false },
        height: { locked: true, value: 30.06 },
        tolerance: 0.29,
        mount: "keyhole",
        plateJoint: "snap",
        keyholeRotation: 0,
        throughHoleDiameter: 7.19,
      }),
    );
    for (const part of d.parts) expect(solids(part.mesh), part.role).toBe(1);
  });

  it("a wide round core with a turned keyhole is one solid (found by the fuzz)", async () => {
    const d = await design(
      spec({
        wire: { length: 4659, diameter: 7.97, type: "stiff" },
        windingQuality: 0.6,
        coreSize: { locked: false },
        height: { locked: true, value: 18.03 },
        layers: { locked: true, value: 3 },
        objective: "aspectRatio",
        tolerance: 0.15,
        mount: "keyhole",
        plateJoint: "snap",
        keyholeRotation: 45,
        throughHoleDiameter: 6.59,
      }),
    );
    for (const part of d.parts) expect(solids(part.mesh), part.role).toBe(1);
  });

  it("the weld leaves a short edge it cannot collapse safely, and counts it", () => {
    // One triangle with a 0.01 mm side: that side is a border, with no triangle across it to drop.
    const mesh: CoilMesh = { positions: new Float32Array([0, 0, 0, 0.01, 0, 0, 0.005, 5, 0]), indices: new Uint32Array([0, 1, 2]) };
    const welded = weldShortEdges(mesh);
    expect(Array.from(welded.mesh.indices)).toEqual([0, 1, 2]);
    expect(welded.stuck).toBe(1);
  });
});

interface Reproduction {
  name: string;
  spec: Partial<CoilSpec>;
  resolution?: Resolution;
  segments?: { round: number; other: number };
}

// Issue #219: a design for each source of the folds and short edges the fuzz below found once it checked every part
// for both. Each one fails on the code before its fix (and only there; the fuzz would cover them all, but slowly).
const REPRODUCTIONS_219: Reproduction[] = [
  // The cap clip block's end faces: the strip from a ring a hair under the end chamfer's depth (so a hair wider than
  // the block) to the full ring folded back over itself, on both sides of every clip.
  { name: "a round snap cap's cable clips", spec: { joint: "snap" } },
  // Where the channel's lips start, the bore rings spread their vertices round each ring's own arc, so they slid
  // round the circle between two rings 0.05 mm apart.
  {
    name: "the core's inner-end channel at its lips",
    spec: { wire: { length: 4505, diameter: 6.1, type: "flex" }, windingQuality: 0.78, coreSize: { locked: true, dimension: "outer", value: 37.14 }, height: { locked: true, value: 69.21 }, tolerance: 0.31, mount: "keyhole", plateJoint: "snap", keyholeRotation: 45 },
  },
  // The base clip's chamfered lips: a chamfer that flares wider than the channel's own wall made the strip between the
  // channel's plain rings and the first lip ring cross over itself, on both sides of the clip's start and end.
  {
    name: "the core's inner-end clip on a thick cable",
    spec: { wire: { length: 2845, diameter: 7.83, type: "usb" }, windingQuality: 0.8, coreSize: { locked: true, dimension: "inner", value: 50.8 }, height: { locked: true, value: 38.37 }, objective: "aspectRatio", tolerance: 0.33, plateJoint: "snap" },
  },
  // A round flange's outer columns came from the outline's corner parameter, 45 degrees round from the inner ones,
  // and on a narrow annulus the twisted strips of its faces folded over each other.
  {
    name: "a big round core's flange on a narrow margin",
    spec: { wire: { length: 8374, diameter: 2.57, type: "flex" }, windingQuality: 0.62, coreSize: { locked: true, dimension: "outer", value: 102.78 }, height: { locked: true, value: 39.38 }, layers: { locked: true, value: 1 }, objective: "aspectRatio", joint: "snap", tolerance: 0.24 },
  },
  // The weld turned a needle a few thousandths of a millimetre high face down in a flat face.
  {
    name: "a weld collapse beside a needle",
    spec: { wire: { length: 3182, diameter: 4.52, type: "usb" }, windingQuality: 0.59, coreSize: { locked: true, dimension: "inner", value: 60.31 }, height: { locked: false }, layers: { locked: false }, objective: "aspectRatio", joint: "snap", tolerance: 0.23, mount: "through", throughHoleDiameter: 7.11 },
  },
  // The flip pass made a new triangle that, with a corner a little off the plane, lay back over its neighbour.
  {
    name: "a flip in a face that is flat only to within the flip pass's tolerance",
    spec: { wire: { length: 1190, diameter: 1.95, type: "flex" }, shape: { kind: "sq", cornerRadius: 14.77 }, windingQuality: 0.72, coreSize: { locked: true, dimension: "outer", value: 92.23 }, height: { locked: true, value: 31.04 }, layers: { locked: true, value: 1 }, objective: "aspectRatio", joint: "snap", tolerance: 0.37, mount: "opengrid", plateJoint: "snap" },
  },
  // The hull of the snap cap's through-hole, many points along each straight side in one plane, had sheets of no
  // thickness folded into its side faces.
  {
    name: "a square snap cap's through-hole",
    spec: { wire: { length: 5346, diameter: 4.9, type: "flex" }, shape: { kind: "sq", cornerRadius: 12.8 }, windingQuality: 0.85, coreSize: { locked: false }, height: { locked: false }, layers: { locked: false }, joint: "snap", tolerance: 0.29 },
    segments: { round: 144, other: 96 },
  },
  // The snap barb's widest ring had a corner a hundredth of a millimetre off a triangular collar's flat side.
  {
    name: "a triangular snap cap's barb against the collar's flat sides",
    spec: { wire: { length: 950, diameter: 2.16, type: "flex" }, shape: { kind: "tri", cornerRadius: 10.23 }, windingQuality: 0.68, coreSize: { locked: true, dimension: "outer", value: 58.88 }, height: { locked: true, value: 58.47 }, layers: { locked: true, value: 3 }, objective: "aspectRatio", joint: "snap", tolerance: 0.21 },
  },
  // A SKÅDIS clip at the very end of the rim: the notch's side wall cut a sliver of rim a hair thick.
  {
    name: "a SKÅDIS notch at the end of the rim",
    spec: { wire: { length: 2221, diameter: 1.78, type: "usb" }, windingQuality: 0.77, coreSize: { locked: false }, height: { locked: true, value: 33.08 }, layers: { locked: false }, objective: "aspectRatio", tolerance: 0.17, mount: "skadis" },
    resolution: "draft",
  },
  // On a 500 mm core the collar pad's facets sagged about as deep as the channel pad's fillet dips into the collar.
  {
    name: "the flange pads of a very big core",
    spec: { wire: { length: 9273, diameter: 5.44, type: "stiff" }, windingQuality: 0.83, coreSize: { locked: false }, height: { locked: true, value: 38.57 }, layers: { locked: true, value: 1 }, objective: "aspectRatio", joint: "bayonet", tolerance: 0.24 },
  },
  // The openGrid plate's back face, triangulated a hair from a connector's corner.
  {
    name: "the openGrid mount plate",
    spec: { wire: { length: 2185, diameter: 1.99, type: "stiff" }, windingQuality: 0.89, coreSize: { locked: false }, height: { locked: false }, objective: "aspectRatio", joint: "bayonet", mount: "opengrid" },
  },
  // A bottom SKÅDIS clip whose outer jaw ended 0.012 mm above its stem.
  {
    name: "a SKÅDIS bottom clip's jaw and stem",
    spec: { wire: { length: 3807, diameter: 3.42, type: "stiff" }, windingQuality: 0.79, coreSize: { locked: true, dimension: "outer", value: 100.91 }, height: { locked: true, value: 76.16 }, layers: { locked: true, value: 4 }, joint: "bayonet", tolerance: 0.26, mount: "skadis" },
  },
  // The snap collar's root flare: its hull took every point along the outline's straight sides, and folded a sheet of
  // no thickness into a flat face (fuzz case 2536, once the snap fingers grew to 12 mm).
  {
    name: "a triangular snap cap's root flare (fuzz case 2536)",
    spec: { wire: { length: 5604, diameter: 2.44, type: "flex" }, shape: { kind: "tri", cornerRadius: 1.78 }, windingQuality: 0.88, coreSize: { locked: true, dimension: "inner", value: 41.71 }, height: { locked: true, value: 75.44 }, layers: { locked: true, value: 3 }, objective: "aspectRatio", joint: "snap", mount: "opengrid", keyholeRotation: 45, throughHoleDiameter: 4.48 },
    segments: { round: 192, other: 144 },
  },
  // A cap clip's end ramp crossed a bore station 0.02 mm from one of the bore ring's vertices, and left an edge the
  // weld could not collapse (fuzz case 939, once the deeper groove moved the clips).
  {
    name: "a cap clip's end ramp beside a bore station (fuzz case 939)",
    spec: { wire: { length: 2222, diameter: 5.26, type: "usb" }, windingQuality: 0.84, coreSize: { locked: true, dimension: "inner", value: 48.1 }, height: { locked: true, value: 83.4 }, layers: { locked: false }, joint: "snap", tolerance: 0.27, mount: "skadis-tclip", throughHoleDiameter: 6.59 },
  },
];

describe("mesh clean-up reproductions (issue #219): every part is one solid, with no short edges or folds", () => {
  it.each(REPRODUCTIONS_219)("$name", async ({ spec: overrides, resolution, segments }) => {
    const shipped = { ...collarSegments };
    Object.assign(collarSegments, segments ?? shipped);
    try {
      const d = await design(spec(overrides), resolution);
      expect(d.parts.flatMap(problems)).toEqual([]);
    } finally {
      Object.assign(collarSegments, shipped);
    }
  });
});

// Issue #221: the SKÅDIS T-clips' floor in the bore (its slots and recesses) and the clips' tall fins, at 3, 2 and 1
// clips, with each cap joint, and the fins cut short under a cap's collar.
const TCLIP_BORES: Array<{ name: string; clips: number; spec: Partial<CoilSpec> }> = [
  { name: "round 40, 1 clip, bayonet cap", clips: 1, spec: { mount: "skadis-tclip", coreSize: { locked: true, dimension: "outer", value: 40 }, topCap: "on", joint: "bayonet" } },
  { name: "square 60, 2 clips", clips: 2, spec: { mount: "skadis-tclip", shape: { kind: "sq", cornerRadius: 10 }, coreSize: { locked: true, dimension: "outer", value: 60 }, wire: { length: 2000, diameter: 3.8, type: "usb" }, layers: { locked: true, value: 1 } } },
  { name: "round 85, 3 clips, snap cap", clips: 3, spec: { mount: "skadis-tclip", coreSize: { locked: true, dimension: "outer", value: 85 }, topCap: "on", joint: "snap", wire: { length: 2000, diameter: 3.8, type: "usb" } } },
  { name: "triangle 120, 3 clips, press cap, loose tolerance", clips: 3, spec: { mount: "skadis-tclip", shape: { kind: "tri", cornerRadius: 12 }, coreSize: { locked: true, dimension: "outer", value: 120 }, topCap: "on", joint: "press", tolerance: 0.6 } },
  { name: "round 150, tall, tight tolerance", clips: 3, spec: { mount: "skadis-tclip", coreSize: { locked: true, dimension: "outer", value: 150 }, height: { locked: true, value: 110 }, tolerance: 0.05 } },
];

describe("the SKÅDIS T-clips' bore floor and fins (issue #221): every part is one solid, with no short edges or folds", () => {
  it.each(TCLIP_BORES)("$name", async ({ spec: overrides, clips }) => {
    const d = await design(spec(overrides));
    expect(d.parts.filter((p) => p.role === "mountClip")).toHaveLength(clips);
    expect(d.parts.flatMap(problems)).toEqual([]);
  });
});

// Issue #227: the fuzz's case 5011. A bayonet cap on a small SKÅDIS core kept an edge of 0.016 mm along the foot of a
// short wall, in a flat face split into slivers a few micrometres high. The weld could move that edge's end onto
// neither of its neighbours without turning a sliver face down over the next one (a zero-thickness fold), so it left
// the edge. Moving both ends to the middle turns none.
const REPRODUCTIONS_227: Reproduction[] = [
  {
    name: "a bayonet cap's wall foot between two slivers (fuzz case 5011)",
    spec: { wire: { length: 1690, diameter: 1.98, type: "flex" }, windingQuality: 0.62, coreSize: { locked: true, dimension: "inner", value: 20.05 }, height: { locked: true, value: 43.19 }, tolerance: 0.18, joint: "bayonet", mount: "skadis" },
    segments: { round: 120, other: 96 },
  },
  {
    // The keyhole pad's underside lay exactly on the line where the plate's top rim chamfer meets the rim face
    // (FLANGE_PAD_EMBED was EDGE_CHAMFER), leaving a zero-length edge where the pad runs out over the rim. Main had
    // it with the cap off (margin 16, set by the keyhole); without the cap clips the cap-on design got the same margin.
    name: "a keyhole pad running out over the rim of a slim triangle flange (fuzz case 1097, cap off)",
    spec: { wire: { length: 2170, diameter: 6.52, type: "usb" }, shape: { kind: "tri", cornerRadius: 7.55 }, windingQuality: 0.62, coreSize: { locked: true, dimension: "outer", value: 42.59 }, height: { locked: false }, layers: { locked: false }, topCap: "off", tolerance: 0.25, mount: "keyhole", keyholeRotation: 0 },
    resolution: "final",
    segments: { round: 144, other: 96 },
  },
  {
    // The channel's side wall crossed the wall's top and bottom rims 0.018 mm from a rim vertex, and the weld could not
    // drop the one-triangle tip beside them: it stood 0.029 mm off its neighbours' plane, over the 0.02 mm it allowed.
    // The same design with the base on has the top channel too (issue #292).
    name: "a channel crossing the rim beside a rim vertex on a bare round core (fuzz case 1220, base off)",
    spec: { wire: { length: 6547, diameter: 7.42, type: "flex" }, windingQuality: 0.51, coreSize: { locked: true, dimension: "outer", value: 51.85 }, height: { locked: false }, layers: { locked: true, value: 1 }, topCap: "auto", tolerance: 0.33, joint: "bayonet", plateJoint: "snap", base: "off" },
    resolution: "final",
    segments: { round: 96, other: 96 },
  },
  {
    name: "the same design with the base on (fuzz case 1220)",
    spec: { wire: { length: 6547, diameter: 7.42, type: "flex" }, windingQuality: 0.51, coreSize: { locked: true, dimension: "outer", value: 51.85 }, height: { locked: false }, layers: { locked: true, value: 1 }, topCap: "auto", tolerance: 0.33, joint: "bayonet", plateJoint: "snap", base: "on" },
    resolution: "final",
    segments: { round: 96, other: 96 },
  },
];

describe("mesh clean-up reproductions (issue #227): every part is one solid, with no short edges or folds", () => {
  it.each(REPRODUCTIONS_227)("$name", async ({ spec: overrides, resolution, segments }) => {
    const shipped = { ...collarSegments };
    Object.assign(collarSegments, segments ?? shipped);
    try {
      const d = await design(spec(overrides), resolution);
      expect(d.parts.flatMap(problems)).toEqual([]);
    } finally {
      Object.assign(collarSegments, shipped);
    }
  });
});

// Issue #304: a thin cable's wall is a few millimetres thick, about as thick as a triangle's corner radius, so the
// bore's corner arc is much shorter than the outer one. The wall's top and bottom annuli and the flange ring paired
// each outer column with the bore point at the same fraction of the bore's own perimeter, a few millimetres along from
// the point across, and at the corners the strips between them twisted over each other: sheets of no thickness, in
// the mesh before the weld or the flips touched it.
const REPRODUCTIONS_304: Reproduction[] = [
  {
    name: "fuzz case 2639 (a bare triangle core, T-clips)",
    spec: { wire: { length: 4835, diameter: 1.52, type: "flex" }, shape: { kind: "tri", cornerRadius: 3.08 }, windingQuality: 0.84, coreSize: { locked: true, dimension: "inner", value: 53.06 }, height: { locked: false }, layers: { locked: true, value: 4 }, tolerance: 0.38, mount: "skadis-tclip", plateJoint: "snap", throughHoleDiameter: 7.8, base: "off" },
    segments: { round: 144, other: 96 },
  },
  {
    name: "fuzz case 4513 (a bare triangle core, snap cap, keyhole)",
    spec: { wire: { length: 4302, diameter: 1.65, type: "flex" }, shape: { kind: "tri", cornerRadius: 1.2 }, windingQuality: 0.86, coreSize: { locked: true, dimension: "outer", value: 67 }, height: { locked: false }, layers: { locked: true, value: 4 }, joint: "snap", tolerance: 0.37, mount: "keyhole", keyholeRotation: 45, throughHoleDiameter: 6.07, base: "off" },
    segments: { round: 96, other: 144 },
  },
  {
    name: "fuzz case 4892 (a triangle core with a flange, labelled)",
    spec: { wire: { length: 827, diameter: 1.59, type: "flex" }, shape: { kind: "tri", cornerRadius: 2.49 }, windingQuality: 0.86, coreSize: { locked: true, dimension: "outer", value: 72.75 }, height: { locked: true, value: 37.7 }, layers: { locked: true, value: 1 }, objective: "aspectRatio", tolerance: 0.39, plateJoint: "snap", throughHoleDiameter: 4.22, label: "ok", base: "on" },
    segments: { round: 144, other: 48 },
  },
  {
    name: "fuzz case 6946 (a big triangle core with a sharp corner)",
    spec: { wire: { length: 9079, diameter: 1.66, type: "usb" }, shape: { kind: "tri", cornerRadius: 0.62 }, windingQuality: 0.5, coreSize: { locked: true, dimension: "inner", value: 98.56 }, height: { locked: false }, layers: { locked: false }, tolerance: 0.35, plateJoint: "snap", keyholeRotation: 45, throughHoleDiameter: 5.42, label: "Lamp 5 m", base: "on" },
    segments: { round: 144, other: 48 },
  },
];

describe("mesh clean-up reproductions (issue #304): a thin cable on a triangle core has no zero-thickness folds", () => {
  it.each(REPRODUCTIONS_304)("$name", async ({ spec: overrides, resolution, segments }) => {
    const shipped = { ...collarSegments };
    Object.assign(collarSegments, segments ?? shipped);
    try {
      const d = await design(spec(overrides), resolution);
      expect(d.parts.flatMap(problems)).toEqual([]);
    } finally {
      Object.assign(collarSegments, shipped);
    }
  });
});

describe("seeded fuzz: every part is one solid, with no short edges or folds, after the mesh clean-up (issues #208, #219)", () => {
  it(`cases ${FROM} to ${FROM + COUNT - 1}`, async () => {
    const shipped = { ...collarSegments };
    const bad: string[] = [];
    const started = Date.now();
    try {
      for (let i = FROM; i < FROM + COUNT; i++) {
        await yieldToEventLoop();
        const c = sample(i);
        Object.assign(collarSegments, c.segments);
        const what = `case ${i} (${c.resolution}, collar ${c.segments.round}/${c.segments.other}) ${JSON.stringify(c.spec)}`;
        let d;
        try {
          d = await design(c.spec, c.resolution);
        } catch (e) {
          bad.push(`${what}: threw ${(e as Error).message}`);
          continue;
        }
        // Issue #219: every part, the mount plate and the SKÅDIS clips too.
        for (const part of d.parts) bad.push(...problems(part).map((p) => `${what}: ${p}`));
        if (COUNT > DEFAULT_CASES && (i - FROM + 1) % 250 === 0) console.log(`fuzz: ${i - FROM + 1} of ${COUNT} cases, ${bad.length} bad, ${Math.round((Date.now() - started) / 1000)} s`);
      }
    } finally {
      Object.assign(collarSegments, shipped);
    }
    if (COUNT > DEFAULT_CASES) console.log(`fuzz: ${COUNT} cases from ${FROM} in ${Math.round((Date.now() - started) / 1000)} s, ${bad.length} bad`);
    expect(bad).toEqual([]);
  }, 7_200_000);
});
