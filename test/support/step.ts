// Shared helpers for the split step-*.test.ts files (previously one
// test/step.test.ts -- see the test-audit report's S1/S2 batches). Every
// STEP test independently re-imports its exported bytes with OCCT
// (opencascade.js), mirroring the S2 spike's crosscheck.mjs, rather than
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
import type { OpenCascadeInstance } from "replicad-opencascadejs";

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
}

/**
 * Write `bytes` to OCCT's virtual FS, read it back as a STEP file with a
 * fresh `STEPControl_Reader`, and report validity plus per-solid volumes.
 * `tag` only needs to be unique within the calling file/test (it just names
 * the scratch path).
 */
export async function reimportStep(bytes: Uint8Array, tag: string): Promise<ReimportResult> {
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
  const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; explorer.More(); explorer.Next()) {
    const gprops = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(explorer.Current(), gprops, 1e-5, false, false);
    solidVolumes.push(gprops.Mass());
  }

  return { valid, solidVolumes };
}

/** For each point, whether it lies inside the STEP file's shape: OCCT's distance from a vertex there to the shape is zero, as an inner solution. */
export async function stepContains(bytes: Uint8Array, tag: string, points: Array<[number, number, number]>): Promise<boolean[]> {
  const oc = await getOC();
  const path = `/${tag}.step`;
  oc.FS.writeFile(path, bytes);
  const reader = new oc.STEPControl_Reader();
  reader.ReadFile(path);
  reader.TransferRoots();
  const shape = reader.OneShape();
  oc.FS.unlink(path);
  return points.map(([x, y, z]) => {
    const vertex = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(x, y, z)).Shape();
    const dist = new oc.BRepExtrema_DistShapeShape(shape, vertex);
    return dist.IsDone() && dist.InnerSolution() && dist.Value() < 1e-6;
  });
}
