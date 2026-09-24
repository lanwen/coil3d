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
  OPENGRID_PLACEHOLDER_PEG_REACH,
  OPENGRID_PLACEHOLDER_PEG_SIZE,
  SCREW_MOUNT_HEAD_RADIUS,
  SCREW_MOUNT_SHANK_RADIUS,
  SKADIS_CLIP_HEIGHT,
  SKADIS_CLIP_PROFILE,
  SKADIS_CLIP_PROFILE_CHAMFERED,
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
import { layoutInnerEnd } from "./innerEnd";
import type { InnerEndLayout, XY } from "./innerEnd";
import { layoutKeyholeMount } from "./mount";
import type { KeyholeSlot } from "./mount";
import type { AnchorPoint, ClipInstance, MountPlateLayout } from "./mountPlate";
import { circumscribedRadius, offsetOutline, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { CoilMesh, JointKind, MountKind, PlateJoint } from "./types";

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

/**
 * What `fuseFlange` needs to cut the bottom-flange inner-end fixing (issue
 * #8): the rim keyhole for the inner cable end, through the flange's full
 * thickness, plus a recessed radial channel from that keyhole to the wall's
 * own groove start on the flange's inner (z=0) face. Always present (unlike
 * the mount, this isn't user-optional -- every core has a bottom flange and
 * every bottom flange gets this feature), so design.ts always passes one.
 */
export interface InnerEndCut {
  wireDiameter: number;
  tolerance: number;
  /** The wire's own minimum bend radius (bendMultiplier * wireDiameter, see types.ts's `bendMultiplierOf`); the channel's fillet uses as much of this as the flange margin allows, see innerEnd.ts. */
  bendRadius: number;
  /** Depth of the channel recess below the flange's inner (z=0) face, mm. */
  channelDepth: number;
  /** The flange's own thickness, mm -- the channel/keyhole cutters use this to stay within it (the keyhole cuts all the way through; the channel only partway). */
  flangeThickness: number;
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

/** What `fuseFlange` needs to cut the clip mount plate's own alignment pegs/holes or snap pockets into the flange's outer (wall-facing) face (issue #14) -- mirrors `CoreJointCut`'s "one shared description, cut by whichever backend needs it" role. Omitted entirely when the plate has no anchors to cut for (see mountPlate.ts's `MountPlateLayout.anchors`). */
export interface MountPlateFlangeCut {
  anchors: AnchorPoint[];
  plateJoint: PlateJoint;
  tolerance: number;
}

/**
 * The channel trench cutter: `innerEnd.ts`'s `channelRibbon` (a single flat
 * 2D polygon tracing the whole trench outline, already channel-width wide
 * and in the flange's local XY, computed ANALYTICALLY -- see its own doc
 * comment for why), extruded ONCE. An earlier version built this from a
 * chain of overlapping cylinders+boxes unioned one at a time (the standard
 * "stroke a polyline" technique) -- replicad's equivalent chain of `fuse()`
 * calls was found to occasionally produce an invalid BRep after ~20
 * sequential fuses, so both backends now extrude one shared polygon
 * instead, which is simpler here too. Returns `undefined` for a degenerate
 * (near-zero-area) ribbon -- the "impossible" bend-radius fallback
 * (innerEnd.ts's D<=0 case) can collapse to almost nothing, with no
 * meaningful trench to cut; the keyhole is still cut regardless.
 */
function channelCutter(wasm: ManifoldToplevel, ribbon: XY[], zLo: number, zHi: number): Manifold | undefined {
  if (ribbon.length < 3) return undefined;
  const loop: [number, number][] = ribbon.map((p) => [p.x, p.y]);
  return new wasm.CrossSection([loop], "NonZero").extrude(zHi - zLo).translate([0, 0, zLo]);
}

/**
 * A solid matching the wall's own outline (round/sq/tri) at offset 0,
 * spanning [zLo, zHi] -- protects the wall's own footprint (and, being a
 * strict subset of it, the bore inside) from the channel cutter: the
 * channel's WIDTH (channelWidth scales with wire diameter, and can exceed
 * WALL_THICKNESS for a heavy cord) extends radially on BOTH sides of its
 * centreline, including at the "groove" end where the centreline itself
 * sits exactly on the wall's own outer surface by design -- without this
 * clip, a wide-enough channel reaches past the wall into the bore's own
 * void, wiring the exterior (already reachable through the keyhole) to that
 * void a SECOND, independent way and adding a genus the part shouldn't
 * have (reproduced directly: an 8mm cable on a 60mm round core gave the
 * core's bore a spurious genus of 2, not 1, before this clip).
 *
 * Sampled at `outline` offset by WELD_OVERLAP (not 0): the channel's own
 * closing edge at the groove end sits EXACTLY on the wall's true outline by
 * construction (innerEnd.ts), so clipping against that same outline
 * unmodified is another razor-thin, exactly-coincident seam -- mirrors this
 * file's own `collarBase` reasoning, and step/build.ts's matching offset on
 * its own STEP-side blocker (needed there to avoid an outright invalid
 * BRep, not just a stray sliver).
 */
function outlineBlocker(wasm: ManifoldToplevel, outline: ShapeOutline, zLo: number, zHi: number, segments = 96): Manifold {
  const grown = offsetOutline(outline, WELD_OVERLAP);
  const loop: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const p = pointAt(grown, i / segments, 0);
    loop.push([p.x, p.y]);
  }
  return new wasm.CrossSection([loop], "NonZero").extrude(zHi - zLo).translate([0, 0, zLo]);
}

/**
 * The bottom flange's own inner-end fixing (issue #8): a rim keyhole (same
 * hole+narrower-retaining-slit shape as `buildKeyholeCutter`'s top-cap
 * keyhole, but cut all the way THROUGH the flange's full thickness -- there
 * is no separate outer face to stop at here) unioned with the recessed
 * channel trench (a shallow `strokePath` cut from the flange's inner, z=0
 * face, CLIPPED to stay outside the wall's own outline -- see
 * `outlineBlocker`) leading to the wall's own groove start. Both share ONE
 * `layoutInnerEnd` call, so the hole/slit and the channel's own starting
 * point can never disagree about where the keyhole actually is.
 */
function buildInnerEndCutter(
  wasm: ManifoldToplevel,
  track: <T extends { delete(): void }>(m: T) => T,
  outline: ShapeOutline,
  margin: number,
  cut: InnerEndCut,
): { cutter: Manifold; layout: InnerEndLayout } {
  const { Manifold } = wasm;
  const layout = layoutInnerEnd(outline, margin, cut.wireDiameter, cut.tolerance, cut.bendRadius);
  const { hole, edge, holeRadius, slitWidth, channelRibbon } = layout;

  const throughH = cut.flangeThickness + 2;
  const throughZLo = -cut.flangeThickness - 1;
  const holeM = track(Manifold.cylinder(throughH, holeRadius, holeRadius, 32, false).translate([hole.x, hole.y, throughZLo]));
  const dx = edge.x - hole.x;
  const dy = edge.y - hole.y;
  const len = Math.hypot(dx, dy);
  let keyhole = holeM;
  if (len > 1e-6) {
    const slitLen = len + 1; // reaches 1mm past the true edge, same convention as buildKeyholeCutter's own slit
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const slit = track(
      Manifold.cube([slitLen, slitWidth, throughH], true)
        .translate([slitLen / 2, 0, 0])
        .rotate([0, 0, angleDeg])
        .translate([hole.x, hole.y, throughZLo + throughH / 2]),
    );
    keyhole = track(holeM.add(slit));
  }

  // The channel recess only cuts partway (channelDepth below z=0), poking
  // 1mm above the flange's inner face for a clean boolean cut -- mirrors
  // buildLabelCutter's own "poke past the real surface" convention. Clipped
  // to stay outside the wall's own outline -- see `outlineBlocker`.
  const rawChannel = channelCutter(wasm, channelRibbon, -cut.channelDepth, 1);
  if (!rawChannel) return { cutter: keyhole, layout };
  track(rawChannel);
  const blocker = track(outlineBlocker(wasm, outline, -cut.channelDepth - 1, 2));
  const channel = track(rawChannel.subtract(blocker));

  return { cutter: track(keyhole.add(channel)), layout };
}

/** Fuse a bottom flange (shaped like `flange.outline`, offset out by `flange.margin`) onto the wall, cutting its own inner-end fixing (issue #8: rim keyhole + recessed channel, always present), optionally a bayonet/snap joint feature into the top rim, then the screw-keyhole mount (issue #13) or the clip mount plate's alignment features (issue #14) if requested. */
export async function fuseFlange(
  wall: CoilMesh,
  flange: FlangeSpec,
  coreJoint?: CoreJointCut,
  innerEnd?: InnerEndCut,
  mountPlateCut?: MountPlateFlangeCut,
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

    if (innerEnd) {
      // `cutter` is already tracked (buildInnerEndCutter tracks every
      // intermediate it builds internally) -- don't track it again here.
      const { cutter } = buildInnerEndCutter(wasm, track, flange.outline, flange.margin, innerEnd);
      fused = track(fused.subtract(cutter));
      status = fused.status();
      if (status !== "NoError") {
        throw new Error(`Inner-end keyhole/channel cut is not a valid manifold: ${status}`);
      }
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

    // Issue #14: the clip mount plate's own alignment pegs (glue) or snap
    // tabs (snap) mate with a shallow hole/pocket cut into this SAME
    // outer face -- see `mountPlateAnchorCutter` and `buildMountPlate`
    // below (the plate itself is a SEPARATE part, built by `buildMountPlate`,
    // not fused here).
    if (mountPlateCut) {
      for (const anchor of mountPlateCut.anchors) {
        const cutter = track(mountPlateAnchorCutter(wasm, anchor, mountPlateCut.plateJoint, mountPlateCut.tolerance, -flange.thickness));
        fused = track(fused.subtract(cutter));
        status = fused.status();
        if (status !== "NoError") {
          throw new Error(`Mount plate anchor cut is not a valid manifold: ${status}`);
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

// --- Clip mount plate (issue #14, docs/research.md §1 "Wall mounting" +
// §10b "SKÅDIS clip") -------------------------------------------------
//
// The plate is a SEPARATE part (see `buildMountPlate`): a flat panel shaped
// like `mountPlate.ts`'s own `MountPlateLayout.outline`, sitting flush
// against the flange's outer (wall-facing) face. In the shared ASSEMBLY
// frame (matching `FlangeSpec`'s own z=[-thickness,0] convention -- see
// this file's header), the panel occupies
// z=[-flangeThickness-MOUNT_PLATE_THICKNESS, -flangeThickness]: its FRONT
// (mating) face flush against the flange's own outer face at
// z=-flangeThickness, its BACK face (bearing the pegboard clips, reaching
// further outward into more-negative z) at
// z=-flangeThickness-MOUNT_PLATE_THICKNESS. Glue pegs/snap tabs protrude the
// OTHER way, from the front face into a shallow hole/pocket cut into the
// flange (z increasing from -flangeThickness, i.e. INTO the flange body).
//
// Every clip/anchor is built in a CANONICAL local frame first (local +X =
// "up", local +Y = "side", local -Z = "reach", flush base at Z=0) then
// rotated about Z by `ClipInstance.rotationDeg`/`AnchorPoint.rotationDeg`
// (mountPlate.ts's file header: `90 - axisDeg`, the same value for every
// clip/anchor in one layout) and translated to its own true (x, y, zBase) --
// this mirrors `radialBox`'s own "rotate a canonical primitive, don't
// hand-rotate its vertices" pattern above.

/** A closed 2D polygon sampling `outline`'s own boundary (offset 0) -- the mount plate panel has NO bore (unlike the wall/flange's ring, `buildOutlineRing`), so a plain `CrossSection` extrude is enough. */
function outlinePolygon(outline: ShapeOutline, columns: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let ci = 0; ci < columns; ci++) {
    const p = pointAt(outline, ci / columns, 0);
    pts.push([p.x, p.y]);
  }
  return pts;
}

/** A solid prism of `outline`'s own footprint, extruded from `zBase` up by `height`. */
function outlinePrismSolid(wasm: ManifoldToplevel, outline: ShapeOutline, height: number, zBase: number, columns: number): Manifold {
  const poly = outlinePolygon(outline, columns);
  return new wasm.CrossSection([poly], "NonZero").extrude(height).translate([0, 0, zBase]);
}

/**
 * One SKÅDIS clip PAIR (docs/research.md §10b; constants.ts's
 * `SKADIS_CLIP_PROFILE` doc comment for the mechanism and the reimplement-
 * not-copy note), in the canonical local frame described above. The profile
 * is a 2D loop in the (side, reach) plane -- built here as (local X, local
 * Y) so `CrossSection.extrude` can sweep it along local Z by
 * `SKADIS_CLIP_HEIGHT` -- then rotated -90 degrees about local X (so the
 * extrusion axis becomes local Y, and the profile's own reach axis becomes
 * local -Z: base flush at Z=0, tip at the most negative Z) and a further
 * -90 degrees about local Z. That last step swaps this construction's own
 * (side, height) axes into this file's shared canonical frame (local +X =
 * "up", local +Y = "side" -- every OTHER clip/anchor solid in this file
 * builds directly into that frame, but a hook's own natural build order
 * produces (X=side, Y=height) instead); it relies on the pair being
 * mirror-symmetric about side=0 (built into the profile below) to make the
 * resulting side-sign flip harmless. Getting this rotation wrong is exactly
 * the issue #14 PR review round 2 bug: a previous version omitted it, so
 * `SKADIS_CLIP_HEIGHT` (meant to run along WALL_UP) rendered horizontally
 * instead. Mirrored about local X=0 (research.md: "extruded 12mm and
 * mirrored" -- the PAIR's own two legs, not two separate grid positions,
 * per constants.ts's own doc comment) for one symmetric, spring-loaded pair.
 * `chamfered` selects constants.ts's `SKADIS_CLIP_PROFILE_CHAMFERED` for
 * every row except the lowest one (issue #14 AC: "chamfer the lower rows
 * at 45").
 */
function skadisHookSolid(wasm: ManifoldToplevel, chamfered: boolean): Manifold {
  const profile = chamfered ? SKADIS_CLIP_PROFILE_CHAMFERED : SKADIS_CLIP_PROFILE;
  const rightLoop: [number, number][] = profile.map(([s, r]): [number, number] => [s, r]);
  const leftLoop: [number, number][] = profile.map(([s, r]): [number, number] => [-s, r]).reverse();
  const solid = new wasm.CrossSection([rightLoop, leftLoop], "NonZero").extrude(SKADIS_CLIP_HEIGHT);
  // MOUNT_PLATE_EMBED shifts the whole hook slightly further INTO the
  // panel (see that constant's doc comment): without it, the hook's own
  // base sits EXACTLY flush with the panel's back face, a razor-thin
  // coincident seam that this file's boolean union resolves unreliably at
  // this feature size (empirically: a disconnected, wrongly-oriented
  // "ghost" copy of the hook, passing `status()`/`genus()` but failing a
  // `decompose()` connected-component count -- see test/mountPlate.test.ts).
  return solid
    .translate([0, 0, -SKADIS_CLIP_HEIGHT / 2])
    .rotate([-90, 0, 0])
    .rotate([0, 0, -90])
    .translate([0, 0, MOUNT_PLATE_EMBED]);
}

/** The openGrid placeholder connector (constants.ts's `OPENGRID_PLACEHOLDER_PEG_SIZE` TODO): a plain square peg in the same canonical local frame, base flush at Z=0, reaching to local -Z. Embedded into the panel by `MOUNT_PLATE_EMBED` -- see `skadisHookSolid`'s comment. */
function openGridConnectorSolid(wasm: ManifoldToplevel): Manifold {
  const s = OPENGRID_PLACEHOLDER_PEG_SIZE;
  const h = OPENGRID_PLACEHOLDER_PEG_REACH + MOUNT_PLATE_EMBED; // spans local Z=[-REACH, +EMBED] once centered and shifted below
  return wasm.Manifold.cube([s, s, h], true).translate([0, 0, (MOUNT_PLATE_EMBED - OPENGRID_PLACEHOLDER_PEG_REACH) / 2]);
}

/** One clip instance (hook or placeholder connector), placed at its own true (x, y) and rotated onto the layout's up/side axes -- see the file header. */
function mountPlateClipSolid(wasm: ManifoldToplevel, mountKind: Extract<MountKind, "skadis" | "opengrid">, clip: ClipInstance, zBase: number): Manifold {
  const canonical = mountKind === "skadis" ? skadisHookSolid(wasm, !clip.plain) : openGridConnectorSolid(wasm);
  return canonical.rotate([0, 0, clip.rotationDeg]).translate([clip.x, clip.y, zBase]);
}

/** One alignment peg (glue) or snap tab (snap), protruding from the plate's FRONT face at local Z=0 toward local +Z (into the flange, once assembled) -- the mirror image, in reach direction, of the clips on the back face. */
function mountPlateAnchorSolid(wasm: ManifoldToplevel, plateJoint: PlateJoint, anchor: AnchorPoint, zBase: number): Manifold {
  const { Manifold } = wasm;
  let canonical: Manifold;
  if (plateJoint === "glue") {
    // Spans local Z=[-EMBED, PEG_HEIGHT] -- embedded into the panel by MOUNT_PLATE_EMBED (see skadisHookSolid's comment).
    canonical = Manifold.cylinder(MOUNT_PLATE_PEG_HEIGHT + MOUNT_PLATE_EMBED, MOUNT_PLATE_PEG_RADIUS, MOUNT_PLATE_PEG_RADIUS, 24, false).translate([0, 0, -MOUNT_PLATE_EMBED]);
  } else {
    // Base spans local Z=[-EMBED, REACH] -- embedded the same way; the barb (which never touches the panel face) is unaffected.
    const base = Manifold.cube([MOUNT_PLATE_SNAP_TAB_THICKNESS, MOUNT_PLATE_SNAP_TAB_WIDTH, MOUNT_PLATE_SNAP_TAB_REACH + MOUNT_PLATE_EMBED], true).translate([
      0,
      0,
      (MOUNT_PLATE_SNAP_TAB_REACH - MOUNT_PLATE_EMBED) / 2,
    ]);
    const barbHeight = 1.2;
    const barb = Manifold.cube([MOUNT_PLATE_SNAP_TAB_THICKNESS + 2 * MOUNT_PLATE_SNAP_BARB, MOUNT_PLATE_SNAP_TAB_WIDTH, barbHeight], true).translate([
      0,
      0,
      MOUNT_PLATE_SNAP_TAB_REACH - barbHeight / 2,
    ]);
    canonical = base.add(barb);
  }
  return canonical.rotate([0, 0, anchor.rotationDeg]).translate([anchor.x, anchor.y, zBase]);
}

/**
 * The flange-side cutter for one anchor (issue #14 AC): a shallow blind
 * hole (glue) sized to the peg plus clearance/tolerance, or a stepped blind
 * pocket (snap) -- a narrow band right at the mouth (clears only the
 * finger's own shaft) followed by a wider interior region (clears the
 * barb), so the barb springs past the narrow band on entry and is then
 * retained behind it -- mirrors `applyCoreJointCut`'s own "wide except a
 * retaining ridge band" snap pattern, in flat-box form instead of radial.
 */
function mountPlateAnchorCutter(wasm: ManifoldToplevel, anchor: AnchorPoint, plateJoint: PlateJoint, tolerance: number, zBase: number): Manifold {
  const { Manifold } = wasm;
  let canonical: Manifold;
  if (plateJoint === "glue") {
    const r = MOUNT_PLATE_PEG_RADIUS + MOUNT_PLATE_PEG_HOLE_CLEARANCE + tolerance;
    // Spans local Z=[-EMBED, HOLE_DEPTH]: the cutter's own mouth face
    // genuinely pierces MOUNT_PLATE_EMBED past the flange's outer face,
    // rather than starting exactly flush with it -- see skadisHookSolid's
    // comment (the SAME razor-thin-coincident-face hazard, here for a cut
    // instead of a union: an un-embedded cutter of this size empirically
    // left the flange's material completely uncut, as a separate,
    // disconnected "ghost" copy of the cutter itself).
    canonical = Manifold.cylinder(MOUNT_PLATE_PEG_HOLE_DEPTH + MOUNT_PLATE_EMBED, r, r, 24, false).translate([0, 0, -MOUNT_PLATE_EMBED]);
  } else {
    const wideThickness = MOUNT_PLATE_SNAP_TAB_THICKNESS + 2 * MOUNT_PLATE_SNAP_BARB + 2 * MOUNT_PLATE_SNAP_GAP;
    const narrowThickness = MOUNT_PLATE_SNAP_TAB_THICKNESS + 2 * MOUNT_PLATE_SNAP_GAP;
    const width = MOUNT_PLATE_SNAP_TAB_WIDTH + 2 * MOUNT_PLATE_SNAP_GAP;
    // Narrow (mouth) band spans local Z=[-EMBED, RIDGE_BAND] -- embedded the same way; the wide interior band (never touches the flange's own outer face) is unaffected.
    const narrow = Manifold.cube([narrowThickness, width, MOUNT_PLATE_SNAP_RIDGE_BAND + MOUNT_PLATE_EMBED], true).translate([
      0,
      0,
      (MOUNT_PLATE_SNAP_RIDGE_BAND - MOUNT_PLATE_EMBED) / 2,
    ]);
    // Starts MOUNT_PLATE_EMBED before the narrow band ends, so the two
    // differently-sized boxes making up this one cutter genuinely overlap
    // at their own shared internal seam too -- the identical hazard as the
    // cutter's outer (mouth) face, just one step further in.
    const wideHeight = MOUNT_PLATE_SNAP_POCKET_DEPTH - MOUNT_PLATE_SNAP_RIDGE_BAND + MOUNT_PLATE_EMBED;
    const wide = Manifold.cube([wideThickness, width, wideHeight], true).translate([0, 0, MOUNT_PLATE_SNAP_RIDGE_BAND - MOUNT_PLATE_EMBED + wideHeight / 2]);
    canonical = narrow.add(wide);
  }
  return canonical.rotate([0, 0, anchor.rotationDeg]).translate([anchor.x, anchor.y, zBase]);
}

export interface MountPlateSpec {
  layout: MountPlateLayout;
  mountKind: Extract<MountKind, "skadis" | "opengrid">;
  plateJoint: PlateJoint;
  tolerance: number;
  /** The core's own flange thickness (mm), so the plate's front face lands flush against z=-flangeThickness -- see the file header. */
  flangeThickness: number;
  /** Columns to sample the plate's own outline at (mirrors `FlangeSpec.columns`). */
  columns: number;
}

/**
 * Build the mount plate part: a flat panel (mountPlate.ts's own
 * `MountPlateLayout.outline`) with every clip glued onto its back face and
 * every alignment peg/snap tab glued onto its front face, already
 * positioned in the shared ASSEMBLY frame (see the file header) -- design.ts
 * uses the result as-is, with no further translation needed (unlike
 * `buildTopCap`, which builds in a LOCAL frame because its own z-offset
 * depends on the solved `height`; here `flangeThickness` is already fully
 * resolved by the time this is called).
 */
export async function buildMountPlate(spec: MountPlateSpec): Promise<CoilMesh> {
  const wasm = await getWasm();
  const trash: { delete(): void }[] = [];
  const track = <T extends { delete(): void }>(m: T): T => {
    trash.push(m);
    return m;
  };

  try {
    const { layout, mountKind, plateJoint, columns, flangeThickness } = spec;
    const backZ = -flangeThickness - MOUNT_PLATE_THICKNESS; // the plate's own back (clip-bearing) face
    const frontZ = -flangeThickness; // the plate's own front (flange-mating) face

    let plate = track(outlinePrismSolid(wasm, layout.outline, MOUNT_PLATE_THICKNESS, backZ, columns));
    if (plate.status() !== "NoError") {
      throw new Error(`Mount plate panel mesh is not a valid manifold: ${plate.status()}`);
    }

    for (const clip of layout.clips) {
      plate = track(plate.add(track(mountPlateClipSolid(wasm, mountKind, clip, backZ))));
    }
    for (const anchor of layout.anchors) {
      plate = track(plate.add(track(mountPlateAnchorSolid(wasm, plateJoint, anchor, frontZ))));
    }

    if (plate.status() !== "NoError") {
      throw new Error(`Mount plate mesh is not a valid manifold: ${plate.status()}`);
    }

    const outMesh = plate.getMesh();
    return { positions: new Float32Array(outMesh.vertProperties), indices: new Uint32Array(outMesh.triVerts) };
  } finally {
    for (const m of trash) m.delete();
  }
}
