// The coil core orchestrator: solves the spec (solve.ts) then builds the
// round, grooved wall and fuses the bottom flange (docs/research.md §4).
// The geometry itself is unchanged from the tracer bullet (#2): it still
// renders only the layer-1 groove on a single wall; layers beyond the first
// only affect the solved numbers and the flange size (the flange must clear
// every wound layer, not just the core's own wall). The top cap for
// multi-layer coils is ticket #9.
//
// `wallSpec`/`flangeSpec` are stashed on the returned Design so the STEP
// exporter (issue #11, src/core/step/build.ts) can fit its B-spline from
// the exact same parametric grid the mesh backend used -- the two backends
// must never drift apart (docs/research.md "STEP").
//
// `resolution` (issue #7) only ever changes the mesh's column/row density
// (see constants.ts); the solved numbers, warnings and wall/flange specs are
// identical between draft and final for the same spec.
//
// `wirePaths` (issue #4) is the schematic wound-cable centerline per layer,
// built from the exact same wallSpec/layerResults used above so it can never
// drift from the printed groove or the solved turns/offsets (see wire.ts).
// It doesn't depend on `resolution` beyond the wallSpec fields it reads.

import {
  CAP_THICKNESS,
  GROOVE_DEPTH_FACTOR,
  MARGIN,
  FINAL_ROWS_PER_PITCH,
  FINAL_COLUMNS,
  FINAL_MIN_CORNER_SEGMENTS_PER_90,
  DRAFT_ROWS_PER_PITCH,
  DRAFT_COLUMNS,
  DRAFT_MIN_CORNER_SEGMENTS_PER_90,
  TAPER_TURNS,
  CLEARANCE,
  WALL_THICKNESS,
} from "./constants";
import { buildMountPlate, buildTopCap, fuseFlange } from "./manifold";
import type { CoreJointCut, InnerEndCut, MountPlateFlangeCut } from "./manifold";
import { layoutInnerEnd, idealChannelDepth, resolveChannelDepth } from "./innerEnd";
import { printBBox } from "./plate";
import { layoutKeyholeMount, layoutThroughHoleMount } from "./mount";
import type { MountLayout } from "./mount";
import { mountPlateLayoutFor, skadisBoard } from "./mountPlate";
import { flangeExtentOf, overallHeightOf, resolveBoreOutline, resolveFlangeSizing } from "./flange";
import { circumscribedRadius, makeOutline, minCornerSegments, offsetOutline } from "./shapes";
import { resolveLabel } from "./label";
import { solve } from "./solve";
import { bendMultiplierOf } from "./types";
import type { CoilSpec, Design, Part, Resolution } from "./types";
import { buildWall } from "./wall";
import { buildInnerEndLeadIn, buildLayerTransitions, buildOuterEndLeadOut, buildWirePaths } from "./wire";

export async function design(spec: CoilSpec, resolution: Resolution = "final"): Promise<Design> {
  const { solution, warnings } = solve(spec);
  const columns = resolution === "draft" ? DRAFT_COLUMNS : FINAL_COLUMNS;
  const rowsPerPitch = resolution === "draft" ? DRAFT_ROWS_PER_PITCH : FINAL_ROWS_PER_PITCH;

  const outline = makeOutline(spec.shape.kind, solution.outerSize, solution.cornerRadius);

  // Issue #85 ("rounded corners look faceted"): the minimum corner-arc
  // segment count every mesh builder below redistributes `columns` toward
  // (shapes.ts's `outlineColumnParams`), scaled to THIS outline's own
  // corner sweep (sq/tri share it -- `n`, hence the sweep angle, is
  // unaffected by any inward/outward offset, so the same floor is correct
  // for the bore, the flange/cap's own offset-out outline, and the mount
  // plate's offset-in one below). Round ignores it entirely (no corner arc
  // of its own).
  const cornerSegPer90 = resolution === "draft" ? DRAFT_MIN_CORNER_SEGMENTS_PER_90 : FINAL_MIN_CORNER_SEGMENTS_PER_90;
  const cornerSegs = minCornerSegments(outline, cornerSegPer90);

  // The bore is a TRUE inward offset of the wall's own outline by the wall
  // thickness (issue #6 AC: "the triangle wall is computed from the true
  // inward offset", not `outer - 2*wall`) -- see flange.ts's
  // `resolveBoreOutline` for the floor/invariant rationale; factored out
  // there so solve.ts's search can share the exact same derivation (issue
  // #63).
  const { boreOutline, reduced: boreReduced } = resolveBoreOutline(outline);
  if (boreReduced) {
    warnings.push(`Core size ${solution.outerSize.toFixed(1)} mm is too small for a ${WALL_THICKNESS} mm wall; the bore has been reduced.`);
  }

  const wireDiameter = spec.wire.diameter;
  const grooveDepth = GROOVE_DEPTH_FACTOR * wireDiameter;
  const layer1Turns = solution.layerResults[0]?.turns ?? 0;

  const wallSpec = {
    outline,
    boreOutline,
    height: solution.height,
    wireDiameter,
    clearance: CLEARANCE,
    grooveDepth,
    marginBottom: MARGIN,
    marginTop: MARGIN,
    taperTurns: TAPER_TURNS,
    turns: layer1Turns,
    columns,
    minCornerSegments: cornerSegs,
    rowsPerPitch,
  };
  const wantsKeyhole = spec.mount === "keyhole";
  const wantsThrough = spec.mount === "through";
  // Issue #14: skadis/opengrid don't cut anything into the flange's own
  // OUTLINE (unlike keyhole) -- the separate mount plate's footprint
  // shrinks to fit whatever margin the flange already has (mountPlate.ts's
  // `layoutMountPlate` insets it) -- but its filament-pin holes still
  // need the flange to be a bit THICKER, exactly like the keyhole mount.
  const mountKindForPlate = spec.mount === "skadis" || spec.mount === "opengrid" ? spec.mount : undefined;

  // The flange must clear the outermost wound layer, not just the core's
  // own wall (docs/research.md §1 "Flange size = final outer envelope +
  // margin"), thick enough for the inner-end channel plus whatever the
  // requested mount/plate needs -- see flange.ts's `resolveFlangeSizing`
  // for the full derivation, factored out (issue #63) so solve.ts's search
  // can score candidates against these SAME real numbers instead of a
  // cruder envelope-only proxy.
  const { margin, thickness, baseMargin, channelOnlyThickness } = resolveFlangeSizing(
    outline,
    boreOutline,
    solution.flangeSize,
    wireDiameter,
    spec.mount,
    spec.keyholeRotation,
    spec.throughHoleDiameter,
  );
  if (wantsKeyhole && margin > baseMargin) {
    warnings.push(`Flange margin increased to ${margin.toFixed(1)} mm to fit the screw-keyhole mount.`);
  }
  if (wantsKeyhole && thickness > channelOnlyThickness + 1e-9) {
    warnings.push(`Flange thickness increased to ${thickness.toFixed(1)} mm to fit the recessed screw-keyhole mount.`);
  }
  if (wantsThrough && margin > baseMargin) {
    warnings.push(`Flange margin increased to ${margin.toFixed(1)} mm to fit the through-hole mount.`);
  }
  if (wantsThrough && thickness > channelOnlyThickness + 1e-9) {
    warnings.push(`Flange thickness increased to ${thickness.toFixed(1)} mm to fit the counterbored through-hole mount.`);
  }
  if (mountKindForPlate && thickness > channelOnlyThickness + 1e-9) {
    warnings.push(`Flange thickness increased to ${thickness.toFixed(1)} mm to fit the mount plate's alignment features.`);
  }

  // `resolveChannelDepth` caps the channel to whatever `thickness` leaves
  // below a small shelf (and below the mount's own recess/counterbore on
  // the OTHER face too, when one is present) -- with `thickness` now
  // ALWAYS provisioned for the full ideal depth (see above), this never
  // actually caps it in the ordinary case; the warning below is now only
  // reachable for a genuinely exotic input this sizing doesn't anticipate.
  const idealDepth = idealChannelDepth(wireDiameter);
  const channelDepth = resolveChannelDepth(wireDiameter, thickness, spec.mount);
  if (channelDepth < idealDepth - 1e-6) {
    warnings.push(
      `The inner-end channel is only ${channelDepth.toFixed(1)} mm deep, limited by the flange's own thickness; the first turn may sit slightly proud of the surrounding flange face.`,
    );
  }

  // Inner-end fixing (issue #8): the bottom flange's own rim keyhole for the
  // inner cable end, plus the recessed channel leading it to the groove
  // start -- always present, unlike the (optional) mount. Computed BEFORE
  // the mount layouts below (issue #70's through-hole mount needs this
  // SAME real channel footprint to keep its own holes clear of it).
  // `layoutInnerEnd` is called again, identically, inside `fuseFlange`/
  // `buildStep` (the same "one shared pure function, called once per
  // backend" convention as `layoutKeyholeMount`/`layoutThroughHoleMount`
  // below), so it's computed here only to surface its warning, to keep the
  // through-hole mount clear of it, and to build the wound-cable
  // schematic's lead-in (wire.ts).
  const bendRadius = bendMultiplierOf(spec.wire) * wireDiameter;
  const innerEndLayout = layoutInnerEnd(outline, margin, wireDiameter, spec.tolerance, bendRadius);
  if (innerEndLayout.warning) warnings.push(innerEndLayout.warning);

  // Kept (not just its warning) so it can be surfaced on the returned
  // Design below: a consumer that wants to actually SHOW the mount's real
  // hung orientation -- not just cut it -- needs `axisDeg` too (see
  // mount.ts's own MountLayout doc comment).
  let mountLayout: MountLayout | undefined;
  if (wantsKeyhole) {
    mountLayout = layoutKeyholeMount(outline, boreOutline, margin, spec.keyholeRotation);
    if (mountLayout.warning) warnings.push(mountLayout.warning);
  }
  // Issue #70 PR review: reuses `solution.flangeSize / 2` as the wound
  // envelope's own radius -- mirrors flange.ts's `resolveFlangeSizing`
  // identically (that function's own doc comment explains why this
  // already-padded number is a safe, conservative stand-in), so the margin
  // that got GROWN to fit and the layout that actually CUTS the holes can
  // never disagree about where "outside the envelope" starts.
  const envelopeRadius = solution.flangeSize / 2;
  if (wantsThrough) {
    const throughLayout = layoutThroughHoleMount(outline, boreOutline, margin, spec.throughHoleDiameter, innerEndLayout, envelopeRadius);
    if (throughLayout.warning) warnings.push(throughLayout.warning);
  }

  const flangeSpec = {
    outline,
    boreOutline,
    margin,
    thickness,
    columns,
    minCornerSegments: cornerSegs,
    mount: spec.mount,
    keyholeRotation: spec.keyholeRotation,
    throughHoleDiameter: spec.throughHoleDiameter,
    envelopeRadius,
  };

  // Issue #14: lay out the clip mount plate (SKÅDIS/openGrid) against the
  // flange's own TRUE outer outline (offsetOutline(outline, margin) --
  // matching manifold.ts's own `buildOutlineRing(flange.outline,
  // flange.margin, ...)` call), so the layout and the actual cut geometry
  // can never disagree on where the flange's edge is.
  let mountPlateLayout: ReturnType<typeof mountPlateLayoutFor> | undefined;
  if (mountKindForPlate) {
    mountPlateLayout = mountPlateLayoutFor(mountKindForPlate, offsetOutline(outline, margin), boreOutline, innerEndLayout);
    if (mountPlateLayout.warning) warnings.push(mountPlateLayout.warning);
    // Issue #106: snap tabs on the plate's front face would print hanging
    // in mid-air (the plate prints back-face up, the flange face-down), so
    // every plate now uses the filament-pin + glue joint. Old links that
    // still ask for "snap" get it, with this notice.
    if (spec.plateJoint === "snap") warnings.push("Snap tabs can't print without supports, so the mount plate uses two filament pins and glue instead.");
  }
  const mountPlateCut: MountPlateFlangeCut | undefined =
    mountPlateLayout && mountPlateLayout.clips.length > 0 && mountPlateLayout.anchors.length > 0
      ? { anchors: mountPlateLayout.anchors, tolerance: spec.tolerance }
      : undefined;

  // Top cap (issue #9): `solution.topCapEnabled` (solve.ts) already resolved
  // the spec's auto|on|off override against the automatic recommendation
  // (capsAuto, on when layers > 1). Only bayonet/snap need a core-side cut
  // (a mating groove or retaining ridge in the top rim); press engages the
  // bore's own existing surface directly, so the core mesh is byte-for-byte
  // unchanged whenever the top cap is off OR the joint is "press" -- see
  // manifold.ts's CoreJointCut.
  const topCapEnabled = solution.topCapEnabled;
  const coreJoint: CoreJointCut | undefined =
    topCapEnabled && spec.joint !== "press"
      ? { boreOutline, height: solution.height, joint: spec.joint, tolerance: spec.tolerance }
      : undefined;

  const innerEndCut: InnerEndCut = { wireDiameter, tolerance: spec.tolerance, bendRadius, channelDepth, flangeThickness: thickness };

  // Real flange/overall-height extents (issue #63 -- PR #59 review: the
  // result panel's numbers must match the built parts, not the solver's own
  // envelope-based estimates). Both are analytic, off the SAME resolved
  // outline/margin/thickness the flange mesh itself is built from just
  // below (never a re-measurement of that mesh) -- see flange.ts.
  const flangeExtent = flangeExtentOf(outline, margin);
  const overallHeight = overallHeightOf(thickness, solution.height, topCapEnabled);

  // Issue #65: the flange is sized to clear the wound cable's own envelope
  // (see `resolveFlangeSizing`'s `baseMargin`, which is why this should
  // never actually fire), but it's a safety net for whatever the solver
  // didn't anticipate -- compared apples-to-apples, both across corners
  // (`envelopeDiameter` is already a circumscribed, across-corners extent;
  // for round, across-corners === across-flats, so this still holds).
  if (solution.envelopeDiameter > flangeExtent.acrossCorners + 1e-6) {
    warnings.push(
      `Cable outer size (${solution.envelopeDiameter.toFixed(1)} mm, across corners) is bigger than the flange (${flangeExtent.acrossCorners.toFixed(1)} mm, across corners) -- the wound cable would stick out past the flange.`,
    );
  }

  const wall = buildWall(wallSpec);
  const coreMesh = await fuseFlange(wall, flangeSpec, coreJoint, innerEndCut, mountPlateCut);

  const parts: Part[] = [{ name: "core", role: "core", mesh: coreMesh, printTransform: { rotateX: 0, translate: [0, 0, 0] } }];

  // Top cap label (issue #12): resolved against the SAME outline/boreOutline/
  // flange margin the STEP backend re-derives from `wallSpec`/`flangeSpec`
  // (step/build.ts calls the same `resolveLabel`), so the two backends can
  // never fit the text differently -- mirrors how CoreJointCut/wallSpec/
  // flangeSpec already keep the mesh and STEP walls from drifting.
  const { label, warning: labelWarning } = await resolveLabel(spec.label, outline, boreOutline, flangeSpec.margin, topCapEnabled);
  if (labelWarning) warnings.push(labelWarning);

  if (topCapEnabled) {
    const capMesh = await buildTopCap({ flange: flangeSpec, joint: spec.joint, tolerance: spec.tolerance, wireDiameter, label });
    // `capMesh` is built in a LOCAL frame (plate z=[0, CAP_THICKNESS], collar
    // reaching down to z=-JOINT_ENGAGE_DEPTH); translating by `height` lands
    // it in the shared assembly frame, flush against the wall's top rim.
    const assembled = translateMesh(capMesh, [0, 0, solution.height]);
    // Print orientation: flip 180 deg about X so the joint boss/lugs/hooks
    // (pointing down in the assembled frame) print pointing UP with no
    // overhang, and the flat plate face -- not the boss -- sits on the bed.
    // After the flip, the assembled z-range [height, height+CAP_THICKNESS]
    // (the plate, previously the TOP) becomes the new bottom; translating by
    // its negation lands that new bottom at z=0 (see types.ts's RigidTransform).
    parts.push({
      name: "top-cap",
      role: "topCap",
      mesh: assembled,
      printTransform: { rotateX: Math.PI, translate: [0, 0, solution.height + CAP_THICKNESS] },
    });
  }

  // Mount plate (issue #14): built directly in the shared assembly frame
  // (manifold.ts's `buildMountPlate` bakes in the `flangeSpec.thickness`
  // offset itself), so -- unlike the top cap above -- no further
  // `translateMesh` is needed here. Skipped entirely when the layout
  // couldn't fit at least 2 clips (its own warning already covers that).
  if (mountPlateLayout && mountKindForPlate && mountPlateLayout.clips.length > 0) {
    const plateMesh = await buildMountPlate({
      layout: mountPlateLayout,
      mountKind: mountKindForPlate,
      tolerance: spec.tolerance,
      flangeThickness: thickness,
      columns,
      minCornerSegments: cornerSegs,
    });
    // Print orientation: flip 180 deg about X so the clips (pointing away
    // from the core in the assembled frame) print pointing UP, on the
    // plate's flat front face (only pin HOLES there, issue #106) -- `bedRestingTransform` (plate.ts) recomputes the exact Z
    // offset that actually rests it on the bed, so the translate here only
    // needs to supply the rotation.
    parts.push({ name: "mount-plate", role: "mountPlate", mesh: plateMesh, printTransform: { rotateX: Math.PI, translate: [0, 0, 0] } });
  }

  const mesh = parts[0].mesh;
  const wirePaths = buildWirePaths(solution.layerResults, wallSpec, spec.windingQuality, resolution);
  // Issue #8: the wound-cable schematic's lead-in, from the SAME channel
  // path just cut into the flange -- never a re-derivation, so the drawn
  // cable can't show it entering the groove anywhere but where it was
  // actually cut. Kept as its own field, not folded into `wirePaths[0]`
  // (see buildInnerEndLeadIn's own doc comment for why).
  const innerEndLeadIn = buildInnerEndLeadIn(innerEndLayout.channelPath, wirePaths[0]);
  // Issue #68: bridge every layer-to-layer transition, then lead the last
  // layer's own end out to the top cap's rim keyhole -- same (x, y) as the
  // bottom flange's own keyhole (`innerEndLayout.hole`, both derived from
  // the identical outline/margin/wireDiameter/tolerance at t=0), sitting at
  // the assembled height of the cap's own mid-thickness. Computed
  // unconditionally, whether or not a top cap is actually built (see
  // wire.ts's `buildOuterEndLeadOut` doc comment).
  const layerTransitions = buildLayerTransitions(wirePaths, solution.layerResults, outline, spec.windingQuality);
  const outerEndLeadOut = buildOuterEndLeadOut(wirePaths, innerEndLayout.hole, solution.height + CAP_THICKNESS / 2, solution.layerResults, outline, spec.windingQuality);

  // Per-part bed-fit warnings (issue #10 AC): each part in ITS OWN print
  // orientation (printBBox reads printTransform, same as the STL/3MF
  // exporters) against the user's bed size. No auto-rotation-to-fit is
  // attempted -- docs/research.md "Out of scope": the bed size only ever
  // triggers a warning, never an automatic layout/orientation change.
  //
  // `partHeight` is a max-min span, so it's unaffected by the 3MF plate
  // layout's per-part Z snap (plate.ts's `layoutParts`: `dz = -minZ`) --
  // that snap only moves WHERE min Z lands (0), not how tall the part
  // is -- so this is already the same height that ends up printed between
  // z=0 and z=bedZ on the actual plate.
  for (const part of parts) {
    const box = printBBox(part);
    const footprintX = box.maxX - box.minX;
    const footprintY = box.maxY - box.minY;
    const partHeight = box.maxZ - box.minZ;
    if (footprintX > spec.print.bedX || footprintY > spec.print.bedY) {
      warnings.push(
        // Issue #105 AC #3: `bedX/Y/Z` come straight from the user's own
        // number input (no `step`-style rounding on typed values, unlike
        // the slider), so an unrounded request must still print rounded here.
        `Part "${part.name}" footprint (${footprintX.toFixed(1)} x ${footprintY.toFixed(1)} mm) doesn't fit the ${spec.print.bedX.toFixed(1)} x ${spec.print.bedY.toFixed(1)} mm bed.`,
      );
    }
    if (partHeight > spec.print.bedZ) {
      warnings.push(`Part "${part.name}" height (${partHeight.toFixed(1)} mm) is taller than the ${spec.print.bedZ.toFixed(1)} mm bed.`);
    }
  }

  return {
    spec,
    solution: { ...solution, overallHeight, flangeExtent },
    warnings,
    parts,
    mesh,
    resolution,
    wirePaths,
    wallSpec,
    flangeSpec,
    mountAxisDeg: mountLayout?.axisDeg ?? mountPlateLayout?.axisDeg,
    pegboard:
      spec.mount === "skadis" && mountPlateLayout && parts.some((p) => p.role === "mountPlate")
        ? skadisBoard(mountPlateLayout, thickness, circumscribedRadius(outline, margin) + 25)
        : undefined,
    innerEndLeadIn,
    layerTransitions,
    outerEndLeadOut,
  };
}

/** A copy of `mesh` with every vertex shifted by [dx, dy, dz]; `indices` is shared (never mutated). */
function translateMesh(mesh: { positions: Float32Array; indices: Uint32Array }, [dx, dy, dz]: [number, number, number]) {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = mesh.positions[i] + dx;
    positions[i + 1] = mesh.positions[i + 1] + dy;
    positions[i + 2] = mesh.positions[i + 2] + dz;
  }
  return { positions, indices: mesh.indices };
}
