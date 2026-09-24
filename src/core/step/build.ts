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
import {
  BAYONET_GAP,
  BAYONET_GROOVE_HEIGHT,
  BAYONET_LEAD,
  BAYONET_LUG_COUNT,
  BAYONET_LUG_HEIGHT,
  BAYONET_LUG_WIDTH,
  CAP_THICKNESS,
  JOINT_ENGAGE_DEPTH,
  JOINT_MIN_BORE_RADIUS,
  JOINT_TRANSITION_HEIGHT,
  KEYHOLE_SLIT_FRACTION,
  LABEL_DEPTH,
  SCREW_MOUNT_HEAD_RADIUS,
  SCREW_MOUNT_SHANK_RADIUS,
  SNAP_BARB,
  SNAP_BARB_HEIGHT,
  SNAP_GAP,
  SNAP_HOOK_COUNT,
  SNAP_RIDGE_THICKNESS,
  SNAP_SLOT_WIDTH,
  WELD_OVERLAP,
} from "../constants";
import { jointGeometry } from "../joints";
import { classifyLabelLoops, getLabelFont, labelLoops, resolveLabel } from "../label";
import type { LabelLoop, ResolvedLabel } from "../label";
import { meshVolume } from "../meshVolume";
import { layoutKeyholeMount } from "../mount";
import type { KeyholeSlot } from "../mount";
import { circumscribedRadius, offsetOutline, pointAt, polygonVertex } from "../shapes";
import type { ShapeOutline } from "../shapes";
import type { CoreJointCut } from "../manifold";
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

/**
 * The replicad solid for one keyhole slot (mount.ts's layout math): a wide
 * (head) circle and a narrow (shank-end) circle, joined by a straight
 * channel of the shank's own width, all drawn in 2D then extruded once --
 * the same shape manifold.ts's `screwMountCutter` builds for the mesh backend,
 * from the identical `KeyholeSlot`, so the two never drift apart.
 */
function screwMountCutterSolid(slot: KeyholeSlot, depth: number, zBase: number): R.Shape3D {
  let drawing = R.drawCircle(SCREW_MOUNT_HEAD_RADIUS)
    .translate(slot.head.x, slot.head.y)
    .fuse(R.drawCircle(SCREW_MOUNT_SHANK_RADIUS).translate(slot.shankEnd.x, slot.shankEnd.y));

  const dx = slot.shankEnd.x - slot.head.x;
  const dy = slot.shankEnd.y - slot.head.y;
  const len = Math.hypot(dx, dy);
  if (len > 1e-6) {
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy * SCREW_MOUNT_SHANK_RADIUS;
    const py = ux * SCREW_MOUNT_SHANK_RADIUS;
    const channel = R.draw([slot.head.x + px, slot.head.y + py] as [number, number])
      .lineTo([slot.head.x - px, slot.head.y - py] as [number, number])
      .lineTo([slot.shankEnd.x - px, slot.shankEnd.y - py] as [number, number])
      .lineTo([slot.shankEnd.x + px, slot.shankEnd.y + py] as [number, number])
      .close();
    drawing = drawing.fuse(channel);
  }

  const sketch = drawing.sketchOnPlane("XY", zBase) as R.Sketch;
  return sketch.extrude(depth);
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

  let coreSolid = tube.fuse(flange);

  // Issue #9: bayonet/snap cut a mating groove/relief into the core's own
  // top rim; press engages the bore's existing surface directly (no
  // core-side cut at all -- see manifold.ts's `applyCoreJointCut`, which
  // this mirrors so the mesh and STEP backends never drift on fit).
  if (design.solution.topCapEnabled && (design.spec.joint === "bayonet" || design.spec.joint === "snap")) {
    coreSolid = applyCoreJointCutSolid(coreSolid, {
      boreOutline,
      height: design.solution.height,
      joint: design.spec.joint,
      tolerance: design.spec.tolerance,
    });
  }

  // Issue #13: cut the same screw-keyhole mount the mesh backend cuts into
  // the CORE part's own bottom flange (manifold.ts's fuseFlange), from the
  // identical layout (mount.ts), so STEP and STL/preview never drift apart.
  if (design.flangeSpec.mount === "keyhole") {
    const layout = layoutKeyholeMount(flangeSpec.outline, flangeSpec.boreOutline, flangeSpec.margin);
    for (const slot of layout.slots) {
      const cutter = screwMountCutterSolid(slot, layout.recessDepth, -flangeSpec.thickness);
      coreSolid = coreSolid.cut(cutter);
    }
  }

  const corePart = design.parts.find((p) => p.role === "core")!;
  validateSolid(kernel, coreSolid, corePart.mesh, corePart.name);

  const shapes: { shape: R.Shape3D; name: string }[] = [{ shape: coreSolid, name: corePart.name }];

  // Issue #9: the top cap, when present, mirrors manifold.ts's buildTopCap
  // almost primitive-for-primitive (plate + engagement collar + joint
  // feature + keyhole cut), sharing the SAME dimensions via joints.ts so
  // the two backends can't drift on fit. Built directly in the shared
  // ASSEMBLY frame (see design.ts): plate at z=[height, height+CAP_THICKNESS],
  // collar reaching down to z=height-JOINT_ENGAGE_DEPTH.
  const topCapPart = design.parts.find((p) => p.role === "topCap");
  if (topCapPart) {
    const capSolid = await buildTopCapSolid(design);
    validateSolid(kernel, capSolid, topCapPart.mesh, topCapPart.name);
    shapes.push({ shape: capSolid, name: topCapPart.name });
  }

  const blob = R.exportSTEP(shapes);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Validate one part's solid: manifold-valid, exactly one solid, and its volume matches the part's own mesh within tolerance. Throws with a descriptive message otherwise. */
function validateSolid(kernel: OpenCascadeInstance, solid: R.Shape3D, mesh: Design["mesh"], name: string): void {
  const analyzer = new kernel.BRepCheck_Analyzer(solid.wrapped, true, false, false);
  const valid = analyzer.IsValid();
  const solidCount = solid.solids.length;
  const stepVolume = R.measureVolume(solid);
  const expectedVolume = meshVolume(mesh);
  const volumeError = Math.abs(stepVolume - expectedVolume) / expectedVolume;

  if (!valid || solidCount !== 1 || volumeError > VOLUME_TOLERANCE) {
    throw new Error(
      `STEP export failed validation for part "${name}": valid=${valid} solids=${solidCount} ` +
        `step volume=${stepVolume.toFixed(1)} mesh volume=${expectedVolume.toFixed(1)} ` +
        `(${(volumeError * 100).toFixed(2)}% off, tolerance ${(VOLUME_TOLERANCE * 100).toFixed(0)}%)`,
    );
  }
}

/** A solid frustum (or plain cylinder, if the two radii are equal) between two circular cross-sections, via a capped loft -- replicad's `makeCylinder` takes only one radius, unlike manifold-3d's. */
function frustumSolid(rBottom: number, rTop: number, zBottom: number, zTop: number): R.Shape3D {
  const bottom = R.sketchCircle(rBottom, { plane: "XY", origin: [0, 0, zBottom] });
  const top = R.sketchCircle(rTop, { plane: "XY", origin: [0, 0, zTop] });
  return bottom.loftWith(top);
}

/**
 * The collar's welded base, shared by all three joints (mirrors manifold.ts's
 * `collarBase`): a straight cylinder at `collarRadius`, flaring out to
 * `boreRadius + WELD_OVERLAP` over the top `JOINT_TRANSITION_HEIGHT` so it
 * genuinely overlaps the plate's own bore edge instead of merely touching it
 * (a `collarRadius < boreRadius` collar centered in the plate's hole would
 * otherwise be a second, disconnected solid -- `.fuse()` reports it as a
 * `Compound` of 2 solids, not a proper single-solid weld).
 */
function collarBaseSolid(collarRadius: number, boreRadius: number): R.Shape3D {
  const straightHeight = JOINT_ENGAGE_DEPTH - JOINT_TRANSITION_HEIGHT;
  const straight = R.makeCylinder(collarRadius, straightHeight, [0, 0, -JOINT_ENGAGE_DEPTH]);
  const transition = frustumSolid(collarRadius, boreRadius + WELD_OVERLAP, -JOINT_TRANSITION_HEIGHT, 0);
  return straight.fuse(transition);
}

/** A box spanning radius [rLo, rHi] and tangential width `width`, at axial [zLo, zHi], rotated to `angleDeg` about Z -- the shared primitive for lugs, entry slots and relief slots (mirrors manifold.ts's `radialBox`). */
function radialBoxSolid(rLo: number, rHi: number, width: number, zLo: number, zHi: number, angleDeg: number): R.Shape3D {
  const box = R.makeBox([Math.min(rLo, rHi), -width / 2, zLo], [Math.max(rLo, rHi), width / 2, zHi]);
  return box.rotate(angleDeg, [0, 0, 0], [0, 0, 1]);
}

/** `count` copies of `build(angleDeg)`, evenly spaced around Z, fused into one shape (mirrors manifold.ts's `unionAtAngles`). */
function unionAtAngles(build: (angleDeg: number) => R.Shape3D, count: number): R.Shape3D {
  let result: R.Shape3D | undefined;
  for (let i = 0; i < count; i++) {
    const m = build((360 * i) / count);
    result = result ? result.fuse(m) : m;
  }
  return result!;
}

/** The rim keyhole cutter (mirrors manifold.ts's `buildKeyholeCutter`): a round hole sized to the cable, connected to the cap's true outer edge by a narrower retaining slit, at arc-length t=0. */
function buildKeyholeSolid(outline: ShapeOutline, margin: number, wireDiameter: number, tolerance: number): R.Shape3D {
  const holeRadius = wireDiameter / 2 + tolerance;
  const slitWidth = wireDiameter * KEYHOLE_SLIT_FRACTION + tolerance;
  const skin = 1;
  const edge = pointAt(outline, 0, margin);
  const cx = edge.x - edge.nx * (holeRadius + skin);
  const cy = edge.y - edge.ny * (holeRadius + skin);
  const h = CAP_THICKNESS + 2;
  const zLo = -1;

  const hole = R.makeCylinder(holeRadius, h, [cx, cy, zLo]);
  const slitLen = Math.hypot(edge.x - cx, edge.y - cy) + skin + 1;
  const angleDeg = (Math.atan2(edge.ny, edge.nx) * 180) / Math.PI;
  const slit = R.makeBox([0, -slitWidth / 2, zLo], [slitLen, slitWidth / 2, zLo + h])
    .rotate(angleDeg, [0, 0, 0], [0, 0, 1])
    .translate([cx, cy, 0]);
  return hole.fuse(slit);
}

/**
 * Cut the bayonet's or snap's mating feature into the core solid's top rim
 * (mirrors manifold.ts's `applyCoreJointCut` primitive-for-primitive, so the
 * mesh and STEP backends can't drift on fit). Returns `core` unchanged when
 * the bore/height are too small for these features -- see JOINT_MIN_BORE_RADIUS.
 */
function applyCoreJointCutSolid(core: R.Shape3D, cut: CoreJointCut): R.Shape3D {
  const { jointRadius, boreRadius } = jointGeometry(cut.boreOutline, cut.joint, cut.tolerance);
  const minHeight = cut.joint === "bayonet" ? BAYONET_LEAD + BAYONET_GROOVE_HEIGHT + 2 : JOINT_ENGAGE_DEPTH + 2;
  if (boreRadius < JOINT_MIN_BORE_RADIUS || cut.height < minHeight) return core;

  const { height } = cut;

  if (cut.joint === "bayonet") {
    const grooveR = jointRadius + BAYONET_LUG_HEIGHT + BAYONET_GAP + 0.1;
    const groove = R.makeCylinder(grooveR, BAYONET_GROOVE_HEIGHT, [0, 0, height - BAYONET_LEAD - BAYONET_GROOVE_HEIGHT]);
    const entrySlots = unionAtAngles(
      (angle) => radialBoxSolid(jointRadius - 1, grooveR + 0.1, BAYONET_LUG_WIDTH + 2 * BAYONET_GAP, height - BAYONET_LEAD - 0.1, height + 1, angle),
      BAYONET_LUG_COUNT,
    );
    return core.cut(groove).cut(entrySlots);
  }

  // snap: a stepped counterbore, mirroring manifold.ts's own reasoning
  // (`wideR`/ridge radius forced past `boreRadius`/`circumscribedRadius` so
  // the cuts and the ridge-ring addition are never a near-tangent, nearly
  // coincident seam against the bore's flat sides or corner arcs).
  const wideR = Math.max(jointRadius - SNAP_GAP - cut.tolerance + SNAP_BARB + 0.3, boreRadius + WELD_OVERLAP);
  const ridgeOuterR = Math.max(wideR, circumscribedRadius(cut.boreOutline, 0) + WELD_OVERLAP);
  const ridgeInnerR = jointRadius - 0.1;
  const ridgeZLo = height - JOINT_ENGAGE_DEPTH + SNAP_BARB_HEIGHT;
  const ridgeZHi = ridgeZLo + SNAP_RIDGE_THICKNESS;

  const wideLower = R.makeCylinder(wideR, ridgeZLo - (height - JOINT_ENGAGE_DEPTH - 1), [0, 0, height - JOINT_ENGAGE_DEPTH - 1]);
  const wideUpper = R.makeCylinder(wideR, height + 1 - ridgeZHi, [0, 0, ridgeZHi]);
  const ridgeOuter = R.makeCylinder(ridgeOuterR, SNAP_RIDGE_THICKNESS, [0, 0, ridgeZLo]);
  const ridgeInner = R.makeCylinder(ridgeInnerR, SNAP_RIDGE_THICKNESS + 0.2, [0, 0, ridgeZLo - 0.1]);
  const ridgeRing = ridgeOuter.cut(ridgeInner);

  return core.cut(wideLower).cut(wideUpper).fuse(ridgeRing);
}

/**
 * A single glyph loop (label.ts's `LabelLoop`) as a closed straight-sided
 * replicad solid, extruded from `zBase` up by `height` -- mirrors
 * manifold.ts's `buildLabelCutter`, one prism per loop instead of one
 * CrossSection, since replicad has no multi-contour nonzero-fill face
 * primitive (see label.ts's `classifyLabelLoops` doc comment).
 *
 * Uses `makePolygon` (one edge per point, wired and faced in a single
 * internally-`localGC`-protected call), NOT the chained `draw().lineTo()`
 * pen used elsewhere in this file (`outlineSolid`): a glyph run's loops
 * chain hundreds of `lineTo` calls, and the pen's own per-segment curve
 * objects have no such protection -- empirically, replicad's
 * FinalizationRegistry-based cleanup (see its `register.ts`) collects an
 * still-in-use intermediate curve mid-chain under ordinary V8 GC pressure,
 * throwing "This object has been deleted". `makePolygon` builds the whole
 * closed loop in one call with no such window.
 */
function labelLoopSolid(loop: LabelLoop, height: number, zBase: number): R.Shape3D {
  const face = R.makePolygon(loop.map(([x, y]): [number, number, number] => [x, y, zBase]));
  const sketch = new R.Sketch(face.outerWire(), { defaultOrigin: [0, 0, zBase], defaultDirection: [0, 0, 1] });
  return sketch.extrude(height);
}

/**
 * The engraved label cutter solid (issue #12): fuse every SOLID glyph loop
 * (label.ts's `classifyLabelLoops`, sign-of-signed-area) into one shape,
 * then cut every HOLE loop out of it -- e.g. "O" becomes an outer disk with
 * an inner disk cut out, a real ring, not two overlapping solids. Undefined
 * when the text renders to no ink at all (e.g. an all-whitespace string that
 * still passed `resolveLabel`'s `trim()` check via internal spaces).
 */
async function buildLabelCutterSolid(label: ResolvedLabel): Promise<R.Shape3D | undefined> {
  const font = await getLabelFont();
  const { solids, holes } = classifyLabelLoops(labelLoops(font, label));
  if (solids.length === 0) return undefined;

  const cutterHeight = LABEL_DEPTH + 1;
  const zBase = CAP_THICKNESS - LABEL_DEPTH;
  let cutter = solids.map((loop) => labelLoopSolid(loop, cutterHeight, zBase)).reduce((a, b) => a.fuse(b));
  for (const hole of holes) cutter = cutter.cut(labelLoopSolid(hole, cutterHeight, zBase));
  return cutter;
}

/** Build the top cap solid (plate + engagement collar for the chosen joint + rim keyhole + engraved label), directly in the shared assembly frame -- see design.ts's own `buildTopCap` call and manifold.ts's mesh-backend twin. */
async function buildTopCapSolid(design: Design): Promise<R.Shape3D> {
  const { flangeSpec, spec, solution } = design;
  const outerOutline = offsetOutline(flangeSpec.outline, flangeSpec.margin);
  const plateOuter = outlineSolid(outerOutline, CAP_THICKNESS, 0);
  const plateInner = outlineSolid(flangeSpec.boreOutline, CAP_THICKNESS + 2, -1);
  const plate = plateOuter.cut(plateInner);

  const { boreRadius, collarRadius } = jointGeometry(flangeSpec.boreOutline, spec.joint, spec.tolerance);
  const canCutJoint = boreRadius >= JOINT_MIN_BORE_RADIUS && solution.height >= JOINT_ENGAGE_DEPTH + 2;

  let collar: R.Shape3D;
  if (spec.joint === "press" || !canCutJoint) {
    collar = collarBaseSolid(collarRadius, boreRadius);
  } else if (spec.joint === "bayonet") {
    const base = collarBaseSolid(collarRadius, boreRadius);
    const grooveZLo = -BAYONET_LEAD - BAYONET_GROOVE_HEIGHT;
    const grooveZHi = -BAYONET_LEAD;
    const lugs = unionAtAngles((a) => radialBoxSolid(collarRadius - 1, collarRadius + BAYONET_LUG_HEIGHT, BAYONET_LUG_WIDTH, grooveZLo, grooveZHi, a), BAYONET_LUG_COUNT);
    collar = base.fuse(lugs);
  } else {
    const base = collarBaseSolid(collarRadius, boreRadius);
    const barbR = collarRadius + SNAP_BARB;
    const barb = R.makeCylinder(barbR, SNAP_BARB_HEIGHT, [0, 0, -JOINT_ENGAGE_DEPTH]);
    const withBarb = base.fuse(barb);
    const slots = unionAtAngles((a) => radialBoxSolid(0, barbR + 0.5, SNAP_SLOT_WIDTH, -JOINT_ENGAGE_DEPTH - 0.5, 0.5, a), SNAP_HOOK_COUNT);
    collar = withBarb.cut(slots);
  }

  const keyhole = buildKeyholeSolid(flangeSpec.outline, flangeSpec.margin, spec.wire.diameter, spec.tolerance);
  let assembled = plate.fuse(collar).cut(keyhole);

  // Mirrors design.ts's own call: the SAME `resolveLabel` the mesh backend
  // uses, against the SAME outline/boreOutline/margin, so the two backends
  // can never fit the label text differently.
  const { label } = await resolveLabel(spec.label, flangeSpec.outline, flangeSpec.boreOutline, flangeSpec.margin, solution.topCapEnabled);
  if (label) {
    const labelCutter = await buildLabelCutterSolid(label);
    if (labelCutter) assembled = assembled.cut(labelCutter);
  }

  return assembled.translate([0, 0, solution.height]);
}
