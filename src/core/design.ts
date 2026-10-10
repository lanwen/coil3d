import {
  CAP_THICKNESS,
  FACE_BRIDGE_NOTE_WIDTH,
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
  STRAP_PLATE_MIN_CUT,
  MOUNT_PLATE_EDGE_MARGIN,
  OPENGRID_PLACEHOLDER_PEG_SIZE,
  SCREW_MOUNT_HEAD_RADIUS,
  SIZE_HI,
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
import { mountPlateLayoutFor, pegHoleRadius } from "./mountPlate";
import { layoutStrapNotches } from "./strapNotch";
import type { StrapNotch } from "./strapNotch";
import { clipPrintRotateZ, isHeavyCable, layoutSkadisClips, lipKeepOffset, skadisBoardSection, skadisClipFootprints } from "./skadisClips";
import type { SkadisClipLayout } from "./skadisClips";
import { layoutSkadisTclips, skadisTclipBoardSection, tclipPrintRotateZ } from "./skadisTclips";
import type { SkadisTclipLayout } from "./skadisTclips";
import { baseEnabled, flangeExtentOf, overallHeightOf, resolveBoreOutline, resolveFlangeSizing, stackedKeyholeThickness } from "./flange";
import { circumscribedRadius, makeOutline, minCornerSegments, offsetOutline, outlineOffsetAt } from "./shapes";
import { getLabelFont, labelLoops, resolveLabel } from "./label";
import { solve } from "./solve";
import type { ShapeOutline } from "./shapes";
import { bendMultiplierOf, noticeCollector } from "./types";
import type { CoilMesh, CoilSpec, Design, Part, Resolution, Solution } from "./types";
import { buildWall, grooveFadeTriangles, grooveShape, wallThickness } from "./wall";
import { crossingActive, crossingReserve, faceTopFloor, planFaceChannels } from "./faceChannel";
import { buildCable, outerStartOf, windLayers } from "./wire";

const STADIUM_ARC_SEGMENTS = 12;
const CABLE_END_EPSILON = 0.01;

function planFlange(spec: CoilSpec, solution: Solution, outline: ShapeOutline, boreOutline: ShapeOutline) {
  const wireDiameter = spec.wire.diameter;
  const mountKindForPlate = spec.mount === "opengrid" ? spec.mount : undefined;
  const heavyCable = isHeavyCable(wireDiameter, spec.wire.length);

  const bendRadius = bendMultiplierOf(spec.wire) * wireDiameter;
  const baseOn = baseEnabled(spec);
  const sized = resolveFlangeSizing(
    outline,
    boreOutline,
    solution.flangeSize,
    wireDiameter,
    spec.mount,
    { tolerance: spec.tolerance, bendRadius, heavyCable, woundLayers: solution.layerResults.filter((r) => r.turns > 0).length, topCap: solution.topCapEnabled },
    spec.keyholeRotation,
    spec.throughHoleDiameter,
    baseOn,
  );
  const channelDepth = resolveChannelDepth(wireDiameter, sized.thickness);

  const layoutsAt = (margin: number) => {
    let thickness = sized.thickness;
    const innerEndLayout = baseOn ? layoutInnerEnd(outline, margin, wireDiameter, spec.tolerance, bendRadius, channelDepth) : undefined;

    let mountLayout: MountLayout | undefined;
    if (spec.mount === "keyhole") {
      const layout = layoutKeyholeMount(outline, boreOutline, margin, spec.keyholeRotation);
      mountLayout = layout;
      const clearance = SCREW_MOUNT_HEAD_RADIUS + INNER_CHANNEL_MIN_SHELF;
      const onChannel = layout.slots.some((slot) =>
        Array.from({ length: 9 }, (_, i) => i / 8).some(
          (k) =>
            innerEndLayout !== undefined &&
            innerEndLayout.channelRibbon.length >= 3 &&
            distanceToClosedPolygon(slot.head.x + (slot.shankEnd.x - slot.head.x) * k, slot.head.y + (slot.shankEnd.y - slot.head.y) * k, innerEndLayout.channelRibbon) < clearance,
        ),
      );
      if (onChannel) thickness = stackedKeyholeThickness(wireDiameter, thickness);
    }
    const skadisLayout: SkadisClipLayout | undefined =
      spec.mount === "skadis" && innerEndLayout
        ? layoutSkadisClips({
            flangeOutline: offsetOutline(outline, margin),
            boreOutline,
            envelopeOutline: offsetOutline(outline, lipKeepOffset(sized.envelopeOffset, thickness, sized.plateThickness, spec.tolerance)),
            thickness,
            plateThickness: sized.plateThickness,
            tolerance: spec.tolerance,
            latch: spec.skadisLatch ?? true,
            heavy: heavyCable,
            avoid: innerEndLayout.channelRibbon,
            padFootprints: channelPadFootprints(outline, innerEndLayout, thickness, sized.plateThickness),
          })
        : undefined;
    return { margin, thickness, innerEndLayout, mountLayout, skadisLayout };
  };

  const mountFits = (plan: ReturnType<typeof layoutsAt>): boolean => {
    if (spec.mount === "keyhole") return plan.mountLayout?.warning === undefined;
    if (spec.mount === "skadis") return plan.skadisLayout?.warning === undefined;
    if (spec.mount === "through") {
      const flange = {
        outline,
        boreOutline,
        margin: plan.margin,
        thickness: plan.thickness,
        plateThickness: sized.plateThickness,
        columns: FINAL_COLUMNS,
        minCornerSegments: minCornerSegments(outline, FINAL_MIN_CORNER_SEGMENTS_PER_90),
        mount: spec.mount,
        throughHoleDiameter: spec.throughHoleDiameter,
      };
      return layoutFlangeThroughHoles(flange, plan.innerEndLayout).warning === undefined;
    }
    if (mountKindForPlate) {
      const layout = mountPlateLayoutFor(offsetOutline(outline, plan.margin), boreOutline, plan.innerEndLayout);
      return layout.clips.length > 0 && layout.anchors.length > 0;
    }
    return true;
  };

  let plan = layoutsAt(sized.margin);
  let sizing = sized;
  if (baseOn && !spec.coreSize.locked && !mountFits(plan)) {
    const grown = growMargin(sized.margin, (margin) => mountFits(layoutsAt(margin)));
    if (grown !== undefined) {
      plan = layoutsAt(grown);
      sizing = { ...sized, margin: grown, mountMargin: grown };
    }
  }
  const { innerEndLayout, mountLayout, skadisLayout, thickness } = plan;
  return { mountKindForPlate, bendRadius, sizing, channelDepth, innerEndLayout, mountLayout, skadisLayout, thickness };
}

function growMargin(from: number, fits: (margin: number) => boolean): number | undefined {
  let tooSmall = from;
  let step = 1;
  while (!fits(from + step)) {
    tooSmall = from + step;
    step *= 2;
    if (step > SIZE_HI) return undefined;
  }
  let works = from + step;
  for (let i = 0; i < 20; i++) {
    const middle = (tooSmall + works) / 2;
    if (fits(middle)) works = middle;
    else tooSmall = middle;
  }
  return works;
}

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

  const cornerSegPer90 = resolution === "draft" ? DRAFT_MIN_CORNER_SEGMENTS_PER_90 : FINAL_MIN_CORNER_SEGMENTS_PER_90;
  const cornerSegs = minCornerSegments(outline, cornerSegPer90);

  const { boreOutline, reduced: boreReduced } = resolveBoreOutline(outline, spec.wire.diameter);
  if (boreReduced) {
    note(`Core size ${solution.outerSize.toFixed(1)} mm is too small for a ${Number(wallThickness(spec.wire.diameter).toFixed(1))} mm wall; the bore has been reduced.`);
  }

  const wireDiameter = spec.wire.diameter;
  const groove = grooveShape(wireDiameter);
  const layer1Turns = solution.layerResults[0]?.turns ?? 0;

  const woundLayers = solution.layerResults.filter((r) => r.turns > 0).length;
  const bendLimit = bendMultiplierOf(spec.wire) * wireDiameter;
  const wound = windLayers(solution.layerResults, outline, wireDiameter, spec.windingQuality, resolution, bendLimit);
  const topFace = woundLayers > 0 && !solution.topCapEnabled;
  const bottomFace = !baseEnabled(spec);
  const reserve = crossingActive(solution.layers, solution.topCapEnabled) ? crossingReserve(wireDiameter, spec.tolerance) : 0;
  const outerStart = topFace ? outerStartOf(wound) : undefined;
  const planChannels = (withTop: boolean) =>
    planFaceChannels({
      outline,
      boreOutline,
      height: solution.height,
      wireDiameter,
      tolerance: spec.tolerance,
      bendRadius: bendLimit,
      topFace: withTop,
      bottomFace,
      reserve,
      outerStart: withTop ? outerStart : undefined,
    });
  let faceChannels = woundLayers === 0 ? undefined : planChannels(topFace);
  if (topFace && outerStart && !faceChannels) {
    faceChannels = planChannels(false);
    note("The outer cable end stays a straight tail: there is no room to lead it over the top turns into the centre hole at this size and height.");
  }
  if (faceChannels?.inner && 2 * faceChannels.channelRadius > FACE_BRIDGE_NOTE_WIDTH) {
    note(`The channel on the bottom face is ${(2 * faceChannels.channelRadius).toFixed(1)} mm wide, so its roof bridges more than 8 mm; check that your printer manages it.`);
  }
  if ((bottomFace || (topFace && !outerStart)) && woundLayers > 0 && !faceChannels) {
    problem("The cable's ends have no room to leave the core's centre at this size and height; the core needs to be bigger.");
  }

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
    rings: faceChannels && {
      holeOutline: faceChannels.holeOutline,
      width: faceChannels.ringWidth,
      bottomThickness: faceChannels.bottomThickness,
      bottomRing: faceChannels.inner !== undefined,
      topThickness: faceChannels.topThickness,
    },
  };
  const wantsKeyhole = spec.mount === "keyhole";
  const wantsThrough = spec.mount === "through";
  const { mountKindForPlate, bendRadius, sizing, channelDepth, innerEndLayout, mountLayout, skadisLayout, thickness } = planFlange(spec, solution, outline, boreOutline);
  const capJointForTclips = resolveCapJoint(spec, wallSpec);
  const tclipLayout: SkadisTclipLayout | undefined =
    spec.mount === "skadis-tclip"
      ? layoutSkadisTclips({
          boreOutline,
          capHole: solution.topCapEnabled ? jointGeometry(boreOutline, capJointForTclips.joint, spec.tolerance).holeOutline : undefined,
          ring: faceChannels?.topThickness !== undefined ? { holeOutline: faceChannels.holeOutline, funnelFloor: faceTopFloor(faceChannels) } : undefined,
          wallTop: solution.height,
          thickness,
          tolerance: spec.tolerance,
        })
      : undefined;
  const { margin, thickness: sizedThickness, plateThickness, baseMargin, mountMargin, innerEndMargin, rimSlotMargin, channelOnlyThickness, envelopeOffset } = sizing;
  const baseOn = baseEnabled(spec);
  if (baseOn && innerEndMargin > mountMargin + 1e-9 && innerEndMargin >= rimSlotMargin) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm so the inner cable end can reach the groove within its ${bendRadius.toFixed(1)} mm bend radius.`);
  }
  if (baseOn && rimSlotMargin > Math.max(mountMargin, innerEndMargin) + 1e-9) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm so the rim cable slot fits beside the core.`);
  }
  if (wantsKeyhole && mountMargin > baseMargin) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm to fit the screw-keyhole mount.`);
  }
  if (wantsThrough && mountMargin > baseMargin) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm to fit the through-hole mount.`);
  }
  if (mountKindForPlate && mountMargin > baseMargin) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm to fit the openGrid clip mount plate's grid.`);
  }
  if (spec.mount === "skadis" && mountMargin > baseMargin) {
    note(`Flange margin increased to ${margin.toFixed(1)} mm so the SKÅDIS clips grip the rim clear of the wound cable and the inner cable end.`);
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
  if (baseOn && channelDepth < idealChannelDepth(wireDiameter) - 1e-6) {
    problem(
      `The inner-end channel is only ${channelDepth.toFixed(1)} mm deep, limited by the flange's own thickness; the first turn may sit slightly proud of the surrounding flange face.`,
    );
  }
  if (innerEndLayout?.warning) problem(innerEndLayout.warning);
  if (mountLayout?.warning) problem(mountLayout.warning);
  if (wantsKeyhole && thickness > channelOnlyThickness + 1e-9) {
    note(`Flange thickness increased to ${thickness.toFixed(1)} mm to fit the recessed screw-keyhole mount.`);
  }
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
    skadis: skadisLayout && skadisLayout.clips.length > 0 ? skadisLayout : undefined,
    skadisTclip: tclipLayout && tclipLayout.clips.length > 0 ? tclipLayout : undefined,
  };
  if (wantsThrough) {
    const throughLayout = layoutFlangeThroughHoles(flangeSpec, innerEndLayout);
    if (throughLayout.warning) problem(throughLayout.warning);
  }

  let mountPlateLayout: ReturnType<typeof mountPlateLayoutFor> | undefined;
  if (mountKindForPlate) {
    mountPlateLayout = mountPlateLayoutFor(offsetOutline(outline, margin), boreOutline, innerEndLayout);
    if (mountPlateLayout.warning) problem(mountPlateLayout.warning);
    if (spec.plateJoint === "snap") note("Snap tabs can't print without supports, so the mount plate uses two printed pegs and glue instead.");
  }
  const mountPlateCut: MountPlateFlangeCut | undefined =
    mountPlateLayout && mountPlateLayout.clips.length > 0 && mountPlateLayout.anchors.length > 0
      ? { anchors: mountPlateLayout.anchors, tolerance: spec.tolerance }
      : undefined;

  const topCapEnabled = solution.topCapEnabled;
  const capJoint = resolveCapJoint(spec, wallSpec);
  if (topCapEnabled && capJoint.warning) note(capJoint.warning);
  const coreJoint: CoreJointCut | undefined =
    topCapEnabled && capJoint.joint !== "press"
      ? { boreOutline, height: solution.height, joint: capJoint.joint, tolerance: spec.tolerance, bayonet: capJoint.bayonet, snap: capJoint.snap }
      : undefined;

  const innerEndCut: InnerEndCut | undefined = baseOn ? { wireDiameter, tolerance: spec.tolerance, bendRadius, channelDepth, flangeThickness: thickness } : undefined;

  const flangeExtent = flangeExtentOf(outline, margin);
  const overallHeight = overallHeightOf(thickness, solution.height, topCapEnabled);

  if ((baseOn || topCapEnabled) && solution.envelopeDiameter > flangeExtent.acrossCorners + 1e-6) {
    problem(
      `Cable outer size (${solution.envelopeDiameter.toFixed(1)} mm, across corners) is bigger than the flange (${flangeExtent.acrossCorners.toFixed(1)} mm, across corners) -- the wound cable would stick out past the flange.`,
    );
  }

  const cable = buildCable(wound, outline, wireDiameter, {
    innerEnd: innerEndLayout,
    faceChannels,
    topCapEnabled,
    wallHeight: solution.height,
    flangeMargin: margin,
    tolerance: spec.tolerance,
    bendRadius,
  });
  for (const warning of cable.warnings) problem(warning);

  const baseKeepOut: XY[][] = baseOn ? [
    ...(innerEndLayout ? [innerEndLayout.channelRibbon] : []),
    ...layoutFlangePads(flangeSpec, innerEndLayout, mountPlateCut?.anchors, spec.tolerance)
      .filter((pad) => pad.shape.kind !== "collar")
      .map((pad) => pad.footprint),
    ...(mountLayout?.slots ?? []).map((slot) => stadiumPolygon(slot.head, slot.shankEnd, SCREW_MOUNT_HEAD_RADIUS)),
    ...(wantsThrough ? throughHoleKeepOut(layoutFlangeThroughHoles(flangeSpec, innerEndLayout)) : []),
    ...(flangeSpec.skadis ? skadisClipFootprints(flangeSpec.skadis) : []),
  ].filter((poly) => poly.length >= 3) : [];
  const baseSlot = baseOn ? layoutRimSlot(outline, margin, wireDiameter, spec.tolerance, cable.outerEndU, baseKeepOut, RIM_SLOT_KEEP_OUT) : undefined;
  if (baseOn && !baseSlot) note("The base's rim cable slot doesn't fit anywhere round the rim beside the mount, so it's left out.");
  const { label, fit: labelFit, warning: labelWarning } = await resolveLabel(spec.label, outline, boreOutline, flangeSpec.margin, topCapEnabled);
  if (labelWarning) problem(labelWarning);

  let capSlot: RimSlot | undefined;
  let capKeepOut: XY[][] = [];
  if (topCapEnabled) {
    const labelKeepOut = label ? labelLoops(await getLabelFont(), label).map((loop) => loop.map(([x, y]) => ({ x, y }))) : [];
    capSlot = layoutRimSlot(outline, margin, wireDiameter, spec.tolerance, cable.outerEndU, labelKeepOut, RIM_SLOT_LABEL_KEEP_OUT);
    if (!capSlot) note("The top cap's rim cable slot doesn't fit anywhere round the rim beside the label, so it's left out.");
    capKeepOut = [...labelKeepOut, ...(capSlot ? [capSlot.outline] : [])];
  }

  const plateCutsNotch = mountPlateCut !== undefined && margin - MOUNT_PLATE_EDGE_MARGIN - envelopeOffset > STRAP_PLATE_MIN_CUT;
  let strapNotches: StrapNotch[] = [];
  if (spec.strapSlots && (baseOn || topCapEnabled)) {
    const strapKeepOut: XY[][] = [
      ...(baseOn ? [...baseKeepOut, ...(baseSlot ? [baseSlot.outline] : []), ...(flangeSpec.skadis?.notches ?? [])] : []),
      ...(mountPlateCut ? mountPlateCut.anchors.map((anchor) => stadiumPolygon(anchor, anchor, pegHoleRadius(spec.tolerance))) : []),
      ...(plateCutsNotch ? (mountPlateLayout?.clips ?? []).map((clip) => stadiumPolygon(clip, clip, (OPENGRID_PLACEHOLDER_PEG_SIZE / 2) * Math.SQRT2)) : []),
      ...capKeepOut,
      ...[cable.innerEndLeadIn, cable.outerEndLeadOut].flatMap((lead) => [
        ...(baseOn ? cableEndKeepOut(lead, outline, envelopeOffset, wireDiameter / 2, (z) => z <= wireDiameter) : []),
        ...(topCapEnabled ? cableEndKeepOut(lead, outline, envelopeOffset, wireDiameter / 2, (z) => z >= solution.height - wireDiameter) : []),
      ]),
    ].filter((poly) => poly.length >= 3);
    const laidOut = layoutStrapNotches(outline, margin, envelopeOffset, strapKeepOut);
    if (laidOut) strapNotches = laidOut;
    else note("The strap slots don't fit anywhere round the rim beside the mount and the cable slot, so they're left out.");
  }
  const platesNotches = {
    base: baseOn ? strapNotches : [],
    cap: topCapEnabled ? strapNotches : [],
    mountPlate: plateCutsNotch ? strapNotches : [],
  };
  const coreFlangeSpec = { ...flangeSpec, rimSlot: baseSlot, strapNotches: platesNotches.base };

  const wall = buildWall(wallSpec);
  const coreMesh = await fuseFlange(wall, coreFlangeSpec, coreJoint, innerEndCut, mountPlateCut, faceChannels);
  coreMesh.fadeTriangles = grooveFadeTriangles(coreMesh, wallSpec);

  const parts: Part[] = [{ name: "core", role: "core", mesh: coreMesh, printTransform: { rotateX: 0, translate: [0, 0, 0] } }];

  if (topCapEnabled) {
    const capMesh = await buildTopCap({ flange: coreFlangeSpec, joint: capJoint.joint, tolerance: spec.tolerance, bayonet: capJoint.bayonet, snap: capJoint.snap, label, rimSlot: capSlot, strapNotches: platesNotches.cap });
    const assembled = translateMesh(capMesh, [0, 0, solution.height]);
    parts.push({
      name: "top-cap",
      role: "topCap",
      mesh: assembled,
      printTransform: { rotateX: Math.PI, translate: [0, 0, solution.height + CAP_THICKNESS] },
    });
  }

  if (mountPlateLayout && mountKindForPlate && mountPlateLayout.clips.length > 0) {
    const plateMesh = await buildMountPlate({
      layout: mountPlateLayout,
      tolerance: spec.tolerance,
      flangeThickness: thickness,
      columns,
      minCornerSegments: cornerSegs,
      strapNotches: platesNotches.mountPlate,
    });
    parts.push({ name: "mount-plate", role: "mountPlate", mesh: plateMesh, printTransform: { rotateX: Math.PI, translate: [0, 0, 0] } });
    if (mountPlateCut) {
      for (const [i, anchor] of mountPlateCut.anchors.entries()) {
        const pegMesh = await buildPeg(anchor, thickness);
        parts.push({ name: `peg-${i + 1}`, role: "peg", mesh: pegMesh, printTransform: { rotateX: Math.PI / 2, translate: [0, 0, 0] } });
      }
    }
  }

  if (flangeSpec.skadis) {
    const layout = flangeSpec.skadis;
    const count = { top: 0, bottom: 0 };
    for (const clip of layout.clips) {
      const clipMesh = await buildSkadisClip(layout, clip);
      const name = `skadis-${clip.role}-clip-${++count[clip.role]}`;
      parts.push({ name, role: "mountClip", mesh: clipMesh, printTransform: { rotateZ: clipPrintRotateZ(layout.axisDeg), rotateX: Math.PI / 2, translate: [0, 0, 0] } });
    }
  }

  if (flangeSpec.skadisTclip) {
    const layout = flangeSpec.skadisTclip;
    for (const [i, clip] of layout.clips.entries()) {
      const clipMesh = await buildSkadisTclip(layout, clip);
      parts.push({ name: `skadis-tclip-${i + 1}`, role: "mountClip", mesh: clipMesh, printTransform: { rotateZ: tclipPrintRotateZ(layout.axisDeg), rotateX: Math.PI / 2, translate: [0, 0, 0] } });
    }
  }

  const mesh = parts[0].mesh;
  let fitsBed = true;
  const cmText = (mm: number) => (mm / 10).toFixed(1).replace(/\.0$/, "");
  for (const part of parts) {
    const box = printBBox(part);
    const partName = part.name.replace(/-\d+$/, "").replace(/-/g, " ");
    const footprintX = box.maxX - box.minX;
    const footprintY = box.maxY - box.minY;
    const partHeight = box.maxZ - box.minZ;
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
    innerEndClip: innerEndLayout?.clip,
    layerTransitions: cable.layerTransitions,
    outerEndLeadOut: cable.outerEndLeadOut,
    cablePath: cable.cablePath,
    faceChannels,
    rimSlots: { base: baseSlot, cap: capSlot },
    strapNotches: platesNotches,
  };
}

function stadiumPolygon(a: XY, b: XY, r: number): XY[] {
  const base = Math.atan2(b.y - a.y, b.x - a.x);
  const semicircle = (c: XY, from: number) =>
    Array.from({ length: STADIUM_ARC_SEGMENTS + 1 }, (_, i) => ({
      x: c.x + r * Math.cos(from + (Math.PI * i) / STADIUM_ARC_SEGMENTS),
      y: c.y + r * Math.sin(from + (Math.PI * i) / STADIUM_ARC_SEGMENTS),
    }));
  return [...semicircle(b, base - Math.PI / 2), ...semicircle(a, base + Math.PI / 2)];
}

function cableEndKeepOut(lead: Float32Array, outline: ShapeOutline, envelopeOffset: number, radius: number, atPlate: (z: number) => boolean): XY[][] {
  const points = Array.from({ length: lead.length / 3 }, (_, i) => ({ x: lead[3 * i], y: lead[3 * i + 1], z: lead[3 * i + 2] }));
  const clear = points.map((p) => atPlate(p.z) && outlineOffsetAt(outline, p.x, p.y).offset > envelopeOffset - radius + CABLE_END_EPSILON);
  return points.slice(1).flatMap((p, i) => (clear[i] || clear[i + 1] ? [stadiumPolygon(points[i], p, radius)] : []));
}

function throughHoleKeepOut(layout: ThroughMountLayout): XY[][] {
  return layout.holes.map((hole) => stadiumPolygon(hole, hole, layout.holeRadius + THROUGH_MOUNT_EDGE_MARGIN));
}

function translateMesh(mesh: CoilMesh, [dx, dy, dz]: [number, number, number]): CoilMesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = mesh.positions[i] + dx;
    positions[i + 1] = mesh.positions[i + 1] + dy;
    positions[i + 2] = mesh.positions[i + 2] + dz;
  }
  return { ...mesh, positions };
}
