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
  DEFAULT_THROUGH_HOLE_DIAMETER,
  JOINT_ENGAGE_DEPTH,
  JOINT_MIN_BORE_RADIUS,
  JOINT_TRANSITION_HEIGHT,
  KEYHOLE_SLIT_FRACTION,
  LABEL_DEPTH,
  MOUNT_PLATE_EMBED,
  MOUNT_PLATE_PEG_HEIGHT,
  MOUNT_PLATE_PEG_HOLE_CLEARANCE,
  MOUNT_PLATE_PEG_HOLE_DEPTH,
  MOUNT_PLATE_PEG_RADIUS,
  MOUNT_PLATE_SNAP_BARB,
  MOUNT_PLATE_SNAP_GAP,
  MOUNT_PLATE_SNAP_POCKET_DEPTH,
  MOUNT_PLATE_SNAP_RIDGE_BAND,
  MOUNT_PLATE_SNAP_TAB_REACH,
  MOUNT_PLATE_SNAP_TAB_THICKNESS,
  MOUNT_PLATE_SNAP_TAB_WIDTH,
  MOUNT_PLATE_THICKNESS,
  OPENGRID_PITCH,
  OPENGRID_PLACEHOLDER_PEG_REACH,
  OPENGRID_PLACEHOLDER_PEG_SIZE,
  SCREW_MOUNT_HEAD_RADIUS,
  SCREW_MOUNT_SLOT_DEPTH,
  SCREW_MOUNT_SLOT_RADIUS,
  SCREW_MOUNT_UNDERCUT_DEPTH,
  SKADIS_CLIP_HEIGHT,
  SKADIS_CLIP_PROFILE,
  SKADIS_CLIP_PROFILE_CHAMFERED,
  SKADIS_PITCH,
  SKADIS_ROW_STAGGER,
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
import { layoutInnerEnd, resolveChannelDepth } from "../innerEnd";
import type { InnerEndLayout, XY } from "../innerEnd";
import { meshVolume } from "../meshVolume";
import { layoutKeyholeMount, layoutThroughHoleMount } from "../mount";
import type { KeyholeSlot, ThroughHole } from "../mount";
import { layoutMountPlate, openGridClipHalfExtents, skadisClipHalfExtents } from "../mountPlate";
import type { AnchorPoint, ClipInstance, MountPlateLayout } from "../mountPlate";
import { circumscribedRadius, offsetOutline, pointAt, polygonVertex } from "../shapes";
import type { ShapeOutline } from "../shapes";
import type { CoreJointCut } from "../manifold";
import type { Design, PlateJoint } from "../types";
import { bendMultiplierOf } from "../types";

/** Recompute mountPlate.ts's layout from `design.flangeSpec`/`design.spec` (mirrors this file's own `layoutKeyholeMount(flangeSpec.outline, flangeSpec.boreOutline, flangeSpec.margin)` re-derivation for the keyhole mount): the STEP backend never stores its own copy, so it can't drift from the mesh backend's. */
function mountPlateLayoutFor(design: Design): MountPlateLayout {
  const { flangeSpec, spec } = design;
  const mountKind = spec.mount as "skadis" | "opengrid";
  const pitch = mountKind === "skadis" ? SKADIS_PITCH : OPENGRID_PITCH;
  const { halfSide, halfUp } = mountKind === "skadis" ? skadisClipHalfExtents() : openGridClipHalfExtents();
  const columnStagger = mountKind === "skadis" ? SKADIS_ROW_STAGGER : 0;
  const flangeOutline = offsetOutline(flangeSpec.outline, flangeSpec.margin);
  return layoutMountPlate(flangeOutline, flangeSpec.boreOutline, pitch, halfSide, halfUp, columnStagger);
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
  const sketchAt = (o: ShapeOutline, z: number): R.Sketch => {
    if (o.n === 4 && o.cornerRadius === o.apothem) {
      return R.sketchCircle(o.apothem, { plane: "XY", origin: [0, 0, z] });
    }
    let pen = R.draw(polygonVertex(o, 0));
    for (let i = 1; i < o.n; i++) {
      pen = pen.lineTo(polygonVertex(o, i)).customCorner(o.cornerRadius);
    }
    const drawing = pen.closeWithCustomCorner(o.cornerRadius);
    return drawing.sketchOnPlane("XY", z) as R.Sketch;
  };
  return sketchAt(bottomOutline, zBottom).loftWith(sketchAt(topOutline, zTop));
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
 * clearance) fused with a wider, shallower cylinder (the counterbore, screw-
 * head clearance) blind from the flange's outer face -- mirrors manifold.ts's
 * `throughHoleCutter` primitive-for-primitive, and `buildInnerEndCutterSolid`'s
 * own through-cut convention (poking 1mm past both faces).
 */
function throughHoleCutterSolid(hole: ThroughHole, holeRadius: number, counterboreRadius: number, counterboreDepth: number, flangeThickness: number): R.Shape3D {
  const throughH = flangeThickness + 2;
  const throughZLo = -flangeThickness - 1;
  const shank = R.makeCylinder(holeRadius, throughH, [hole.x, hole.y, throughZLo]);
  const counterbore = R.makeCylinder(counterboreRadius, counterboreDepth + 1, [hole.x, hole.y, throughZLo]);
  return shank.fuse(counterbore);
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

  // Issue #8: the bottom flange's own rim keyhole + recessed inner channel,
  // mirroring manifold.ts's `buildInnerEndCutter` primitive-for-primitive
  // (same `layoutInnerEnd` call, same `resolveChannelDepth`), so the mesh and
  // STEP backends can never drift on where the keyhole/channel actually sit.
  // Kept (not just consumed for its own cutter): issue #70's through-hole
  // mount checks the SAME real, computed channel footprint, never a
  // re-derivation.
  const innerEndCutter = buildInnerEndCutterSolid(
    flangeSpec.outline,
    flangeSpec.margin,
    flangeSpec.thickness,
    resolveChannelDepth(design.spec.wire.diameter, flangeSpec.thickness, flangeSpec.mount),
    design.spec.wire.diameter,
    design.spec.tolerance,
    bendMultiplierOf(design.spec.wire) * design.spec.wire.diameter,
  );
  coreSolid = coreSolid.cut(innerEndCutter.cutter);

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
  // identical layout (mount.ts) and the SAME inner-end channel footprint
  // just cut above, so STEP and STL/preview never drift apart.
  if (design.flangeSpec.mount === "through") {
    const layout = layoutThroughHoleMount(
      flangeSpec.outline,
      flangeSpec.boreOutline,
      flangeSpec.margin,
      flangeSpec.throughHoleDiameter ?? DEFAULT_THROUGH_HOLE_DIAMETER,
      innerEndCutter.layout,
    );
    for (const hole of layout.holes) {
      const cutter = throughHoleCutterSolid(hole, layout.holeRadius, layout.counterboreRadius, layout.counterboreDepth, flangeSpec.thickness);
      coreSolid = coreSolid.cut(cutter);
    }
  }

  // Issue #14: cut the same alignment-peg holes/snap-tab pockets the mesh
  // backend cuts into the flange's outer face (manifold.ts's `fuseFlange`'s
  // `mountPlateCut`), from the identical layout (mountPlate.ts), so STEP and
  // STL/preview never drift apart. Only when the plate itself actually got
  // built (there's a `mountPlate` part) -- an empty layout means the plate
  // was skipped, and there's nothing on the flange to cut for.
  if (design.parts.some((p) => p.role === "mountPlate")) {
    const layout = mountPlateLayoutFor(design);
    for (const anchor of layout.anchors) {
      const cutter = mountPlateAnchorCutterSolid(design.spec.plateJoint, design.spec.tolerance).rotate(anchor.rotationDeg, [0, 0, 0], [0, 0, 1]).translate([anchor.x, anchor.y, -flangeSpec.thickness]);
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
  // its back face and pegs/tabs on its front), sharing the SAME dimensions
  // via constants.ts and the SAME layout via mountPlateLayoutFor.
  const mountPlatePart = design.parts.find((p) => p.role === "mountPlate");
  if (mountPlatePart) {
    const plateSolid = buildMountPlateSolid(design);
    validateSolid(kernel, plateSolid, mountPlatePart.mesh, mountPlatePart.name);
    shapes.push({ shape: plateSolid, name: mountPlatePart.name });
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
 * The channel trench cutter solid: `innerEnd.ts`'s `channelRibbon` (a single
 * flat 2D polygon tracing the whole trench outline, computed ANALYTICALLY --
 * see its own doc comment for why), extruded ONCE -- mirrors manifold.ts's
 * `channelCutter`. An earlier version built this from a chain of
 * cylinders+boxes `fuse()`d one at a time (the standard "stroke a polyline"
 * technique); that sequential-fuse chain was found to occasionally produce
 * an invalid BRep (`BRepCheck_Analyzer` false) here even though the
 * equivalent manifold-3d boolean chain stayed valid, so both backends now
 * extrude one shared polygon instead (also guaranteeing they extrude the
 * exact same shape). Mirrors `labelLoopSolid`'s own `makePolygon` + `Sketch`
 * + `extrude` pattern. Returns `undefined` for a degenerate (near-zero-area)
 * ribbon -- see `channelRibbon`'s own doc comment.
 */
function channelCutterSolid(ribbon: XY[], zLo: number, zHi: number): R.Shape3D | undefined {
  if (ribbon.length < 3) return undefined;
  const face = R.makePolygon(ribbon.map(({ x, y }): [number, number, number] => [x, y, zLo]));
  const sketch = new R.Sketch(face.outerWire(), { defaultOrigin: [0, 0, zLo], defaultDirection: [0, 0, 1] });
  return sketch.extrude(zHi - zLo);
}

/**
 * The bottom flange's own inner-end fixing (issue #8): the rim keyhole (same
 * hole+narrower-retaining-slit shape as `buildKeyholeSolid`'s top-cap
 * keyhole, but cut all the way THROUGH the flange's full thickness) unioned
 * with the recessed channel trench (clipped to stay outside the wall's own
 * outline via `outlineSolid` -- see manifold.ts's `outlineBlocker` for why:
 * the channel's own width can exceed WALL_THICKNESS for a heavy cord, and
 * without this clip it reaches past the wall into the bore's own void,
 * adding a genus the part shouldn't have), mirroring manifold.ts's
 * `buildInnerEndCutter` primitive-for-primitive from the SAME `layoutInnerEnd`
 * call, so the two backends can never disagree on where the keyhole/channel
 * actually sit.
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
  const layout: InnerEndLayout = layoutInnerEnd(outline, margin, wireDiameter, tolerance, bendRadius);
  const { hole, edge, holeRadius, slitWidth, channelRibbon } = layout;

  const throughH = flangeThickness + 2;
  const throughZLo = -flangeThickness - 1;
  const holeSolid = R.makeCylinder(holeRadius, throughH, [hole.x, hole.y, throughZLo]);
  const dx = edge.x - hole.x;
  const dy = edge.y - hole.y;
  const len = Math.hypot(dx, dy);
  let keyhole = holeSolid;
  if (len > 1e-6) {
    const slitLen = len + 1;
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const slit = R.makeBox([0, -slitWidth / 2, throughZLo], [slitLen, slitWidth / 2, throughZLo + throughH])
      .rotate(angleDeg, [0, 0, 0], [0, 0, 1])
      .translate([hole.x, hole.y, 0]);
    keyhole = holeSolid.fuse(slit);
  }

  const rawChannel = channelCutterSolid(channelRibbon, -channelDepth, 1);
  if (!rawChannel) return { cutter: keyhole, layout };
  // Offset outward by WELD_OVERLAP: the ribbon's own closing edge at the
  // groove end sits EXACTLY on the wall's true outline by construction (see
  // innerEnd.ts), so clipping against that same outline unmodified is
  // another razor-thin, exactly-coincident seam -- the same boolean
  // robustness landmine this codebase already works around elsewhere (see
  // manifold.ts's own `collarBase`/WELD_OVERLAP comments). A genuine
  // volumetric overlap cuts a hair more than strictly necessary, but stays
  // well inside the STEP/mesh volume-match tolerance.
  const blocker = outlineSolid(offsetOutline(outline, WELD_OVERLAP), channelDepth + 3, -channelDepth - 1);
  const channel = rawChannel.cut(blocker);
  return { cutter: keyhole.fuse(channel), layout };
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

  const { boreRadius, collarRadius, collarOutline, weldOutline } = jointGeometry(flangeSpec.boreOutline, spec.joint, spec.tolerance);
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

/**
 * One SKÅDIS clip PAIR (mirrors manifold.ts's `skadisHookSolid` -- see its
 * own doc comment for the full derivation): the profile's own (side, reach)
 * loop extruded along local Z by `SKADIS_CLIP_HEIGHT`, then rotated -90
 * degrees about local X (extrusion axis -> local Y, reach -> local -Z) and a
 * further -90 degrees about local Z (swaps this construction's own (side,
 * height) axes into the shared canonical frame, local +X = "up" -- relies on
 * the pair's own side=0 mirror symmetry to make the resulting sign flip on
 * `side` harmless). Getting this second rotation right (issue #14 PR review
 * round 2) is what keeps `SKADIS_CLIP_HEIGHT` running along WALL_UP instead
 * of rendering horizontally.
 */
function skadisHookSolidStep(chamfered: boolean): R.Shape3D {
  const profile = chamfered ? SKADIS_CLIP_PROFILE_CHAMFERED : SKADIS_CLIP_PROFILE;
  const rightLoop: [number, number][] = profile.map(([s, r]) => [s, r]);
  const leftLoop: [number, number][] = profile.map(([s, r]): [number, number] => [-s, r]).reverse();
  const solid = loopSolid(rightLoop, SKADIS_CLIP_HEIGHT).fuse(loopSolid(leftLoop, SKADIS_CLIP_HEIGHT));
  // Embedded MOUNT_PLATE_EMBED into the panel -- mirrors manifold.ts's
  // `skadisHookSolid` (same razor-thin-coincident-face hazard this
  // constant guards against, for a boolean fuse instead of a cut).
  return solid
    .translate([0, 0, -SKADIS_CLIP_HEIGHT / 2])
    .rotate(-90, [0, 0, 0], [1, 0, 0])
    .rotate(-90, [0, 0, 0], [0, 0, 1])
    .translate([0, 0, MOUNT_PLATE_EMBED]);
}

/** The openGrid placeholder connector (mirrors manifold.ts's `openGridConnectorSolid` -- see constants.ts's TODO). Embedded into the panel by MOUNT_PLATE_EMBED. */
function openGridConnectorSolidStep(): R.Shape3D {
  const s = OPENGRID_PLACEHOLDER_PEG_SIZE;
  return R.makeBox([-s / 2, -s / 2, -OPENGRID_PLACEHOLDER_PEG_REACH], [s / 2, s / 2, MOUNT_PLATE_EMBED]);
}

/** One clip instance, placed at its own true (x, y) and rotated onto the layout's up/side axes (mirrors manifold.ts's `mountPlateClipSolid`). */
function mountPlateClipSolidStep(mountKind: "skadis" | "opengrid", clip: ClipInstance, zBase: number): R.Shape3D {
  const canonical = mountKind === "skadis" ? skadisHookSolidStep(!clip.plain) : openGridConnectorSolidStep();
  return canonical.rotate(clip.rotationDeg, [0, 0, 0], [0, 0, 1]).translate([clip.x, clip.y, zBase]);
}

/** One alignment peg (glue) or snap tab (snap), reaching from local Z=0 toward local +Z (mirrors manifold.ts's `mountPlateAnchorSolid`). */
function mountPlateAnchorSolidStep(plateJoint: PlateJoint, anchor: AnchorPoint, zBase: number): R.Shape3D {
  let canonical: R.Shape3D;
  if (plateJoint === "glue") {
    canonical = R.makeCylinder(MOUNT_PLATE_PEG_RADIUS, MOUNT_PLATE_PEG_HEIGHT + MOUNT_PLATE_EMBED, [0, 0, -MOUNT_PLATE_EMBED]);
  } else {
    const t = MOUNT_PLATE_SNAP_TAB_THICKNESS / 2;
    const w = MOUNT_PLATE_SNAP_TAB_WIDTH / 2;
    const base = R.makeBox([-t, -w, -MOUNT_PLATE_EMBED], [t, w, MOUNT_PLATE_SNAP_TAB_REACH]);
    const barbHeight = 1.2;
    const bt = t + MOUNT_PLATE_SNAP_BARB;
    const barb = R.makeBox([-bt, -w, MOUNT_PLATE_SNAP_TAB_REACH - barbHeight], [bt, w, MOUNT_PLATE_SNAP_TAB_REACH]);
    canonical = base.fuse(barb);
  }
  return canonical.rotate(anchor.rotationDeg, [0, 0, 0], [0, 0, 1]).translate([anchor.x, anchor.y, zBase]);
}

/** The flange-side cutter for one anchor (mirrors manifold.ts's `mountPlateAnchorCutter`): a shallow blind hole (glue), or a stepped blind pocket (snap) -- narrow at the mouth (clears only the finger's shaft), wide beyond it (clears the barb, retaining it once inserted). */
function mountPlateAnchorCutterSolid(plateJoint: PlateJoint, tolerance: number): R.Shape3D {
  if (plateJoint === "glue") {
    const r = MOUNT_PLATE_PEG_RADIUS + MOUNT_PLATE_PEG_HOLE_CLEARANCE + tolerance;
    // Pierces MOUNT_PLATE_EMBED past the flange's outer face -- mirrors manifold.ts's `mountPlateAnchorCutter`.
    return R.makeCylinder(r, MOUNT_PLATE_PEG_HOLE_DEPTH + MOUNT_PLATE_EMBED, [0, 0, -MOUNT_PLATE_EMBED]);
  }
  const wideT = MOUNT_PLATE_SNAP_TAB_THICKNESS / 2 + MOUNT_PLATE_SNAP_BARB + MOUNT_PLATE_SNAP_GAP;
  const narrowT = MOUNT_PLATE_SNAP_TAB_THICKNESS / 2 + MOUNT_PLATE_SNAP_GAP;
  const w = MOUNT_PLATE_SNAP_TAB_WIDTH / 2 + MOUNT_PLATE_SNAP_GAP;
  const narrow = R.makeBox([-narrowT, -w, -MOUNT_PLATE_EMBED], [narrowT, w, MOUNT_PLATE_SNAP_RIDGE_BAND]);
  // Starts MOUNT_PLATE_EMBED before the narrow band ends, so the two boxes overlap at their own shared internal seam too.
  const wideHeight = MOUNT_PLATE_SNAP_POCKET_DEPTH - MOUNT_PLATE_SNAP_RIDGE_BAND + MOUNT_PLATE_EMBED;
  const wide = R.makeBox([-wideT, -w, MOUNT_PLATE_SNAP_RIDGE_BAND - MOUNT_PLATE_EMBED], [wideT, w, MOUNT_PLATE_SNAP_RIDGE_BAND - MOUNT_PLATE_EMBED + wideHeight]);
  return narrow.fuse(wide);
}

/** Build the mount plate solid (issue #14): a flat panel (`layout.outline`, `outlineSolid` -- no bore, unlike the core/flange) with every clip fused onto its back face and every peg/tab fused onto its front face, in the shared ASSEMBLY frame -- mirrors manifold.ts's own `buildMountPlate`. */
function buildMountPlateSolid(design: Design): R.Shape3D {
  const { flangeSpec, spec } = design;
  const mountKind = spec.mount as "skadis" | "opengrid";
  const layout = mountPlateLayoutFor(design);
  const backZ = -flangeSpec.thickness - MOUNT_PLATE_THICKNESS;
  const frontZ = -flangeSpec.thickness;

  let plate = outlineSolid(layout.outline, MOUNT_PLATE_THICKNESS, backZ);
  for (const clip of layout.clips) plate = plate.fuse(mountPlateClipSolidStep(mountKind, clip, backZ));
  for (const anchor of layout.anchors) plate = plate.fuse(mountPlateAnchorSolidStep(spec.plateJoint, anchor, frontZ));
  return plate;
}
