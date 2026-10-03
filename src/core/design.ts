// The coil core orchestrator: solves the spec (solve.ts) then builds the
// round, grooved wall and fuses the bottom flange (docs/design.md, Geometry).
// The geometry itself is unchanged from the tracer bullet (#2): it still
// renders only the layer-1 groove on a single wall; layers beyond the first
// only affect the solved numbers and the flange size (the flange must clear
// every wound layer, not just the core's own wall). The top cap for
// multi-layer coils is ticket #9.
//
// `wallSpec`/`flangeSpec` are stashed on the returned Design so the STEP
// exporter (issue #11, src/core/step/build.ts) can fit its B-spline from
// the exact same parametric grid the mesh backend used -- the two backends
// must never drift apart (docs/design.md, Export).
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
  MARGIN_BOTTOM,
  MARGIN_TOP_FACTOR,
  FINAL_ROWS_PER_PITCH,
  FINAL_COLUMNS,
  FINAL_MIN_CORNER_SEGMENTS_PER_90,
  DRAFT_ROWS_PER_PITCH,
  DRAFT_COLUMNS,
  DRAFT_MIN_CORNER_SEGMENTS_PER_90,
  RUN_IN_TURNS,
  TAPER_TURNS,
  INNER_CHANNEL_MIN_SHELF,
  RIM_SLOT_KEEP_OUT,
  RIM_SLOT_LABEL_KEEP_OUT,
  SCREW_MOUNT_HEAD_RADIUS,
  SKADIS_CLIP_WIDTH,
  THROUGH_MOUNT_EDGE_MARGIN,
} from "./constants";
import { buildMountPlate, buildPeg, buildSkadisClip, buildSkadisTclip, buildTopCap, fuseFlange } from "./manifold";
import type { CoreJointCut, InnerEndCut, MountPlateFlangeCut } from "./manifold";
import { jointGeometry, resolveCapJoint } from "./joints";
import { layoutInnerEnd, layoutRimSlot, idealChannelDepth, resolveChannelDepth } from "./innerEnd";
import type { RimSlot, XY } from "./innerEnd";
import { printBBox } from "./plate";
import { distanceToClosedPolygon, layoutKeyholeMount } from "./mount";
import { channelPadFootprints, layoutFlangePads, layoutFlangeThroughHoles } from "./flangePads";
import type { MountLayout, ThroughMountLayout } from "./mount";
import { mountPlateLayoutFor } from "./mountPlate";
import { clipFrame, clipPrintRotateZ, isHeavyCable, layoutSkadisClips, lipKeepOffset, skadisBoardSection } from "./skadisClips";
import type { SkadisClipLayout } from "./skadisClips";
import { layoutSkadisTclips, skadisTclipBoardSection, tclipPrintRotateZ } from "./skadisTclips";
import type { SkadisTclipLayout } from "./skadisTclips";
import { flangeExtentOf, overallHeightOf, resolveBoreOutline, resolveFlangeSizing, stackedKeyholeThickness } from "./flange";
import { circumscribedRadius, makeOutline, minCornerSegments, offsetOutline } from "./shapes";
import { getLabelFont, labelLoops, resolveLabel } from "./label";
import { solve } from "./solve";
import type { ShapeOutline } from "./shapes";
import { bendMultiplierOf, noticeCollector } from "./types";
import type { CoilMesh, CoilSpec, Design, Part, Resolution, Solution } from "./types";
import { buildWall, grooveFadeTriangles, grooveShape, wallThickness } from "./wall";
import { buildCable } from "./wire";

/**
 * The flange's real sizing for a solved geometry, without building any mesh:
 * margin and thickness (including whatever the mount needs), the inner-end
 * channel and clip, and the screw-keyhole layout. design() builds the parts
 * from this, and also runs it on each alternate candidate (issue #192), so
 * an option card's size is exactly what picking that option builds.
 */
function planFlange(spec: CoilSpec, solution: Solution, outline: ShapeOutline, boreOutline: ShapeOutline) {
  const wireDiameter = spec.wire.diameter;
  // Issue #14: openGrid doesn't cut anything into the flange's own
  // OUTLINE (unlike keyhole) -- the separate mount plate's footprint
  // shrinks to fit whatever margin the flange already has (mountPlate.ts's
  // `layoutMountPlate` insets it) -- but its peg holes still
  // need the flange to be a bit THICKER, exactly like the keyhole mount.
  const mountKindForPlate = spec.mount === "opengrid" ? spec.mount : undefined;
  const heavyCable = isHeavyCable(wireDiameter, spec.wire.length);

  // The flange must clear the outermost wound layer, not just the core's
  // own wall (docs/design.md, Parts and printing: flange size = final
  // outer envelope + margin), thick enough for the inner-end channel plus whatever the
  // requested mount/plate needs -- see flange.ts's `resolveFlangeSizing`
  // for the full derivation, factored out (issue #63) so solve.ts's search
  // can score candidates against these SAME real numbers instead of a
  // cruder envelope-only proxy.
  const bendRadius = bendMultiplierOf(spec.wire) * wireDiameter;
  const sizing = resolveFlangeSizing(
    outline,
    boreOutline,
    solution.flangeSize,
    wireDiameter,
    spec.mount,
    { tolerance: spec.tolerance, bendRadius, heavyCable },
    spec.keyholeRotation,
    spec.throughHoleDiameter,
  );
  let thickness = sizing.thickness;
  const channelDepth = resolveChannelDepth(wireDiameter, thickness);

  // Inner-end fixing (issues #8, #117): the bottom flange's recessed channel
  // and cable clip for the inner cable end, leading it to the groove
  // start -- always present, unlike the (optional) mount. Computed BEFORE
  // the mount layouts (issue #70's through-hole mount needs this
  // SAME real channel footprint to keep its own holes clear of it).
  // `layoutInnerEnd` is called again, identically, inside `fuseFlange`/
  // `buildStep` (the same "one shared pure function, called once per
  // backend" convention as `layoutKeyholeMount`/`layoutThroughHoleMount`),
  // so it's computed here only to surface its warning, to keep the
  // through-hole mount clear of it, and to build the wound-cable
  // schematic's lead-in (wire.ts).
  const innerEndLayout = layoutInnerEnd(outline, sizing.margin, wireDiameter, spec.tolerance, bendRadius, channelDepth);

  // Kept (not just its warning) so it can be surfaced on the returned
  // Design: a consumer that wants to actually SHOW the mount's real
  // hung orientation -- not just cut it -- needs `axisDeg` too (see
  // mount.ts's own MountLayout doc comment).
  let mountLayout: MountLayout | undefined;
  if (spec.mount === "keyhole") {
    const layout = layoutKeyholeMount(outline, boreOutline, sizing.margin, spec.keyholeRotation);
    mountLayout = layout;
    // Issue #122: the keyhole's pocket (wall face) and the channel (winding
    // face) sit on separate pads, so the flange is only as thick as the
    // deeper of the two. The keyhole layout doesn't steer around the
    // channel, so if a slot ever lands on it, stack the two depths there
    // (the pre-#122 sizing) rather than let them meet.
    const clearance = SCREW_MOUNT_HEAD_RADIUS + INNER_CHANNEL_MIN_SHELF;
    const onChannel = layout.slots.some((slot) =>
      Array.from({ length: 9 }, (_, i) => i / 8).some(
        (k) =>
          innerEndLayout.channelRibbon.length >= 3 &&
          distanceToClosedPolygon(slot.head.x + (slot.shankEnd.x - slot.head.x) * k, slot.head.y + (slot.shankEnd.y - slot.head.y) * k, innerEndLayout.channelRibbon) < clearance,
      ),
    );
    if (onChannel) thickness = stackedKeyholeThickness(wireDiameter, thickness);
  }
  // Issue #207: the SKÅDIS rim clips, kept clear of the wound cable and of
  // the inner-end channel. The flange spec carries this layout, so both
  // geometry backends cut the same notches and build the same clips.
  const skadisLayout: SkadisClipLayout | undefined =
    spec.mount === "skadis"
      ? layoutSkadisClips({
          flangeOutline: offsetOutline(outline, sizing.margin),
          boreOutline,
          envelopeOutline: offsetOutline(outline, lipKeepOffset(sizing.envelopeOffset, thickness, sizing.plateThickness, spec.tolerance)),
          thickness,
          plateThickness: sizing.plateThickness,
          tolerance: spec.tolerance,
          latch: spec.skadisLatch ?? true,
          heavy: heavyCable,
          avoid: innerEndLayout.channelRibbon,
          padFootprints: channelPadFootprints(outline, innerEndLayout, thickness, sizing.plateThickness),
        })
      : undefined;
  return { mountKindForPlate, bendRadius, sizing, channelDepth, innerEndLayout, mountLayout, skadisLayout, thickness };
}

/** An alternate candidate with its real flange width and overall height filled in (issue #192), from the same `planFlange` design() builds the parts from. */
function withRealExtents(spec: CoilSpec, alt: Solution): Solution {
  const outline = makeOutline(spec.shape.kind, alt.outerSize, alt.cornerRadius);
  const { boreOutline } = resolveBoreOutline(outline, spec.wire.diameter);
  const { sizing, thickness } = planFlange(spec, alt, outline, boreOutline);
  return { ...alt, flangeExtent: flangeExtentOf(outline, sizing.margin), overallHeight: overallHeightOf(thickness, alt.height, alt.topCapEnabled) };
}

export async function design(spec: CoilSpec, resolution: Resolution = "final"): Promise<Design> {
  const solved = solve(spec);
  const { solution } = solved;
  const { notices, problem, note } = noticeCollector();
  notices.push(...solved.notices);
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
  const { boreOutline, reduced: boreReduced } = resolveBoreOutline(outline, spec.wire.diameter);
  if (boreReduced) {
    note(`Core size ${solution.outerSize.toFixed(1)} mm is too small for a ${Number(wallThickness(spec.wire.diameter).toFixed(1))} mm wall; the bore has been reduced.`);
  }

  const wireDiameter = spec.wire.diameter;
  const groove = grooveShape(wireDiameter);
  const layer1Turns = solution.layerResults[0]?.turns ?? 0;

  const wallSpec = {
    outline,
    boreOutline,
    height: solution.height,
    wireDiameter,
    pitch: groove.pitch,
    grooveRadius: groove.radius,
    grooveDepth: groove.depth,
    marginBottom: MARGIN_BOTTOM,
    marginTop: (MARGIN_TOP_FACTOR * wireDiameter) / 2,
    taperTurns: TAPER_TURNS,
    runInTurns: RUN_IN_TURNS,
    turns: layer1Turns,
    columns,
    minCornerSegments: cornerSegs,
    rowsPerPitch,
  };
  const wantsKeyhole = spec.mount === "keyhole";
  const wantsThrough = spec.mount === "through";
  const { mountKindForPlate, bendRadius, sizing, channelDepth, innerEndLayout, mountLayout, skadisLayout, thickness } = planFlange(spec, solution, outline, boreOutline);
  // Issues #213, #221: the SKÅDIS T-clips, in a floor across the bottom of the bore. With a cap, each
  // fin's top must be reachable through its hole, and the fins stop below its collar.
  const capJointForTclips = resolveCapJoint(spec, wallSpec);
  const tclipLayout: SkadisTclipLayout | undefined =
    spec.mount === "skadis-tclip"
      ? layoutSkadisTclips({
          boreOutline,
          capHole: solution.topCapEnabled ? jointGeometry(boreOutline, capJointForTclips.joint, spec.tolerance).holeOutline : undefined,
          wallTop: solution.height,
          thickness,
          tolerance: spec.tolerance,
        })
      : undefined;
  const { margin, thickness: sizedThickness, plateThickness, baseMargin, mountMargin, innerEndMargin, rimSlotMargin, envelopeOffset, channelOnlyThickness } = sizing;
  if (innerEndMargin > mountMargin + 1e-9 && innerEndMargin >= rimSlotMargin) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm so the inner cable end can reach the groove within its ${bendRadius.toFixed(1)} mm bend radius.`);
  }
  if (rimSlotMargin > Math.max(mountMargin, innerEndMargin) + 1e-9) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm so the rim cable slot fits beside the core.`);
  }
  if (wantsKeyhole && mountMargin > baseMargin) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm to fit the screw-keyhole mount.`);
  }
  if (wantsThrough && mountMargin > baseMargin) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm to fit the through-hole mount.`);
  }
  // Issue #129: the through-hole mount no longer needs a thickness floor of
  // its own (no counterbore) -- `thickness` is always `channelOnlyThickness`
  // for it, exactly like `mount === "none"`, so there is nothing to warn
  // about here any more.
  if (mountKindForPlate && mountMargin > baseMargin) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm to fit the openGrid clip mount plate's grid.`);
  }
  if (spec.mount === "skadis" && mountMargin > baseMargin) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm so the SKÅDIS clips grip the rim clear of the wound cable.`);
  }
  if (skadisLayout?.warning) problem(skadisLayout.warning);
  if (tclipLayout?.warning) problem(tclipLayout.warning);
  if (tclipLayout?.note) note(tclipLayout.note);
  if (tclipLayout && tclipLayout.clips.length > 0 && sizedThickness > channelOnlyThickness + 1e-9) {
    note(`Flange thickness increased to ${sizedThickness.toFixed(1)} mm so the bore's floor is thick enough under the T-clips' recesses.`);
  }
  if (mountKindForPlate && sizedThickness > channelOnlyThickness + 1e-9) {
    note(`Flange thickness increased to ${sizedThickness.toFixed(1)} mm to fit the mount plate's alignment features.`);
  }
  // `resolveChannelDepth` caps the channel to whatever `thickness` leaves
  // below a small shelf -- with `thickness` now
  // ALWAYS provisioned for the full ideal depth (see above), this never
  // actually caps it in the ordinary case; the warning below is now only
  // reachable for a genuinely exotic input this sizing doesn't anticipate.
  if (channelDepth < idealChannelDepth(wireDiameter) - 1e-6) {
    problem(
      `The inner-end channel is only ${channelDepth.toFixed(1)} mm deep, limited by the flange's own thickness; the first turn may sit slightly proud of the surrounding flange face.`,
    );
  }
  if (innerEndLayout.warning) problem(innerEndLayout.warning);
  if (mountLayout?.warning) problem(mountLayout.warning);
  if (wantsKeyhole && thickness > channelOnlyThickness + 1e-9) {
    note(`Flange thickness increased to ${thickness.toFixed(1)} mm to fit the recessed screw-keyhole mount.`);
  }
  // Issue #70 PR review: reuses `solution.flangeSize / 2` as the wound
  // envelope's own radius -- mirrors flange.ts's `resolveFlangeSizing`
  // identically (that function's own doc comment explains why this
  // already-padded number is a safe, conservative stand-in), so the margin
  // that got GROWN to fit and the layout that actually CUTS the holes can
  // never disagree about where "outside the envelope" starts.
  const envelopeRadius = solution.flangeSize / 2;

  const flangeSpec = {
    outline,
    boreOutline,
    margin,
    thickness,
    plateThickness,
    columns,
    minCornerSegments: cornerSegs,
    mount: spec.mount,
    keyholeRotation: spec.keyholeRotation,
    throughHoleDiameter: spec.throughHoleDiameter,
    envelopeRadius,
    skadis: skadisLayout && skadisLayout.clips.length > 0 ? skadisLayout : undefined,
    skadisTclip: tclipLayout && tclipLayout.clips.length > 0 ? tclipLayout : undefined,
  };
  // Issue #139: laid out from the finished flange spec, as both backends do,
  // so it keeps clear of the same pads they build.
  if (wantsThrough) {
    const throughLayout = layoutFlangeThroughHoles(flangeSpec, innerEndLayout);
    if (throughLayout.warning) problem(throughLayout.warning);
  }

  // Issue #14: lay out the openGrid clip mount plate against the
  // flange's own TRUE outer outline (offsetOutline(outline, margin) --
  // matching manifold.ts's own `buildOutlineRing(flange.outline,
  // flange.margin, ...)` call), so the layout and the actual cut geometry
  // can never disagree on where the flange's edge is.
  let mountPlateLayout: ReturnType<typeof mountPlateLayoutFor> | undefined;
  if (mountKindForPlate) {
    mountPlateLayout = mountPlateLayoutFor(offsetOutline(outline, margin), boreOutline, innerEndLayout);
    if (mountPlateLayout.warning) problem(mountPlateLayout.warning);
    // Issue #106: snap tabs on the plate's front face would print hanging
    // in mid-air (the plate prints back-face up, the flange face-down), so
    // every plate now uses the peg + glue joint. Old links that
    // still ask for "snap" get it, with this notice.
    if (spec.plateJoint === "snap") note("Snap tabs can't print without supports, so the mount plate uses two printed pegs and glue instead.");
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
  // Issue #167: the twist lock or the snap clips are laid out (or turned
  // down, for a non-round or too-small core) once, by the same
  // `resolveCapJoint` the STEP backend calls -- a fallback builds the plain
  // press-fit collar in both, with a warning. The spec keeps its joint.
  const capJoint = resolveCapJoint(spec, wallSpec);
  if (topCapEnabled && capJoint.warning) note(capJoint.warning);
  const coreJoint: CoreJointCut | undefined =
    topCapEnabled && capJoint.joint !== "press"
      ? { boreOutline, height: solution.height, joint: capJoint.joint, tolerance: spec.tolerance, bayonet: capJoint.bayonet, snap: capJoint.snap }
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
    problem(
      `Cable outer size (${solution.envelopeDiameter.toFixed(1)} mm, across corners) is bigger than the flange (${flangeExtent.acrossCorners.toFixed(1)} mm, across corners) -- the wound cable would stick out past the flange.`,
    );
  }

  // The drawn cable (issues #4, #68, #115, #117): one path from the inner
  // end's clip, through every layer and transition, to the outer end --
  // built before the flange and the cap, whose rim slots are laid out where
  // the cable's outer end leaves the coil (issue #241). The lead-in is
  // `innerEndLayout`'s own, the same layout the flange's channel and clip are
  // cut from.
  const cable = buildCable(solution.layerResults, wallSpec, spec.windingQuality, resolution, {
    innerEnd: innerEndLayout,
    topCapEnabled,
    height: solution.height,
    margin,
    envelopeOffset,
    tolerance: spec.tolerance,
    bendRadius,
  });
  for (const warning of cable.warnings) problem(warning);

  // Issue #241: the base's rim slot, as near the outer end as it fits, clear
  // of the inner-end channel, the mount's cuts and every pad but the collar
  // (its seat stays outside that by construction).
  const baseKeepOut: XY[][] = [
    innerEndLayout.channelRibbon,
    ...layoutFlangePads(flangeSpec, innerEndLayout, mountPlateCut?.anchors, spec.tolerance)
      .filter((pad) => pad.shape.kind !== "collar")
      .map((pad) => pad.footprint),
    ...(mountLayout?.slots ?? []).map((slot) => stadiumPolygon(slot.head, slot.shankEnd, SCREW_MOUNT_HEAD_RADIUS)),
    ...(wantsThrough ? throughHoleKeepOut(layoutFlangeThroughHoles(flangeSpec, innerEndLayout)) : []),
    ...(flangeSpec.skadis ? skadisClipFootprints(flangeSpec.skadis) : []),
  ].filter((poly) => poly.length >= 3);
  const baseSlot = layoutRimSlot(outline, margin, wireDiameter, spec.tolerance, cable.outerEndU, baseKeepOut, RIM_SLOT_KEEP_OUT);
  if (!baseSlot) note("The base's rim cable slot doesn't fit anywhere round the rim beside the mount, so it's left out.");
  const coreFlangeSpec = { ...flangeSpec, rimSlot: baseSlot };

  const wall = buildWall(wallSpec);
  const coreMesh = await fuseFlange(wall, coreFlangeSpec, coreJoint, innerEndCut, mountPlateCut);
  coreMesh.fadeTriangles = grooveFadeTriangles(coreMesh, wallSpec);

  const parts: Part[] = [{ name: "core", role: "core", mesh: coreMesh, printTransform: { rotateX: 0, translate: [0, 0, 0] } }];

  // Top cap label (issue #12): resolved against the SAME outline/boreOutline/
  // flange margin the STEP backend re-derives from `wallSpec`/`flangeSpec`
  // (step/build.ts calls the same `resolveLabel`), so the two backends can
  // never fit the text differently -- mirrors how CoreJointCut/wallSpec/
  // flangeSpec already keep the mesh and STEP walls from drifting.
  const { label, fit: labelFit, warning: labelWarning } = await resolveLabel(spec.label, outline, boreOutline, flangeSpec.margin, topCapEnabled);
  if (labelWarning) problem(labelWarning);

  // Issue #241: the cap's rim slot, where the cable's outer end arrives under
  // the cap (moved along the rim only if the label is in the way).
  let capSlot: RimSlot | undefined;
  if (topCapEnabled) {
    const labelKeepOut = label ? labelLoops(await getLabelFont(), label).map((loop) => loop.map(([x, y]) => ({ x, y }))) : [];
    capSlot = layoutRimSlot(outline, margin, wireDiameter, spec.tolerance, cable.outerEndU, labelKeepOut, RIM_SLOT_LABEL_KEEP_OUT);
    if (!capSlot) note("The top cap's rim cable slot doesn't fit anywhere round the rim beside the label, so it's left out.");
    const capMesh = await buildTopCap({ flange: coreFlangeSpec, joint: capJoint.joint, tolerance: spec.tolerance, bayonet: capJoint.bayonet, snap: capJoint.snap, label, rimSlot: capSlot });
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
    // Issue #132: one printed alignment peg per hole pair, standing in its
    // holes across the seam. Printed lying on a wide flat (a quarter turn
    // about X), so its layers run along it -- see constants.ts's
    // MOUNT_PLATE_PEG_* for why.
    if (mountPlateCut) {
      for (const [i, anchor] of mountPlateCut.anchors.entries()) {
        const pegMesh = await buildPeg(anchor, thickness);
        parts.push({ name: `peg-${i + 1}`, role: "peg", mesh: pegMesh, printTransform: { rotateX: Math.PI / 2, translate: [0, 0, 0] } });
      }
    }
  }

  // Issue #207: the SKÅDIS rim clips, built in the assembly frame (seated on
  // the board, wrapping the rim). Each prints lying on its flat face: a turn
  // about Z lines that face up with X, then a quarter turn about X lays it
  // on the bed, so every load runs along the layers.
  if (flangeSpec.skadis) {
    const layout = flangeSpec.skadis;
    const count = { top: 0, bottom: 0 };
    for (const clip of layout.clips) {
      const clipMesh = await buildSkadisClip(layout, clip);
      const name = `skadis-${clip.role}-clip-${++count[clip.role]}`;
      parts.push({ name, role: "mountClip", mesh: clipMesh, printTransform: { rotateZ: clipPrintRotateZ(layout.axisDeg), rotateX: Math.PI / 2, translate: [0, 0, 0] } });
    }
  }

  // Issue #213: the SKÅDIS T-clips, built seated and turned. Each prints
  // lying on its flat face (a turn about Z, then a quarter turn about X).
  if (flangeSpec.skadisTclip) {
    const layout = flangeSpec.skadisTclip;
    for (const [i, clip] of layout.clips.entries()) {
      const clipMesh = await buildSkadisTclip(layout, clip);
      parts.push({ name: `skadis-tclip-${i + 1}`, role: "mountClip", mesh: clipMesh, printTransform: { rotateZ: tclipPrintRotateZ(layout.axisDeg), rotateX: Math.PI / 2, translate: [0, 0, 0] } });
    }
  }

  const mesh = parts[0].mesh;
  // Per-part bed-fit warnings (issue #10 AC): each part in ITS OWN print
  // orientation (printBBox reads printTransform, same as the STL/3MF
  // exporters) against the user's bed size. No auto-rotation-to-fit is
  // attempted -- docs/design.md, Decisions (Printer): the bed size only ever
  // triggers a warning, never an automatic layout/orientation change.
  //
  // `partHeight` is a max-min span, so it's unaffected by the 3MF plate
  // layout's per-part Z snap (plate.ts's `layoutParts`: `dz = -minZ`) --
  // that snap only moves WHERE min Z lands (0), not how tall the part
  // is -- so this is already the same height that ends up printed between
  // z=0 and z=bedZ on the actual plate.
  let fitsBed = true;
  const cmText = (mm: number) => (mm / 10).toFixed(1).replace(/\.0$/, "");
  for (const part of parts) {
    const box = printBBox(part);
    // "peg-1"/"peg-2" -> "peg", "skadis-top-clip-1" -> "skadis top clip", "top-cap" -> "top cap": the part's name in plain words.
    const partName = part.name.replace(/-\d+$/, "").replace(/-/g, " ");
    const footprintX = box.maxX - box.minX;
    const footprintY = box.maxY - box.minY;
    const partHeight = box.maxZ - box.minZ;
    // Issue #105 AC #3: `bedX/Y/Z` come straight from the user's own number
    // input (no `step`-style rounding on typed values, unlike the slider),
    // so an unrounded request must still print rounded here. Issue #192:
    // plain words, in cm.
    if (footprintX > spec.print.bedX || footprintY > spec.print.bedY) {
      fitsBed = false;
      problem(`The ${partName}'s footprint is ${cmText(footprintX)} × ${cmText(footprintY)} cm; it doesn't fit your ${cmText(spec.print.bedX)} × ${cmText(spec.print.bedY)} cm bed.`);
    }
    if (partHeight > spec.print.bedZ) {
      fitsBed = false;
      problem(`The ${partName} is ${cmText(partHeight)} cm tall; your printer fits ${cmText(spec.print.bedZ)} cm.`);
    }
  }

  return {
    spec,
    solution: { ...solution, overallHeight, flangeExtent, alternates: solution.alternates.map((alt) => withRealExtents(spec, alt)) },
    notices,
    warnings: notices.map((n) => n.message),
    fitsBed,
    labelFit,
    parts,
    mesh,
    resolution,
    wirePaths: cable.wirePaths,
    wallSpec,
    flangeSpec: coreFlangeSpec,
    mountAxisDeg: mountLayout?.axisDeg ?? flangeSpec.skadis?.axisDeg ?? flangeSpec.skadisTclip?.axisDeg ?? mountPlateLayout?.axisDeg,
    pegboard: flangeSpec.skadis
      ? skadisBoardSection(flangeSpec.skadis, circumscribedRadius(outline, margin) + 45)
      : flangeSpec.skadisTclip
        ? skadisTclipBoardSection(flangeSpec.skadisTclip, circumscribedRadius(outline, margin) + 45)
        : undefined,
    innerEndLeadIn: cable.innerEndLeadIn,
    innerEndClip: innerEndLayout.clip,
    layerTransitions: cable.layerTransitions,
    outerEndLeadOut: cable.outerEndLeadOut,
    cablePath: cable.cablePath,
    rimSlots: { base: baseSlot, cap: capSlot },
  };
}

/** The stadium from `a` to `b` at radius `r`, as a closed polygon. */
function stadiumPolygon(a: XY, b: XY, r: number): XY[] {
  const base = Math.atan2(b.y - a.y, b.x - a.x);
  const half = (c: XY, from: number) => Array.from({ length: 13 }, (_, i) => ({ x: c.x + r * Math.cos(from + (Math.PI * i) / 12), y: c.y + r * Math.sin(from + (Math.PI * i) / 12) }));
  return [...half(b, base - Math.PI / 2), ...half(a, base + Math.PI / 2)];
}

/** Each through-hole with the screw head's bearing ring round it, as a polygon. */
function throughHoleKeepOut(layout: ThroughMountLayout): XY[][] {
  return layout.holes.map((hole) => stadiumPolygon(hole, hole, layout.holeRadius + THROUGH_MOUNT_EDGE_MARGIN));
}

/** Each SKÅDIS rim clip's footprint on the flange (its notch and the jaws beside it), as a polygon. */
function skadisClipFootprints(layout: SkadisClipLayout): XY[][] {
  return layout.clips.map((clip) => {
    const ups = clip.profile.map(([u]) => u);
    const [lo, hi] = [Math.min(...ups), Math.max(...ups)];
    const { at } = clipFrame(layout.axisDeg, clip.side);
    const w = SKADIS_CLIP_WIDTH / 2;
    return [at(lo, 0, -w), at(hi, 0, -w), at(hi, 0, w), at(lo, 0, w)].map(({ x, y }) => ({ x, y }));
  });
}

/** A copy of `mesh` with every vertex shifted by [dx, dy, dz]; `indices` is shared (never mutated). */
function translateMesh(mesh: CoilMesh, [dx, dy, dz]: [number, number, number]): CoilMesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = mesh.positions[i] + dx;
    positions[i + 1] = mesh.positions[i + 1] + dy;
    positions[i + 2] = mesh.positions[i + 2] + dz;
  }
  return { ...mesh, positions };
}
