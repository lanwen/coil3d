import Module, { type ManifoldToplevel } from "manifold-3d";
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
  SCREW_MOUNT_LEVEL_OVERLAP,
  SCREW_MOUNT_SLOT_DEPTH,
  SCREW_MOUNT_SLOT_RADIUS,
  SCREW_MOUNT_UNDERCUT_DEPTH,
  SKADIS_CLIP_WIDTH,
  SNAP_SLOT_WIDTH,
  WELD_OVERLAP,
  INNER_CHANNEL_WALL_GUARD,
} from "./constants";
import { jointGeometry } from "./joints";
import type { BayonetLayout, OutlineStack, RevolvedFeature, SnapLayout } from "./joints";
import { getLabelFont, labelLoops } from "./label";
import type { ResolvedLabel } from "./label";
import { chamferedRim, chamferWedgeRows, rimTriangles } from "./edgeChamfer";
import type { RimRow } from "./edgeChamfer";
import { buildOutlineRing } from "./wall";
import { layoutInnerEnd, sweepMesh } from "./innerEnd";
import { FACE_CUT_OVERSHOOT, FACE_DOME_SEGMENTS, FACE_REVOLVE_SEGMENTS } from "./constants";
import { faceCutArcs, faceDipSweep } from "./faceChannel";
import type { FaceCutArc, FaceChannelLayout, FaceEnd } from "./faceChannel";
import type { InnerEndLayout, RimSlot, SweepSolid, XY } from "./innerEnd";
import type { StrapSlot } from "./strapSlot";
import { layoutKeyholeMount, throughHoleCountersink } from "./mount";
import { layoutFlangePads, layoutFlangeThroughHoles, plateTopZ } from "./flangePads";
import { FLAT_FACE_MAX_EDGE, improveFlatFaces } from "./flatFaces";
import { weldShortEdges } from "./weld";
import type { KeyholeSlot, ThroughHole } from "./mount";
import { pegHoleOutline, pegSweep } from "./mountPlate";
import type { AnchorPoint, ClipInstance, MountPlateLayout } from "./mountPlate";
import { clipFrame } from "./skadisClips";
import type { RimClip, SkadisClipLayout } from "./skadisClips";
import { tclipPieceLevels } from "./skadisTclips";
import type { SkadisTclipLayout, Tclip, TclipCutter } from "./skadisTclips";
import { isPill, offsetOutline, outlineColumnParams, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { CoilMesh, JointKind, MountKind } from "./types";

let wasmPromise: Promise<ManifoldToplevel> | undefined;

function coilMeshOf(outMesh: ManifoldMesh): CoilMesh {
  return { positions: new Float32Array(outMesh.vertProperties), indices: new Uint32Array(outMesh.triVerts) };
}

function getWasm(): Promise<ManifoldToplevel> {
  if (!wasmPromise) {
    wasmPromise = Module().then((wasm) => {
      wasm.setup();
      return wasm;
    });
  }
  return wasmPromise;
}

export interface FlangeSpec {
  outline: ShapeOutline;
  boreOutline: ShapeOutline;
  margin: number;
  thickness: number;
  plateThickness?: number;
  columns: number;
  minCornerSegments: number;
  mount: MountKind;
  keyholeRotation?: number;
  throughHoleDiameter?: number;
  skadis?: SkadisClipLayout;
  skadisTclip?: SkadisTclipLayout;
  rimSlot?: RimSlot;
  strapSlots?: StrapSlot[];
}

export interface CoreJointCut {
  boreOutline: ShapeOutline;
  height: number;
  joint: Extract<JointKind, "bayonet" | "snap">;
  tolerance: number;
  bayonet?: BayonetLayout;
  snap?: SnapLayout;
}

export interface InnerEndCut {
  wireDiameter: number;
  tolerance: number;
  bendRadius: number;
  channelDepth: number;
  flangeThickness: number;
}

type Manifold = InstanceType<ManifoldToplevel["Manifold"]>;
type ManifoldMesh = InstanceType<ManifoldToplevel["Mesh"]>;
type Track = <T extends { delete(): void }>(m: T) => T;
type Polygons = [number, number][][];

function revolved(wasm: ManifoldToplevel, track: Track, profile: [number, number][], segments: number, degrees: number): Manifold {
  const section = track(new wasm.CrossSection([profile], "Positive"));
  return track(section.revolve(segments, degrees));
}

function prismAt(wasm: ManifoldToplevel, track: Track, loops: Polygons, fill: "NonZero" | "Positive", height: number, zBase: number): Manifold {
  const section = track(new wasm.CrossSection(loops, fill));
  const prism = track(section.extrude(height));
  return track(prism.translate([0, 0, zBase]));
}

function unionAtAngles(track: Track, build: (angleDeg: number) => Manifold, anglesDeg: number[]): Manifold {
  let result: Manifold | undefined;
  for (const angle of anglesDeg) {
    const m = build(angle);
    result = result ? track(result.add(m)) : m;
  }
  return result!;
}

function collarBase(
  wasm: ManifoldToplevel,
  track: Track,
  collarOutline: ShapeOutline,
  rootOutline: ShapeOutline,
  depth: number,
  segments: number,
  minCornerSegments: number,
): Manifold {
  const straightHeight = depth - JOINT_TRANSITION_HEIGHT / 2;
  const straight = outlinePrismSolid(wasm, track, collarOutline, straightHeight, -depth, segments, minCornerSegments);
  const bottomPts: [number, number, number][] = corners(outlinePolygon(collarOutline, segments, minCornerSegments)).map(([x, y]) => [x, y, -JOINT_TRANSITION_HEIGHT]);
  const topPts: [number, number, number][] = corners(outlinePolygon(rootOutline, segments, minCornerSegments)).map(([x, y]) => [x, y, 0]);
  const transition = track(wasm.Manifold.hull([...bottomPts, ...topPts]));
  return track(straight.add(transition));
}

type PinHoleDirection = 1 | -1;
const INTO_FLANGE = 1;
const INTO_PLATE = -1;
const CYLINDER_SEGMENTS = 32;
const BAYONET_REVOLVE_SEGMENTS = 96;
const BLOCKER_SEGMENTS = 96;
const CUTTER_OVERSHOOT = 1;
const COUNTERSINK_CARRY_DEPTH = 0.5;
const SNAP_SLOT_OVERSHOOT = 0.5;
const DEGENERATE_EXTENT = 1e-6;

export const collarSegments = { round: 144, other: 48 };

function stackSolid(wasm: ManifoldToplevel, track: Track, stack: OutlineStack, columns: number, cornerSegments: number): Manifold {
  const pieces: Manifold[] = [];
  for (let i = 0; i + 1 < stack.length; i++) {
    const pts = [stack[i], stack[i + 1]].flatMap(({ outline, z }) => corners(outlinePolygon(outline, columns, cornerSegments)).map(([x, y]): [number, number, number] => [x, y, z]));
    pieces.push(track(wasm.Manifold.hull(pts)));
  }
  return track(wasm.Manifold.union(pieces));
}

function corners(poly: [number, number][]): [number, number][] {
  return poly.filter((p, i) => {
    const [a, b] = [poly[(i + poly.length - 1) % poly.length], poly[(i + 1) % poly.length]];
    const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
    return Math.abs(cross) > 1e-9 * Math.hypot(b[0] - a[0], b[1] - a[1]);
  });
}

function radialBox(wasm: ManifoldToplevel, track: Track, rLo: number, rHi: number, width: number, zLo: number, zHi: number, angleDeg: number): Manifold {
  const { Manifold: M } = wasm;
  const lenX = Math.max(rHi - rLo, DEGENERATE_EXTENT);
  const h = Math.max(zHi - zLo, DEGENERATE_EXTENT);
  const box = track(M.cube([lenX, width, h], true));
  const shifted = track(box.translate([Math.min(rLo, rHi) + lenX / 2, 0, 0]));
  const turned = track(shifted.rotate([0, 0, angleDeg]));
  return track(turned.translate([0, 0, (zLo + zHi) / 2]));
}

function revolvedFeature(wasm: ManifoldToplevel, track: Track, f: RevolvedFeature, dz: number): Manifold {
  const solid = revolved(wasm, track, f.profile, BAYONET_REVOLVE_SEGMENTS, f.sweepDeg);
  const turned = track(solid.rotate([0, 0, f.startDeg]));
  return track(turned.translate([0, 0, dz]));
}

function applyCoreJointCut(wasm: ManifoldToplevel, track: Track, core: Manifold, cut: CoreJointCut, flange: FlangeSpec): Manifold {
  if (cut.joint === "bayonet") {
    return track(wasm.Manifold.union([core, ...cut.bayonet!.lugs.map((f) => revolvedFeature(wasm, track, f, cut.height))]));
  }

  const { height } = cut;
  const rim = (stack: OutlineStack): OutlineStack => stack.map(({ outline, z }) => ({ outline, z: z + height }));
  const solid = (stack: OutlineStack) => stackSolid(wasm, track, rim(stack), flange.columns, flange.minCornerSegments);
  const rings = cut.snap!.rings.map(({ lip, relief }) => track(solid(lip).subtract(solid(relief))));
  return track(wasm.Manifold.union([core, ...rings]));
}

function slotLevelSolid(wasm: ManifoldToplevel, track: Track, slot: KeyholeSlot, headRadius: number, otherRadius: number, height: number, zLo: number): Manifold {
  const { Manifold } = wasm;
  const head = track(track(Manifold.cylinder(height, headRadius, headRadius, CYLINDER_SEGMENTS)).translate(slot.head.x, slot.head.y, zLo));
  const shankEnd = track(track(Manifold.cylinder(height, otherRadius, otherRadius, CYLINDER_SEGMENTS)).translate(slot.shankEnd.x, slot.shankEnd.y, zLo));
  const dx = slot.shankEnd.x - slot.head.x;
  const dy = slot.shankEnd.y - slot.head.y;
  const len = Math.hypot(dx, dy);
  const parts = [head, shankEnd];
  if (len > DEGENERATE_EXTENT) {
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy * otherRadius;
    const py = ux * otherRadius;
    const channelPolygon: [number, number][] = [
      [slot.head.x + px, slot.head.y + py],
      [slot.head.x - px, slot.head.y - py],
      [slot.shankEnd.x - px, slot.shankEnd.y - py],
      [slot.shankEnd.x + px, slot.shankEnd.y + py],
    ];
    parts.push(prismAt(wasm, track, [channelPolygon], "Positive", height, zLo));
  }
  return track(Manifold.union(parts));
}

function screwMountCutter(wasm: ManifoldToplevel, track: Track, slot: KeyholeSlot, zBase: number): Manifold {
  const mouthZLo = zBase - WELD_OVERLAP;
  const slotLevel = slotLevelSolid(wasm, track, slot, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_SLOT_RADIUS, SCREW_MOUNT_SLOT_DEPTH + WELD_OVERLAP + SCREW_MOUNT_LEVEL_OVERLAP, mouthZLo);
  const undercutLevel = slotLevelSolid(wasm, track, slot, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_UNDERCUT_DEPTH, zBase + SCREW_MOUNT_SLOT_DEPTH);
  return track(wasm.Manifold.union([slotLevel, undercutLevel]));
}

function throughHoleCutter(wasm: ManifoldToplevel, track: Track, hole: ThroughHole, holeRadius: number, flangeThickness: number, zTop: number, plateThickness: number): Manifold {
  const { Manifold } = wasm;
  const straight = track(Manifold.cylinder(flangeThickness + 2 * WELD_OVERLAP, holeRadius, holeRadius, CYLINDER_SEGMENTS));
  const bore = track(straight.translate(hole.x, hole.y, -flangeThickness - WELD_OVERLAP));
  const sink = throughHoleCountersink(holeRadius, plateThickness);
  if (sink.depth <= DEGENERATE_EXTENT) return bore;
  const flared = track(Manifold.cylinder(sink.depth + WELD_OVERLAP + COUNTERSINK_CARRY_DEPTH, holeRadius - COUNTERSINK_CARRY_DEPTH, sink.radius + WELD_OVERLAP, CYLINDER_SEGMENTS));
  const cone = track(flared.translate(hole.x, hole.y, zTop - sink.depth - COUNTERSINK_CARRY_DEPTH));
  return track(Manifold.union([bore, cone]));
}

export interface MountPlateFlangeCut {
  anchors: AnchorPoint[];
  tolerance: number;
}

function rimPrismCutter(wasm: ManifoldToplevel, track: Track, outline: XY[], zLo: number, height: number): Manifold {
  return prismAt(wasm, track, [outline.map((p): [number, number] => [p.x, p.y])], "NonZero", height, zLo);
}

function sweepSolid(wasm: ManifoldToplevel, sweep: SweepSolid): Manifold {
  const mesh = sweepMesh(sweep);
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  if (m.status() !== "NoError") throw new Error(`Cable clip sweep is not a valid manifold: ${m.status()}`);
  return m;
}

function outlineBlocker(wasm: ManifoldToplevel, track: Track, outline: ShapeOutline, zLo: number, zHi: number, segments = BLOCKER_SEGMENTS): Manifold {
  const grown = offsetOutline(outline, INNER_CHANNEL_WALL_GUARD);
  const loop: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const p = pointAt(grown, i / segments, 0);
    loop.push([p.x, p.y]);
  }
  return prismAt(wasm, track, [loop], "NonZero", zHi - zLo, zLo);
}

function buildInnerEndCutter(
  wasm: ManifoldToplevel,
  track: Track,
  outline: ShapeOutline,
  layout: InnerEndLayout,
  cut: InnerEndCut,
): Manifold {
  const raw = track(sweepSolid(wasm, layout.channel));
  const top = Math.max(...layout.channel.rings.flat().map((p) => p.z)) + CUTTER_OVERSHOOT;
  const blocker = outlineBlocker(wasm, track, outline, -cut.flangeThickness - CUTTER_OVERSHOOT, top);
  return track(raw.subtract(blocker));
}

function relieveFlange(
  wasm: ManifoldToplevel,
  track: Track,
  ring: Manifold,
  flange: FlangeSpec,
  innerEnd: InnerEndLayout | undefined,
  mountPlateCut: MountPlateFlangeCut | undefined,
): Manifold {
  const zPlate = plateTopZ(flange);
  if (zPlate === undefined) return ring;
  const pads = layoutFlangePads(flange, innerEnd, mountPlateCut?.anchors, mountPlateCut?.tolerance);
  const padSolid = track(wasm.Manifold.union(pads.map((pad) => track(sweepSolid(wasm, pad.sweep)))));
  const kept = track(rimHull(wasm, flange.outline, chamferWedgeRows(flange.margin, zPlate, -flange.thickness - CUTTER_OVERSHOOT), flange.columns, flange.minCornerSegments));
  return track(ring.intersect(track(kept.add(padSolid))));
}

type Section = [number, number][];

function channelProfile(face: FaceEnd["face"], offset: number, halfWidth: number, level: number, height: number): Section {
  const dome = (from: number, to: number) =>
    Array.from({ length: FACE_DOME_SEGMENTS + 1 }, (_, i): [number, number] => {
      const a = from + ((to - from) * i) / FACE_DOME_SEGMENTS;
      return [offset + halfWidth * Math.cos(a), level + halfWidth * Math.sin(a)];
    });
  if (face === "bottom") {
    return [[offset - halfWidth, -FACE_CUT_OVERSHOOT], [offset + halfWidth, -FACE_CUT_OVERSHOOT], ...dome(0, Math.PI)];
  }
  return [...dome(Math.PI, 2 * Math.PI), [offset + halfWidth, height + FACE_CUT_OVERSHOOT], [offset - halfWidth, height + FACE_CUT_OVERSHOOT]];
}

function faceArcCutter(wasm: ManifoldToplevel, track: Track, arc: FaceCutArc, end: FaceEnd, layout: FaceChannelLayout): Manifold {
  const profile = channelProfile(end.face, arc.radius, layout.channelRadius, end.level, layout.height);
  const degrees = (Math.abs(arc.sweep) * 180) / Math.PI;
  const lowest = (Math.min(arc.from, arc.from + arc.sweep) * 180) / Math.PI;
  const solid = revolved(wasm, track, profile, FACE_REVOLVE_SEGMENTS, degrees);
  const turned = track(solid.rotate([0, 0, lowest]));
  return track(turned.translate([arc.centre.x, arc.centre.y, 0]));
}

function faceChannelCutter(wasm: ManifoldToplevel, track: Track, layout: FaceChannelLayout): Manifold {
  const ends = [...(layout.inner ? [layout.inner] : []), ...(layout.outer ? [layout.outer] : [])];
  const dips = ends.flatMap((end) => {
    const dip = faceDipSweep(end, layout);
    return dip ? [track(sweepSolid(wasm, dip))] : [];
  });
  const pieces = [...dips, ...ends.flatMap((end) => faceCutArcs(end).map((arc) => faceArcCutter(wasm, track, arc, end, layout)))];
  return track(wasm.Manifold.union(pieces));
}

export async function fuseFlange(
  wall: CoilMesh,
  flange: FlangeSpec,
  coreJoint?: CoreJointCut,
  innerEnd?: InnerEndCut,
  mountPlateCut?: MountPlateFlangeCut,
  faceChannels?: FaceChannelLayout,
): Promise<CoilMesh> {
  const wasm = await getWasm();
  const { Manifold, Mesh } = wasm;
  const trash: { delete(): void }[] = [];
  const track = <T extends { delete(): void }>(m: T): T => {
    trash.push(m);
    return m;
  };

  try {
    const wallManifold = track(new Manifold(new Mesh({ numProp: 3, vertProperties: wall.positions, triVerts: wall.indices })));
    if (wallManifold.status() !== "NoError") {
      throw new Error(`Wall mesh is not a valid manifold: ${wallManifold.status()}`);
    }

    const bare = flange.thickness <= 0;

    const innerEndLayout = innerEnd ? layoutInnerEnd(flange.outline, flange.margin, innerEnd.wireDiameter, innerEnd.tolerance, innerEnd.bendRadius, innerEnd.channelDepth) : undefined;
    let fused = wallManifold;
    if (!bare) {
      const ringManifold = flange.skadisTclip
        ? track(rimHull(wasm, flange.outline, chamferedRim(flange.margin, -flange.thickness, 0), flange.columns, flange.minCornerSegments))
        : outlineRingManifold(wasm, track, flange);
      const flangeManifold = relieveFlange(wasm, track, ringManifold, flange, innerEndLayout, mountPlateCut);
      fused = track(wallManifold.add(flangeManifold));
    }
    if (coreJoint) fused = applyCoreJointCut(wasm, track, fused, coreJoint, flange);

    let status = fused.status();
    if (status !== "NoError") {
      throw new Error(`Fused mesh is not a valid manifold: ${status}`);
    }

    if (faceChannels) {
      fused = track(fused.subtract(faceChannelCutter(wasm, track, faceChannels)));
      status = fused.status();
      if (status !== "NoError") {
        throw new Error(`Face channel cut is not a valid manifold: ${status}`);
      }
    }

    if (innerEnd && innerEndLayout) {
      const cutter = buildInnerEndCutter(wasm, track, flange.outline, innerEndLayout, innerEnd);
      fused = track(fused.subtract(cutter));
      status = fused.status();
      if (status !== "NoError") {
        throw new Error(`Inner-end channel/clip cut is not a valid manifold: ${status}`);
      }
    }

    if (flange.mount === "keyhole") {
      const layout = layoutKeyholeMount(flange.outline, flange.boreOutline, flange.margin, flange.keyholeRotation);
      for (const slot of layout.slots) {
        const cutter = screwMountCutter(wasm, track, slot, -flange.thickness);
        fused = track(fused.subtract(cutter));
        status = fused.status();
        if (status !== "NoError") {
          throw new Error(`Keyhole mount cut is not a valid manifold: ${status}`);
        }
      }
    }

    if (flange.mount === "through") {
      const layout = layoutFlangeThroughHoles(flange, innerEndLayout);
      for (const hole of layout.holes) {
        const cutter = throughHoleCutter(wasm, track, hole, layout.holeRadius, flange.thickness, plateTopZ(flange) ?? 0, Math.min(flange.plateThickness ?? flange.thickness, flange.thickness));
        fused = track(fused.subtract(cutter));
        status = fused.status();
        if (status !== "NoError") {
          throw new Error(`Through-hole mount cut is not a valid manifold: ${status}`);
        }
      }
    }

    if (flange.skadis) {
      for (const notch of flange.skadis.notchCutters) {
        const cutter = clipFramePrism(wasm, track, notch.profile, notch.side0, notch.width, flange.skadis.axisDeg);
        fused = track(fused.subtract(cutter));
        status = fused.status();
        if (status !== "NoError") {
          throw new Error(`SKÅDIS notch cut is not a valid manifold: ${status}`);
        }
      }
    }

    if (flange.rimSlot) {
      fused = track(fused.subtract(rimPrismCutter(wasm, track, flange.rimSlot.outline, -flange.thickness - WELD_OVERLAP, flange.thickness + 2 * WELD_OVERLAP)));
      status = fused.status();
      if (status !== "NoError") {
        throw new Error(`Rim slot cut is not a valid manifold: ${status}`);
      }
    }

    for (const slot of flange.strapSlots ?? []) {
      fused = track(fused.subtract(rimPrismCutter(wasm, track, slot.outline, -flange.thickness - WELD_OVERLAP, flange.thickness + 2 * WELD_OVERLAP)));
      status = fused.status();
      if (status !== "NoError") {
        throw new Error(`Strap slot cut is not a valid manifold: ${status}`);
      }
    }

    if (flange.skadisTclip) {
      const hullOf = (cutter: TclipCutter) => track(wasm.Manifold.hull(cutter.levels.flatMap((l) => l.poly.map((p): [number, number, number] => [p.x, p.y, l.z]))));
      const cuts = flange.skadisTclip.cutters.flatMap(({ slot, recess, leadIns }) => {
        const prism = prismAt(wasm, track, recess.pieces.map((poly) => poly.map((p): [number, number] => [p.x, p.y])), "Positive", recess.top - recess.bottom, recess.bottom);
        return [prism, hullOf(slot), ...leadIns.map(hullOf)];
      });
      fused = track(fused.subtract(track(Manifold.union(cuts))));
      status = fused.status();
      if (status !== "NoError") {
        throw new Error(`SKÅDIS T-clip cut is not a valid manifold: ${status}`);
      }
    }

    if (mountPlateCut) {
      for (const anchor of mountPlateCut.anchors) {
        const cutter = pinHoleCutter(wasm, track, anchor, mountPlateCut.tolerance, -flange.thickness, INTO_FLANGE);
        fused = track(fused.subtract(cutter));
        status = fused.status();
        if (status !== "NoError") {
          throw new Error(`Mount plate anchor cut is not a valid manifold: ${status}`);
        }
      }
    }

    const outMesh = track(fused.refineToLength(FLAT_FACE_MAX_EDGE)).getMesh();
    const mesh = improveFlatFaces(
      weldShortEdges(coilMeshOf(outMesh)).mesh,
      { horizontalOnly: true },
    );
    if (bare) return mesh;
    const zPlate = plateTopZ(flange);
    const rim = rimTriangles(mesh, flange.outline, flange.margin, zPlate === undefined ? [[-flange.thickness, 0]] : [[-flange.thickness, 0], [-flange.thickness, zPlate]]);
    return rim ? { ...mesh, rimTriangles: rim } : mesh;
  } finally {
    for (const m of trash) m.delete();
  }
}

export interface TopCapSpec {
  flange: FlangeSpec;
  joint: JointKind;
  tolerance: number;
  bayonet?: BayonetLayout;
  snap?: SnapLayout;
  label?: ResolvedLabel;
  rimSlot?: RimSlot;
  strapSlots?: StrapSlot[];
}

export async function buildTopCap(spec: TopCapSpec): Promise<CoilMesh> {
  const wasm = await getWasm();
  const { Manifold } = wasm;
  const trash: { delete(): void }[] = [];
  const track = <T extends { delete(): void }>(m: T): T => {
    trash.push(m);
    return m;
  };

  try {
    const { flange, joint, tolerance, label, rimSlot, strapSlots, bayonet, snap } = spec;
    const plate = track(rimHull(wasm, flange.outline, chamferedRim(flange.margin, 0, CAP_THICKNESS), flange.columns, flange.minCornerSegments));
    if (plate.status() !== "NoError") {
      throw new Error(`Top cap plate mesh is not a valid manifold: ${plate.status()}`);
    }

    const { collarOutline, holeOutline } = jointGeometry(flange.boreOutline, joint, tolerance);
    const segments = !isPill(collarOutline) && collarOutline.cornerRadius >= collarOutline.apothem - 1e-6 ? collarSegments.round : collarSegments.other;

    const straight = () => outlinePrismSolid(wasm, track, collarOutline, JOINT_ENGAGE_DEPTH + WELD_OVERLAP, -JOINT_ENGAGE_DEPTH, segments, flange.minCornerSegments);
    let collar: Manifold;
    if (joint === "bayonet") {
      const slots = track(Manifold.union(bayonet!.cuts.map((f) => revolvedFeature(wasm, track, f, 0))));
      collar = track(straight().subtract(slots));
    } else if (snap) {
      collar = snapCollar(wasm, track, collarOutline, snap, segments, flange.minCornerSegments);
    } else {
      collar = straight();
    }

    let assembled = track(plate.add(collar));
    if (snap?.hole) {
      assembled = track(assembled.subtract(stackSolid(wasm, track, snap.hole, segments, flange.minCornerSegments)));
    } else if (holeOutline) {
      const hole = outlinePrismSolid(wasm, track, holeOutline, CAP_THICKNESS + JOINT_ENGAGE_DEPTH + 2 * CUTTER_OVERSHOOT, -JOINT_ENGAGE_DEPTH - CUTTER_OVERSHOOT, segments, flange.minCornerSegments);
      assembled = track(assembled.subtract(hole));
    }
    if (rimSlot) assembled = track(assembled.subtract(rimPrismCutter(wasm, track, rimSlot.outline, -WELD_OVERLAP, CAP_THICKNESS + 2 * WELD_OVERLAP)));
    for (const slot of strapSlots ?? []) {
      assembled = track(assembled.subtract(rimPrismCutter(wasm, track, slot.outline, -WELD_OVERLAP, CAP_THICKNESS + 2 * WELD_OVERLAP)));
    }

    let labelId: number | undefined;
    if (label) {
      const labelCutter = track((await buildLabelCutter(wasm, track, label)).asOriginal());
      labelId = labelCutter.originalID();
      assembled = track(assembled.subtract(labelCutter));
    }

    if (assembled.status() !== "NoError") {
      throw new Error(`Top cap mesh is not a valid manifold: ${assembled.status()}`);
    }

    const outMesh = track(assembled.refineToLength(FLAT_FACE_MAX_EDGE)).getMesh();
    const raw = coilMeshOf(outMesh);
    const welded = weldShortEdges(raw);
    const mesh: CoilMesh = improveFlatFaces(welded.mesh);
    mesh.rimTriangles = rimTriangles(mesh, flange.outline, flange.margin, [[0, CAP_THICKNESS]]);
    if (labelId !== undefined) mesh.labelTriangles = weldedLabelTriangles(outMesh, labelId, raw.indices.length / 3, welded.origin);
    return mesh;
  } finally {
    for (const m of trash) m.delete();
  }
}

function weldedLabelTriangles(outMesh: ManifoldMesh, labelId: number, triangleCount: number, weldedOrigin: Uint32Array): Uint32Array {
  const isLabel = new Uint8Array(triangleCount);
  const runIndex = outMesh.runIndex!;
  const runOriginalID = outMesh.runOriginalID!;
  for (let r = 0; r < runOriginalID.length; r++) {
    if (runOriginalID[r] !== labelId) continue;
    for (let t = runIndex[r] / 3; t < runIndex[r + 1] / 3; t++) isLabel[t] = 1;
  }
  const labelTriangles: number[] = [];
  weldedOrigin.forEach((old, t) => {
    if (isLabel[old]) labelTriangles.push(t);
  });
  return new Uint32Array(labelTriangles);
}

async function buildLabelCutter(wasm: ManifoldToplevel, track: Track, label: ResolvedLabel): Promise<Manifold> {
  const font = await getLabelFont();
  const loops = labelLoops(font, label);
  const cutterHeight = LABEL_DEPTH + CUTTER_OVERSHOOT;
  return prismAt(wasm, track, loops, "NonZero", cutterHeight, CAP_THICKNESS - LABEL_DEPTH);
}

function snapCollar(wasm: ManifoldToplevel, track: Track, collarOutline: ShapeOutline, snap: SnapLayout, segments: number, minCornerSegments: number): Manifold {
  const base = collarBase(wasm, track, collarOutline, snap.rootOutline, snap.depth, segments, minCornerSegments);
  const barb = stackSolid(wasm, track, snap.barb, segments, minCornerSegments);
  const withBarb = track(base.add(barb));
  const slots = unionAtAngles(track, (angle) => radialBox(wasm, track, 0, snap.slotOuterRadius, SNAP_SLOT_WIDTH, -snap.depth - SNAP_SLOT_OVERSHOOT, SNAP_SLOT_OVERSHOOT, angle), snap.slotAnglesDeg);
  return track(withBarb.subtract(slots));
}

function outlinePolygon(outline: ShapeOutline, columns: number, minCornerSegments: number): [number, number][] {
  const ts = outlineColumnParams(outline, columns, minCornerSegments);
  return ts.map((t) => {
    const p = pointAt(outline, t, 0);
    return [p.x, p.y] as [number, number];
  });
}

function rimHull(wasm: ManifoldToplevel, outline: ShapeOutline, rows: RimRow[], columns: number, minCornerSegments: number): Manifold {
  const ts = outlineColumnParams(outline, columns, minCornerSegments);
  const pts = rows.flatMap(({ offset, z }) =>
    corners(
      ts.map((t): [number, number] => {
        const p = pointAt(outline, t, offset);
        return [p.x, p.y];
      }),
    ).map(([x, y]): [number, number, number] => [x, y, z]),
  );
  return wasm.Manifold.hull(pts);
}

function outlineRingManifold(wasm: ManifoldToplevel, track: Track, flange: FlangeSpec): Manifold {
  const ringMesh = buildOutlineRing(flange.outline, flange.margin, flange.boreOutline, -flange.thickness, 0, flange.columns, flange.minCornerSegments);
  const ring = track(new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: ringMesh.positions, triVerts: ringMesh.indices })));
  if (ring.status() !== "NoError") {
    throw new Error(`Flange mesh is not a valid manifold: ${ring.status()}`);
  }
  return ring;
}

function outlinePrismSolid(wasm: ManifoldToplevel, track: Track, outline: ShapeOutline, height: number, zBase: number, columns: number, minCornerSegments: number): Manifold {
  return prismAt(wasm, track, [outlinePolygon(outline, columns, minCornerSegments)], "NonZero", height, zBase);
}

function openGridConnectorSolid(wasm: ManifoldToplevel, track: Track): Manifold {
  const size = OPENGRID_PLACEHOLDER_PEG_SIZE;
  const heightWithEmbed = OPENGRID_PLACEHOLDER_PEG_REACH + MOUNT_PLATE_EMBED;
  const cube = track(wasm.Manifold.cube([size, size, heightWithEmbed], true));
  return track(cube.translate([0, 0, (MOUNT_PLATE_EMBED - OPENGRID_PLACEHOLDER_PEG_REACH) / 2]));
}

function mountPlateClipSolid(wasm: ManifoldToplevel, track: Track, clip: ClipInstance, zBase: number): Manifold {
  const connector = openGridConnectorSolid(wasm, track);
  const turned = track(connector.rotate([0, 0, clip.rotationDeg]));
  return track(turned.translate([clip.x, clip.y, zBase]));
}

function pinHoleCutter(wasm: ManifoldToplevel, track: Track, anchor: AnchorPoint, tolerance: number, zFace: number, dir: PinHoleDirection): Manifold {
  const poly: [number, number][] = pegHoleOutline(anchor, tolerance).map((p) => [p.x, p.y]);
  const depthWithMouth = MOUNT_PLATE_PEG_HOLE_DEPTH + MOUNT_PLATE_EMBED;
  const hole = prismAt(wasm, track, [poly], "NonZero", depthWithMouth, -MOUNT_PLATE_EMBED);
  const oriented = dir === INTO_FLANGE ? hole : track(hole.mirror([0, 0, 1]));
  return track(oriented.translate([0, 0, zFace]));
}

export interface MountPlateSpec {
  layout: MountPlateLayout;
  tolerance: number;
  flangeThickness: number;
  columns: number;
  minCornerSegments: number;
  strapSlots?: StrapSlot[];
}

export async function buildMountPlate(spec: MountPlateSpec): Promise<CoilMesh> {
  const wasm = await getWasm();
  const trash: { delete(): void }[] = [];
  const track = <T extends { delete(): void }>(m: T): T => {
    trash.push(m);
    return m;
  };

  try {
    const { layout, tolerance, columns, minCornerSegments, flangeThickness, strapSlots } = spec;
    const plateBackZ = -flangeThickness - MOUNT_PLATE_THICKNESS;
    const plateFrontZ = -flangeThickness;

    let plate = outlinePrismSolid(wasm, track, layout.outline, MOUNT_PLATE_THICKNESS, plateBackZ, columns, minCornerSegments);
    if (plate.status() !== "NoError") {
      throw new Error(`Mount plate panel mesh is not a valid manifold: ${plate.status()}`);
    }

    for (const clip of layout.clips) {
      plate = track(plate.add(mountPlateClipSolid(wasm, track, clip, plateBackZ)));
    }
    for (const anchor of layout.anchors) {
      plate = track(plate.subtract(pinHoleCutter(wasm, track, anchor, tolerance, plateFrontZ, INTO_PLATE)));
    }
    for (const slot of strapSlots ?? []) {
      plate = track(plate.subtract(rimPrismCutter(wasm, track, slot.outline, plateBackZ - WELD_OVERLAP, MOUNT_PLATE_THICKNESS + 2 * WELD_OVERLAP)));
    }

    if (plate.status() !== "NoError") {
      throw new Error(`Mount plate mesh is not a valid manifold: ${plate.status()}`);
    }

    const outMesh = plate.getMesh();
    return weldShortEdges(coilMeshOf(outMesh)).mesh;
  } finally {
    for (const m of trash) m.delete();
  }
}

export async function buildPeg(anchor: AnchorPoint, flangeThickness: number): Promise<CoilMesh> {
  const wasm = await getWasm();
  const peg = sweepSolid(wasm, pegSweep(anchor, -flangeThickness));
  try {
    const outMesh = peg.getMesh();
    return coilMeshOf(outMesh);
  } finally {
    peg.delete();
  }
}

function clipFramePrism(wasm: ManifoldToplevel, track: Track, profile: [number, number][], s0: number, width: number, axisDeg: number): Manifold {
  const { up, side } = clipFrame(axisDeg, s0);
  const section = track(new wasm.CrossSection([profile], "NonZero"));
  const prism = track(section.extrude(width));
  return track(prism.transform([up.x, up.y, 0, 0, 0, 0, 1, 0, side.x, side.y, 0, 0, s0 * side.x, s0 * side.y, 0, 1]));
}

export async function buildSkadisClip(layout: SkadisClipLayout, clip: RimClip): Promise<CoilMesh> {
  const wasm = await getWasm();
  const trash: { delete(): void }[] = [];
  const track = <T extends { delete(): void }>(m: T): T => {
    trash.push(m);
    return m;
  };
  try {
    const placed = clipFramePrism(wasm, track, clip.profile, clip.side - SKADIS_CLIP_WIDTH / 2, SKADIS_CLIP_WIDTH, layout.axisDeg);
    if (placed.status() !== "NoError") throw new Error(`SKÅDIS clip is not a valid manifold: ${placed.status()}`);
    return coilMeshOf(placed.getMesh());
  } finally {
    for (const m of trash) m.delete();
  }
}

export async function buildSkadisTclip(layout: SkadisTclipLayout, clip: Tclip): Promise<CoilMesh> {
  const wasm = await getWasm();
  const hulls = clip.pieces.map((piece) => wasm.Manifold.hull(tclipPieceLevels(layout.axisDeg, clip, piece).flat().map((p): [number, number, number] => [p.x, p.y, p.z])));
  const clipSolid = wasm.Manifold.union(hulls);
  try {
    if (clipSolid.status() !== "NoError") throw new Error(`SKÅDIS T-clip is not a valid manifold: ${clipSolid.status()}`);
    const outMesh = clipSolid.getMesh();
    return coilMeshOf(outMesh);
  } finally {
    for (const h of hulls) h.delete();
    clipSolid.delete();
  }
}
