import Module from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilMesh, CoilSpec, JointKind, MountKind, Resolution, ShapeSpec } from "../src/core";
import { collarSegments } from "../src/core/manifold";
import { WELD_EPSILON, weldShortEdges } from "../src/core/weld";

// Issue #208: the mesh clean-up passes (weld.ts, flatFaces.ts) must keep every
// part one connected solid. Their failures only showed at a few fractional
// sizes (issue #201: a bayonet cap at 28.31, 28.37 and 28.88 mm), which grid
// sweeps step over, so this samples seeded random specs instead: shapes,
// corner radii, joints, mounts, sizes, heights, cables and collar facet counts.
//
// The default run is a fixed sample. For a long run, set the case count (and,
// to continue elsewhere, the first case index):
//   COIL3D_FUZZ=5000 npx vitest run test/meshFuzz.test.ts
//   COIL3D_FUZZ=2500 COIL3D_FUZZ_FROM=2500 npx vitest run test/meshFuzz.test.ts
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
  return {
    spec,
    resolution: r() < 0.15 ? "draft" : "final",
    // The shipped counts most of the time, others to show the passes don't depend on them.
    segments: r() < 0.5 ? { round: 144, other: 48 } : { round: pick([96, 120, 144, 192]), other: pick([48, 96, 120, 144]) },
  };
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

describe("seeded fuzz: every part is one solid after the mesh clean-up (issue #208)", () => {
  it(`cases ${FROM} to ${FROM + COUNT - 1}`, async () => {
    const shipped = { ...collarSegments };
    const bad: string[] = [];
    const started = Date.now();
    try {
      for (let i = FROM; i < FROM + COUNT; i++) {
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
        for (const part of d.parts) {
          const n = solids(part.mesh);
          if (n !== 1) bad.push(`${what}: ${part.role} is ${n < 0 ? "not a valid solid" : `${n} solids`}`);
          // Only the core and the cap go through the weld. (The mount plate and the SKÅDIS clips can keep a few
          // short edges from their booleans; they only have to be one solid.)
          if (part.role === "core" || part.role === "topCap") {
            const short = edgesShorterThan(part.mesh, SHORT_EDGE);
            if (short > 0) bad.push(`${what}: ${part.role} has ${short} edges under ${SHORT_EDGE} mm`);
          }
        }
        if (COUNT > DEFAULT_CASES && (i - FROM + 1) % 250 === 0) console.log(`fuzz: ${i - FROM + 1} of ${COUNT} cases, ${bad.length} bad, ${Math.round((Date.now() - started) / 1000)} s`);
      }
    } finally {
      Object.assign(collarSegments, shipped);
    }
    if (COUNT > DEFAULT_CASES) console.log(`fuzz: ${COUNT} cases from ${FROM} in ${Math.round((Date.now() - started) / 1000)} s, ${bad.length} bad`);
    expect(bad).toEqual([]);
  }, 7_200_000);
});
