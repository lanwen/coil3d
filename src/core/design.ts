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
  DEFAULT_BASE,
  MARGIN_TOP_FACTOR,
  FINAL_ROWS_PER_PITCH,
  FINAL_COLUMNS,
  FINAL_MIN_CORNER_SEGMENTS_PER_90,
  DRAFT_ROWS_PER_PITCH,
  DRAFT_COLUMNS,
  DRAFT_MIN_CORNER_SEGMENTS_PER_90,
  RUN_IN_TURNS,
  TAPER_TURNS,
  RIM_SLOT_KEEP_OUT,
  RIM_SLOT_LABEL_KEEP_OUT,
  SCREW_MOUNT_HEAD_RADIUS,
  SKADIS_CLIP_WIDTH,
  THROUGH_MOUNT_EDGE_MARGIN,
} from "./constants";
import { buildMountPlate, buildPeg, buildSkadisClip, buildSkadisTclip, buildTopCap, fuseFlange } from "./manifold";
import type { CoreJointCut, MountPlateFlangeCut } from "./manifold";
import { jointGeometry, resolveCapJoint } from "./joints";
import { layoutRimSlot } from "./innerEnd";
import { layoutCentreInnerEnd } from "./centreEnds";
import type { RimSlot, XY } from "./innerEnd";
import { printBBox } from "./plate";
import { layoutKeyholeMount } from "./mount";
import { layoutFlangePads, layoutFlangeThroughHoles } from "./flangePads";
import type { MountLayout, ThroughMountLayout } from "./mount";
import { mountPlateLayoutFor } from "./mountPlate";
import { clipFrame, clipPrintRotateZ, isHeavyCable, layoutSkadisClips, lipKeepOffset, skadisBoardSection } from "./skadisClips";
import type { SkadisClipLayout } from "./skadisClips";
import { layoutSkadisTclips, skadisTclipBoardSection, tclipPrintRotateZ } from "./skadisTclips";
import type { SkadisTclipLayout } from "./skadisTclips";
import { baseEnabled, flangeExtentOf, overallHeightOf, resolveBoreOutline, resolveFlangeSizing } from "./flange";
import { circumscribedRadius, makeOutline, minCornerSegments, offsetOutline } from "./shapes";
import { getLabelFont, labelLoops, resolveLabel } from "./label";
import { solve } from "./solve";
import type { ShapeOutline } from "./shapes";
import { bendMultiplierOf, noticeCollector } from "./types";
import type { CoilMesh, CoilSpec, Design, Part, Resolution, Solution } from "./types";
import { bottomMargin, buildWall, grooveFadeTriangles, grooveShape, wallThickness } from "./wall";
import { buildCable } from "./wire";

function planFlange(spec: CoilSpec, solution: Solution, outline: ShapeOutline, boreOutline: ShapeOutline) {
  const wireDiameter = spec.wire.diameter;
  const mountKindForPlate = spec.mount === "opengrid" ? spec.mount : undefined;
  const heavyCable = isHeavyCable(wireDiameter, spec.wire.length);

  const bendRadius = bendMultiplierOf(spec.wire) * wireDiameter;
  const baseOn = baseEnabled(spec);
  const sizing = resolveFlangeSizing(
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
  const thickness = sizing.thickness;
  const centre = layoutCentreInnerEnd(outline, boreOutline, wireDiameter, spec.tolerance, bendRadius, solution.height, baseOn ? -thickness : 0);

  const mountLayout: MountLayout | undefined = spec.mount === "keyhole" ? layoutKeyholeMount(outline, boreOutline, sizing.margin, spec.keyholeRotation) : undefined;
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
          avoid: centre.channelRibbon,
          padFootprints: [],
        })
      : undefined;
  return { mountKindForPlate, bendRadius, sizing, centre, mountLayout, skadisLayout, thickness };
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

  const cornerSegPer90 = resolution === "draft" ? DRAFT_MIN_CORNER_SEGMENTS_PER_90 : FINAL_MIN_CORNER_SEGMENTS_PER_90;
  const cornerSegs = minCornerSegments(outline, cornerSegPer90);

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
    marginBottom: bottomMargin(wireDiameter),
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
  const { mountKindForPlate, bendRadius, sizing, centre, mountLayout, skadisLayout, thickness } = planFlange(spec, solution, outline, boreOutline);
  const capJointForTclips = resolveCapJoint(spec, wallSpec);
  const tclipLayout: SkadisTclipLayout | undefined =
    spec.mount === "skadis-tclip"
      ? layoutSkadisTclips({
          boreOutline,
          capHole: solution.topCapEnabled ? jointGeometry(boreOutline, capJointForTclips.joint, spec.tolerance).holeOutline : undefined,
          wallTop: solution.height,
          thickness,
          tolerance: spec.tolerance,
          avoid: [centre.rib, centre.floorRibbon],
        })
      : undefined;
  const { margin, thickness: sizedThickness, plateThickness, baseMargin, mountMargin, rimSlotMargin, channelOnlyThickness } = sizing;
  const baseOn = baseEnabled(spec);
  if (spec.mount !== "none" && (spec.base ?? DEFAULT_BASE) === "off") {
    note("A wall mount needs the base plate, so the base stays on.");
  }
  if (baseOn && rimSlotMargin > mountMargin + 1e-9) {
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
  if (!centre.feasible) {
    problem(`The core is too small for the inner cable end to leave the bore within its ${bendRadius.toFixed(1)} mm bend radius and clear of the wall; make the core bigger.`);
  }
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
    const throughLayout = layoutFlangeThroughHoles(flangeSpec, centre);
    if (throughLayout.warning) problem(throughLayout.warning);
  }

  let mountPlateLayout: ReturnType<typeof mountPlateLayoutFor> | undefined;
  if (mountKindForPlate) {
    mountPlateLayout = mountPlateLayoutFor(offsetOutline(outline, margin), boreOutline, centre);
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

  const flangeExtent = flangeExtentOf(outline, margin);
  const overallHeight = overallHeightOf(thickness, solution.height, topCapEnabled);

  if ((baseOn || topCapEnabled) && solution.envelopeDiameter > flangeExtent.acrossCorners + 1e-6) {
    problem(
      `Cable outer size (${solution.envelopeDiameter.toFixed(1)} mm, across corners) is bigger than the flange (${flangeExtent.acrossCorners.toFixed(1)} mm, across corners) -- the wound cable would stick out past the flange.`,
    );
  }

  const cable = buildCable(solution.layerResults, wallSpec, spec.windingQuality, resolution, {
    innerEnd: centre,
    topCapEnabled,
    height: solution.height,
    margin,
    tolerance: spec.tolerance,
    bendRadius,
  });
  for (const warning of cable.warnings) problem(warning);

  const baseKeepOut: XY[][] = baseOn ? [
    centre.channelRibbon,
    ...layoutFlangePads(flangeSpec, undefined, mountPlateCut?.anchors, spec.tolerance)
      .filter((pad) => pad.shape.kind !== "collar")
      .map((pad) => pad.footprint),
    ...(mountLayout?.slots ?? []).map((slot) => stadiumPolygon(slot.head, slot.shankEnd, SCREW_MOUNT_HEAD_RADIUS)),
    ...(wantsThrough ? throughHoleKeepOut(layoutFlangeThroughHoles(flangeSpec, centre)) : []),
    ...(flangeSpec.skadis ? skadisClipFootprints(flangeSpec.skadis) : []),
  ].filter((poly) => poly.length >= 3) : [];
  const baseSlot = baseOn ? layoutRimSlot(outline, margin, wireDiameter, spec.tolerance, cable.outerEndU, baseKeepOut, RIM_SLOT_KEEP_OUT) : undefined;
  if (baseOn && !baseSlot) note("The base's rim cable slot doesn't fit anywhere round the rim beside the mount, so it's left out.");
  const coreFlangeSpec = { ...flangeSpec, rimSlot: baseSlot };

  const wall = buildWall(wallSpec);
  const coreMesh = await fuseFlange(wall, coreFlangeSpec, coreJoint, centre, mountPlateCut);
  coreMesh.fadeTriangles = grooveFadeTriangles(coreMesh, wallSpec);

  const parts: Part[] = [{ name: "core", role: "core", mesh: coreMesh, printTransform: { rotateX: 0, translate: [0, 0, 0] } }];

  const { label, fit: labelFit, warning: labelWarning } = await resolveLabel(spec.label, outline, boreOutline, flangeSpec.margin, topCapEnabled);
  if (labelWarning) problem(labelWarning);

  let capSlot: RimSlot | undefined;
  if (topCapEnabled) {
    const labelKeepOut = label ? labelLoops(await getLabelFont(), label).map((loop) => loop.map(([x, y]) => ({ x, y }))) : [];
    capSlot = layoutRimSlot(outline, margin, wireDiameter, spec.tolerance, cable.outerEndU, labelKeepOut, RIM_SLOT_LABEL_KEEP_OUT);
    if (!capSlot) note("The top cap's rim cable slot doesn't fit anywhere round the rim beside the label, so it's left out.");
    const capMesh = await buildTopCap({ flange: coreFlangeSpec, joint: capJoint.joint, tolerance: spec.tolerance, bayonet: capJoint.bayonet, snap: capJoint.snap, label, rimSlot: capSlot, centreNotch: centre.capNotch });
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
    centreInnerEnd: centre,
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
