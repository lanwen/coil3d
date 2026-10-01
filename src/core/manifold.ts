// Fuses the bottom flange onto the grooved wall with manifold-3d (docs/design.md,
// Geometry: "don't boolean the groove", but a flat flange -- and, since issue #9,
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
// COOP/COEP headers (fine on any static host and under `vite preview`).
//
// Issue #9 (top cap, joints, keyhole): `buildTopCap` builds the cap as a
// second manifold part, mirroring the bottom flange (same footprint, but a
// straight through-hole down the middle since issue #127) plus an
// engagement collar that reaches down into the core's bore. All three joints (press/bayonet/snap) share ONE circular
// collar centered on the coil axis regardless of the core's own
// round/sq/tri cross-section -- see joints.ts for why. `applyCoreJointCut`
// cuts the matching bayonet groove/entry-slots or snap relief/ridge into the
// core's own top rim; press needs no core-side cut at all (the collar simply
// presses against the bore's existing inner surface). Every feature here is
// built from manifold-3d PRIMITIVES (cylinder/cube + boolean ops), never a
// hand-rolled triangle mesh, so winding/orientation is always correct.

import Module, { type ManifoldToplevel } from "manifold-3d";
import {
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
  SCREW_MOUNT_LEVEL_OVERLAP,
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
} from "./constants";
import { jointGeometry } from "./joints";
import type { BayonetLayout, RevolvedFeature } from "./joints";
import { getLabelFont, labelLoops } from "./label";
import type { ResolvedLabel } from "./label";
import { buildOutlineRing } from "./wall";
import { layoutInnerEnd, sweepMesh } from "./innerEnd";
import type { CapClipLayout, InnerEndLayout, SweepSolid } from "./innerEnd";
import { layoutKeyholeMount } from "./mount";
import { layoutFlangePads, layoutFlangeThroughHoles, plateTopZ } from "./flangePads";
import type { KeyholeSlot, ThroughHole } from "./mount";
import { pegHoleOutline, pegSweep } from "./mountPlate";
import type { AnchorPoint, ClipInstance, MountPlateLayout } from "./mountPlate";
import { circumscribedRadius, offsetOutline, outlineColumnParams, pointAt } from "./shapes";
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
  /** How far beyond `outline` the flange extends, mm (docs/design.md, Parts and printing). */
  margin: number;
  /** The full thickness, z = [-thickness, 0]: on the pads (issue #122), and the flange's overall thickness. */
  thickness: number;
  /** Issue #122: the plate's own thickness away from the pads (flangePads.ts); omitted, or equal to `thickness`, means a plain full-thickness flange. */
  plateThickness?: number;
  /** Columns around the circumference (mirrors WallSpec.columns). */
  columns: number;
  /** Issue #85: minimum corner-arc segments (mirrors WallSpec.minCornerSegments) -- see shapes.ts's `outlineColumnParams`. */
  minCornerSegments: number;
  /** Screw-keyhole wall mount (issue #13): cut into the flange's outer (wall-facing, z=-thickness) face when `"keyhole"`. See mount.ts. */
  mount: MountKind;
  /** Issue #71: prefers a different one of the shape's own natural axes for the keyhole mount's own `bestAxisDeg` search, 0 or 45 degrees off literal vertical (`KEYHOLE_ROTATION_OPTIONS`; 90 is not offered -- see that constant's own doc comment). Ignored (and may be omitted) when `mount !== "keyhole"`. */
  keyholeRotation?: number;
  /** Issue #70: through-hole (screw-shank clearance) diameter, mm; defaults to `DEFAULT_THROUGH_HOLE_DIAMETER` when omitted. Ignored when `mount !== "through"`. */
  throughHoleDiameter?: number;
  /** Issue #70 PR review: the wound cable's own outer radius (mirrors flange.ts's own `flangeSizeEnvelope / 2` reasoning) -- every through-hole is kept clear of it too, not just the wall's own surface, so it stays reachable with a screwdriver. 0/omitted when not relevant (no mount, or not yet known). */
  envelopeRadius?: number;
}

/** What `fuseFlange` needs to cut a bayonet/snap joint's mating feature into the core's own top rim. Press needs no core-side cut, so it's omitted entirely by the caller. */
export interface CoreJointCut {
  boreOutline: ShapeOutline;
  /** Full core height (z of the wall's top rim in the shared assembly frame). */
  height: number;
  joint: Extract<JointKind, "bayonet" | "snap">;
  tolerance: number;
  /** Issue #167: the twist lock's shared layout (joints.ts's `bayonetLayout`), present exactly when `joint` is "bayonet". */
  bayonet?: BayonetLayout;
}

/**
 * What `fuseFlange` needs to cut the bottom-flange inner-end fixing (issues
 * #8, #115, #117): the recessed channel swept along the cable (a round bore
 * following its drop, along its tangent chord) from the wall's own groove
 * start on the flange's inner (z=0) face, with the cable clip near the rim
 * and the cable leaving through the rim. Always present (unlike the mount,
 * this isn't user-optional -- every core has a bottom flange and every
 * bottom flange gets this feature), so design.ts always passes one.
 */
export interface InnerEndCut {
  wireDiameter: number;
  tolerance: number;
  /** The wire's own minimum bend radius (bendMultiplier * wireDiameter, see types.ts's `bendMultiplierOf`); innerEnd.ts sizes the lead-in's chord and drop from it. */
  bendRadius: number;
  /** Depth of the channel recess below the flange's inner (z=0) face, mm. */
  channelDepth: number;
  /** The flange's own thickness, mm. */
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
 * The collar's welded base, shared by all three joints: a straight prism at
 * `collarOutline`'s own footprint for most of `JOINT_ENGAGE_DEPTH`, flaring
 * out to `weldOutline`'s footprint over the top `JOINT_TRANSITION_HEIGHT` --
 * flush with the plate's own inner (bore) edge (`weldOutline` IS the bore
 * outline offset out by `WELD_OVERLAP`, joints.ts), so the boolean union has
 * a genuinely overlapping face to weld onto at every angle, not just near
 * each flat side's own midpoint (exactly how the wall/flange fuse already
 * relies on a shared edge, see `fuseFlange` above).
 *
 * Issue #55: a plain circular transition (flaring to a circle at
 * `boreRadius + WELD_OVERLAP`) only reached the plate's non-round bore edge
 * near each flat side's midpoint -- the bore's corners sit farther out, so
 * the "transition" never actually touched them, leaving the collar a
 * second, disconnected solid there (`decompose().length === 2`, the
 * repro's floating disc). Both `collarOutline` and `weldOutline` are the
 * SAME bore outline, offset by a constant amount at every angle (shapes.ts's
 * Steiner offset), so the flare now overlaps the plate's hole edge all the
 * way around, for any shape -- round reduces to the old plain-circle collar
 * for free (see joints.ts).
 *
 * The transition is a convex hull between the two footprints (not a swept
 * `CrossSection`, which manifold-3d has no direct loft for): both outlines
 * are convex and share the same corner arrangement, so their hull is exactly
 * the ruled frustum between them, with no shortcut through the middle.
 */
function collarBase(
  wasm: ManifoldToplevel,
  track: <T extends { delete(): void }>(m: T) => T,
  collarOutline: ShapeOutline,
  weldOutline: ShapeOutline,
  segments: number,
  minCornerSegments: number,
): Manifold {
  const straightHeight = JOINT_ENGAGE_DEPTH - JOINT_TRANSITION_HEIGHT;
  const straight = track(outlinePrismSolid(wasm, collarOutline, straightHeight, -JOINT_ENGAGE_DEPTH, segments, minCornerSegments));
  const bottomPts: [number, number, number][] = outlinePolygon(collarOutline, segments, minCornerSegments).map(([x, y]) => [x, y, -JOINT_TRANSITION_HEIGHT]);
  const topPts: [number, number, number][] = outlinePolygon(weldOutline, segments, minCornerSegments).map(([x, y]) => [x, y, 0]);
  const transition = track(wasm.Manifold.hull([...bottomPts, ...topPts]));
  return track(straight.add(transition));
}

/** A box spanning radius [rLo, rHi] and tangential width `width`, at axial [zLo, zHi], rotated to `angleDeg` about Z -- the shared primitive for lugs, entry slots and relief slots (all "a chunk of material/void between two radii, centered on an angle"). */
function radialBox(wasm: ManifoldToplevel, rLo: number, rHi: number, width: number, zLo: number, zHi: number, angleDeg: number): Manifold {
  const { Manifold: M } = wasm;
  const lenX = Math.max(rHi - rLo, 1e-6);
  const h = Math.max(zHi - zLo, 1e-6);
  return M.cube([lenX, width, h], true)
    .translate([Math.min(rLo, rHi) + lenX / 2, 0, 0])
    .rotate([0, 0, angleDeg])
    .translate([0, 0, (zLo + zHi) / 2]);
}

/** Issue #167: a bayonet lug, slot or groove (joints.ts's `RevolvedFeature`), raised by `dz`. */
function revolvedFeature(wasm: ManifoldToplevel, f: RevolvedFeature, dz: number): Manifold {
  return wasm.Manifold.revolve([f.profile], 96, f.sweepDeg).rotate([0, 0, f.startDeg]).translate([0, 0, dz]);
}

/**
 * Cut the bayonet's or snap's mating feature into an already-fused core
 * manifold, near its top rim (docs/design.md, Parts and printing; ticket:
 * "3 bayonet lugs + L-slots in the core's top rim"). Bayonet: 3 straight
 * entry slots (open at the top edge) leading into a full twist-lock groove.
 * Snap: a stepped relief (wide everywhere except one narrow retaining ridge
 * band) that a hook's barb must flex past, then springs back under. Skips
 * silently (returns the manifold unchanged) when the bore is too small or
 * the core too short for these features to fit inside the 3 mm wall without
 * breaking through to the wound-cable side -- see JOINT_MIN_BORE_RADIUS.
 */
function applyCoreJointCut(wasm: ManifoldToplevel, track: <T extends { delete(): void }>(m: T) => T, core: Manifold, cut: CoreJointCut): Manifold {
  // Issue #167: the bayonet's lugs, standing in the bore under the rim,
  // from the shared layout (which already decided the core can take them --
  // see design.ts). Added, never cut: the wall keeps its full thickness.
  if (cut.joint === "bayonet") {
    return track(wasm.Manifold.union([core, ...cut.bayonet!.lugs.map((f) => track(revolvedFeature(wasm, f, cut.height)))]));
  }

  const { jointRadius, boreRadius } = jointGeometry(cut.boreOutline, cut.joint, cut.tolerance);
  if (boreRadius < JOINT_MIN_BORE_RADIUS || cut.height < JOINT_ENGAGE_DEPTH + 2) return core;

  const { height } = cut;
  const segments = 48;

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
 * One depth LEVEL of the keyhole slot cutter (issue #71): a `headRadius`
 * cylinder at the head, an `otherRadius` cylinder at the shank-end, joined by
 * a straight channel of `otherRadius`'s own width -- built from primitives +
 * a single extruded rectangle (not `Manifold.hull`, which would smoothly
 * taper the channel to the head's full width instead of stepping down to the
 * narrower rail a real keyhole slot has -- see mount.ts's file header).
 * `screwMountCutter` below calls this twice (a narrow, shallow "slot" level
 * and a head-width, deeper "undercut" level behind it) and unions the result.
 */
function slotLevelSolid(wasm: ManifoldToplevel, slot: KeyholeSlot, headRadius: number, otherRadius: number, height: number, zLo: number): Manifold {
  const { Manifold } = wasm;
  const head = Manifold.cylinder(height, headRadius, headRadius, 32).translate(slot.head.x, slot.head.y, zLo);
  const shankEnd = Manifold.cylinder(height, otherRadius, otherRadius, 32).translate(slot.shankEnd.x, slot.shankEnd.y, zLo);
  const dx = slot.shankEnd.x - slot.head.x;
  const dy = slot.shankEnd.y - slot.head.y;
  const len = Math.hypot(dx, dy);
  const parts = [head, shankEnd];
  if (len > 1e-6) {
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
    parts.push(Manifold.extrude([channelPolygon], height).translate(0, 0, zLo));
  }
  return Manifold.union(parts);
}

/**
 * The manifold-3d cut for one keyhole slot (mount.ts's layout math), cut
 * from `zBase` (the flange's outer face) inward. Issue #71 ("verify the
 * keyhole actually catches the screw"): TWO depth levels, unioned --
 *
 * - A shallow, narrow "slot" level (`SCREW_MOUNT_SLOT_DEPTH` deep,
 *   `SCREW_MOUNT_SLOT_RADIUS`-wide channel/shank-end, but still
 *   `SCREW_MOUNT_HEAD_RADIUS`-wide at the head itself -- that's the
 *   head-entry hole, which must stay full width all the way down).
 * - A deeper, head-width "undercut" level directly behind it
 *   (`SCREW_MOUNT_UNDERCUT_DEPTH` deep, `SCREW_MOUNT_HEAD_RADIUS` everywhere)
 *   -- what actually lets the screw HEAD travel from the head-entry hole to
 *   the shank's resting point and stay captured there, hidden behind the
 *   narrower slot above it.
 *
 * Only the MOUTH (the slot level's own outer face, at `zBase`) pokes
 * WELD_OVERLAP past the flange's true outer face, instead of starting
 * exactly flush with it: this recess is a BLIND pocket (unlike a
 * through-cut, which pokes past both faces), so its mouth would otherwise sit exactly
 * coincident with the ring's own bottom annulus face. That razor-thin,
 * exactly-coincident seam is the same hazard `pinHoleCutter`'s own
 * MOUNT_PLATE_EMBED fixes ("an un-embedded cutter... left the flange's
 * material completely uncut, as a separate, disconnected 'ghost' copy of the
 * cutter itself") -- issue #41 traced the stray-sliver genus failure to
 * exactly this: `fused.subtract(cutter)` occasionally leaving a whole,
 * inverted copy of the cutter behind as a disconnected negative-volume piece
 * instead of actually cutting the recess, once manifold-3d's own
 * floating-point tolerance made the exact coincidence resolve badly. The
 * SEAM between the two levels (at `zBase + SCREW_MOUNT_SLOT_DEPTH`) never
 * touches any PRE-EXISTING target face -- it's an internal step between two
 * solids of different radii on the same axis, an ordinary counterbore-style
 * union, not the mouth's own "cutter vs. target" coincidence. Empirically,
 * though, manifold-3d's own union of the two LEVELS (both part of this same
 * cutter, before it's ever subtracted from anything) hit the identical class
 * of floating-point fragility at an exact, coincident abutment between them:
 * a fine flange-thickness sweep (test/geometry.test.ts's issue #41 coverage)
 * turned up one specific thickness where an exact abutment there produced a
 * stray-sliver genus failure. `SCREW_MOUNT_LEVEL_OVERLAP` grows the slot
 * level's own height by a hairline past the nominal seam for exactly the
 * same reason WELD_OVERLAP/MOUNT_PLATE_EMBED exist -- imperceptible at print
 * scale, and the recess's own total depth/floor (`zBase +
 * SCREW_MOUNT_RECESS_DEPTH`, where the load-bearing shelf begins) is
 * unchanged from the original single-level cut.
 */
function screwMountCutter(wasm: ManifoldToplevel, slot: KeyholeSlot, zBase: number): Manifold {
  const mouthZLo = zBase - WELD_OVERLAP;
  const slotLevel = slotLevelSolid(wasm, slot, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_SLOT_RADIUS, SCREW_MOUNT_SLOT_DEPTH + WELD_OVERLAP + SCREW_MOUNT_LEVEL_OVERLAP, mouthZLo);
  const undercutLevel = slotLevelSolid(wasm, slot, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_HEAD_RADIUS, SCREW_MOUNT_UNDERCUT_DEPTH, zBase + SCREW_MOUNT_SLOT_DEPTH);
  return wasm.Manifold.union([slotLevel, undercutLevel]);
}

/**
 * The manifold-3d cut for one through-hole mount hole (issue #70, mount.ts's
 * `layoutThroughHoleMount`): a plain cylinder (the screw-shank clearance),
 * the SAME radius through the flange's full depth -- poking WELD_OVERLAP
 * past BOTH faces, the same "never a coincident target face" reasoning as
 * every other through-cut here. Issue #129: no counterbore any more -- the
 * screw head bears directly on the flange's own winding-side face.
 */
function throughHoleCutter(wasm: ManifoldToplevel, hole: ThroughHole, holeRadius: number, flangeThickness: number): Manifold {
  const { Manifold } = wasm;
  return Manifold.cylinder(flangeThickness + 2 * WELD_OVERLAP, holeRadius, holeRadius, 32).translate(hole.x, hole.y, -flangeThickness - WELD_OVERLAP);
}

/** What `fuseFlange` needs to cut the clip mount plate's own peg holes into the flange's outer (wall-facing) face (issue #14, #106) -- mirrors `CoreJointCut`'s "one shared description, cut by whichever backend needs it" role. Omitted entirely when the plate has no anchors to cut for (see mountPlate.ts's `MountPlateLayout.anchors`). */
export interface MountPlateFlangeCut {
  anchors: AnchorPoint[];
  tolerance: number;
}

/** A manifold of one of innerEnd.ts's swept solids (the channel/clip cutters and the cap clip's block), meshed by the same shared `sweepMesh` the rings come with. */
function sweepSolid(wasm: ManifoldToplevel, sweep: SweepSolid): Manifold {
  const mesh = sweepMesh(sweep);
  const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  if (m.status() !== "NoError") throw new Error(`Cable clip sweep is not a valid manifold: ${m.status()}`);
  return m;
}

/**
 * A solid matching the wall's own outline (round/sq/tri) at offset 0,
 * spanning [zLo, zHi] -- protects the wall's own footprint (and, being a
 * strict subset of it, the bore inside) from the channel cutter: the
 * channel's bore (its width scales with wire diameter, and can exceed
 * WALL_THICKNESS for a heavy cord) extends radially on BOTH sides of the
 * cable, and near the groove start the cable itself is still in the
 * groove -- without this clip, a wide-enough bore reaches past the wall
 * into the bore's own void, wiring the exterior to that void a SECOND,
 * independent way and adding a genus the part shouldn't
 * have (reproduced directly: an 8mm cable on a 60mm round core gave the
 * core's bore a spurious genus of 2, not 1, before this clip).
 *
 * Sampled at `outline` offset by INNER_CHANNEL_WALL_GUARD (not 0): clipping against the
 * wall's true outline unmodified would risk a razor-thin, exactly-coincident seam -- mirrors this
 * file's own `collarBase` reasoning, and step/build.ts's matching offset on
 * its own STEP-side blocker (needed there to avoid an outright invalid
 * BRep, not just a stray sliver).
 */
function outlineBlocker(wasm: ManifoldToplevel, outline: ShapeOutline, zLo: number, zHi: number, segments = 96): Manifold {
  const grown = offsetOutline(outline, INNER_CHANNEL_WALL_GUARD);
  const loop: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const p = pointAt(grown, i / segments, 0);
    loop.push([p.x, p.y]);
  }
  return new wasm.CrossSection([loop], "NonZero").extrude(zHi - zLo).translate([0, 0, zLo]);
}

/**
 * The bottom flange's own inner-end fixing (issues #8, #117): the channel +
 * clip swept along the cable (`layoutInnerEnd`'s `channel`), cut from the
 * flange's inner (z=0) face and out through its rim, CLIPPED to stay outside
 * the wall's own outline -- see `outlineBlocker` (near the groove start the
 * bore still overlaps the wall, where the cable is still in the air).
 */
function buildInnerEndCutter(
  wasm: ManifoldToplevel,
  track: <T extends { delete(): void }>(m: T) => T,
  outline: ShapeOutline,
  layout: InnerEndLayout,
  cut: InnerEndCut,
): Manifold {
  const raw = track(sweepSolid(wasm, layout.channel));
  const top = Math.max(...layout.channel.rings.flat().map((p) => p.z)) + 1;
  const blocker = track(outlineBlocker(wasm, outline, -cut.flangeThickness - 1, top));
  return track(raw.subtract(blocker));
}

/**
 * Issue #122: the flange ring thinned to its plate away from the pads
 * (flangePads.ts): the slab above the plate's top face, minus every pad, is
 * cut away. Returns `ring` unchanged when the plate is full thickness.
 */
function relieveFlange(
  wasm: ManifoldToplevel,
  track: <T extends { delete(): void }>(m: T) => T,
  ring: Manifold,
  flange: FlangeSpec,
  innerEnd: InnerEndLayout | undefined,
  mountPlateCut: MountPlateFlangeCut | undefined,
): Manifold {
  const zPlate = plateTopZ(flange);
  if (zPlate === undefined) return ring;
  const pads = layoutFlangePads(flange, innerEnd, mountPlateCut?.anchors, mountPlateCut?.tolerance);
  const padSolid = track(wasm.Manifold.union(pads.map((pad) => track(sweepSolid(wasm, pad.sweep)))));
  const slab = track(outlinePrismSolid(wasm, offsetOutline(flange.outline, flange.margin + 1), 1 - zPlate, zPlate, flange.columns, flange.minCornerSegments));
  return track(ring.subtract(track(slab.subtract(padSolid))));
}

/** Fuse a bottom flange (shaped like `flange.outline`, offset out by `flange.margin`) onto the wall, cutting its own inner-end fixing (issues #8, #117: recessed channel + cable clip, always present), optionally a bayonet/snap joint feature into the top rim, then the screw-keyhole mount (issue #13) or the clip mount plate's alignment features (issue #14) if requested. */
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

    const ringMesh = buildOutlineRing(flange.outline, flange.margin, flange.boreOutline, -flange.thickness, 0, flange.columns, flange.minCornerSegments);
    const ringManifold = track(new Manifold(new Mesh({ numProp: 3, vertProperties: ringMesh.positions, triVerts: ringMesh.indices })));
    if (ringManifold.status() !== "NoError") {
      throw new Error(`Flange mesh is not a valid manifold: ${ringManifold.status()}`);
    }

    // Laid out up front: the flange's pads (issue #122) follow the channel
    // too, not just its cutter below.
    const innerEndLayout = innerEnd ? layoutInnerEnd(flange.outline, flange.margin, innerEnd.wireDiameter, innerEnd.tolerance, innerEnd.bendRadius, innerEnd.channelDepth) : undefined;
    const flangeManifold = relieveFlange(wasm, track, ringManifold, flange, innerEndLayout, mountPlateCut);

    let fused = track(wallManifold.add(flangeManifold));
    // `applyCoreJointCut` already tracks its own returned manifold (like every other value it constructs) -- don't track it again here.
    if (coreJoint) fused = applyCoreJointCut(wasm, track, fused, coreJoint);

    let status = fused.status();
    if (status !== "NoError") {
      throw new Error(`Fused mesh is not a valid manifold: ${status}`);
    }

    // `innerEndLayout` is also what issue #70's through-hole mount checks
    // below: the SAME real channel footprint the cutter cut, never a
    // re-derivation.
    if (innerEnd && innerEndLayout) {
      // `cutter` is already tracked (buildInnerEndCutter tracks every
      // intermediate it builds internally) -- don't track it again here.
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
        const cutter = track(screwMountCutter(wasm, slot, -flange.thickness));
        fused = track(fused.subtract(cutter));
        status = fused.status();
        if (status !== "NoError") {
          throw new Error(`Keyhole mount cut is not a valid manifold: ${status}`);
        }
      }
    }

    if (flange.mount === "through") {
      // No inner-end cut was passed (only some direct/test callers ever omit
      // it -- design.ts always provides one): then there is no channel or
      // channel pad to keep clear of, just the collar.
      const layout = layoutFlangeThroughHoles(flange, innerEndLayout);
      for (const hole of layout.holes) {
        const cutter = track(throughHoleCutter(wasm, hole, layout.holeRadius, flange.thickness));
        fused = track(fused.subtract(cutter));
        status = fused.status();
        if (status !== "NoError") {
          throw new Error(`Through-hole mount cut is not a valid manifold: ${status}`);
        }
      }
    }

    // Issue #14/#106: the clip mount plate's alignment pegs sit in a
    // shallow blind hole cut into this SAME outer face (and a matching one
    // in the plate) -- see `pinHoleCutter` and `buildMountPlate` below (the
    // plate itself is a SEPARATE part, built by `buildMountPlate`, not
    // fused here).
    if (mountPlateCut) {
      for (const anchor of mountPlateCut.anchors) {
        const cutter = track(pinHoleCutter(wasm, anchor, mountPlateCut.tolerance, -flange.thickness, 1));
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
  /** The joint actually built: design.ts passes "press" when a bayonet falls back (issue #167). */
  joint: JointKind;
  tolerance: number;
  /** Issue #167: the twist lock's shared layout, present exactly when `joint` is "bayonet". */
  bayonet?: BayonetLayout;
  /** Engraved label text (issue #12), already fit-checked by `label.ts`'s `resolveLabel` -- undefined means no label to cut. */
  label?: ResolvedLabel;
  /** The cable clips for the outer end (issue #117: where the cable's cap lead-out ends, repeated around the cap since issue #121, `Design.capClip`). Omitted: no clip. */
  clip?: CapClipLayout;
}

/**
 * Build the top cap: a plate with a through-hole in its middle (issue #127) following the core's own
 * outline out to the flange's footprint (mirroring the bottom flange), with
 * a downward engagement collar for the chosen joint and cable clips for the
 * outer cable end under it. Built entirely in a LOCAL frame (plate z=[0, CAP_THICKNESS],
 * collar z=[-JOINT_ENGAGE_DEPTH, 0]) and translated by the caller into the
 * shared assembly frame -- see design.ts.
 */
export async function buildTopCap(spec: TopCapSpec): Promise<CoilMesh> {
  const wasm = await getWasm();
  const { Manifold } = wasm;
  const trash: { delete(): void }[] = [];
  const track = <T extends { delete(): void }>(m: T): T => {
    trash.push(m);
    return m;
  };

  try {
    const { flange, joint, tolerance, label, clip, bayonet } = spec;
    // The plate: the same outer outline (and columns) as the bottom
    // flange's own ring. Issue #127: its middle is opened up below by the
    // through-hole (`holeOutline`), never by a blind pocket whose floor would
    // print as a bridge (the pre-#121 annulus over a solid collar plug).
    const rim = outlineColumnParams(flange.outline, flange.columns, flange.minCornerSegments).map((t): [number, number] => {
      const p = pointAt(flange.outline, t, flange.margin);
      return [p.x, p.y];
    });
    const plate = track(new wasm.CrossSection([rim], "NonZero").extrude(CAP_THICKNESS));
    if (plate.status() !== "NoError") {
      throw new Error(`Top cap plate mesh is not a valid manifold: ${plate.status()}`);
    }

    const { collarRadius, collarOutline, weldOutline, holeOutline } = jointGeometry(flange.boreOutline, joint, tolerance);
    const segments = 48;

    let collar: Manifold;
    if (joint === "press") {
      collar = collarBase(wasm, track, collarOutline, weldOutline, segments, flange.minCornerSegments);
    } else if (joint === "bayonet") {
      // Issue #167: a straight round tube, run WELD_OVERLAP up into the
      // (solid, since #127) plate -- no flare out to the bore, which would
      // rub the core's rim through the twist -- with the L-slots cut in.
      const base = track(outlinePrismSolid(wasm, collarOutline, JOINT_ENGAGE_DEPTH + WELD_OVERLAP, -JOINT_ENGAGE_DEPTH, segments, flange.minCornerSegments));
      const slots = track(Manifold.union(bayonet!.cuts.map((f) => track(revolvedFeature(wasm, f, 0)))));
      collar = track(base.subtract(slots));
    } else {
      // snap: a collar with a barb band at its tip (deepest point, LOCAL
      // z=[-JOINT_ENGAGE_DEPTH, -JOINT_ENGAGE_DEPTH+SNAP_BARB_HEIGHT]) and 3
      // axial relief slots cutting it into cantilever fingers.
      const base = collarBase(wasm, track, collarOutline, weldOutline, segments, flange.minCornerSegments);
      const barbR = collarRadius + SNAP_BARB;
      const barb = track(Manifold.cylinder(SNAP_BARB_HEIGHT, barbR, barbR, segments, false).translate([0, 0, -JOINT_ENGAGE_DEPTH]));
      const withBarb = track(base.add(barb));
      // Already tracked (unionAtAngles tracks its own final reduce step).
      // The slot's radial reach clears the transition's own widened top
      // (collarBase flares out to `weldOutline`, issue #55) at EVERY angle,
      // not just the flat sides -- `circumscribedRadius` is the outline's
      // own farthest point, so this stays correct for round/sq/tri alike.
      const slotOuterR = Math.max(barbR + 0.5, circumscribedRadius(weldOutline, 0) + 0.5);
      const slots = unionAtAngles(track, (angle) => radialBox(wasm, 0, slotOuterR, SNAP_SLOT_WIDTH, -JOINT_ENGAGE_DEPTH - 0.5, 0.5, angle), SNAP_HOOK_COUNT);
      collar = track(withBarb.subtract(slots));
    }

    let assembled = track(plate.add(collar));
    // Issue #127: a straight through-hole down the middle -- the collar is a
    // tube, and in the cap's print orientation (face down) the hole's walls
    // rise straight up from the bed with nothing spanning it.
    if (holeOutline) {
      const hole = track(outlinePrismSolid(wasm, holeOutline, CAP_THICKNESS + JOINT_ENGAGE_DEPTH + 2, -JOINT_ENGAGE_DEPTH - 1, segments, flange.minCornerSegments));
      assembled = track(assembled.subtract(hole));
    }
    // Issue #117: the cable clips hang under the plate (each block welded
    // 1 mm into the plate), with their bores cut through them.
    for (const c of clip?.clips ?? []) {
      const block = track(sweepSolid(wasm, c.block));
      const bore = track(sweepSolid(wasm, c.bore));
      assembled = track(track(assembled.add(block)).subtract(bore));
    }

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

// --- Clip mount plate (issue #14, docs/mounts.md, SKÅDIS) -------------------------------------------------
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
// z=-flangeThickness-MOUNT_PLATE_THICKNESS. Nothing protrudes from the
// front face (issue #106: the plate prints on it): a blind peg hole
// goes into the plate from it, and a matching one into the flange from its
// outer face (see `pinHoleCutter`).
//
// Every clip is built in a CANONICAL local frame first (local +X =
// "up", local +Y = "side", local -Z = "reach", flush base at Z=0) then
// rotated about Z by `ClipInstance.rotationDeg`/`AnchorPoint.rotationDeg`
// (mountPlate.ts's file header: `90 - axisDeg`, the same value for every
// clip/anchor in one layout) and translated to its own true (x, y, zBase) --
// this mirrors `radialBox`'s own "rotate a canonical primitive, don't
// hand-rotate its vertices" pattern above.

/**
 * A closed 2D polygon sampling `outline`'s own boundary (offset 0) -- the
 * mount plate panel has NO bore (unlike the wall/flange's ring,
 * `buildOutlineRing`), so a plain `CrossSection` extrude is enough. Issue
 * #85: `columns` is a requested budget, redistributed toward corner arcs
 * (`outlineColumnParams`) instead of a plain `ci / columns`.
 */
function outlinePolygon(outline: ShapeOutline, columns: number, minCornerSegments: number): [number, number][] {
  const ts = outlineColumnParams(outline, columns, minCornerSegments);
  return ts.map((t) => {
    const p = pointAt(outline, t, 0);
    return [p.x, p.y] as [number, number];
  });
}

/** A solid prism of `outline`'s own footprint, extruded from `zBase` up by `height`. */
function outlinePrismSolid(wasm: ManifoldToplevel, outline: ShapeOutline, height: number, zBase: number, columns: number, minCornerSegments: number): Manifold {
  const poly = outlinePolygon(outline, columns, minCornerSegments);
  return new wasm.CrossSection([poly], "NonZero").extrude(height).translate([0, 0, zBase]);
}

/**
 * One SKÅDIS clip PAIR (constants.ts's `SKADIS_CLIP_PROFILE` doc comment
 * for the mechanism and dimensions), in the canonical local frame described
 * above. Each leg's (side, reach) loop is built as (local X, local Y) so
 * `CrossSection.extrude` sweeps it along local Z by `SKADIS_CLIP_HEIGHT`,
 * then rotated -90 degrees about local X (extrusion axis -> local Y, reach
 * -> local -Z: base at Z=0, tip at the most negative Z) and a further -90
 * degrees about local Z, which swaps this construction's own (side, height)
 * axes into the shared frame (local +X = "up", local +Y = "side"); the
 * pair's side=0 mirror symmetry makes the resulting side-sign flip harmless.
 * The loop's reach-0 points are pushed MOUNT_PLATE_EMBED into the panel
 * (that constant's doc comment: a coincident base face unions unreliably)
 * WITHOUT moving the rest of the clip, so the barb stays exactly where the
 * profile puts it relative to the plate's face (issue #106: the issue #14
 * version shifted the whole clip 0.5 mm toward the plate instead).
 */
function skadisHookSolid(wasm: ManifoldToplevel): Manifold {
  const leg = SKADIS_CLIP_PROFILE.map(([s, r]): [number, number] => [s, r === 0 ? -MOUNT_PLATE_EMBED : r]);
  const leftLoop: [number, number][] = leg.map(([s, r]): [number, number] => [-s, r]).reverse();
  const solid = new wasm.CrossSection([leg, leftLoop], "NonZero").extrude(SKADIS_CLIP_HEIGHT);
  return solid
    .translate([0, 0, -SKADIS_CLIP_HEIGHT / 2])
    .rotate([-90, 0, 0])
    .rotate([0, 0, -90]);
}

/** The openGrid placeholder connector (constants.ts's `OPENGRID_PLACEHOLDER_PEG_SIZE` TODO): a plain square peg in the same canonical local frame, base flush at Z=0, reaching to local -Z. Embedded into the panel by `MOUNT_PLATE_EMBED` -- see `skadisHookSolid`'s comment. */
function openGridConnectorSolid(wasm: ManifoldToplevel): Manifold {
  const s = OPENGRID_PLACEHOLDER_PEG_SIZE;
  const h = OPENGRID_PLACEHOLDER_PEG_REACH + MOUNT_PLATE_EMBED; // spans local Z=[-REACH, +EMBED] once centered and shifted below
  return wasm.Manifold.cube([s, s, h], true).translate([0, 0, (MOUNT_PLATE_EMBED - OPENGRID_PLACEHOLDER_PEG_REACH) / 2]);
}

/** One clip instance (hook or placeholder connector), placed at its own true (x, y) and rotated onto the layout's up/side axes -- see the file header. */
function mountPlateClipSolid(wasm: ManifoldToplevel, mountKind: Extract<MountKind, "skadis" | "opengrid">, clip: ClipInstance, zBase: number): Manifold {
  const canonical = mountKind === "skadis" ? skadisHookSolid(wasm) : openGridConnectorSolid(wasm);
  return canonical.rotate([0, 0, clip.rotationDeg]).translate([clip.x, clip.y, zBase]);
}

/**
 * One peg hole (issues #106, #132, #143, constants.ts's MOUNT_PLATE_PEG_*): a
 * blind prism MOUNT_PLATE_PEG_HOLE_DEPTH deep, the peg's own octagon
 * (`pegHoleOutline`) so it grips every flat with the same tolerance
 * clearance, starting at the mating face `zFace` and going into the part
 * along `dir` (+1: into the flange, from its outer face; -1: into the plate,
 * from its front face). Its mouth pokes MOUNT_PLATE_EMBED out past the face,
 * so the cut never shares a coincident face with it (see that constant's
 * doc comment). Printable both ways: each hole opens onto its own part's bed
 * face.
 */
function pinHoleCutter(wasm: ManifoldToplevel, anchor: AnchorPoint, tolerance: number, zFace: number, dir: 1 | -1): Manifold {
  const poly: [number, number][] = pegHoleOutline(anchor, tolerance).map((p) => [p.x, p.y]);
  const h = MOUNT_PLATE_PEG_HOLE_DEPTH + MOUNT_PLATE_EMBED;
  const hole = new wasm.CrossSection([poly], "NonZero").extrude(h).translate([0, 0, -MOUNT_PLATE_EMBED]);
  return (dir === 1 ? hole : hole.mirror([0, 0, 1])).translate([0, 0, zFace]);
}

export interface MountPlateSpec {
  layout: MountPlateLayout;
  mountKind: Extract<MountKind, "skadis" | "opengrid">;
  tolerance: number;
  /** The core's own flange thickness (mm), so the plate's front face lands flush against z=-flangeThickness -- see the file header. */
  flangeThickness: number;
  /** Columns to sample the plate's own outline at (mirrors `FlangeSpec.columns`). */
  columns: number;
  /** Issue #85: minimum corner-arc segments (mirrors `FlangeSpec.minCornerSegments`). */
  minCornerSegments: number;
}

/**
 * Build the mount plate part: a flat panel (mountPlate.ts's own
 * `MountPlateLayout.outline`) with every clip fused onto its back face and
 * a peg hole cut into its front face per anchor, already
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
    const { layout, mountKind, tolerance, columns, minCornerSegments, flangeThickness } = spec;
    const backZ = -flangeThickness - MOUNT_PLATE_THICKNESS; // the plate's own back (clip-bearing) face
    const frontZ = -flangeThickness; // the plate's own front (flange-mating) face

    let plate = track(outlinePrismSolid(wasm, layout.outline, MOUNT_PLATE_THICKNESS, backZ, columns, minCornerSegments));
    if (plate.status() !== "NoError") {
      throw new Error(`Mount plate panel mesh is not a valid manifold: ${plate.status()}`);
    }

    for (const clip of layout.clips) {
      plate = track(plate.add(track(mountPlateClipSolid(wasm, mountKind, clip, backZ))));
    }
    for (const anchor of layout.anchors) {
      plate = track(plate.subtract(track(pinHoleCutter(wasm, anchor, tolerance, frontZ, -1))));
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

/**
 * One alignment peg part (issue #132): mountPlate.ts's `pegSweep` rings,
 * standing in its hole across the plate/flange seam (z = -flangeThickness)
 * in the shared ASSEMBLY frame, like `buildMountPlate`.
 */
export async function buildPeg(anchor: AnchorPoint, flangeThickness: number): Promise<CoilMesh> {
  const wasm = await getWasm();
  const peg = sweepSolid(wasm, pegSweep(anchor, -flangeThickness));
  try {
    const outMesh = peg.getMesh();
    return { positions: new Float32Array(outMesh.vertProperties), indices: new Uint32Array(outMesh.triVerts) };
  } finally {
    peg.delete();
  }
}
