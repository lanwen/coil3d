// The actual STEP build. Proven by the S2 spike (spikes/s2-step-export,
// see RESULT.md "approach A"): fit a periodic cubic B-spline surface
// (bspfit.ts) to the SAME parametric wall grid buildRoundWall uses
// (wall.ts's createWallProfile), sew it with planar caps into a solid, cut
// the bore, fuse the bottom flange, validate, and write STEP.
//
// This module statically imports replicad + replicad-opencascadejs (~5 MB
// brotli of WASM). It must only ever be reached through a dynamic
// `import()` — never a static one — so bundlers keep it out of the app's
// main chunk. See step/index.ts and step/worker.ts, the only two call
// sites this file is allowed to have.

import * as R from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import type { OpenCascadeInstance } from "replicad-opencascadejs";
import { fitPeriodicUClampedV, type Vec3 } from "./bspfit";
import { createWallProfile } from "../wall";
import { meshVolume } from "../meshVolume";
import { offsetOutline, polygonVertex } from "../shapes";
import type { ShapeOutline } from "../shapes";
import type { Design } from "../types";

/**
 * A solid prism of the given outline, extruded from `zBase` upward by
 * `height`. Round keeps the plain, well-proven cylinder (its outline is
 * already an exact circle, see shapes.ts); sq/tri build a TRUE rounded
 * polygon via replicad's corner-fillet sketcher, so the STEP bore/flange
 * follow the same offset outline the mesh backend uses (issue #6 AC: "the
 * flange for non-round shapes should follow the offset outline, not a
 * circle") instead of a bounding cylinder.
 */
function outlineSolid(o: ShapeOutline, height: number, zBase: number): R.Shape3D {
  if (o.n === 4 && o.cornerRadius === o.apothem) {
    return R.makeCylinder(o.apothem, height, [0, 0, zBase]);
  }
  let pen = R.draw(polygonVertex(o, 0));
  for (let i = 1; i < o.n; i++) {
    pen = pen.lineTo(polygonVertex(o, i)).customCorner(o.cornerRadius);
  }
  const drawing = pen.closeWithCustomCorner(o.cornerRadius);
  // The outline is always one simple closed convex profile, never a
  // disjoint/compound sketch, so `sketchOnPlane` always resolves to a plain
  // `Sketch` in practice, not the compound `Sketches` its return type also allows.
  const sketch = drawing.sketchOnPlane("XY", zBase) as R.Sketch;
  return sketch.extrude(height);
}

// S2 RESULT.md: ~20 V-samples per helical pitch keeps the max fitting
// deviation under 0.1 mm; NU reuses the mesh's own column count so the two
// backends sample the identical grid resolution around the circumference.
const V_SAMPLES_PER_PITCH = 20;
const MIN_V_SAMPLES = 40;
// S2 RESULT.md saw <0.03% volume error for this approach; 1% leaves margin
// for coarser grids while still catching the silent boolean failures OCCT
// is prone to on B-spline walls.
const VOLUME_TOLERANCE = 0.01;

let oc: OpenCascadeInstance | undefined;
async function getOC(): Promise<OpenCascadeInstance> {
  if (!oc) {
    oc = await initOpenCascade();
    R.setOC(oc);
  }
  return oc;
}

export async function buildStep(design: Design): Promise<Uint8Array<ArrayBuffer>> {
  const kernel = await getOC();
  const { wallSpec, flangeSpec } = design;
  const profile = createWallProfile(wallSpec);
  const { height, columns: NU, boreOutline } = wallSpec;

  const NV = Math.max(MIN_V_SAMPLES, Math.round(V_SAMPLES_PER_PITCH * wallSpec.turns) + 1);
  const dz = 1e-4;
  const tangent = (z0: number, z1: number) => (i: number): Vec3 => {
    const t = i / NU;
    const a = profile.point(t, z0);
    const b = profile.point(t, z1);
    return a.map((v, c) => ((b[c] - v) / (z1 - z0)) * height) as Vec3;
  };
  const fit = fitPeriodicUClampedV(
    NU,
    NV,
    (i, j) => profile.point(i / NU, (j * height) / (NV - 1)),
    tangent(0, dz),
    tangent(height - dz, height),
  );

  // OCCT wants the periodic pole index shifted by NU-1 relative to the
  // textbook (C[i-1]+4C[i]+C[i+1])/6 layout (empirically determined in the
  // S2 spike).
  const SHIFT = NU - 1;
  const poles = new kernel.NCollection_Array2_gp_Pnt(1, NU, 1, fit.nvp);
  for (let i = 0; i < NU; i++) {
    for (let k = 0; k < fit.nvp; k++) {
      const q = fit.pole((i + SHIFT) % NU, k);
      poles.SetValue(i + 1, k + 1, new kernel.gp_Pnt(q[0], q[1], q[2]));
    }
  }
  const toArr1 = (vals: number[], asInt: boolean) => {
    const arr = new (asInt ? kernel.NCollection_Array1_int : kernel.NCollection_Array1_double)(1, vals.length);
    vals.forEach((v, n) => arr.SetValue(n + 1, v));
    return arr;
  };
  const surface = new kernel.Geom_BSplineSurface(
    poles,
    toArr1(fit.uKnots, false),
    toArr1(fit.vKnots, false),
    toArr1(fit.uMults, true),
    toArr1(fit.vMults, true),
    3,
    3,
    true,
    false,
  );

  const face = new kernel.BRepBuilderAPI_MakeFace(surface, 1e-6).Face();
  const sewing = new kernel.BRepBuilderAPI_Sewing(1e-3, true, true, true, false);
  sewing.Add(face);
  const edges = new kernel.TopExp_Explorer(face, kernel.TopAbs_ShapeEnum.TopAbs_EDGE, kernel.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; edges.More(); edges.Next()) {
    const edge = kernel.TopoDS.Edge(edges.Current());
    if (kernel.BRep_Tool.IsClosed(edge, face)) continue; // the U seam, not a boundary
    const cap = new kernel.BRepBuilderAPI_MakeFace(new kernel.BRepBuilderAPI_MakeWire(edge).Wire(), true);
    if (!cap.IsDone()) throw new Error("STEP export: planar cap face failed");
    sewing.Add(cap.Face());
  }
  sewing.Perform(new kernel.Message_ProgressRange());
  const outerFix = new kernel.ShapeFix_Solid(
    new kernel.BRepBuilderAPI_MakeSolid(kernel.TopoDS.Shell(sewing.SewedShape())).Solid(),
  );
  outerFix.Perform(new kernel.Message_ProgressRange());

  const outer = R.cast(outerFix.Solid()).asShape3D();
  const bore = outlineSolid(boreOutline, height + 2, -1);
  const tube = outer.cut(bore);

  const flangeOutline = offsetOutline(flangeSpec.outline, flangeSpec.margin);
  const flangeOuter = outlineSolid(flangeOutline, flangeSpec.thickness, -flangeSpec.thickness);
  const flangeInner = outlineSolid(flangeSpec.boreOutline, flangeSpec.thickness + 2, -flangeSpec.thickness - 1);
  const flange = flangeOuter.cut(flangeInner);

  const fused = tube.fuse(flange);

  const analyzer = new kernel.BRepCheck_Analyzer(fused.wrapped, true, false, false);
  const valid = analyzer.IsValid();
  const solidCount = fused.solids.length;
  const stepVolume = R.measureVolume(fused);
  const expectedVolume = meshVolume(design.mesh);
  const volumeError = Math.abs(stepVolume - expectedVolume) / expectedVolume;

  if (!valid || solidCount !== 1 || volumeError > VOLUME_TOLERANCE) {
    throw new Error(
      `STEP export failed validation: valid=${valid} solids=${solidCount} ` +
        `step volume=${stepVolume.toFixed(1)} mesh volume=${expectedVolume.toFixed(1)} ` +
        `(${(volumeError * 100).toFixed(2)}% off, tolerance ${(VOLUME_TOLERANCE * 100).toFixed(0)}%)`,
    );
  }

  const blob = fused.blobSTEP();
  return new Uint8Array(await blob.arrayBuffer());
}
