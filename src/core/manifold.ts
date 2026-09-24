// Fuses the bottom flange onto the grooved wall with manifold-3d (docs/research.md
// §4: "don't boolean the groove", but a flat flange -- and, since issue #9,
// the small joint features below -- are fine manifold booleans).
//
// The flange itself is a direct parametric mesh too (wall.ts's
// `buildOutlineRing`), shaped like the core's own outline extended outward
// by `margin` -- not a bounding circle (issue #6 AC "the flange for
// non-round shapes should follow the offset outline"). Round keeps
// producing a plain circular flange for free, since round's outline IS a
// circle (see shapes.ts).
//
// manifold-3d ships a single-threaded WASM build, so this works without
// COOP/COEP headers (fine for GitHub Pages / `vite preview`).
//
// Issue #9 (top cap, joints, keyhole): `buildTopCap` builds the cap as a
// second manifold part, mirroring the bottom flange (same footprint, via the
// same `buildOutlineRing`) plus an engagement collar that reaches down into
// the core's bore. All three joints (press/bayonet/snap) share ONE circular
// collar centered on the coil axis regardless of the core's own
// round/sq/tri cross-section -- see joints.ts for why. `applyCoreJointCut`
// cuts the matching bayonet groove/entry-slots or snap relief/ridge into the
// core's own top rim; press needs no core-side cut at all (the collar simply
// presses against the bore's existing inner surface). Every feature here is
// built from manifold-3d PRIMITIVES (cylinder/cube + boolean ops), never a
// hand-rolled triangle mesh, so winding/orientation is always correct.

import Module, { type ManifoldToplevel } from "manifold-3d";
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
} from "./constants";
import { jointGeometry } from "./joints";
import { getLabelFont, labelLoops } from "./label";
import type { ResolvedLabel } from "./label";
import { buildOutlineRing } from "./wall";
import { layoutKeyholeMount } from "./mount";
import type { KeyholeSlot } from "./mount";
import { circumscribedRadius, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { CoilMesh, JointKind, MountKind } from "./types";

let wasmPromise: Promise<ManifoldToplevel> | undefined;

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
  /** The wall's own outline at offset 0; the flange's outer edge is this outline offset outward by `margin`. */
  outline: ShapeOutline;
  /** The wall's own bore outline (the flange shares the same bore). */
  boreOutline: ShapeOutline;
  /** How far beyond `outline` the flange extends, mm (docs/research.md §1). */
  margin: number;
  thickness: number;
  /** Columns around the circumference (mirrors WallSpec.columns). */
  columns: number;
  /** Screw-keyhole wall mount (issue #13): cut into the flange's outer (wall-facing, z=-thickness) face when `"keyhole"`. See mount.ts. */
  mount: MountKind;
}

/** What `fuseFlange` needs to cut a bayonet/snap joint's mating feature into the core's own top rim. Press needs no core-side cut, so it's omitted entirely by the caller. */
export interface CoreJointCut {
  boreOutline: ShapeOutline;
  /** Full core height (z of the wall's top rim in the shared assembly frame). */
  height: number;
  joint: Extract<JointKind, "bayonet" | "snap">;
  tolerance: number;
}

type Manifold = InstanceType<ManifoldToplevel["Manifold"]>;

/** Boxes/cylinders repeated at `count` evenly-spaced angles around Z, unioned into one manifold. Every intermediate boolean result is `track()`ed (a real CSG op, unlike a lazy transform chain -- see manifold.ts's own `.add()`/`.subtract()` calls elsewhere), so nothing leaks across the reduce. */
function unionAtAngles(track: <T extends { delete(): void }>(m: T) => T, build: (angleDeg: number) => Manifold, count: number): Manifold {
  let result: Manifold | undefined;
  for (let i = 0; i < count; i++) {
    const m = track(build((360 * i) / count));
    result = result ? track(result.add(m)) : m;
  }
  return result!;
}

/**
 * The collar's welded base, shared by all three joints: a straight cylinder
 * at `collarRadius` for most of `JOINT_ENGAGE_DEPTH`, flaring out to
 * `boreRadius` over the top `JOINT_TRANSITION_HEIGHT` -- flush with the
 * plate's own inner (bore) edge, so the boolean union has a coincident,
 * radius-matched face to weld onto (exactly how the wall/flange fuse
 * already relies on a shared edge, see `fuseFlange` above). Without this,
 * `collarRadius < boreRadius` (always true -- see joints.ts) leaves the
 * collar floating inside the plate's hole, touching nothing: two
 * disconnected solids that both individually pass `status() === "NoError"`
 * but are never actually one part.
 */
function collarBase(wasm: ManifoldToplevel, track: <T extends { delete(): void }>(m: T) => T, collarRadius: number, boreRadius: number, segments: number): Manifold {
  const straightHeight = JOINT_ENGAGE_DEPTH - JOINT_TRANSITION_HEIGHT;
  const straight = track(wasm.Manifold.cylinder(straightHeight, collarRadius, collarRadius, segments, false).translate([0, 0, -JOINT_ENGAGE_DEPTH]));
  // The transition's top radius genuinely OVERLAPS the plate's own bore
  // edge by a small margin (WELD_OVERLAP), rather than exactly matching it:
  // the plate's ring (buildOutlineRing, at `flange.columns` segments) and
  // this cylinder (at a different segment count) trace the same nominal
  // circle with differently-angled vertices, so an EXACT radius match is a
  // razor-thin, non-coincident seam that boolean CSG handles poorly (stray
  // slivers, inflated genus). A real volumetric overlap is robust.
  const transition = track(wasm.Manifold.cylinder(JOINT_TRANSITION_HEIGHT, collarRadius, boreRadius + WELD_OVERLAP, segments, false).translate([0, 0, -JOINT_TRANSITION_HEIGHT]));
  return track(straight.add(transition));
}

/** A box spanning radius [rLo, rHi] and tangential width `width`, at axial [zLo, zHi], rotated to `angleDeg` about Z -- the shared primitive for lugs, entry slots and relief slots (all "a chunk of material/void between two radii, centered on an angle"). */
function radialBox(wasm: ManifoldToplevel, rLo: number, rHi: number, width: number, zLo: number, zHi: number, angleDeg: number): Manifold {
  const { Manifold: M } = wasm;
  const lenX = Math.max(rHi - rLo, 1e-6);
  const h = Math.max(zHi - zLo, 1e-6);
  return M.cube([lenX, width, h], true)
    .translate([lenX / 2, 0, 0])
    .rotate([0, 0, angleDeg])
    .translate([0, 0, (zLo + zHi) / 2]);
}

/**
 * Cut the bayonet's or snap's mating feature into an already-fused core
 * manifold, near its top rim (docs/research.md §1 "Cap joint"; ticket:
 * "3 bayonet lugs + L-slots in the core's top rim"). Bayonet: 3 straight
 * entry slots (open at the top edge) leading into a full twist-lock groove.
 * Snap: a stepped relief (wide everywhere except one narrow retaining ridge
 * band) that a hook's barb must flex past, then springs back under. Skips
 * silently (returns the manifold unchanged) when the bore is too small or
 * the core too short for these features to fit inside the 3 mm wall without
 * breaking through to the wound-cable side -- see JOINT_MIN_BORE_RADIUS.
 */
function applyCoreJointCut(wasm: ManifoldToplevel, track: <T extends { delete(): void }>(m: T) => T, core: Manifold, cut: CoreJointCut): Manifold {
  const { jointRadius, boreRadius } = jointGeometry(cut.boreOutline, cut.joint, cut.tolerance);
  const minHeight = cut.joint === "bayonet" ? BAYONET_LEAD + BAYONET_GROOVE_HEIGHT + 2 : JOINT_ENGAGE_DEPTH + 2;
  if (boreRadius < JOINT_MIN_BORE_RADIUS || cut.height < minHeight) return core;

  const { height } = cut;
  const segments = 48;

  if (cut.joint === "bayonet") {
    const grooveR = jointRadius + BAYONET_LUG_HEIGHT + BAYONET_GAP + 0.1;
    const groove = wasm.Manifold.cylinder(BAYONET_GROOVE_HEIGHT, grooveR, grooveR, segments, false).translate([0, 0, height - BAYONET_LEAD - BAYONET_GROOVE_HEIGHT]);
    const entrySlots = unionAtAngles(
      track,
      (angle) => radialBox(wasm, jointRadius - 1, grooveR + 0.1, BAYONET_LUG_WIDTH + 2 * BAYONET_GAP, height - BAYONET_LEAD - 0.1, height + 1, angle),
      BAYONET_LUG_COUNT,
    );
    // `entrySlots` is already tracked (unionAtAngles tracks its own final reduce step).
    return track(track(core.subtract(track(groove))).subtract(entrySlots));
  }

  // snap: a stepped counterbore -- wide below and above a narrow ridge band.
  // `wideR` is forced comfortably past `boreRadius` (by WELD_OVERLAP): the
  // core's existing bore wall sits exactly at `boreRadius`, and for a
  // non-round bore that's a real FLAT SIDE, not just a point -- a cutter
  // radius only fractions of a mm past it is nearly tangent to that flat
  // side along its whole length, which boolean CSG handles poorly (stray
  // slivers, inflated genus; round has no flat side so it never showed this).
  const wideR = Math.max(jointRadius - SNAP_GAP - cut.tolerance + SNAP_BARB + 0.3, boreRadius + WELD_OVERLAP);
  const ridgeInnerR = jointRadius - 0.1; // matches the finger's own nominal shaft, so the ridge is a real constriction relative to `wideR`
  // The ridge is material ADDED back at this z-band (see ridgeRing below), so
  // -- unlike the WIDE cuts, a harmless no-op wherever it doesn't reach
  // existing solid -- it must reach solid material at EVERY angle or it
  // floats as a disconnected island wherever the bore's corner arcs bulge
  // out past `wideR` (round/sq/tri share one circular collar, but a non-round
  // bore's corners sit farther out than its flat sides: see shapes.ts).
  const ridgeOuterR = Math.max(wideR, circumscribedRadius(cut.boreOutline, 0) + WELD_OVERLAP);
  const ridgeZLo = height - JOINT_ENGAGE_DEPTH + SNAP_BARB_HEIGHT;
  const ridgeZHi = ridgeZLo + SNAP_RIDGE_THICKNESS;
  const wideLower = wasm.Manifold.cylinder(ridgeZLo - (height - JOINT_ENGAGE_DEPTH - 1), wideR, wideR, segments, false).translate([0, 0, height - JOINT_ENGAGE_DEPTH - 1]);
  const wideUpper = wasm.Manifold.cylinder(height + 1 - ridgeZHi, wideR, wideR, segments, false).translate([0, 0, ridgeZHi]);
  const ridgeOuter = wasm.Manifold.cylinder(SNAP_RIDGE_THICKNESS, ridgeOuterR, ridgeOuterR, segments, false).translate([0, 0, ridgeZLo]);
  const ridgeInner = wasm.Manifold.cylinder(SNAP_RIDGE_THICKNESS + 0.2, ridgeInnerR, ridgeInnerR, segments, false).translate([0, 0, ridgeZLo - 0.1]);
  const ridgeRing = track(track(ridgeOuter).subtract(track(ridgeInner))); // the material LEFT BEHIND at the ridge band once the wide cuts remove everything past ridgeInnerR elsewhere
  const wide = track(track(wideLower).add(track(wideUpper)));
  return track(track(core.subtract(wide)).add(ridgeRing));
}

/**
 * The manifold-3d cut for one keyhole slot (mount.ts's layout math): a wide
 * (head) cylinder and a narrow (shank-end) cylinder, joined by a straight
 * channel of the shank's own width -- all cut to `depth` starting at `zBase`
 * (the flange's outer face). Built from primitives + a single extruded
 * rectangle (not `Manifold.hull`, which would smoothly taper the channel to
 * the head's full width instead of stepping down to the narrower rail a
 * real keyhole slot has -- see mount.ts's file header).
 */
function screwMountCutter(wasm: ManifoldToplevel, slot: KeyholeSlot, depth: number, zBase: number) {
  const { Manifold } = wasm;
  const head = Manifold.cylinder(depth, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_HEAD_RADIUS, 32).translate(slot.head.x, slot.head.y, zBase);
  const shankEnd = Manifold.cylinder(depth, SCREW_MOUNT_SHANK_RADIUS, SCREW_MOUNT_SHANK_RADIUS, 32).translate(slot.shankEnd.x, slot.shankEnd.y, zBase);
  const dx = slot.shankEnd.x - slot.head.x;
  const dy = slot.shankEnd.y - slot.head.y;
  const len = Math.hypot(dx, dy);
  const parts = [head, shankEnd];
  if (len > 1e-6) {
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy * SCREW_MOUNT_SHANK_RADIUS;
    const py = ux * SCREW_MOUNT_SHANK_RADIUS;
    const channelPolygon: [number, number][] = [
      [slot.head.x + px, slot.head.y + py],
      [slot.head.x - px, slot.head.y - py],
      [slot.shankEnd.x - px, slot.shankEnd.y - py],
      [slot.shankEnd.x + px, slot.shankEnd.y + py],
    ];
    parts.push(Manifold.extrude([channelPolygon], depth).translate(0, 0, zBase));
  }
  return Manifold.union(parts);
}

/** Fuse a bottom flange (shaped like `flange.outline`, offset out by `flange.margin`) onto the wall, optionally cutting a bayonet/snap joint feature into the top rim, then cutting the screw-keyhole mount (issue #13) into the bottom flange if requested. */
export async function fuseFlange(wall: CoilMesh, flange: FlangeSpec, coreJoint?: CoreJointCut): Promise<CoilMesh> {
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

    const ringMesh = buildOutlineRing(flange.outline, flange.margin, flange.boreOutline, -flange.thickness, 0, flange.columns);
    const ringManifold = track(new Manifold(new Mesh({ numProp: 3, vertProperties: ringMesh.positions, triVerts: ringMesh.indices })));
    if (ringManifold.status() !== "NoError") {
      throw new Error(`Flange mesh is not a valid manifold: ${ringManifold.status()}`);
    }

    let fused = track(wallManifold.add(ringManifold));
    // `applyCoreJointCut` already tracks its own returned manifold (like every other value it constructs) -- don't track it again here.
    if (coreJoint) fused = applyCoreJointCut(wasm, track, fused, coreJoint);

    let status = fused.status();
    if (status !== "NoError") {
      throw new Error(`Fused mesh is not a valid manifold: ${status}`);
    }

    if (flange.mount === "keyhole") {
      const layout = layoutKeyholeMount(flange.outline, flange.boreOutline, flange.margin);
      for (const slot of layout.slots) {
        const cutter = track(screwMountCutter(wasm, slot, layout.recessDepth, -flange.thickness));
        fused = track(fused.subtract(cutter));
        status = fused.status();
        if (status !== "NoError") {
          throw new Error(`Keyhole mount cut is not a valid manifold: ${status}`);
        }
      }
    }

    const outMesh = fused.getMesh();
    return {
      positions: new Float32Array(outMesh.vertProperties),
      indices: new Uint32Array(outMesh.triVerts),
    };
  } finally {
    for (const m of trash) m.delete();
  }
}

export interface TopCapSpec {
  /** Same outline/margin/boreOutline/columns as the bottom FlangeSpec -- the cap is sized to the flange (ticket: "sized to the flange"). */
  flange: FlangeSpec;
  joint: JointKind;
  tolerance: number;
  wireDiameter: number;
  /** Engraved label text (issue #12), already fit-checked by `label.ts`'s `resolveLabel` -- undefined means no label to cut. */
  label?: ResolvedLabel;
}

/**
 * Build the top cap: an annular plate following the core's own outline out
 * to the flange's footprint (mirroring the bottom flange), with a downward
 * engagement collar for the chosen joint and a rim keyhole for the outer
 * cable end. Built entirely in a LOCAL frame (plate z=[0, CAP_THICKNESS],
 * collar z=[-JOINT_ENGAGE_DEPTH, 0]) and translated by the caller into the
 * shared assembly frame -- see design.ts.
 */
export async function buildTopCap(spec: TopCapSpec): Promise<CoilMesh> {
  const wasm = await getWasm();
  const { Manifold, Mesh } = wasm;
  const trash: { delete(): void }[] = [];
  const track = <T extends { delete(): void }>(m: T): T => {
    trash.push(m);
    return m;
  };

  try {
    const { flange, joint, tolerance, wireDiameter, label } = spec;
    const plateMesh = buildOutlineRing(flange.outline, flange.margin, flange.boreOutline, 0, CAP_THICKNESS, flange.columns);
    const plate = track(new Manifold(new Mesh({ numProp: 3, vertProperties: plateMesh.positions, triVerts: plateMesh.indices })));
    if (plate.status() !== "NoError") {
      throw new Error(`Top cap plate mesh is not a valid manifold: ${plate.status()}`);
    }

    const { collarRadius, boreRadius } = jointGeometry(flange.boreOutline, joint, tolerance);
    const segments = 48;

    let collar: Manifold;
    if (joint === "press") {
      collar = collarBase(wasm, track, collarRadius, boreRadius, segments);
    } else if (joint === "bayonet") {
      const base = collarBase(wasm, track, collarRadius, boreRadius, segments);
      const grooveZLo = -BAYONET_LEAD - BAYONET_GROOVE_HEIGHT;
      const grooveZHi = -BAYONET_LEAD;
      // Already tracked (unionAtAngles tracks its own final reduce step).
      const lugs = unionAtAngles(track, (angle) => radialBox(wasm, collarRadius - 1, collarRadius + BAYONET_LUG_HEIGHT, BAYONET_LUG_WIDTH, grooveZLo, grooveZHi, angle), BAYONET_LUG_COUNT);
      collar = track(base.add(lugs));
    } else {
      // snap: a collar with a barb band at its tip (deepest point, LOCAL
      // z=[-JOINT_ENGAGE_DEPTH, -JOINT_ENGAGE_DEPTH+SNAP_BARB_HEIGHT]) and 3
      // axial relief slots cutting it into cantilever fingers.
      const base = collarBase(wasm, track, collarRadius, boreRadius, segments);
      const barbR = collarRadius + SNAP_BARB;
      const barb = track(Manifold.cylinder(SNAP_BARB_HEIGHT, barbR, barbR, segments, false).translate([0, 0, -JOINT_ENGAGE_DEPTH]));
      const withBarb = track(base.add(barb));
      // Already tracked (unionAtAngles tracks its own final reduce step).
      // The slot's radial reach clears the transition frustum's own widened
      // top (collarBase flares out to boreRadius + WELD_OVERLAP), so every
      // finger is fully separated all the way up to the plate, not just
      // through the plain straight section below it.
      const slotOuterR = Math.max(barbR + 0.5, boreRadius + WELD_OVERLAP + 0.5);
      const slots = unionAtAngles(track, (angle) => radialBox(wasm, 0, slotOuterR, SNAP_SLOT_WIDTH, -JOINT_ENGAGE_DEPTH - 0.5, 0.5, angle), SNAP_HOOK_COUNT);
      collar = track(withBarb.subtract(slots));
    }

    const keyholeCutter = track(buildKeyholeCutter(wasm, flange.outline, flange.margin, wireDiameter, tolerance));
    let assembled = track(track(plate.add(collar)).subtract(keyholeCutter));

    if (label) {
      const labelCutter = track(await buildLabelCutter(wasm, label));
      assembled = track(assembled.subtract(labelCutter));
    }

    if (assembled.status() !== "NoError") {
      throw new Error(`Top cap mesh is not a valid manifold: ${assembled.status()}`);
    }

    const outMesh = assembled.getMesh();
    return {
      positions: new Float32Array(outMesh.vertProperties),
      indices: new Uint32Array(outMesh.triVerts),
    };
  } finally {
    for (const m of trash) m.delete();
  }
}

/**
 * The engraved label cutter (issue #12): the fitted text's glyph loops
 * (label.ts's `labelLoops`, already positioned in the plate's own local XY
 * frame), unioned into ONE CrossSection with the "NonZero" fill rule -- this
 * is what turns a solid-contour + hole-contour pair (e.g. "O") into a real
 * ring instead of two overlapping disks, with no separate hole-vs-solid
 * bookkeeping needed on this backend (see label.ts's `classifyLabelLoops`
 * doc comment for why replicad, lacking this primitive, needs that
 * bookkeeping instead). Extruded from just above the plate's own top face
 * (LOCAL z=CAP_THICKNESS -- the room-facing face, see the file header)
 * down by LABEL_DEPTH, poking 1mm past the real top for a clean boolean cut.
 */
async function buildLabelCutter(wasm: ManifoldToplevel, label: ResolvedLabel): Promise<Manifold> {
  const font = await getLabelFont();
  const loops = labelLoops(font, label);
  const cutterHeight = LABEL_DEPTH + 1;
  const cutter = new wasm.CrossSection(loops, "NonZero").extrude(cutterHeight);
  return cutter.translate([0, 0, CAP_THICKNESS - LABEL_DEPTH]);
}

/**
 * A through-cut keyhole in the cap's rim for the outer cable end (ticket:
 * "sized from the cable diameter plus tolerance"): a round hole sized to
 * the cable, set just inside the cap's true outer edge at arc-length t=0
 * (the same reference point every other outline sample uses), connected to
 * that edge by a narrower retaining slit.
 */
function buildKeyholeCutter(wasm: ManifoldToplevel, outline: ShapeOutline, margin: number, wireDiameter: number, tolerance: number): Manifold {
  const { Manifold } = wasm;
  const holeRadius = wireDiameter / 2 + tolerance;
  const slitWidth = wireDiameter * KEYHOLE_SLIT_FRACTION + tolerance;
  const skin = 1; // mm of rim material left outside the hole
  const edge = pointAt(outline, 0, margin); // true outer surface point + outward normal at t=0
  const cx = edge.x - edge.nx * (holeRadius + skin);
  const cy = edge.y - edge.ny * (holeRadius + skin);
  const h = CAP_THICKNESS + 2;
  const zLo = -1;

  const hole = Manifold.cylinder(h, holeRadius, holeRadius, 32, false).translate([cx, cy, zLo]);
  const slitLen = Math.hypot(edge.x - cx, edge.y - cy) + skin + 1;
  const angleDeg = (Math.atan2(edge.ny, edge.nx) * 180) / Math.PI;
  const slit = Manifold.cube([slitLen, slitWidth, h], true)
    .translate([slitLen / 2, 0, 0])
    .rotate([0, 0, angleDeg])
    .translate([cx, cy, zLo + h / 2]);
  return hole.add(slit);
}
