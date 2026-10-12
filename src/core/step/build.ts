import * as R from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import type { Geom_BSplineSurface, OpenCascadeInstance, TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import { fitPeriodicUClampedV, type BSplineFit, type Vec3 } from "./bspfit";
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
import { faceCutArcs } from "../faceChannel";
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
import { isPill, offsetOutline, outlineColumnParams, polygonVertex } from "../shapes";
import type { ShapeOutline } from "../shapes";
import type { CoreJointCut } from "../manifold";
import type { Design } from "../types";
import { bendMultiplierOf } from "../types";

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

function isRoundOutline(o: ShapeOutline): boolean {
  return o.n === 4 && o.cornerRadius === o.apothem;
}

function outlineSolid(o: ShapeOutline, height: number, zBase: number): R.Shape3D {
  if (isRoundOutline(o)) return R.makeCylinder(o.apothem, height, [0, 0, zBase]);
  return outlineSketch(o, zBase).extrude(height);
}

function outlineLoftSolid(bottomOutline: ShapeOutline, topOutline: ShapeOutline, zBottom: number, zTop: number): R.Shape3D {
  return outlineSketch(bottomOutline, zBottom).loftWith(outlineSketch(topOutline, zTop));
}

function rimLoftSolid(outline: ShapeOutline, rows: RimRow[]): R.Shape3D {
  const [first, ...rest] = rows.map(({ offset, z }) => outlineSketch(offsetOutline(outline, offset), z));
  return first.loftWith(rest, { ruled: true });
}

function outlineSketch(o: ShapeOutline, z: number): R.Sketch {
  if (isRoundOutline(o)) return R.sketchCircle(o.apothem, { plane: "XY", origin: [0, 0, z] });
  if (isPill(o)) {
    const h = o.halfStraight ?? 0;
    const r = o.cornerRadius;
    const pill = R.draw([h, -r]).threePointsArcTo([h, r], [h + r, 0]).lineTo([-h, r]).threePointsArcTo([-h, -r], [-h - r, 0]).close();
    return pill.sketchOnPlane("XY", z) as R.Sketch;
  }
  let pen = R.draw(polygonVertex(o, 0));
  for (let i = 1; i < o.n; i++) {
    pen = pen.lineTo(polygonVertex(o, i)).customCorner(o.cornerRadius);
  }
  const drawing = pen.closeWithCustomCorner(o.cornerRadius);
  return drawing.sketchOnPlane("XY", z) as R.Sketch;
}

function stackSolidStep(stack: OutlineStack, dz = 0): R.Shape3D {
  const [first, ...rest] = stack.map(({ outline, z }) => outlineSketch(outline, z + dz));
  return first.loftWith(rest, { ruled: true });
}

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

function screwMountCutterSolid(slot: KeyholeSlot, zBase: number): R.Shape3D {
  const slotLevel = slotLevelSolid(slot, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_SLOT_RADIUS, SCREW_MOUNT_SLOT_DEPTH, zBase);
  const undercutLevel = slotLevelSolid(slot, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_UNDERCUT_DEPTH, zBase + SCREW_MOUNT_SLOT_DEPTH);
  return slotLevel.fuse(undercutLevel);
}

function throughHoleCutterSolid(hole: ThroughHole, holeRadius: number, flangeThickness: number, zTop: number, plateThickness: number): R.Shape3D[] {
  const throughH = flangeThickness + 2 * THROUGH_HOLE_OVERSHOOT;
  const throughZLo = -flangeThickness - THROUGH_HOLE_OVERSHOOT;
  const bore = R.makeCylinder(holeRadius, throughH, [hole.x, hole.y, throughZLo]);
  const sink = throughHoleCountersink(holeRadius, plateThickness);
  if (sink.depth <= 1e-6) return [bore];
  const coneFoot = zTop - sink.depth - COUNTERSINK_CARRY_INTO_BORE;
  const coneHead = zTop + COUNTERSINK_CARRY_ABOVE_FACE;
  const cone = R.sketchCircle(holeRadius - COUNTERSINK_CARRY_INTO_BORE, { plane: "XY", origin: [hole.x, hole.y, coneFoot] }).loftWith(
    R.sketchCircle(sink.radius + COUNTERSINK_CARRY_ABOVE_FACE, { plane: "XY", origin: [hole.x, hole.y, coneHead] }),
  );
  return [bore, cone];
}

const V_SAMPLES_PER_PITCH = 20;
const MIN_V_SAMPLES = 40;
const SECTOR_COLUMNS = 16;
const FACE_BAND_MARGIN = 0.5;
const FACE_BAND_MIN_MIDDLE = 1;
const WALL_PROBE_DEPTH = 0.3;
const SEWN_FUZZY = 1e-4;
const VOLUME_TOLERANCE = 0.015;
const VALIDATION_VOLUME_PRECISION = 1e-3;
const FUZZY_CUTS = [1e-4, 1e-3, 1e-2];
const CUT_AGREEMENT = 0.01;
const MIN_REMOVED_VOLUME = 1e-6;
const THROUGH_HOLE_OVERSHOOT = 1;
const COUNTERSINK_CARRY_INTO_BORE = 0.5;
const COUNTERSINK_CARRY_ABOVE_FACE = 1;
const TANGENT_PROBE_STEP = 1e-4;
const PLANAR_TOLERANCE = 1e-6;

let oc: OpenCascadeInstance | undefined;
function loadedKernel(): OpenCascadeInstance {
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

function bandSamples(zLo: number, zHi: number, pitch: number): number {
  return Math.max(MIN_V_SAMPLES, Math.round((V_SAMPLES_PER_PITCH * (zHi - zLo)) / pitch) + 1);
}

function cutShape(kernel: OpenCascadeInstance, shape: TopoDS_Shape, tools: TopoDS_Shape[]): R.AnyShape {
  const progress = new kernel.Message_ProgressRange();
  const args = new kernel.NCollection_List_TopoDS_Shape();
  const list = new kernel.NCollection_List_TopoDS_Shape();
  const run = new kernel.BRepAlgoAPI_Cut();
  try {
    args.Append(shape);
    for (const tool of tools) list.Append(tool);
    run.SetArguments(args);
    run.SetTools(list);
    run.SetFuzzyValue(SEWN_FUZZY);
    run.Build(progress);
    if (run.HasErrors()) throw new Error("STEP export: a boolean operation failed");
    const result = run.Shape();
    const cut = R.cast(result);
    result.delete();
    return cut;
  } finally {
    run.delete();
    list.delete();
    args.delete();
    progress.delete();
  }
}

function cutSolid(kernel: OpenCascadeInstance, solid: R.Shape3D, tools: R.Shape3D[]): R.Shape3D {
  return cutShape(kernel, solid.wrapped, tools.map((tool) => tool.wrapped)) as R.Shape3D;
}

function sewnSolidOf(kernel: OpenCascadeInstance, faces: TopoDS_Face[]): R.Shape3D {
  const progress = new kernel.Message_ProgressRange();
  const sewing = new kernel.BRepBuilderAPI_Sewing(1e-3, true, true, true, false);
  for (const face of faces) sewing.Add(face);
  sewing.Perform(progress);
  const sewn = sewing.SewedShape();
  const shell = kernel.TopoDS.Shell(sewn);
  const make = new kernel.BRepBuilderAPI_MakeSolid(shell);
  const rough = make.Solid();
  const fix = new kernel.ShapeFix_Solid(rough);
  fix.Perform(progress);
  const fixed = fix.Solid();
  const solid = R.cast(fixed).asShape3D();
  for (const item of [fixed, fix, rough, make, shell, sewn, sewing, progress]) item.delete();
  return solid;
}

interface FaceBand {
  zLo: number;
  zHi: number;
  sectors: number;
}

function faceBands(layout: FaceChannelLayout, height: number, sectors: number): FaceBand[] {
  const reach = layout.channelRadius + FACE_BAND_MARGIN;
  const splits = [...(layout.inner ? [layout.inner.level + reach] : []), ...(layout.outer ? [layout.outer.level - reach] : [])];
  const separate = splits.length < 2 || splits[1] - splits[0] > FACE_BAND_MIN_MIDDLE;
  const edges = [0, ...(separate ? splits : []), height];
  return edges.slice(1).map((zHi, i) => ({
    zLo: edges[i],
    zHi,
    sectors: (layout.inner !== undefined && i === 0) || (layout.outer !== undefined && i === edges.length - 2) ? sectors : 1,
  }));
}

function faceRings(kernel: OpenCascadeInstance, layout: FaceChannelLayout, boreOutline: ShapeOutline): R.Shape3D[] {
  const grown = offsetOutline(boreOutline, FACE_RING_OVERLAP);
  const hole = (zLo: number, zHi: number) => outlineSolid(layout.holeOutline, zHi - zLo, zLo);
  const over = FACE_CUT_OVERSHOOT;
  const rings: R.Shape3D[] = [];
  if (layout.inner) rings.push(cutSolid(kernel, outlineSolid(grown, layout.bottomThickness + over, -over), [hole(-2 * over, layout.bottomThickness + 2 * over)]));
  if (layout.topThickness !== undefined) {
    const flat = layout.height - layout.topThickness;
    const depth = layout.funnelDepth + FACE_RING_OVERLAP;
    const foot = flat - depth;
    const top = layout.height + over;
    const flared = { ...layout.holeOutline, apothem: layout.holeOutline.apothem + depth, cornerRadius: layout.holeOutline.cornerRadius + depth };
    rings.push(cutSolid(kernel, outlineSolid(grown, top - foot, foot), [outlineLoftSolid(flared, layout.holeOutline, foot, flat), hole(flat - over, top + over)]));
  }
  return rings;
}

function reversedSolid(solid: R.Shape3D): R.Shape3D {
  const reversed = solid.wrapped.Reversed();
  const copy = R.cast(reversed) as R.Shape3D;
  reversed.delete();
  return copy;
}

function faceChannelTube(kernel: OpenCascadeInstance, layout: FaceChannelLayout, profile: WallProfile, ts: number[], wallSpec: WallSpec): R.Shape3D {
  const { boreOutline, height, pitch } = wallSpec;
  const bands = faceBands(layout, height, Math.ceil(ts.length / SECTOR_COLUMNS));
  const fits = bands.map(({ zLo, zHi }) => fitBand(profile, ts, zLo, zHi, bandSamples(zLo, zHi, pitch)));
  const faces = fits.flatMap((fit, i) => bandFaces(kernel, fit, bands[i].sectors));
  const rings = faceRings(kernel, layout, boreOutline);
  const hollow = cutSolid(kernel, outlineSolid(boreOutline, height, 0), rings);
  const atEnd = (face: R.Face, z: number) => face.geomType === "PLANE" && Math.abs(face.center.z - z) < 1e-6;
  const openings = hollow.faces.filter((face) => atEnd(face, 0) || atEnd(face, height));
  const cap = (rim: TopoDS_Face, z: number) =>
    openings.filter((face) => atEnd(face, z)).reduce<TopoDS_Face[]>((pieces, footprint) => pieces.flatMap((piece) => cutShape(kernel, piece, [footprint.wrapped]).faces.map((face) => face.wrapped)), [rim]);
  faces.push(
    ...cap(rimCaps(kernel, fits[0]).bottom, 0),
    ...cap(rimCaps(kernel, fits[fits.length - 1]).top, height),
    ...hollow.faces.filter((face) => !openings.some((opening) => opening.wrapped.IsSame(face.wrapped))).map((face) => face.wrapped),
  );
  const tube = sewnSolidOf(kernel, faces);
  const [x, y, z] = profile.point(ts[0], height / 2);
  const shrink = (Math.hypot(x, y) - WALL_PROBE_DEPTH) / Math.hypot(x, y);
  const oriented = isInside(kernel, tube, { x: x * shrink, y: y * shrink, z }) ? tube : reversedSolid(tube);
  const ends = [layout.inner, layout.outer].filter((end): end is FaceEnd => end !== undefined);
  const tools = ends.map((end) => faceCutArcs(end).map((arc) => faceArcCutterSolid(arc, end, layout)).reduce((all, piece) => all.fuse(piece)));
  const channelled = cutSolid(kernel, oriented, tools);
  for (const solid of [...rings, ...tools, hollow, tube, oriented]) solid.delete();
  return channelled;
}

function fitBand(profile: WallProfile, ts: number[], zLo: number, zHi: number, samples: number): BSplineFit {
  const span = zHi - zLo;
  const tangent = (z0: number, z1: number) => (i: number): Vec3 => {
    const t = ts[i];
    const a = profile.point(t, z0);
    const b = profile.point(t, z1);
    return a.map((v, c) => ((b[c] - v) / (z1 - z0)) * span) as Vec3;
  };
  return fitPeriodicUClampedV(ts, samples, (i, j) => profile.point(ts[i], zLo + (j * span) / (samples - 1)), tangent(zLo, zLo + TANGENT_PROBE_STEP), tangent(zHi - TANGENT_PROBE_STEP, zHi));
}

function array1(kernel: OpenCascadeInstance, values: number[], integers: boolean) {
  const array = new (integers ? kernel.NCollection_Array1_int : kernel.NCollection_Array1_double)(1, values.length);
  values.forEach((value, n) => array.SetValue(n + 1, value));
  return array;
}

function splineSurface(kernel: OpenCascadeInstance, fit: BSplineFit, poleAt: (i: number, k: number) => Vec3, columns: number, uKnots: number[], uMults: number[], periodic: boolean): Geom_BSplineSurface {
  const poles = new kernel.NCollection_Array2_gp_Pnt(1, columns, 1, fit.nvp);
  const point = new kernel.gp_Pnt(0, 0, 0);
  for (let i = 0; i < columns; i++) {
    for (let k = 0; k < fit.nvp; k++) {
      const [x, y, z] = poleAt(i, k);
      point.SetCoord(x, y, z);
      poles.SetValue(i + 1, k + 1, point);
    }
  }
  const knots = [array1(kernel, uKnots, false), array1(kernel, fit.vKnots, false), array1(kernel, uMults, true), array1(kernel, fit.vMults, true)];
  const surface = new kernel.Geom_BSplineSurface(poles, knots[0], knots[1], knots[2], knots[3], 3, 3, periodic, false);
  for (const array of knots) array.delete();
  poles.delete();
  point.delete();
  return surface;
}

function bandSurface(kernel: OpenCascadeInstance, fit: BSplineFit): Geom_BSplineSurface {
  return splineSurface(kernel, fit, (i, k) => fit.pole((i + fit.NU - 1) % fit.NU, k), fit.NU, fit.uKnots, fit.uMults, true);
}

interface PoleSpan {
  knots: number[];
  columns: Vec3[][];
}

function insertKnot({ knots, columns }: PoleSpan, u: number): PoleSpan {
  let k = knots.length - 1;
  while (knots[k] > u) k--;
  const repeats = knots.filter((knot) => knot === u).length;
  const inserted = columns.concat([columns[columns.length - 1]]).map((column, i) => {
    if (i <= k - 3) return columns[i];
    if (i > k - repeats) return columns[i - 1];
    const weight = (u - knots[i]) / (knots[i + 3] - knots[i]);
    return column.map((pole, row) => pole.map((value, axis) => weight * value + (1 - weight) * columns[i - 1][row][axis]) as Vec3);
  });
  return { knots: [...knots.slice(0, k + 1), u, ...knots.slice(k + 1)], columns: inserted };
}

function clampedSpan(span: PoleSpan): PoleSpan {
  const [start, end] = [span.knots[3], span.knots[span.knots.length - 4]];
  let clamped = span;
  for (let i = 0; i < 3; i++) clamped = insertKnot(insertKnot(clamped, start), end);
  return { knots: clamped.knots.slice(3, -3), columns: clamped.columns.slice(3, -3) };
}

function sectorSurface(kernel: OpenCascadeInstance, fit: BSplineFit, first: number, count: number): Geom_BSplineSurface {
  const { NU } = fit;
  const wrap = (i: number) => ((i % NU) + NU) % NU;
  const columns = Array.from({ length: count + 3 }, (_, i) => Array.from({ length: fit.nvp }, (_, k) => fit.pole(wrap(first - 1 + i), k)));
  const knots: number[] = [];
  for (let q = first - 3; q <= first + count + 3; q++) knots.push(fit.uKnots[wrap(q)] + Math.floor(q / NU));
  const span = clampedSpan({ knots, columns });
  const distinct = span.knots.filter((knot, i) => i === 0 || knot !== span.knots[i - 1]);
  const mults = distinct.map((knot) => span.knots.filter((other) => other === knot).length);
  return splineSurface(kernel, fit, (i, k) => span.columns[i][k], span.columns.length, distinct, mults, false);
}

function faceOn(kernel: OpenCascadeInstance, surface: Geom_BSplineSurface): TopoDS_Face {
  const make = new kernel.BRepBuilderAPI_MakeFace(surface, 1e-6);
  const face = make.Face();
  make.delete();
  surface.delete();
  return face;
}

function bandFaces(kernel: OpenCascadeInstance, fit: BSplineFit, sectors: number): TopoDS_Face[] {
  if (sectors <= 1) return [faceOn(kernel, bandSurface(kernel, fit))];
  const per = Math.ceil(fit.NU / sectors);
  const faces: TopoDS_Face[] = [];
  for (let first = 0; first < fit.NU; first += per) faces.push(faceOn(kernel, sectorSurface(kernel, fit, first, Math.min(per, fit.NU - first))));
  return faces;
}

function rimCaps(kernel: OpenCascadeInstance, fit: BSplineFit): { bottom: TopoDS_Face; top: TopoDS_Face } {
  const face = faceOn(kernel, bandSurface(kernel, fit));
  const caps: TopoDS_Face[] = [];
  const edges = new kernel.TopExp_Explorer(face, kernel.TopAbs_ShapeEnum.TopAbs_EDGE, kernel.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; edges.More(); edges.Next()) {
    const current = edges.Current();
    const edge = kernel.TopoDS.Edge(current);
    if (!kernel.BRep_Tool.IsClosed(edge, face)) {
      const wire = new kernel.BRepBuilderAPI_MakeWire(edge);
      const outline = wire.Wire();
      const cap = new kernel.BRepBuilderAPI_MakeFace(outline, true);
      if (!cap.IsDone()) throw new Error("STEP export: planar cap face failed");
      caps.push(cap.Face());
      for (const item of [cap, outline, wire]) item.delete();
    }
    edge.delete();
    current.delete();
  }
  edges.delete();
  face.delete();
  const [first, second] = caps;
  const lower = (R.cast(first) as R.Face).center.z < (R.cast(second) as R.Face).center.z;
  return lower ? { bottom: first, top: second } : { bottom: second, top: first };
}

function wallBandSolid(kernel: OpenCascadeInstance, profile: WallProfile, ts: number[], zLo: number, zHi: number, samples: number): R.Shape3D {
  const fit = fitBand(profile, ts, zLo, zHi, samples);
  const caps = rimCaps(kernel, fit);
  const solid = sewnSolidOf(kernel, [...bandFaces(kernel, fit, 1), caps.bottom, caps.top]);
  return isInside(kernel, solid, { x: 0, y: 0, z: (zLo + zHi) / 2 }) ? solid : reversedSolid(solid);
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
    for (const slot of flangeSpec.strapSlots ?? []) {
      const loop: [number, number][] = slot.outline.map((p) => [p.x, p.y]);
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

function cutsAgree(a: { removed: number }, b: { removed: number }): boolean {
  return Math.abs(a.removed - b.removed) <= CUT_AGREEMENT * Math.max(a.removed, b.removed);
}

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
    if (r && r.removed > MIN_REMOVED_VOLUME) results.push(r);
    if (results.length === 2) {
      const [a, b] = results;
      if (cutsAgree(a, b)) return a.result;
    }
  }
  if (results.length === 0) throw new Error("STEP export: a boolean cut failed (it removed nothing)");
  return results.reduce((m, r) => (r.removed > m.removed ? r : m)).result;
}

function validateSolid(kernel: OpenCascadeInstance, solid: R.Shape3D, mesh: Design["mesh"], name: string): void {
  const analyzer = new kernel.BRepCheck_Analyzer(solid.wrapped, true, false, false);
  const valid = analyzer.IsValid();
  analyzer.delete();
  const solidCount = solid.solids.length;
  const gprops = new kernel.GProp_GProps();
  kernel.BRepGProp.VolumeProperties(solid.wrapped, gprops, VALIDATION_VOLUME_PRECISION, false, false);
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

function collarBaseSolid(collarOutline: ShapeOutline, rootOutline: ShapeOutline, depth: number): R.Shape3D {
  const straightHeight = depth - JOINT_TRANSITION_HEIGHT;
  const straight = outlineSolid(collarOutline, straightHeight, -depth);
  const transition = outlineLoftSolid(collarOutline, rootOutline, -JOINT_TRANSITION_HEIGHT, 0);
  return straight.fuse(transition);
}

function radialBoxSolid(rLo: number, rHi: number, width: number, zLo: number, zHi: number, angleDeg: number): R.Shape3D {
  const box = R.makeBox([Math.min(rLo, rHi), -width / 2, zLo], [Math.max(rLo, rHi), width / 2, zHi]);
  return box.rotate(angleDeg, [0, 0, 0], [0, 0, 1]);
}

function revolvedFeatureSolid(f: RevolvedFeature, dz: number): R.Shape3D {
  const face = R.makePolygon(f.profile.map(([r, z]): [number, number, number] => [r, 0, z + dz]));
  const sketch = new R.Sketch(face.outerWire(), { defaultOrigin: [0, 0, 0], defaultDirection: [0, -1, 0] });
  return sketch.revolve([0, 0, 1], { origin: [0, 0, 0], angle: f.sweepDeg }).rotate(f.startDeg, [0, 0, 0], [0, 0, 1]);
}

function unionAtAngles(build: (angleDeg: number) => R.Shape3D, anglesDeg: number[]): R.Shape3D {
  let result: R.Shape3D | undefined;
  for (const angle of anglesDeg) {
    const m = build(angle);
    result = result ? result.fuse(m) : m;
  }
  return result!;
}

type Point3 = { x: number; y: number; z: number };

const pointTuple = (p: Point3): [number, number, number] => [p.x, p.y, p.z];

const quadAsTriangles = (quad: Point3[]): Point3[][] => [
  [quad[0], quad[1], quad[2]],
  [quad[0], quad[2], quad[3]],
];

function ringStripSolid(rings: Point3[][], sideFaces: (quad: Point3[]) => Point3[][]): R.Shape3D {
  const m = rings[0].length;
  const faces: R.Face[] = [R.makePolygon(rings[0].map(pointTuple)), R.makePolygon(rings[rings.length - 1].map(pointTuple))];
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < m; j++) {
      const quad = [rings[i][j], rings[i][(j + 1) % m], rings[i + 1][(j + 1) % m], rings[i + 1][j]];
      for (const polygon of sideFaces(quad)) faces.push(R.makePolygon(polygon.map(pointTuple)));
    }
  }
  return R.makeSolid(faces);
}

function sweepSolidStep(sweep: SweepSolid): R.Shape3D {
  return ringStripSolid(sweep.rings, quadAsTriangles);
}

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
  const blocker = outlineSolid(offsetOutline(outline, INNER_CHANNEL_WALL_GUARD), top + flangeThickness + 1, -flangeThickness - 1);
  return { cutter: raw.cut(blocker), layout };
}

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

function newellNormal(polygon: Point3[]): Point3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return { x: nx, y: ny, z: nz };
}

function isPlanar(q: Point3[]): boolean {
  const { x: nx, y: ny, z: nz } = newellNormal(q);
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-12) return false;
  const c = q.reduce((s, p) => ({ x: s.x + p.x / q.length, y: s.y + p.y / q.length, z: s.z + p.z / q.length }), { x: 0, y: 0, z: 0 });
  return q.every((p) => Math.abs(((p.x - c.x) * nx + (p.y - c.y) * ny + (p.z - c.z) * nz) / l) < PLANAR_TOLERANCE);
}

const planarOrAsTriangles = (quad: Point3[]): Point3[][] => (isPlanar(quad) ? [quad] : quadAsTriangles(quad));

function padSolidStep(pad: FlangePad, levels: number[], outline: ShapeOutline): R.Shape3D {
  const { shape } = pad;
  let sketches: R.Sketch[];
  if (shape.kind === "collar") {
    sketches = levels.map((z) => outlineSketch(offsetOutline(outline, offsetAtZ(shape.offset, z)), z));
  } else if (shape.kind === "stadium") {
    sketches = levels.map((z) => stadiumSketch(shape.a, shape.b, offsetAtZ(shape.radius, z), z));
  } else {
    return ringStripSolid(pad.sweep.rings, planarOrAsTriangles);
  }
  return sketches[0].loftWith(sketches.slice(1), { ruled: true });
}

function relieveFlangeSolid(kernel: OpenCascadeInstance, flange: R.Shape3D, flangeSpec: Design["flangeSpec"], innerEnd: InnerEndLayout, anchors: AnchorPoint[], tolerance: number): R.Shape3D {
  const zPlate = plateTopZ(flangeSpec);
  if (zPlate === undefined) return flange;
  const levels = padLevels(zPlate);
  const pads = layoutFlangePads(flangeSpec, innerEnd, anchors, tolerance).map((pad) => padSolidStep(pad, levels, flangeSpec.outline));
  const padSolid = pads.slice(1).reduce((all, pad) => all.fuse(pad), pads[0]);
  const slab = outlineSolid(offsetOutline(flangeSpec.outline, flangeSpec.margin + 1), 1 - zPlate + SLAB_BELOW_FACE, zPlate - SLAB_BELOW_FACE);
  const keptFrustum = rimLoftSolid(flangeSpec.outline, chamferWedgeRows(flangeSpec.margin, zPlate));
  return checkedCut(kernel, flange, checkedCut(kernel, checkedCut(kernel, slab, keptFrustum), padSolid));
}

function applyCoreJointCutSolid(core: R.Shape3D, cut: CoreJointCut): R.Shape3D {
  if (cut.joint === "bayonet") {
    return cut.bayonet!.lugs.reduce((solid, f) => solid.fuse(revolvedFeatureSolid(f, cut.height)), core);
  }

  return cut.snap!.rings.reduce((solid, { lip, relief }) => solid.fuse(stackSolidStep(lip, cut.height).cut(stackSolidStep(relief, cut.height))), core);
}

function labelLoopSolid(loop: LabelLoop, height: number, zBase: number): R.Shape3D {
  const face = R.makePolygon(loop.map(([x, y]): [number, number, number] => [x, y, zBase]));
  const sketch = new R.Sketch(face.outerWire(), { defaultOrigin: [0, 0, zBase], defaultDirection: [0, 0, 1] });
  return sketch.extrude(height);
}

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

async function buildTopCapSolid(design: Design): Promise<R.Shape3D> {
  const { flangeSpec, spec, solution } = design;
  const plate = rimLoftSolid(flangeSpec.outline, chamferedRim(flangeSpec.margin, 0, CAP_THICKNESS));

  const capJoint = resolveCapJoint(spec, design.wallSpec);
  const { collarOutline, holeOutline } = jointGeometry(flangeSpec.boreOutline, capJoint.joint, spec.tolerance);
  const straight = () => outlineSolid(collarOutline, JOINT_ENGAGE_DEPTH + WELD_OVERLAP, -JOINT_ENGAGE_DEPTH);
  const snap = capJoint.snap;

  let collar: R.Shape3D;
  if (capJoint.joint === "bayonet") {
    collar = capJoint.bayonet!.cuts.reduce((solid, f) => solid.cut(revolvedFeatureSolid(f, 0)), straight());
  } else if (snap) {
    const withBarb = collarBaseSolid(collarOutline, snap.rootOutline, snap.depth).fuse(stackSolidStep(snap.barb));
    const slots = unionAtAngles((a) => radialBoxSolid(0, snap.slotOuterRadius, SNAP_SLOT_WIDTH, -snap.depth - 0.5, 0.5, a), snap.slotAnglesDeg);
    collar = withBarb.cut(slots);
  } else {
    collar = straight();
  }

  let assembled = plate.fuse(collar);
  if (snap?.hole) assembled = assembled.cut(stackSolidStep(snap.hole));
  else if (holeOutline) assembled = assembled.cut(outlineSolid(holeOutline, CAP_THICKNESS + JOINT_ENGAGE_DEPTH + 2, -JOINT_ENGAGE_DEPTH - 1));

  const { label } = await resolveLabel(spec.label, flangeSpec.outline, flangeSpec.boreOutline, flangeSpec.margin, solution.topCapEnabled);
  if (label) {
    const labelCutter = await buildLabelCutterSolid(label);
    if (labelCutter) assembled = assembled.cut(labelCutter);
  }

  const slot = design.rimSlots.cap;
  if (slot) {
    const loop: [number, number][] = slot.outline.map((p) => [p.x, p.y]);
    assembled = checkedCut(loadedKernel(), assembled, loopSolid(loop, CAP_THICKNESS + 2 * WELD_OVERLAP).translate([0, 0, -WELD_OVERLAP]));
  }

  for (const slot of design.strapSlots.cap) {
    const loop: [number, number][] = slot.outline.map((p) => [p.x, p.y]);
    assembled = checkedCut(loadedKernel(), assembled, loopSolid(loop, CAP_THICKNESS + 2 * WELD_OVERLAP).translate([0, 0, -WELD_OVERLAP]));
  }

  return assembled.translate([0, 0, solution.height]);
}

function loopSolid(loop: [number, number][], height: number): R.Shape3D {
  const face = R.makePolygon(loop.map(([x, y]): [number, number, number] => [x, y, 0]));
  const sketch = new R.Sketch(face.outerWire(), { defaultOrigin: [0, 0, 0], defaultDirection: [0, 0, 1] });
  return sketch.extrude(height);
}

function openGridConnectorSolidStep(): R.Shape3D {
  const s = OPENGRID_PLACEHOLDER_PEG_SIZE;
  return R.makeBox([-s / 2, -s / 2, -OPENGRID_PLACEHOLDER_PEG_REACH], [s / 2, s / 2, MOUNT_PLATE_EMBED]);
}

function mountPlateClipSolidStep(clip: ClipInstance, zBase: number): R.Shape3D {
  return openGridConnectorSolidStep().rotate(clip.rotationDeg, [0, 0, 0], [0, 0, 1]).translate([clip.x, clip.y, zBase]);
}

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

function pinHoleCutterSolid(anchor: AnchorPoint, tolerance: number, zFace: number, dir: 1 | -1): R.Shape3D {
  const loop: [number, number][] = pegHoleOutline(anchor, tolerance).map((p) => [p.x, p.y]);
  const h = MOUNT_PLATE_PEG_HOLE_DEPTH + MOUNT_PLATE_EMBED;
  const z0 = dir === 1 ? zFace - MOUNT_PLATE_EMBED : zFace + MOUNT_PLATE_EMBED - h;
  return loopSolid(loop, h).translate([0, 0, z0]);
}

function buildMountPlateSolid(design: Design): R.Shape3D {
  const { flangeSpec, spec } = design;
  const layout = mountPlateLayoutFor(design);
  const backZ = -flangeSpec.thickness - MOUNT_PLATE_THICKNESS;
  const frontZ = -flangeSpec.thickness;

  let plate = outlineSolid(layout.outline, MOUNT_PLATE_THICKNESS, backZ);
  for (const clip of layout.clips) plate = plate.fuse(mountPlateClipSolidStep(clip, backZ));
  for (const anchor of layout.anchors) plate = plate.cut(pinHoleCutterSolid(anchor, spec.tolerance, frontZ, -1));
  for (const slot of design.strapSlots.mountPlate) {
    const loop: [number, number][] = slot.outline.map((p) => [p.x, p.y]);
    plate = checkedCut(loadedKernel(), plate, loopSolid(loop, MOUNT_PLATE_THICKNESS + 2 * WELD_OVERLAP).translate([0, 0, backZ - WELD_OVERLAP]));
  }
  return plate;
}

function ruledLoft(levels: Array<Array<[number, number, number]>>): R.Shape3D {
  const sketches = levels.map((pts) => new R.Sketch(R.makePolygon(pts).outerWire()));
  const [first, ...rest] = sketches;
  return first.loftWith(rest, { ruled: true });
}

function skadisTclipSolid(layout: SkadisTclipLayout, clip: Tclip): R.Shape3D {
  const [first, ...rest] = clip.pieces.map((piece) => ruledLoft(tclipPieceLevels(layout.axisDeg, clip, piece).map((level) => level.map((p): [number, number, number] => [p.x, p.y, p.z]))));
  return rest.reduce((acc, r) => acc.fuse(r), first);
}
