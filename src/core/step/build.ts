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
  SKADIS_CLIP_HEIGHT,
  SKADIS_CLIP_PROFILE,
  SNAP_BARB,
  SNAP_BARB_HEIGHT,
  SNAP_GAP,
  SNAP_HOOK_COUNT,
  SNAP_RIDGE_THICKNESS,
  SNAP_SLOT_WIDTH,
  WELD_OVERLAP,
  INNER_CHANNEL_WALL_GUARD,
} from "../constants";
import { jointGeometry } from "../joints";
import { classifyLabelLoops, getLabelFont, labelLoops, resolveLabel } from "../label";
import type { LabelLoop, ResolvedLabel } from "../label";
import { layoutInnerEnd, resolveChannelDepth } from "../innerEnd";
import type { InnerEndLayout, SweepSolid } from "../innerEnd";
import { meshVolume } from "../meshVolume";
import { layoutKeyholeMount } from "../mount";
import { layoutFlangePads, layoutFlangeThroughHoles, offsetAtZ, padLevels, plateTopZ } from "../flangePads";
import type { FlangePad } from "../flangePads";
import type { KeyholeSlot, ThroughHole } from "../mount";
import { mountPlateLayoutFor as layoutFor, pegHoleOutline, pegSweep } from "../mountPlate";
import type { AnchorPoint, ClipInstance, MountPlateLayout } from "../mountPlate";
import { circumscribedRadius, offsetOutline, outlineColumnParams, polygonVertex } from "../shapes";
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
  return layoutFor(spec.mount as "skadis" | "opengrid", offsetOutline(flangeSpec.outline, flangeSpec.margin), flangeSpec.boreOutline, innerEnd);
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
 * both faces). Issue #129: no counterbore any more.
 */
function throughHoleCutterSolid(hole: ThroughHole, holeRadius: number, flangeThickness: number): R.Shape3D {
  const throughH = flangeThickness + 2;
  const throughZLo = -flangeThickness - 1;
  return R.makeCylinder(holeRadius, throughH, [hole.x, hole.y, throughZLo]);
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

export async function buildStep(design: Design): Promise<Uint8Array<ArrayBuffer>> {
  const kernel = await getOC();
  const { wallSpec, flangeSpec } = design;
  const profile = createWallProfile(wallSpec);
  const { height, columns, minCornerSegments, outline, boreOutline } = wallSpec;
  // Issue #85 PR review round 2: the SAME adaptive, corner-favoring sample
  // placement the mesh backend uses (shapes.ts's `outlineColumnParams`),
  // not a uniformly-raised NU -- a sq/tri corner arc that's a small share
  // of the perimeter would otherwise need a MUCH bigger NU than the mesh
  // ever does to reach the same per-corner segment floor, and OCCT's own
  // boolean ops (the bore cut, the flange fuse) scale with NU badly enough
  // that this blew well past a 2x build-time budget when tried (see
  // `bspfit.ts`'s own comment on `fitPeriodicUClampedV`). `ts.length` is
  // usually just `columns` unchanged (round always; sq/tri whenever the
  // corner floor's own share already fits the existing budget -- only a
  // shape needing MORE columns than the budget for its corners alone grows
  // NU at all, exactly like the mesh backend's own `buildWall`).
  const ts = outlineColumnParams(outline, columns, minCornerSegments);
  const NU = ts.length;

  const NV = Math.max(MIN_V_SAMPLES, Math.round(V_SAMPLES_PER_PITCH * wallSpec.turns) + 1);
  const dz = 1e-4;
  const tangent = (z0: number, z1: number) => (i: number): Vec3 => {
    const t = ts[i];
    const a = profile.point(t, z0);
    const b = profile.point(t, z1);
    return a.map((v, c) => ((b[c] - v) / (z1 - z0)) * height) as Vec3;
  };
  const fit = fitPeriodicUClampedV(ts, NV, (i, j) => profile.point(ts[i], (j * height) / (NV - 1)), tangent(0, dz), tangent(height - dz, height));

  // OCCT wants the periodic pole index shifted by NU-1 relative to the
  // textbook (C[i-1]+4C[i]+C[i+1])/6 layout (empirically determined in an
  // early prototype) -- applied to the POLES only, `uKnots` unchanged. Issue #85 PR
  // review round 2 (tried and reverted): rotating `uKnots` by the same
  // amount, reasoning a non-uniform `ts` isn't rotation-invariant the way
  // the old plain `i / NU` was, seemed plausible but was wrong -- it paired
  // each rotated pole with the WRONG knot span and threw the surface's own
  // volume off by ~5%. Empirically, OCCT's own pole/knot association for a
  // periodic surface evidently isn't "pole i sits at knot i" (which would
  // need the rotation); leaving `uKnots` exactly as `fitPeriodicUClampedV`
  // returns it -- unrotated, in `ts`'s own natural order -- and shifting
  // ONLY the poles (exactly as the original, round-only code already did)
  // is what's actually correct, uniform or not.
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

  // Issues #8, #117: the bottom flange's own recessed channel + cable clip,
  // mirroring manifold.ts's `buildInnerEndCutter` (same `layoutInnerEnd`
  // call, same `resolveChannelDepth`, lofted through the SAME rings), so the
  // mesh and STEP backends can never drift on where the channel/clip sit.
  // Kept (not just consumed for its own cutter): issue #70's through-hole
  // mount checks the SAME real, computed channel footprint, never a
  // re-derivation. Cut from the flange BEFORE it's fused to the wall: the
  // cutter is already clipped clear of the wall (so the result is the same
  // as the mesh backend's cut of the fused core), and OCCT then never has to
  // test the channel's many faces against the wall's big B-spline surface --
  // cutting the fused core instead made the whole export several times slower.
  const innerEndCutter = buildInnerEndCutterSolid(
    flangeSpec.outline,
    flangeSpec.margin,
    flangeSpec.thickness,
    resolveChannelDepth(design.spec.wire.diameter, flangeSpec.thickness),
    design.spec.wire.diameter,
    design.spec.tolerance,
    bendMultiplierOf(design.spec.wire) * design.spec.wire.diameter,
  );
  // Issue #122: thinned to its plate away from the pads (manifold.ts's
  // `relieveFlange`, from the same flangePads.ts layout and rings).
  const anchors = design.parts.some((p) => p.role === "mountPlate") ? mountPlateLayoutFor(design).anchors : [];
  const relieved = relieveFlangeSolid(kernel, flange, flangeSpec, innerEndCutter.layout, anchors, design.spec.tolerance);
  let coreSolid = tube.fuse(checkedCut(kernel, relieved, innerEndCutter.cutter));

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
    const layout = layoutKeyholeMount(flangeSpec.outline, flangeSpec.boreOutline, flangeSpec.margin, flangeSpec.keyholeRotation);
    for (const slot of layout.slots) {
      const cutter = screwMountCutterSolid(slot, -flangeSpec.thickness);
      coreSolid = coreSolid.cut(cutter);
    }
  }

  // Issue #70: cut the same through-hole mount the mesh backend cuts into
  // the CORE part's own bottom flange (manifold.ts's fuseFlange), from the
  // identical layout (flangePads.ts's `layoutFlangeThroughHoles`), kept clear
  // of the SAME inner-end channel and pads just built above, so STEP and
  // STL/preview never drift apart.
  if (design.flangeSpec.mount === "through") {
    const layout = layoutFlangeThroughHoles(flangeSpec, innerEndCutter.layout);
    for (const hole of layout.holes) {
      const cutter = throughHoleCutterSolid(hole, layout.holeRadius, flangeSpec.thickness);
      coreSolid = coreSolid.cut(cutter);
    }
  }

  // Issue #14/#106: cut the same peg holes the mesh
  // backend cuts into the flange's outer face (manifold.ts's `fuseFlange`'s
  // `mountPlateCut`), from the identical layout (mountPlate.ts), so STEP and
  // STL/preview never drift apart. Only when the plate itself actually got
  // built (there's a `mountPlate` part) -- an empty layout means the plate
  // was skipped, and there's nothing on the flange to cut for.
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

  // Issue #14: the clip mount plate, mirroring manifold.ts's own
  // `buildMountPlate` primitive-for-primitive (a flat panel plus clips on
  // its back face and pin holes in its front), sharing the SAME dimensions
  // via constants.ts and the SAME layout via mountPlateLayoutFor.
  const mountPlatePart = design.parts.find((p) => p.role === "mountPlate");
  if (mountPlatePart) {
    const plateSolid = buildMountPlateSolid(design);
    validateSolid(kernel, plateSolid, mountPlatePart.mesh, mountPlatePart.name);
    shapes.push({ shape: plateSolid, name: mountPlatePart.name });
  }

  // Issue #132: the alignment pegs, one per anchor (design.ts names them in
  // anchor order), from the same `pegSweep` rings the mesh is built from.
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
 * on) -- so a cut that removes no volume counts as a failure too.
 */
function checkedCut(kernel: OpenCascadeInstance, shape: R.Shape3D, tool: R.Shape3D | R.Shape3D[]): R.Shape3D {
  const before = R.measureVolume(shape);
  for (const fuzzy of FUZZY_CUTS) {
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
      if (op.HasErrors()) continue;
      const result = R.cast(op.Shape()) as R.Shape3D;
      if (R.measureVolume(result) < before - 1e-6) return result;
    } finally {
      op.delete();
      args.delete();
      tools.delete();
    }
  }
  throw new Error("STEP export: a boolean cut failed (it removed nothing)");
}

/**
 * `shape` fused with every one of `tool`, the same way as `checkedCut` (issue #121): the
 * cap's swept clip blocks fused plainly into the plate gave a solid OCCT's
 * own checker rejects, so each fuzzy value is tried in turn until the result
 * checks valid.
 */
function checkedFuse(kernel: OpenCascadeInstance, shape: R.Shape3D, tool: R.Shape3D[]): R.Shape3D {
  for (const fuzzy of FUZZY_CUTS) {
    const args = new kernel.NCollection_List_TopoDS_Shape();
    args.Append(shape.wrapped);
    const tools = new kernel.NCollection_List_TopoDS_Shape();
    for (const t of tool) tools.Append(t.wrapped);
    const op = new kernel.BRepAlgoAPI_Fuse();
    try {
      op.SetArguments(args);
      op.SetTools(tools);
      op.SetFuzzyValue(fuzzy);
      op.Build(new kernel.Message_ProgressRange());
      if (op.HasErrors()) continue;
      const result = R.cast(op.Shape()) as R.Shape3D;
      const analyzer = new kernel.BRepCheck_Analyzer(result.wrapped, true, false, false);
      const valid = analyzer.IsValid();
      analyzer.delete();
      if (valid) return result;
    } finally {
      op.delete();
      args.delete();
      tools.delete();
    }
  }
  throw new Error("STEP export: a boolean fuse failed (no valid result)");
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
        `(${(volumeError * 100).toFixed(2)}% off, tolerance ${(VOLUME_TOLERANCE * 100).toFixed(1)}%)`,
    );
  }
}

/**
 * The collar's welded base, shared by all three joints (mirrors manifold.ts's
 * `collarBase`): a straight prism at `collarOutline`'s own footprint, flaring
 * out to `weldOutline`'s footprint over the top `JOINT_TRANSITION_HEIGHT` so
 * it genuinely overlaps the plate's own bore edge AT EVERY ANGLE -- flats and
 * corners alike -- instead of merely touching it near each flat side's own
 * midpoint (issue #55: a `collarRadius < boreRadius` PLAIN CIRCLE collar
 * centered in a non-round plate's hole left the corners of that hole
 * untouched, so `.fuse()` reported a `Compound` of 2 solids there, not a
 * proper single-solid weld -- `weldOutline` is `boreOutline` itself offset
 * out by `WELD_OVERLAP`, joints.ts, so it coincides with -- and overlaps --
 * the plate's hole edge everywhere, for any shape).
 */
function collarBaseSolid(collarOutline: ShapeOutline, weldOutline: ShapeOutline): R.Shape3D {
  const straightHeight = JOINT_ENGAGE_DEPTH - JOINT_TRANSITION_HEIGHT;
  const straight = outlineSolid(collarOutline, straightHeight, -JOINT_ENGAGE_DEPTH);
  const transition = outlineLoftSolid(collarOutline, weldOutline, -JOINT_TRANSITION_HEIGHT, 0);
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

/**
 * One of innerEnd.ts's swept solids (the channel/clip cutter and the cap
 * clip's block and bore) as a polyhedral solid: exactly the triangles
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
  const slab = outlineSolid(offsetOutline(flangeSpec.outline, flangeSpec.margin + 1), 1 - zPlate, zPlate);
  return checkedCut(kernel, flange, checkedCut(kernel, slab, padSolid));
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

/** Build the top cap solid (plate + engagement collar for the chosen joint + cable clip + engraved label), directly in the shared assembly frame -- see design.ts's own `buildTopCap` call and manifold.ts's mesh-backend twin. */
async function buildTopCapSolid(design: Design): Promise<R.Shape3D> {
  const { flangeSpec, spec, solution } = design;
  const outerOutline = offsetOutline(flangeSpec.outline, flangeSpec.margin);
  // Issue #127: the plate's middle is opened by the through-hole below (mirrors manifold.ts).
  const plate = outlineSolid(outerOutline, CAP_THICKNESS, 0);

  const { boreRadius, collarRadius, collarOutline, weldOutline, holeOutline } = jointGeometry(flangeSpec.boreOutline, spec.joint, spec.tolerance);
  const canCutJoint = boreRadius >= JOINT_MIN_BORE_RADIUS && solution.height >= JOINT_ENGAGE_DEPTH + 2;

  let collar: R.Shape3D;
  if (spec.joint === "press" || !canCutJoint) {
    collar = collarBaseSolid(collarOutline, weldOutline);
  } else if (spec.joint === "bayonet") {
    const base = collarBaseSolid(collarOutline, weldOutline);
    const grooveZLo = -BAYONET_LEAD - BAYONET_GROOVE_HEIGHT;
    const grooveZHi = -BAYONET_LEAD;
    const lugs = unionAtAngles((a) => radialBoxSolid(collarRadius - 1, collarRadius + BAYONET_LUG_HEIGHT, BAYONET_LUG_WIDTH, grooveZLo, grooveZHi, a), BAYONET_LUG_COUNT);
    collar = base.fuse(lugs);
  } else {
    const base = collarBaseSolid(collarOutline, weldOutline);
    const barbR = collarRadius + SNAP_BARB;
    const barb = R.makeCylinder(barbR, SNAP_BARB_HEIGHT, [0, 0, -JOINT_ENGAGE_DEPTH]);
    const withBarb = base.fuse(barb);
    // The slot's radial reach clears the transition's own widened top
    // (collarBaseSolid flares out to `weldOutline`, issue #55) at EVERY
    // angle, not just the flat sides -- `circumscribedRadius` is the
    // outline's own farthest point, so this stays correct for round/sq/tri.
    const slotOuterR = Math.max(barbR + 0.5, circumscribedRadius(weldOutline, 0) + 0.5);
    const slots = unionAtAngles((a) => radialBoxSolid(0, slotOuterR, SNAP_SLOT_WIDTH, -JOINT_ENGAGE_DEPTH - 0.5, 0.5, a), SNAP_HOOK_COUNT);
    collar = withBarb.cut(slots);
  }

  let assembled = plate.fuse(collar);
  // Issue #127: the straight through-hole down the middle (the collar is a tube).
  if (holeOutline) assembled = assembled.cut(outlineSolid(holeOutline, CAP_THICKNESS + JOINT_ENGAGE_DEPTH + 2, -JOINT_ENGAGE_DEPTH - 1));

  // Mirrors design.ts's own call: the SAME `resolveLabel` the mesh backend
  // uses, against the SAME outline/boreOutline/margin, so the two backends
  // can never fit the label text differently. Cut before the clips (issue
  // #121): a plain cut after their fuzzy fuses gave an invalid solid.
  const { label } = await resolveLabel(spec.label, flangeSpec.outline, flangeSpec.boreOutline, flangeSpec.margin, solution.topCapEnabled);
  if (label) {
    const labelCutter = await buildLabelCutterSolid(label);
    if (labelCutter) assembled = assembled.cut(labelCutter);
  }

  // Issue #117/#121: the cable clips under the cap (mirrors manifold.ts's
  // `buildTopCap`, built from the same `Design.capClip` rings). Their bores
  // are cut from the plate and from each block separately, then everything
  // fused in one (fuzzy, `checkedFuse`) boolean: cutting a bore from the
  // already-fused plate + block made OCCT remove the bore's WHOLE volume
  // (about 100 mm^3 too much per clip for a 3.8 mm cable), even where it runs
  // outside the part, and a plain fuse gave a solid OCCT's checker rejects.
  const clips = design.capClip?.clips ?? [];
  if (clips.length > 0) {
    const kernel = getOCSync();
    const bores = clips.map((clip) => sweepSolidStep(clip.bore));
    const blocks = clips.map((clip, i) => {
      const block = sweepSolidStep(clip.block);
      const cut = checkedCut(kernel, block, bores[i]);
      block.delete();
      return cut;
    });
    const plateCut = checkedCut(kernel, assembled, bores);
    const next = checkedFuse(kernel, plateCut, blocks);
    // Freed right away: several clips' worth of many-faceted solids would
    // otherwise pile up in OCCT's WASM heap until GC.
    for (const shape of [...bores, ...blocks, plateCut, assembled]) shape.delete();
    assembled = next;
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

/** One SKÅDIS clip PAIR -- mirrors manifold.ts's `skadisHookSolid` (see its own doc comment for the rotations and the root-only MOUNT_PLATE_EMBED). */
function skadisHookSolidStep(): R.Shape3D {
  const leg: [number, number][] = SKADIS_CLIP_PROFILE.map(([s, r]): [number, number] => [s, r === 0 ? -MOUNT_PLATE_EMBED : r]);
  const leftLoop: [number, number][] = leg.map(([s, r]): [number, number] => [-s, r]).reverse();
  const solid = loopSolid(leg, SKADIS_CLIP_HEIGHT).fuse(loopSolid(leftLoop, SKADIS_CLIP_HEIGHT));
  return solid
    .translate([0, 0, -SKADIS_CLIP_HEIGHT / 2])
    .rotate(-90, [0, 0, 0], [1, 0, 0])
    .rotate(-90, [0, 0, 0], [0, 0, 1]);
}

/** The openGrid placeholder connector (mirrors manifold.ts's `openGridConnectorSolid` -- see constants.ts's TODO). Embedded into the panel by MOUNT_PLATE_EMBED. */
function openGridConnectorSolidStep(): R.Shape3D {
  const s = OPENGRID_PLACEHOLDER_PEG_SIZE;
  return R.makeBox([-s / 2, -s / 2, -OPENGRID_PLACEHOLDER_PEG_REACH], [s / 2, s / 2, MOUNT_PLATE_EMBED]);
}

/** One clip instance, placed at its own true (x, y) and rotated onto the layout's up/side axes (mirrors manifold.ts's `mountPlateClipSolid`). */
function mountPlateClipSolidStep(mountKind: "skadis" | "opengrid", clip: ClipInstance, zBase: number): R.Shape3D {
  const canonical = mountKind === "skadis" ? skadisHookSolidStep() : openGridConnectorSolidStep();
  return canonical.rotate(clip.rotationDeg, [0, 0, 0], [0, 0, 1]).translate([clip.x, clip.y, zBase]);
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
  const mountKind = spec.mount as "skadis" | "opengrid";
  const layout = mountPlateLayoutFor(design);
  const backZ = -flangeSpec.thickness - MOUNT_PLATE_THICKNESS;
  const frontZ = -flangeSpec.thickness;

  let plate = outlineSolid(layout.outline, MOUNT_PLATE_THICKNESS, backZ);
  for (const clip of layout.clips) plate = plate.fuse(mountPlateClipSolidStep(mountKind, clip, backZ));
  for (const anchor of layout.anchors) plate = plate.cut(pinHoleCutterSolid(anchor, spec.tolerance, frontZ, -1));
  return plate;
}
