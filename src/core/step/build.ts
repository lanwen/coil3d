// The actual STEP build. See docs/design.md (Export) and
// docs/step-notes.md for why: fit a periodic cubic B-spline surface
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
import type { WallProfile, WallSpec } from "../wall";
import {
  CAP_THICKNESS,
  JOINT_ENGAGE_DEPTH,
  JOINT_TRANSITION_HEIGHT,
  LABEL_DEPTH,
  MOUNT_PLATE_EMBED,
  MOUNT_PLATE_PEG_HOLE_DEPTH,
  MOUNT_PLATE_THICKNESS,
  OPENGRID_PLACEHOLDER_PEG_REACH,
  OPENGRID_PLACEHOLDER_PEG_SIZE,
  SCREW_MOUNT_HEAD_RADIUS,
  SCREW_MOUNT_SLOT_DEPTH,
  SCREW_MOUNT_SLOT_RADIUS,
  SCREW_MOUNT_UNDERCUT_DEPTH,
  SKADIS_CLIP_WIDTH,
  SNAP_SLOT_WIDTH,
  WELD_OVERLAP,
  INNER_CHANNEL_WALL_GUARD,
  FACE_BLOCK_MARGIN,
  FACE_MIN_MIDDLE_PITCHES,
  FACE_CUT_OVERSHOOT,
  FACE_RING_OVERLAP,
} from "../constants";
import { chamferedRim, chamferWedgeRows, SLAB_BELOW_FACE } from "../edgeChamfer";
import type { RimRow } from "../edgeChamfer";
import { jointGeometry, resolveCapJoint } from "../joints";
import type { OutlineStack, RevolvedFeature } from "../joints";
import { classifyLabelLoops, getLabelFont, labelLoops, resolveLabel } from "../label";
import type { LabelLoop, ResolvedLabel } from "../label";
import { layoutInnerEnd, resolveChannelDepth } from "../innerEnd";
import { faceCutArcs, faceTopFloor } from "../faceChannel";
import type { FaceChannelLayout, FaceCutArc, FaceEnd } from "../faceChannel";
import type { InnerEndLayout, SweepSolid } from "../innerEnd";
import { meshVolume } from "../meshVolume";
import { layoutKeyholeMount, throughHoleCountersink } from "../mount";
import { layoutFlangePads, layoutFlangeThroughHoles, offsetAtZ, padLevels, plateTopZ } from "../flangePads";
import type { FlangePad } from "../flangePads";
import type { KeyholeSlot, ThroughHole } from "../mount";
import { mountPlateLayoutFor as layoutFor, pegHoleOutline, pegSweep } from "../mountPlate";
import type { AnchorPoint, ClipInstance, MountPlateLayout } from "../mountPlate";
import { clipFrame } from "../skadisClips";
import type { RimClip, SkadisClipLayout } from "../skadisClips";
import { tclipPieceLevels } from "../skadisTclips";
import type { SkadisTclipLayout, Tclip } from "../skadisTclips";
import { offsetOutline, outlineColumnParams, polygonVertex } from "../shapes";
import type { ShapeOutline } from "../shapes";
import type { CoreJointCut } from "../manifold";
import type { Design } from "../types";
import { bendMultiplierOf } from "../types";

/** Recompute mountPlate.ts's layout from `design.flangeSpec`/`design.spec` (mirrors this file's own `layoutKeyholeMount(flangeSpec.outline, flangeSpec.boreOutline, flangeSpec.margin)` re-derivation for the keyhole mount): the STEP backend never stores its own copy, so it can't drift from the mesh backend's. */
function mountPlateLayoutFor(design: Design): MountPlateLayout {
  const { flangeSpec, spec } = design;
  const innerEnd = layoutInnerEnd(
    flangeSpec.outline,
    flangeSpec.margin,
    spec.wire.diameter,
    spec.tolerance,
    bendMultiplierOf(spec.wire) * spec.wire.diameter,
    resolveChannelDepth(spec.wire.diameter, flangeSpec.thickness),
  );
  return layoutFor(offsetOutline(flangeSpec.outline, flangeSpec.margin), flangeSpec.boreOutline, innerEnd);
}

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
 * A solid loft between `bottomOutline`'s own boundary (at `zBottom`) and
 * `topOutline`'s own boundary (at `zTop`) -- replicad's `loftWith`, the exact
 * (not convex-hull-approximated) equivalent of manifold.ts's `Manifold.hull`
 * transition (issue #55): both outlines share the same corner count and
 * arrangement (they're always two different Steiner offsets of the SAME
 * bore outline, joints.ts), so the loft is a true ruled surface between
 * corresponding flats/corners, not just "a convex shape that contains both".
 *
 * Deliberately its OWN sketch construction, not `outlineSolid`'s: `loftWith`
 * needs two `Sketch`es (not `Shape3D` solids) to loft between, and always
 * sketching a plain polygon (never `outlineSolid`'s own `makeCylinder`
 * shortcut for an exactly-round outline) keeps this new code path from ever
 * perturbing `outlineSolid`'s existing, widely-used solids (bore, flange,
 * mount plate, ...) -- only the collar transition (`collarBaseSolid`) calls
 * this.
 */
function outlineLoftSolid(bottomOutline: ShapeOutline, topOutline: ShapeOutline, zBottom: number, zTop: number): R.Shape3D {
  return outlineSketch(bottomOutline, zBottom).loftWith(outlineSketch(topOutline, zTop));
}

/** Issue #229: the solid whose outline is `outline` offset by each row's `offset`, at the row's `z`, lofted (ruled) through the rows -- the STEP twin of manifold.ts's `rimHull`. */
function rimLoftSolid(outline: ShapeOutline, rows: RimRow[]): R.Shape3D {
  const [first, ...rest] = rows.map(({ offset, z }) => outlineSketch(offsetOutline(outline, offset), z));
  return first.loftWith(rest, { ruled: true });
}

/** `o`'s own boundary as a sketch at height z (a plain circle when round). */
function outlineSketch(o: ShapeOutline, z: number): R.Sketch {
  if (o.n === 4 && o.cornerRadius === o.apothem) {
    return R.sketchCircle(o.apothem, { plane: "XY", origin: [0, 0, z] });
  }
  let pen = R.draw(polygonVertex(o, 0));
  for (let i = 1; i < o.n; i++) {
    pen = pen.lineTo(polygonVertex(o, i)).customCorner(o.cornerRadius);
  }
  const drawing = pen.closeWithCustomCorner(o.cornerRadius);
  return drawing.sketchOnPlane("XY", z) as R.Sketch;
}

/** joints.ts's `OutlineStack` as one solid: a ruled loft through its stations (mirrors manifold.ts's `stackSolid`, which hulls each pair). */
function stackSolidStep(stack: OutlineStack, dz = 0): R.Shape3D {
  const [first, ...rest] = stack.map(({ outline, z }) => outlineSketch(outline, z + dz));
  return first.loftWith(rest, { ruled: true });
}

/**
 * One depth LEVEL of the keyhole slot solid (issue #71, mirrors
 * manifold.ts's `slotLevelSolid`): a `headRadius` circle at the head and an
 * `otherRadius` circle at the shank-end, joined by a straight channel of
 * `otherRadius`'s own width, all drawn in 2D then extruded once.
 * `screwMountCutterSolid` below fuses two of these (a narrow, shallow "slot"
 * level and a head-width, deeper "undercut" level behind it).
 */
function slotLevelSolid(slot: KeyholeSlot, headRadius: number, otherRadius: number, height: number, zLo: number): R.Shape3D {
  let drawing = R.drawCircle(headRadius)
    .translate(slot.head.x, slot.head.y)
    .fuse(R.drawCircle(otherRadius).translate(slot.shankEnd.x, slot.shankEnd.y));

  const dx = slot.shankEnd.x - slot.head.x;
  const dy = slot.shankEnd.y - slot.head.y;
  const len = Math.hypot(dx, dy);
  if (len > 1e-6) {
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy * otherRadius;
    const py = ux * otherRadius;
    const channel = R.draw([slot.head.x + px, slot.head.y + py] as [number, number])
      .lineTo([slot.head.x - px, slot.head.y - py] as [number, number])
      .lineTo([slot.shankEnd.x - px, slot.shankEnd.y - py] as [number, number])
      .lineTo([slot.shankEnd.x + px, slot.shankEnd.y + py] as [number, number])
      .close();
    drawing = drawing.fuse(channel);
  }

  const sketch = drawing.sketchOnPlane("XY", zLo) as R.Sketch;
  return sketch.extrude(height);
}

/**
 * The replicad solid for one keyhole slot (mount.ts's layout math), cut from
 * `zBase` (the flange's outer face) inward -- mirrors manifold.ts's
 * `screwMountCutter` primitive-for-primitive (same two depth levels, same
 * constants), so the mesh and STEP backends can never drift apart. See that
 * function's own doc comment for the full issue #71 rationale (why a single
 * uniform-depth cut couldn't actually let the screw head travel to its
 * resting point, and why the internal seam between the two levels needs no
 * WELD_OVERLAP-style treatment, unlike the mouth).
 */
function screwMountCutterSolid(slot: KeyholeSlot, zBase: number): R.Shape3D {
  const slotLevel = slotLevelSolid(slot, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_SLOT_RADIUS, SCREW_MOUNT_SLOT_DEPTH, zBase);
  const undercutLevel = slotLevelSolid(slot, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_UNDERCUT_DEPTH, zBase + SCREW_MOUNT_SLOT_DEPTH);
  return slotLevel.fuse(undercutLevel);
}

/**
 * The replicad solid for one through-hole mount hole (issue #70, mount.ts's
 * `layoutThroughHoleMount`): a plain, full-thickness cylinder (screw-shank
 * clearance), the SAME radius through the flange's full depth -- mirrors
 * manifold.ts's `throughHoleCutter` primitive-for-primitive, and
 * `buildInnerEndCutterSolid`'s own through-cut convention (poking 1mm past
 * both faces). Issue #129: no counterbore. Issue #239: the countersink on
 * the winding face (the plate's top, `zTop`), a cone lofted between two
 * circles, carried on 1 mm above that face; cut as a separate tool.
 */
function throughHoleCutterSolid(hole: ThroughHole, holeRadius: number, flangeThickness: number, zTop: number, plateThickness: number): R.Shape3D[] {
  const throughH = flangeThickness + 2;
  const throughZLo = -flangeThickness - 1;
  const bore = R.makeCylinder(holeRadius, throughH, [hole.x, hole.y, throughZLo]);
  const sink = throughHoleCountersink(holeRadius, plateThickness);
  if (sink.depth <= 1e-6) return [bore];
  // The same 45 degree cone as the mesh's, carried on half a millimetre down inside the bore.
  const cone = R.sketchCircle(holeRadius - 0.5, { plane: "XY", origin: [hole.x, hole.y, zTop - sink.depth - 0.5] }).loftWith(R.sketchCircle(sink.radius + 1, { plane: "XY", origin: [hole.x, hole.y, zTop + 1] }));
  return [bore, cone];
}

// docs/step-notes.md: ~20 V-samples per helical pitch keeps the max fitting
// deviation under 0.1 mm; NU starts from the mesh's own column BUDGET so the
// two backends sample comparable grid resolution around the circumference.
//
// Issue #85 PR review round 2: the wall's own B-spline surface was still
// sampling a plain, evenly-spaced `i / NU` across the WHOLE perimeter
// (round 1 of this PR left it alone, reasoning the flange/cap's EXACT
// replicad `customCorner` fillets covered "the STEP corners" -- true for
// THEM, but not for the wall's own swept surface, still built from this
// sampled grid; a real miss, caught in review). Fixed by reusing the mesh
// backend's own adaptive, corner-favoring samples (shapes.ts's
// `outlineColumnParams`) here too -- a UNIFORMLY larger NU (tried first)
// technically also reaches the same per-corner segment floor, but for a
// shape whose corner is a small share of the perimeter that meant a much
// bigger NU than the mesh ever needs, and OCCT's own boolean ops against
// the resulting surface scale with NU badly enough that it blew well past
// a 2x build-time budget (a shape needing 4x the column count took 3.3x as
// long to build, not the ~1.4x a shape needing only a modest bump did).
// `bspfit.ts`'s `fitPeriodicUClampedV` now fits a genuinely NON-uniform
// periodic cubic B-spline (the general Cox-de-Boor collocation, not just
// the uniform case's textbook 1/6-4/6-1/6 shortcut) to make this safe --
// see that function's own doc comment.
const V_SAMPLES_PER_PITCH = 20;
const MIN_V_SAMPLES = 40;
// An early prototype saw <0.03% volume error for this approach; 1% leaves margin
// for coarser grids while still catching the silent boolean failures OCCT
// is prone to on B-spline walls. Issue #85 PR review round 2: briefly
// bumped to 2% in round 1 to paper over a mesh/STEP volume gap; back to
// the original 1% now that the STEP wall ALSO clears the corner segment
// floor (reusing the mesh's own sample placement, not just a bigger
// uniform NU), so both backends are accurate and agree well within it.
// Issue #117: 1.5%. A rounded-square fixture (60 mm, 15 mm corners, one
// layer; test/step-single-part.test.ts) already sat at 0.99% on main --
// measured, the STEP tube itself comes out ~180 mm^3 (0.9%) under the mesh
// wall, and its fuse with the flange loses another ~150 mm^3 (the fitted
// wall reaches a hair below z=0) -- and #117's smaller inner-end cut (no
// through-keyhole) tipped it just over 1%. That wall-fit gap predates this
// issue and is left for its own ticket; the silent boolean failure this
// check exists to catch is now also caught directly (`checkedCut`).
const VOLUME_TOLERANCE = 0.015;
/** Fuzzy values (mm) `checkedCut` tries in turn: all far below print resolution, enough for OCCT to resolve the swept cutters' small facets. */
const FUZZY_CUTS = [1e-4, 1e-3, 1e-2];

let oc: OpenCascadeInstance | undefined;
/** The kernel, once `getOC` has loaded it (every builder below runs after `buildStep` awaited it). */
function getOCSync(): OpenCascadeInstance {
  if (!oc) throw new Error("STEP export: OpenCascade is not loaded yet");
  return oc;
}
async function getOC(): Promise<OpenCascadeInstance> {
  if (!oc) {
    oc = await initOpenCascade();
    R.setOC(oc);
  }
  return oc;
}

function channelSection(face: FaceEnd["face"], offset: number, halfWidth: number, level: number, height: number): R.Sketch {
  const left = offset - halfWidth;
  const right = offset + halfWidth;
  const pen =
    face === "bottom"
      ? R.draw([left, -FACE_CUT_OVERSHOOT]).lineTo([right, -FACE_CUT_OVERSHOOT]).lineTo([right, level]).threePointsArcTo([left, level], [offset, level + halfWidth])
      : R.draw([left, level]).threePointsArcTo([right, level], [offset, level - halfWidth]).lineTo([right, height + FACE_CUT_OVERSHOOT]).lineTo([left, height + FACE_CUT_OVERSHOOT]);
  return pen.close().sketchOnPlane("XZ") as R.Sketch;
}

function faceArcCutterSolid(arc: FaceCutArc, end: FaceEnd, layout: FaceChannelLayout): R.Shape3D {
  const degrees = (Math.abs(arc.sweep) * 180) / Math.PI;
  const lowest = (Math.min(arc.from, arc.from + arc.sweep) * 180) / Math.PI;
  const solid = channelSection(end.face, arc.radius, layout.channelRadius, end.level, layout.height).revolve([0, 0, 1], { angle: degrees });
  return solid.rotate(lowest, [0, 0, 0], [0, 0, 1]).translate([arc.centre.x, arc.centre.y, 0]);
}

function boreBetween(boreOutline: ShapeOutline, zLo: number, zHi: number): R.Shape3D {
  return outlineSolid(boreOutline, zHi - zLo, zLo);
}

function bandSamples(zLo: number, zHi: number, pitch: number): number {
  return Math.max(MIN_V_SAMPLES, Math.round((V_SAMPLES_PER_PITCH * (zHi - zLo)) / pitch) + 1);
}

function boolean(kernel: OpenCascadeInstance, op: "cut" | "fuse", a: R.Shape3D, b: R.Shape3D): R.Shape3D {
  const run = op === "cut" ? new kernel.BRepAlgoAPI_Cut(a.wrapped, b.wrapped) : new kernel.BRepAlgoAPI_Fuse(a.wrapped, b.wrapped);
  try {
    run.Build(new kernel.Message_ProgressRange());
    if (run.HasErrors()) throw new Error("STEP export: a boolean operation failed");
    return R.cast(run.Shape()) as R.Shape3D;
  } finally {
    run.delete();
  }
}

function sewnSolid(kernel: OpenCascadeInstance, solids: R.Shape3D[], interfaces: number[]): R.Shape3D {
  const sewing = new kernel.BRepBuilderAPI_Sewing(1e-3, true, true, true, false);
  for (const solid of solids) {
    for (const face of solid.faces) {
      if (face.geomType === "PLANE" && interfaces.some((z) => Math.abs(face.center.z - z) < 1e-4)) continue;
      sewing.Add(face.wrapped);
    }
  }
  sewing.Perform(new kernel.Message_ProgressRange());
  const fix = new kernel.ShapeFix_Solid(new kernel.BRepBuilderAPI_MakeSolid(kernel.TopoDS.Shell(sewing.SewedShape())).Solid());
  fix.Perform(new kernel.Message_ProgressRange());
  return R.cast(fix.Solid()).asShape3D();
}

function faceChannelTube(kernel: OpenCascadeInstance, layout: FaceChannelLayout, profile: WallProfile, ts: number[], wallSpec: WallSpec): R.Shape3D {
  const { boreOutline, height, pitch } = wallSpec;
  const rings = faceRingSolids(layout, boreOutline);
  const slots = (ends: FaceEnd[]) =>
    ends.flatMap((end) => faceCutArcs(end).map((arc) => faceArcCutterSolid(arc, end, layout))).reduce((all, piece) => boolean(kernel, "fuse", all, piece));
  const band = (zLo: number, zHi: number, ring: R.Shape3D | undefined, ends: FaceEnd[]) => {
    const bore = boreBetween(boreOutline, zLo - FACE_CUT_OVERSHOOT, zHi + FACE_CUT_OVERSHOOT);
    const wall = wallBandSolid(kernel, profile, ts, zLo, zHi, bandSamples(zLo, zHi, pitch));
    const open = boolean(kernel, "cut", wall, ring ? boolean(kernel, "cut", bore, ring) : bore);
    return ends.length > 0 ? boolean(kernel, "cut", open, slots(ends)) : open;
  };
  const splitLow = layout.bottomThickness + FACE_BLOCK_MARGIN;
  const splitHigh = faceTopFloor(layout) - FACE_RING_OVERLAP - FACE_BLOCK_MARGIN;
  if (layout.outer && splitHigh - splitLow < FACE_MIN_MIDDLE_PITCHES * pitch) {
    const both = rings.slice(1).reduce((all, ring) => boolean(kernel, "fuse", all, ring), rings[0]);
    return band(0, height, both, [layout.inner, layout.outer]);
  }
  const bottom = band(0, splitLow, rings[0], [layout.inner]);
  if (!layout.outer) return sewnSolid(kernel, [bottom, band(splitLow, height, undefined, [])], [splitLow]);
  const middle = band(splitLow, splitHigh, undefined, []);
  const top = band(splitHigh, height, rings[1], [layout.outer]);
  return sewnSolid(kernel, [bottom, middle, top], [splitLow, splitHigh]);
}

function faceRingSolids(layout: FaceChannelLayout, boreOutline: ShapeOutline): R.Shape3D[] {
  const grown = offsetOutline(boreOutline, FACE_RING_OVERLAP);
  const hole = (zLo: number, zHi: number) => outlineSolid(layout.holeOutline, zHi - zLo, zLo);
  const over = FACE_CUT_OVERSHOOT;
  const rings = [outlineSolid(grown, layout.bottomThickness + over, -over).cut(hole(-2 * over, layout.bottomThickness + 2 * over))];
  if (layout.topThickness !== undefined) {
    const flat = layout.height - layout.topThickness;
    const depth = layout.funnelDepth + FACE_RING_OVERLAP;
    const foot = flat - depth;
    const top = layout.height + over;
    const flared = { ...layout.holeOutline, apothem: layout.holeOutline.apothem + depth, cornerRadius: layout.holeOutline.cornerRadius + depth };
    const void_ = outlineLoftSolid(flared, layout.holeOutline, foot, flat).fuse(hole(flat - over, top + over));
    rings.push(outlineSolid(grown, top - foot, foot).cut(void_));
  }
  return rings;
}

function wallBandSolid(kernel: OpenCascadeInstance, profile: WallProfile, ts: number[], zLo: number, zHi: number, samples: number): R.Shape3D {
  const NU = ts.length;
  const span = zHi - zLo;
  const dz = 1e-4;
  const tangent = (z0: number, z1: number) => (i: number): Vec3 => {
    const t = ts[i];
    const a = profile.point(t, z0);
    const b = profile.point(t, z1);
    return a.map((v, c) => ((b[c] - v) / (z1 - z0)) * span) as Vec3;
  };
  const fit = fitPeriodicUClampedV(ts, samples, (i, j) => profile.point(ts[i], zLo + (j * span) / (samples - 1)), tangent(zLo, zLo + dz), tangent(zHi - dz, zHi));

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
    if (kernel.BRep_Tool.IsClosed(edge, face)) continue;
    const cap = new kernel.BRepBuilderAPI_MakeFace(new kernel.BRepBuilderAPI_MakeWire(edge).Wire(), true);
    if (!cap.IsDone()) throw new Error("STEP export: planar cap face failed");
    sewing.Add(cap.Face());
  }
  sewing.Perform(new kernel.Message_ProgressRange());
  const outerFix = new kernel.ShapeFix_Solid(
    new kernel.BRepBuilderAPI_MakeSolid(kernel.TopoDS.Shell(sewing.SewedShape())).Solid(),
  );
  outerFix.Perform(new kernel.Message_ProgressRange());
  const solid = R.cast(outerFix.Solid()).asShape3D();
  return isInside(kernel, solid, { x: 0, y: 0, z: (zLo + zHi) / 2 }) ? solid : (R.cast(solid.wrapped.Reversed()) as R.Shape3D);
}

function isInside(kernel: OpenCascadeInstance, solid: R.Shape3D, point: { x: number; y: number; z: number }): boolean {
  const location = new kernel.gp_Pnt(point.x, point.y, point.z);
  const vertex = new kernel.BRepBuilderAPI_MakeVertex(location);
  const distance = new kernel.BRepExtrema_DistShapeShape();
  try {
    distance.LoadS1(vertex.Vertex());
    distance.LoadS2(solid.wrapped);
    distance.Perform(new kernel.Message_ProgressRange());
    return distance.InnerSolution();
  } finally {
    distance.delete();
    vertex.delete();
    location.delete();
  }
}

export async function buildStep(design: Design): Promise<Uint8Array<ArrayBuffer>> {
  const kernel = await getOC();
  const { wallSpec, flangeSpec } = design;
  const profile = createWallProfile(wallSpec);
  const { height, columns, minCornerSegments, outline, boreOutline } = wallSpec;
  const ts = outlineColumnParams(outline, columns, minCornerSegments);

  const NV = Math.max(MIN_V_SAMPLES, Math.round(V_SAMPLES_PER_PITCH * wallSpec.turns) + 1);
  const tube = design.faceChannels
    ? faceChannelTube(kernel, design.faceChannels, profile, ts, wallSpec)
    : wallBandSolid(kernel, profile, ts, 0, height, NV).cut(outlineSolid(boreOutline, height + 2, -1));

  let coreSolid = tube;
  let innerEndCutter: ReturnType<typeof buildInnerEndCutterSolid> | undefined;
  if (flangeSpec.thickness > 0) {
    const flangeOuter = rimLoftSolid(flangeSpec.outline, chamferedRim(flangeSpec.margin, -flangeSpec.thickness, 0));
    const flangeInner = outlineSolid(flangeSpec.boreOutline, flangeSpec.thickness + 2, -flangeSpec.thickness - 1);
    const flange = flangeSpec.skadisTclip ? flangeOuter : flangeOuter.cut(flangeInner);

    innerEndCutter = buildInnerEndCutterSolid(
      flangeSpec.outline,
      flangeSpec.margin,
      flangeSpec.thickness,
      resolveChannelDepth(design.spec.wire.diameter, flangeSpec.thickness),
      design.spec.wire.diameter,
      design.spec.tolerance,
      bendMultiplierOf(design.spec.wire) * design.spec.wire.diameter,
    );
    const anchors = design.parts.some((p) => p.role === "mountPlate") ? mountPlateLayoutFor(design).anchors : [];
    const relieved = relieveFlangeSolid(kernel, flange, flangeSpec, innerEndCutter.layout, anchors, design.spec.tolerance);
    let flangeSolid = checkedCut(kernel, relieved, innerEndCutter.cutter);
    for (const notch of flangeSpec.skadis?.notches ?? []) {
      const loop: [number, number][] = notch.map((p) => [p.x, p.y]);
      flangeSolid = checkedCut(kernel, flangeSolid, loopSolid(loop, flangeSpec.thickness + 2 * WELD_OVERLAP).translate([0, 0, -flangeSpec.thickness - WELD_OVERLAP]));
    }
    if (flangeSpec.rimSlot) {
      const loop: [number, number][] = flangeSpec.rimSlot.outline.map((p) => [p.x, p.y]);
      flangeSolid = checkedCut(kernel, flangeSolid, loopSolid(loop, flangeSpec.thickness + 2 * WELD_OVERLAP).translate([0, 0, -flangeSpec.thickness - WELD_OVERLAP]));
    }
    for (const cutters of flangeSpec.skadisTclip?.cutters ?? []) {
      const [first, ...rest] = cutters.map((cutter) => ruledLoft(cutter.levels.map((l) => l.poly.map((p): [number, number, number] => [p.x, p.y, l.z]))));
      flangeSolid = checkedCut(kernel, flangeSolid, rest.reduce((acc, r) => acc.fuse(r), first));
    }
    coreSolid = tube.fuse(flangeSolid);
  }

  const capJoint = resolveCapJoint(design.spec, design.wallSpec);
  if (design.solution.topCapEnabled && (capJoint.joint === "bayonet" || capJoint.joint === "snap")) {
    coreSolid = applyCoreJointCutSolid(coreSolid, {
      boreOutline,
      height: design.solution.height,
      joint: capJoint.joint,
      tolerance: design.spec.tolerance,
      bayonet: capJoint.bayonet,
      snap: capJoint.snap,
    });
  }

  if (design.flangeSpec.mount === "keyhole") {
    const layout = layoutKeyholeMount(flangeSpec.outline, flangeSpec.boreOutline, flangeSpec.margin, flangeSpec.keyholeRotation);
    for (const slot of layout.slots) {
      const cutter = screwMountCutterSolid(slot, -flangeSpec.thickness);
      coreSolid = coreSolid.cut(cutter);
    }
  }

  if (design.flangeSpec.mount === "through") {
    const layout = layoutFlangeThroughHoles(flangeSpec, innerEndCutter?.layout);
    for (const hole of layout.holes) {
      for (const cutter of throughHoleCutterSolid(hole, layout.holeRadius, flangeSpec.thickness, plateTopZ(flangeSpec) ?? 0, Math.min(flangeSpec.plateThickness ?? flangeSpec.thickness, flangeSpec.thickness))) coreSolid = coreSolid.cut(cutter);
    }
  }

  if (design.parts.some((p) => p.role === "mountPlate")) {
    const layout = mountPlateLayoutFor(design);
    for (const anchor of layout.anchors) {
      const cutter = pinHoleCutterSolid(anchor, design.spec.tolerance, -flangeSpec.thickness, 1);
      coreSolid = coreSolid.cut(cutter);
    }
  }

  const corePart = design.parts.find((p) => p.role === "core")!;
  validateSolid(kernel, coreSolid, corePart.mesh, corePart.name);

  const shapes: { shape: R.Shape3D; name: string }[] = [{ shape: coreSolid, name: corePart.name }];

  const topCapPart = design.parts.find((p) => p.role === "topCap");
  if (topCapPart) {
    const capSolid = await buildTopCapSolid(design);
    validateSolid(kernel, capSolid, topCapPart.mesh, topCapPart.name);
    shapes.push({ shape: capSolid, name: topCapPart.name });
  }

  const mountPlatePart = design.parts.find((p) => p.role === "mountPlate");
  if (mountPlatePart) {
    const plateSolid = buildMountPlateSolid(design);
    validateSolid(kernel, plateSolid, mountPlatePart.mesh, mountPlatePart.name);
    shapes.push({ shape: plateSolid, name: mountPlatePart.name });
  }

  const clipParts = design.parts.filter((p) => p.role === "mountClip");
  if (clipParts.length > 0 && flangeSpec.skadis) {
    const layout = flangeSpec.skadis;
    clipParts.forEach((part, i) => {
      const clipSolid = skadisClipSolid(layout, layout.clips[i]);
      validateSolid(kernel, clipSolid, part.mesh, part.name);
      shapes.push({ shape: clipSolid, name: part.name });
    });
  }

  const tclipParts = design.parts.filter((p) => p.role === "mountClip");
  if (tclipParts.length > 0 && flangeSpec.skadisTclip) {
    const layout = flangeSpec.skadisTclip;
    tclipParts.forEach((part, i) => {
      const clipSolid = skadisTclipSolid(layout, layout.clips[i]);
      validateSolid(kernel, clipSolid, part.mesh, part.name);
      shapes.push({ shape: clipSolid, name: part.name });
    });
  }

  const pegParts = design.parts.filter((p) => p.role === "peg");
  if (pegParts.length > 0) {
    const { anchors } = mountPlateLayoutFor(design);
    pegParts.forEach((part, i) => {
      const pegSolid = sweepSolidStep(pegSweep(anchors[i], -flangeSpec.thickness));
      validateSolid(kernel, pegSolid, part.mesh, part.name);
      shapes.push({ shape: pegSolid, name: part.name });
    });
  }

  const blob = R.exportSTEP(shapes);
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * `shape` minus `tool`, straight through OCCT's boolean builder with a small
 * fuzzy value (a larger one if that fails), failing loudly instead of
 * silently returning `shape` unchanged. Issue #117's swept cutters (hundreds
 * of small planar faces): without a fuzzy value OCCT sometimes cut nothing
 * at all, reporting no error (replicad's own `cut` would pass that straight
 * on) -- so a cut that removes no volume counts as a failure too. Issue
 * #239: it can also cut only a sliver (the inner-end channel on one wide
 * flange: 7 mm^3 of its 2958 at the smallest fuzzy value, all of it at the
 * next), so the first result is checked against the next fuzzy value's, and
 * where the two disagree the cut that removes the most wins.
 */
function checkedCut(kernel: OpenCascadeInstance, shape: R.Shape3D, tool: R.Shape3D | R.Shape3D[]): R.Shape3D {
  const before = R.measureVolume(shape);
  const cut = (fuzzy: number): { result: R.Shape3D; removed: number } | undefined => {
    const args = new kernel.NCollection_List_TopoDS_Shape();
    args.Append(shape.wrapped);
    const tools = new kernel.NCollection_List_TopoDS_Shape();
    for (const t of [tool].flat()) tools.Append(t.wrapped);
    const op = new kernel.BRepAlgoAPI_Cut();
    try {
      op.SetArguments(args);
      op.SetTools(tools);
      op.SetFuzzyValue(fuzzy);
      op.Build(new kernel.Message_ProgressRange());
      if (op.HasErrors()) return undefined;
      const result = R.cast(op.Shape()) as R.Shape3D;
      return { result, removed: before - R.measureVolume(result) };
    } finally {
      op.delete();
      args.delete();
      tools.delete();
    }
  };
  const results: Array<{ result: R.Shape3D; removed: number }> = [];
  for (const fuzzy of FUZZY_CUTS) {
    const r = cut(fuzzy);
    if (r && r.removed > 1e-6) results.push(r);
    // Two results that agree (within 1%) settle it.
    if (results.length === 2) {
      const [a, b] = results;
      if (Math.abs(a.removed - b.removed) <= 0.01 * Math.max(a.removed, b.removed)) return a.result;
    }
  }
  if (results.length === 0) throw new Error("STEP export: a boolean cut failed (it removed nothing)");
  return results.reduce((m, r) => (r.removed > m.removed ? r : m)).result;
}

/** Validate one part's solid: manifold-valid, exactly one solid, and its volume matches the part's own mesh within tolerance. Throws with a descriptive message otherwise. */
function validateSolid(kernel: OpenCascadeInstance, solid: R.Shape3D, mesh: Design["mesh"], name: string): void {
  const analyzer = new kernel.BRepCheck_Analyzer(solid.wrapped, true, false, false);
  const valid = analyzer.IsValid();
  const solidCount = solid.solids.length;
  // Adaptive integration to a set precision: the default (fixed-order Gauss)
  // one misreads a B-spline wall with a deep groove by a few percent.
  const gprops = new kernel.GProp_GProps();
  kernel.BRepGProp.VolumeProperties(solid.wrapped, gprops, 1e-5, false, false);
  const stepVolume = gprops.Mass();
  gprops.delete();
  const expectedVolume = meshVolume(mesh);
  const volumeError = Math.abs(stepVolume - expectedVolume) / expectedVolume;

  if (!valid || solidCount !== 1 || volumeError > VOLUME_TOLERANCE) {
    throw new Error(
      `STEP export failed validation for part "${name}": valid=${valid} solids=${solidCount} ` +
        `step volume=${stepVolume.toFixed(1)} mesh volume=${expectedVolume.toFixed(1)} ` +
        `(${(volumeError * 100).toFixed(2)}% off, tolerance ${(VOLUME_TOLERANCE * 100).toFixed(1)}%)`,
    );
  }
}

/** The snap collar's base (mirrors manifold.ts's `collarBase`, issue #172): a straight prism flaring over its top `JOINT_TRANSITION_HEIGHT` out to `rootOutline`, which stays inside the core's bore. */
function collarBaseSolid(collarOutline: ShapeOutline, rootOutline: ShapeOutline, depth: number): R.Shape3D {
  const straightHeight = depth - JOINT_TRANSITION_HEIGHT;
  const straight = outlineSolid(collarOutline, straightHeight, -depth);
  const transition = outlineLoftSolid(collarOutline, rootOutline, -JOINT_TRANSITION_HEIGHT, 0);
  return straight.fuse(transition);
}

/** A box spanning radius [rLo, rHi] and tangential width `width`, at axial [zLo, zHi], rotated to `angleDeg` about Z -- the shared primitive for lugs, entry slots and relief slots (mirrors manifold.ts's `radialBox`). */
function radialBoxSolid(rLo: number, rHi: number, width: number, zLo: number, zHi: number, angleDeg: number): R.Shape3D {
  const box = R.makeBox([Math.min(rLo, rHi), -width / 2, zLo], [Math.max(rLo, rHi), width / 2, zHi]);
  return box.rotate(angleDeg, [0, 0, 0], [0, 0, 1]);
}

/** Issue #167: a bayonet lug, slot or groove (joints.ts's `RevolvedFeature`), raised by `dz` -- mirrors manifold.ts's `revolvedFeature`. */
function revolvedFeatureSolid(f: RevolvedFeature, dz: number): R.Shape3D {
  const face = R.makePolygon(f.profile.map(([r, z]): [number, number, number] => [r, 0, z + dz]));
  const sketch = new R.Sketch(face.outerWire(), { defaultOrigin: [0, 0, 0], defaultDirection: [0, -1, 0] });
  return sketch.revolve([0, 0, 1], { origin: [0, 0, 0], angle: f.sweepDeg }).rotate(f.startDeg, [0, 0, 0], [0, 0, 1]);
}

/** `build(angleDeg)` at each of the given angles around Z, fused into one shape (mirrors manifold.ts's `unionAtAngles`). */
function unionAtAngles(build: (angleDeg: number) => R.Shape3D, anglesDeg: number[]): R.Shape3D {
  let result: R.Shape3D | undefined;
  for (const angle of anglesDeg) {
    const m = build(angle);
    result = result ? result.fuse(m) : m;
  }
  return result!;
}

/**
 * One of innerEnd.ts's swept solids (the channel/clip cutter and the flange
 * pads) as a polyhedral solid: exactly the triangles
 * manifold.ts's `sweepMesh` meshes from the same rings (each end capped by
 * one planar face), so the two backends cut the identical shape. (A ruled
 * loft through the same rings gave the same shape but made the export
 * several times slower.)
 */
function sweepSolidStep(sweep: SweepSolid): R.Shape3D {
  const pt = (p: { x: number; y: number; z: number }): [number, number, number] => [p.x, p.y, p.z];
  const { rings } = sweep;
  const m = rings[0].length;
  const faces: R.Face[] = [R.makePolygon(rings[0].map(pt)), R.makePolygon(rings[rings.length - 1].map(pt))];
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < m; j++) {
      const [a, b, c, d] = [rings[i][j], rings[i][(j + 1) % m], rings[i + 1][j], rings[i + 1][(j + 1) % m]];
      faces.push(R.makePolygon([pt(a), pt(b), pt(d)]), R.makePolygon([pt(a), pt(d), pt(c)]));
    }
  }
  return R.makeSolid(faces);
}

/**
 * The bottom flange's own inner-end fixing (issues #8, #117): the channel +
 * clip swept along the cable, clipped to stay outside the wall's own outline
 * (see manifold.ts's `outlineBlocker` for why), mirroring manifold.ts's
 * `buildInnerEndCutter` from the SAME `layoutInnerEnd` call and rings.
 */
function buildInnerEndCutterSolid(
  outline: ShapeOutline,
  margin: number,
  flangeThickness: number,
  channelDepth: number,
  wireDiameter: number,
  tolerance: number,
  bendRadius: number,
): { cutter: R.Shape3D; layout: InnerEndLayout } {
  const layout: InnerEndLayout = layoutInnerEnd(outline, margin, wireDiameter, tolerance, bendRadius, channelDepth);
  const raw = sweepSolidStep(layout.channel);
  const top = Math.max(...layout.channel.rings.flat().map((p) => p.z)) + 1;
  // Offset outward by INNER_CHANNEL_WALL_GUARD, exactly like manifold.ts's
  // blocker: clipping against the wall's exact outline would risk a
  // razor-thin, exactly-coincident seam.
  const blocker = outlineSolid(offsetOutline(outline, INNER_CHANNEL_WALL_GUARD), top + flangeThickness + 1, -flangeThickness - 1);
  return { cutter: raw.cut(blocker), layout };
}

/** A stadium (a circle when `a` and `b` coincide) sketch at height z. */
function stadiumSketch(a: { x: number; y: number }, b: { x: number; y: number }, r: number, z: number): R.Sketch {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len <= 1e-9) return R.sketchCircle(r, { plane: "XY", origin: [a.x, a.y, z] });
  const nx = (-(b.y - a.y) / len) * r;
  const ny = ((b.x - a.x) / len) * r;
  const vx = ((b.x - a.x) / len) * r;
  const vy = ((b.y - a.y) / len) * r;
  return R.draw([a.x + nx, a.y + ny])
    .lineTo([b.x + nx, b.y + ny])
    .threePointsArcTo([b.x - nx, b.y - ny], [b.x + vx, b.y + vy])
    .lineTo([a.x - nx, a.y - ny])
    .threePointsArcTo([a.x + nx, a.y + ny], [a.x - vx, a.y - vy])
    .close()
    .sketchOnPlane("XY", z) as R.Sketch;
}

/** Whether the 4 points of a quad lie in one plane (to well within OCCT's own tolerance). */
function isPlanar(q: Array<{ x: number; y: number; z: number }>): boolean {
  // Newell's normal, then every corner's distance from the mean plane.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-12) return false;
  const c = q.reduce((s, p) => ({ x: s.x + p.x / q.length, y: s.y + p.y / q.length, z: s.z + p.z / q.length }), { x: 0, y: 0, z: 0 });
  return q.every((p) => Math.abs(((p.x - c.x) * nx + (p.y - c.y) * ny + (p.z - c.z) * nz) / l) < 1e-6);
}

/**
 * One flange pad (flangePads.ts) as a solid, lofted (ruled) through its
 * three levels: the collar and the round pads from exact curves (the mesh
 * backend samples the same shapes), the channel pad from the same rings the
 * mesh backend sweeps.
 */
function padSolidStep(pad: FlangePad, levels: number[], outline: ShapeOutline): R.Shape3D {
  const { shape } = pad;
  let sketches: R.Sketch[];
  if (shape.kind === "collar") {
    sketches = levels.map((z) => outlineSketch(offsetOutline(outline, offsetAtZ(shape.offset, z)), z));
  } else if (shape.kind === "stadium") {
    sketches = levels.map((z) => stadiumSketch(shape.a, shape.b, offsetAtZ(shape.radius, z), z));
  } else {
    // The channel pad and its fillet (flangePads.ts), from the same rings
    // the mesh backend sweeps: the two end rings (each flat), and one face
    // per ring pair and side -- a flat quad where it is one (most of the
    // mitred pad, and every strip of the fillet's cone), else two triangles
    // (where the pad's tail eases into the collar, issue #133).
    const pt = (p: { x: number; y: number; z: number }): [number, number, number] => [p.x, p.y, p.z];
    const { rings } = pad.sweep;
    const m = rings[0].length;
    const faces: R.Face[] = [R.makePolygon(rings[0].map(pt)), R.makePolygon(rings[rings.length - 1].map(pt))];
    for (let i = 0; i + 1 < rings.length; i++) {
      for (let j = 0; j < m; j++) {
        const quad = [rings[i][j], rings[i][(j + 1) % m], rings[i + 1][(j + 1) % m], rings[i + 1][j]];
        if (isPlanar(quad)) faces.push(R.makePolygon(quad.map(pt)));
        else faces.push(R.makePolygon([quad[0], quad[1], quad[2]].map(pt)), R.makePolygon([quad[0], quad[2], quad[3]].map(pt)));
      }
    }
    return R.makeSolid(faces);
  }
  return sketches[0].loftWith(sketches.slice(1), { ruled: true });
}

/** Issue #122: the flange minus the slab above its plate's top face, less every pad -- mirrors manifold.ts's `relieveFlange`. `flange` unchanged when the plate is full thickness. */
function relieveFlangeSolid(kernel: OpenCascadeInstance, flange: R.Shape3D, flangeSpec: Design["flangeSpec"], innerEnd: InnerEndLayout, anchors: AnchorPoint[], tolerance: number): R.Shape3D {
  const zPlate = plateTopZ(flangeSpec);
  if (zPlate === undefined) return flange;
  const levels = padLevels(zPlate);
  const pads = layoutFlangePads(flangeSpec, innerEnd, anchors, tolerance).map((pad) => padSolidStep(pad, levels, flangeSpec.outline));
  const padSolid = pads.slice(1).reduce((all, pad) => all.fuse(pad), pads[0]);
  // Issue #229: the slab's lower edge runs down the plate top's chamfer, around the frustum that stays.
  const slab = outlineSolid(offsetOutline(flangeSpec.outline, flangeSpec.margin + 1), 1 - zPlate + SLAB_BELOW_FACE, zPlate - SLAB_BELOW_FACE);
  const kept = rimLoftSolid(flangeSpec.outline, chamferWedgeRows(flangeSpec.margin, zPlate));
  return checkedCut(kernel, flange, checkedCut(kernel, checkedCut(kernel, slab, kept), padSolid));
}

/**
 * Add the bayonet's lugs (issue #167) or the snap's ridge ring (issue #186) to the core solid's top rim
 * (mirrors manifold.ts's `applyCoreJointCut` primitive-for-primitive, so the
 * mesh and STEP backends can't drift on fit), from the layout
 * joints.ts's `resolveCapJoint` made.
 */
function applyCoreJointCutSolid(core: R.Shape3D, cut: CoreJointCut): R.Shape3D {
  // Issue #167: the bayonet's lugs in the bore, from the shared layout.
  if (cut.joint === "bayonet") {
    return cut.bayonet!.lugs.reduce((solid, f) => solid.fuse(revolvedFeatureSolid(f, cut.height)), core);
  }

  // snap (issues #168, #186): the ridge and the seat, each its relief cut
  // from its lip on its own, then added -- the same `snapLayout` as
  // manifold.ts's `applyCoreJointCut`. The wall is never cut.
  return cut.snap!.rings.reduce((solid, { lip, relief }) => solid.fuse(stackSolidStep(lip, cut.height).cut(stackSolidStep(relief, cut.height))), core);
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

/** Build the top cap solid (plate + engagement collar for the chosen joint + engraved label + rim slot), directly in the shared assembly frame -- see design.ts's own `buildTopCap` call and manifold.ts's mesh-backend twin. */
async function buildTopCapSolid(design: Design): Promise<R.Shape3D> {
  const { flangeSpec, spec, solution } = design;
  // Issue #127: the plate's middle is opened by the through-hole below (mirrors manifold.ts).
  // Issues #229, #237: the outer edge is chamfered on both faces (edgeChamfer.ts's `chamferedRim`).
  const plate = rimLoftSolid(flangeSpec.outline, chamferedRim(flangeSpec.margin, 0, CAP_THICKNESS));

  // Issue #167: the joint design.ts built (a bayonet may fall back to press fit).
  const capJoint = resolveCapJoint(spec, design.wallSpec);
  const { collarOutline, holeOutline } = jointGeometry(flangeSpec.boreOutline, capJoint.joint, spec.tolerance);
  // Issue #172: a straight tube into the plate, no flare (mirrors manifold.ts).
  const straight = () => outlineSolid(collarOutline, JOINT_ENGAGE_DEPTH + WELD_OVERLAP, -JOINT_ENGAGE_DEPTH);
  const snap = capJoint.snap;

  let collar: R.Shape3D;
  if (capJoint.joint === "bayonet") {
    // The L-slots cut into the straight tube (mirrors manifold.ts).
    collar = capJoint.bayonet!.cuts.reduce((solid, f) => solid.cut(revolvedFeatureSolid(f, 0)), straight());
  } else if (snap) {
    // Issues #168, #186: the root flare, the barb and the slots from
    // the same `snapLayout` as manifold.ts's `buildTopCap`.
    const withBarb = collarBaseSolid(collarOutline, snap.rootOutline, snap.depth).fuse(stackSolidStep(snap.barb));
    const slots = unionAtAngles((a) => radialBoxSolid(0, snap.slotOuterRadius, SNAP_SLOT_WIDTH, -snap.depth - 0.5, 0.5, a), snap.slotAnglesDeg);
    collar = withBarb.cut(slots);
  } else {
    // Press, or a bayonet or snap the core can't take (joints.ts's `resolveCapJoint`).
    collar = straight();
  }

  let assembled = plate.fuse(collar);
  // Issue #127: the straight through-hole down the middle (the collar is a tube).
  // The snap fingers reach deeper than JOINT_ENGAGE_DEPTH, so their hole comes with the layout.
  if (snap?.hole) assembled = assembled.cut(stackSolidStep(snap.hole));
  else if (holeOutline) assembled = assembled.cut(outlineSolid(holeOutline, CAP_THICKNESS + JOINT_ENGAGE_DEPTH + 2, -JOINT_ENGAGE_DEPTH - 1));

  // Mirrors design.ts's own call: the SAME `resolveLabel` the mesh backend
  // uses, against the SAME outline/boreOutline/margin, so the two backends
  // can never fit the label text differently.
  const { label } = await resolveLabel(spec.label, flangeSpec.outline, flangeSpec.boreOutline, flangeSpec.margin, solution.topCapEnabled);
  if (label) {
    const labelCutter = await buildLabelCutterSolid(label);
    if (labelCutter) assembled = assembled.cut(labelCutter);
  }

  // Issue #241: the rim cable slot (mirrors manifold.ts's `buildTopCap`, from the same `Design.rimSlots.cap`).
  const slot = design.rimSlots.cap;
  if (slot) {
    const loop: [number, number][] = slot.outline.map((p) => [p.x, p.y]);
    assembled = checkedCut(getOCSync(), assembled, loopSolid(loop, CAP_THICKNESS + 2 * WELD_OVERLAP).translate([0, 0, -WELD_OVERLAP]));
  }

  return assembled.translate([0, 0, solution.height]);
}

// --- Clip mount plate (issue #14) -- mirrors manifold.ts's own "Clip mount
// plate" section primitive-for-primitive, replicad in place of manifold-3d.
// See that file's header for the shared canonical-local-frame convention
// (local +X = "up", local +Y = "side", local -Z = "reach") every clip/anchor
// is built in before being rotated (`ClipInstance.rotationDeg`/
// `AnchorPoint.rotationDeg`) and translated to its own true position. ------

/** A closed 2D polygon, in the XY plane at z=0, extruded along +Z by `height` -- the replicad equivalent of manifold.ts's `CrossSection` extrude, built via `makePolygon` (mirrors `labelLoopSolid`'s own reasoning: a single call, not a chained chained `draw().lineTo()` pen, avoids replicad's FinalizationRegistry GC hazard on a long point run). */
function loopSolid(loop: [number, number][], height: number): R.Shape3D {
  const face = R.makePolygon(loop.map(([x, y]): [number, number, number] => [x, y, 0]));
  const sketch = new R.Sketch(face.outerWire(), { defaultOrigin: [0, 0, 0], defaultDirection: [0, 0, 1] });
  return sketch.extrude(height);
}

/** The openGrid placeholder connector (mirrors manifold.ts's `openGridConnectorSolid` -- see constants.ts's TODO). Embedded into the panel by MOUNT_PLATE_EMBED. */
function openGridConnectorSolidStep(): R.Shape3D {
  const s = OPENGRID_PLACEHOLDER_PEG_SIZE;
  return R.makeBox([-s / 2, -s / 2, -OPENGRID_PLACEHOLDER_PEG_REACH], [s / 2, s / 2, MOUNT_PLATE_EMBED]);
}

/** One placeholder connector, placed at its own true (x, y) and rotated onto the layout's up/side axes (mirrors manifold.ts's `mountPlateClipSolid`). */
function mountPlateClipSolidStep(clip: ClipInstance, zBase: number): R.Shape3D {
  return openGridConnectorSolidStep().rotate(clip.rotationDeg, [0, 0, 0], [0, 0, 1]).translate([clip.x, clip.y, zBase]);
}

/** One SKÅDIS rim clip (issue #207): the profile as a face in the clip's own plane, extruded along the layout's side axis -- mirrors manifold.ts's `buildSkadisClip`. */
function skadisClipSolid(layout: SkadisClipLayout, clip: RimClip): R.Shape3D {
  const frame = clipFrame(layout.axisDeg, clip.side);
  const w = SKADIS_CLIP_WIDTH / 2;
  const face = R.makePolygon(clip.profile.map(([u, z]): [number, number, number] => {
    const p = frame.at(u, z, -w);
    return [p.x, p.y, p.z];
  }));
  const sketch = new R.Sketch(face.outerWire(), { defaultOrigin: [0, 0, 0], defaultDirection: [frame.side.x, frame.side.y, 0] });
  return sketch.extrude(2 * w);
}

/** One peg hole cutter (mirrors manifold.ts's `pinHoleCutter`): the peg's own octagon (`pegHoleOutline`), not a cylinder (issue #143). `dir` +1 cuts into the flange from its outer face, -1 into the plate from its front face. */
function pinHoleCutterSolid(anchor: AnchorPoint, tolerance: number, zFace: number, dir: 1 | -1): R.Shape3D {
  const loop: [number, number][] = pegHoleOutline(anchor, tolerance).map((p) => [p.x, p.y]);
  const h = MOUNT_PLATE_PEG_HOLE_DEPTH + MOUNT_PLATE_EMBED;
  const z0 = dir === 1 ? zFace - MOUNT_PLATE_EMBED : zFace + MOUNT_PLATE_EMBED - h;
  return loopSolid(loop, h).translate([0, 0, z0]);
}

/** Build the mount plate solid (issue #14): a flat panel (`layout.outline`, `outlineSolid` -- no bore, unlike the core/flange) with every clip fused onto its back face and a pin hole cut into its front face per anchor, in the shared ASSEMBLY frame -- mirrors manifold.ts's own `buildMountPlate`. */
function buildMountPlateSolid(design: Design): R.Shape3D {
  const { flangeSpec, spec } = design;
  const layout = mountPlateLayoutFor(design);
  const backZ = -flangeSpec.thickness - MOUNT_PLATE_THICKNESS;
  const frontZ = -flangeSpec.thickness;

  let plate = outlineSolid(layout.outline, MOUNT_PLATE_THICKNESS, backZ);
  for (const clip of layout.clips) plate = plate.fuse(mountPlateClipSolidStep(clip, backZ));
  for (const anchor of layout.anchors) plate = plate.cut(pinHoleCutterSolid(anchor, spec.tolerance, frontZ, -1));
  return plate;
}

/** A ruled loft through closed polygons (each a list of 3D points, all with the same count): the STEP twin of a convex hull through the same levels. */
function ruledLoft(levels: Array<Array<[number, number, number]>>): R.Shape3D {
  const sketches = levels.map((pts) => new R.Sketch(R.makePolygon(pts).outerWire()));
  const [first, ...rest] = sketches;
  return first.loftWith(rest, { ruled: true });
}

/** One SKÅDIS T-clip (issues #213, #221): its convex pieces, each lofted through its four levels across the clip, fused -- mirrors manifold.ts's `buildSkadisTclip`. */
function skadisTclipSolid(layout: SkadisTclipLayout, clip: Tclip): R.Shape3D {
  const [first, ...rest] = clip.pieces.map((piece) => ruledLoft(tclipPieceLevels(layout.axisDeg, clip, piece).map((level) => level.map((p): [number, number, number] => [p.x, p.y, p.z]))));
  return rest.reduce((acc, r) => acc.fuse(r), first);
}
