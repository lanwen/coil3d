// Shared helpers for the split step-*.test.ts files (previously one
// test/step.test.ts -- see the test-audit report's S1/S2 batches). Every
// STEP test independently re-imports its exported bytes with OCCT
// (opencascade.js), using a separate OCCT reader, rather than
// trusting exportDesign's own internal validation. That was a ~25-line
// "write file -> STEPControl_Reader -> BRepCheck -> count solids -> sum
// volumes" block copied 9 times across the tests; this file gives every
// split test file one `reimportStep` call instead.
//
// `getOC` is lazily initialized and cached at MODULE scope, not per test.
// Vitest gives each test FILE its own worker/module registry by default, so
// this cache is naturally "one shared lazy OCCT instance per file": tests
// within the same file share one instance, and different step-*.test.ts
// files (running in different workers) each get their own, never leaking
// WASM heap across files.
import { beforeEach } from "vitest";
import type { OpenCascadeInstance } from "replicad-opencascadejs";
import { CAP_THICKNESS, SNAP_FINGER_LENGTH, STRAP_SLOT_INNER_WALL, STRAP_SLOT_OUTER_WALL, STRAP_SLOT_WIDTH } from "../../src/core/constants";
import type { Design } from "../../src/core";

// Issue #163: OCCT runs inline in the test worker, so one STEP test blocks
// its event loop for 30+ s (60+ s on a busy machine). Vitest's worker->main
// RPC has a fixed 60 s timeout (not configurable), and the "task started"
// update it sends just before a test is still waiting for its reply when the
// block begins. A slow machine then ends the run with an unhandled
// `Timeout calling "onTaskUpdate"` although every test passed. Pausing
// briefly before each test lets that reply arrive first.
beforeEach(() => new Promise((resolve) => setTimeout(resolve, 500)));

// Issue #32: every OCCT build/re-import is the slowest operation in the
// suite, and gets much slower under CPU contention -- so every test using it
// gets this generous explicit timeout instead of vitest's 5s default.
export const STEP_TIMEOUT_MS = 60_000;

/** Volume of a closed, consistently-oriented triangle mesh, by the divergence theorem -- an independent check, not core/meshVolume.ts. */
export function meshVolume(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  const { positions: v, indices: t } = mesh;
  let volume = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const c = t[i + 2] * 3;
    volume +=
      (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
        v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
        v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) /
      6;
  }
  return Math.abs(volume);
}

let ocPromise: Promise<OpenCascadeInstance> | undefined;
async function getOC(): Promise<OpenCascadeInstance> {
  if (!ocPromise) {
    ocPromise = import("replicad-opencascadejs").then((m) => m.default());
  }
  return ocPromise;
}

export interface ReimportResult {
  /** `BRepCheck_Analyzer.IsValid()` on the re-imported shape. */
  valid: boolean;
  /** One volume per `TopAbs_SOLID` found, in `TopExp_Explorer` encounter order. */
  solidVolumes: number[];
  /** For each of `points` (if given), whether it lies inside the shape -- see `stepContains`. */
  inside: boolean[];
}

/**
 * Write `bytes` to OCCT's virtual FS, read it back as a STEP file with a
 * fresh `STEPControl_Reader`, and report validity plus per-solid volumes,
 * and which of `points` lie inside it (from the same read, saving a second
 * one). `tag` only needs to be unique within the calling file/test (it just
 * names the scratch path).
 */
export async function reimportStep(bytes: Uint8Array, tag: string, points: Array<[number, number, number]> = []): Promise<ReimportResult> {
  const oc = await getOC();
  const path = `/${tag}.step`;
  oc.FS.writeFile(path, bytes);
  const reader = new oc.STEPControl_Reader();
  reader.ReadFile(path);
  reader.TransferRoots();
  const shape = reader.OneShape();
  oc.FS.unlink(path);

  const analyzer = new oc.BRepCheck_Analyzer(shape, true, false, false);
  const valid = analyzer.IsValid();

  const solidVolumes: number[] = [];
  const solids: Array<ReturnType<typeof explorer.Current>> = [];
  const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; explorer.More(); explorer.Next()) {
    const gprops = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(explorer.Current(), gprops, 1e-5, false, false);
    solidVolumes.push(gprops.Mass());
    solids.push(explorer.Current());
  }

  // Per solid: OCCT reports an inner solution for a point inside one solid, not inside a compound of several.
  const inside = points.map(([x, y, z]) => {
    const vertex = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(x, y, z)).Shape();
    return solids.some((solid) => {
      const dist = new oc.BRepExtrema_DistShapeShape(solid, vertex);
      return dist.IsDone() && dist.InnerSolution() && dist.Value() < 1e-6;
    });
  });
  return { valid, solidVolumes, inside };
}

/** The heights, bottom to top, where the vertical line through (x, y) crosses `mesh`'s surface. Below the first crossing is outside; each crossing flips it. */
export function verticalCrossings(mesh: { positions: Float32Array; indices: Uint32Array }, x: number, y: number): number[] {
  const { positions: p, indices: t } = mesh;
  const hits: number[] = [];
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
    const d = (p[b + 1] - p[c + 1]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 1] - p[c + 1]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((p[b + 1] - p[c + 1]) * (x - p[c]) + (p[c] - p[b]) * (y - p[c + 1])) / d;
    const l2 = ((p[c + 1] - p[a + 1]) * (x - p[c]) + (p[a] - p[c]) * (y - p[c + 1])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    hits.push(l1 * p[a + 2] + l2 * p[b + 2] + l3 * p[c + 2]);
  }
  hits.sort((u, v) => u - v);
  return hits.filter((z, i) => i === 0 || z - hits[i - 1] > 1e-4);
}

/** Whether height `z` on a vertical line with these crossings (`verticalCrossings`) is inside the mesh. */
export function insideAt(crossings: number[], z: number): boolean {
  return crossings.filter((c) => c < z).length % 2 === 1;
}

/**
 * Issue #168: the snap joint's chamfered barb and ridge sit where the mesh
 * has them. Probe points 0.15 mm either side of every place a vertical line
 * through the joint (on a flat side's middle) crosses the core's or the
 * cap's mesh surface: inside or outside the STEP model exactly as in the
 * mesh. Issue #186: three lines, 0.1 mm inside the bore (the ridge and the
 * seat), 0.5 mm (the barb's point, the ridge and the seat) and 2 mm (the
 * bevel on the fingers' tips and the seat), down to 6 mm under the tips.
 */
export function snapProbes(d: Design): { points: Array<[number, number, number]>; expected: boolean[] } {
  const { boreOutline } = d.flangeSpec;
  const h = d.solution.height;
  const angle = Math.PI / boreOutline.n;
  const points: Array<[number, number, number]> = [];
  const expected: boolean[] = [];
  for (const inset of [0.1, 0.5, 2]) {
    const [x, y] = [(boreOutline.apothem - inset) * Math.cos(angle), (boreOutline.apothem - inset) * Math.sin(angle)];
    const crossings = d.parts.map((p) => verticalCrossings(p.mesh, x, y));
    const zs = crossings.flat().filter((z) => z > h - SNAP_FINGER_LENGTH - 6 && z < h - 0.5);
    for (const z of zs.flatMap((z) => [z - 0.15, z + 0.15])) {
      points.push([x, y, z]);
      expected.push(crossings.some((c) => insideAt(c, z)));
    }
  }
  return { points, expected };
}

/**
 * Issue #167: each re-imported solid's volume against its own part's mesh,
 * as a relative error -- per part, so one part's missing feature can't hide
 * inside the whole design's total (the mesh's bayonet lugs once went missing
 * under a 2% total check). Solids come back in part order.
 */
export function perPartVolumeErrors(solidVolumes: number[], parts: Array<{ mesh: { positions: Float32Array; indices: Uint32Array } }>): number[] {
  return parts.map((p, i) => Math.abs(solidVolumes[i] - meshVolume(p.mesh)) / meshVolume(p.mesh));
}

/** For each point, whether it lies inside one of the STEP file's solids: OCCT's distance from a vertex there to that solid is zero, as an inner solution. (Asked per solid: for a file of several parts, the whole compound never reports an inner solution.) */
export async function stepContains(bytes: Uint8Array, tag: string, points: Array<[number, number, number]>): Promise<boolean[]> {
  const oc = await getOC();
  const path = `/${tag}.step`;
  oc.FS.writeFile(path, bytes);
  const reader = new oc.STEPControl_Reader();
  reader.ReadFile(path);
  reader.TransferRoots();
  const shape = reader.OneShape();
  oc.FS.unlink(path);
  const solids: (typeof shape)[] = [];
  const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; explorer.More(); explorer.Next()) solids.push(explorer.Current());
  return points.map(([x, y, z]) => {
    const vertex = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(x, y, z)).Shape();
    return solids.some((solid) => {
      const dist = new oc.BRepExtrema_DistShapeShape(solid, vertex);
      return dist.IsDone() && dist.InnerSolution() && dist.Value() < 1e-6;
    });
  });
}

/** Points in each strap slot's hole and in the plate on either side of it, in the base and the cap, and whether each lies inside the solid. */
export function strapProbes(d: Design): { points: Array<[number, number, number]>; expected: boolean[] } {
  const points: Array<[number, number, number]> = [];
  const expected: boolean[] = [];
  const probe = (slots: Design["strapSlots"]["base"], z: number) => {
    for (const s of slots) {
      const at = (k: number): [number, number, number] => [s.centre.x + s.axis.x * k, s.centre.y + s.axis.y * k, z];
      points.push(at(0), at(STRAP_SLOT_WIDTH / 2 + STRAP_SLOT_OUTER_WALL / 2), at(-(STRAP_SLOT_WIDTH / 2 + STRAP_SLOT_INNER_WALL / 2)));
      expected.push(false, true, true);
    }
  };
  probe(d.strapSlots.base, -d.flangeSpec.thickness / 2);
  probe(d.strapSlots.cap, d.wallSpec.height + CAP_THICKNESS / 2);
  return { points, expected };
}
