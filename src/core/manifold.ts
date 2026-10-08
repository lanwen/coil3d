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
// adds the bayonet's lugs (issue #167; its L-slots are in the cap's collar)
// or the snap's ridge and seat rings (issue #186) inside its bore; press needs no
// core-side feature at all (the collar simply
// presses against the bore's existing inner surface). Every feature here is
// built from manifold-3d PRIMITIVES (cylinder/cube + boolean ops), never a
// hand-rolled triangle mesh, so winding/orientation is always correct.

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
import { faceCutArcs } from "./faceChannel";
import type { FaceCutArc, FaceChannelLayout, FaceEnd } from "./faceChannel";
import type { InnerEndLayout, RimSlot, SweepSolid } from "./innerEnd";
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
import type { SkadisTclipLayout, Tclip } from "./skadisTclips";
import { offsetOutline, outlineColumnParams, pointAt } from "./shapes";
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
  /** Issue #207: the SKÅDIS rim clips' layout (skadisClips.ts) -- its notches are cut through the rim (the jaws grip the flange's plain plate, no pad). Present only when `mount` is "skadis" and the clips fit. */
  skadis?: SkadisClipLayout;
  /** Issues #213, #221: the SKÅDIS T-clips' layout (skadisTclips.ts) -- a floor fills the bore, with a slot through it per clip and the fin's recess in its top. Present only when `mount` is "skadis-tclip" and the clips fit. */
  skadisTclip?: SkadisTclipLayout;
  /** Issue #241: the rim cable slot (innerEnd.ts's `layoutRimSlot`), cut straight through the flange. Omitted: none fits. */
  rimSlot?: RimSlot;
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
  /** Issue #186: the snap clips' shared layout (joints.ts's `snapLayout`), present exactly when `joint` is "snap". */
  snap?: SnapLayout;
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

/** Boxes/cylinders repeated at the given angles around Z, unioned into one manifold. Every intermediate boolean result is `track()`ed (a real CSG op, unlike a lazy transform chain -- see manifold.ts's own `.add()`/`.subtract()` calls elsewhere), so nothing leaks across the reduce. */
function unionAtAngles(track: <T extends { delete(): void }>(m: T) => T, build: (angleDeg: number) => Manifold, anglesDeg: number[]): Manifold {
  let result: Manifold | undefined;
  for (const angle of anglesDeg) {
    const m = track(build(angle));
    result = result ? track(result.add(m)) : m;
  }
  return result!;
}

/**
 * The snap collar's base (issue #172): a straight prism at `collarOutline`'s
 * footprint, flaring over its top `JOINT_TRANSITION_HEIGHT` out to
 * `rootOutline` (joints.ts's `snapLayout`), which stays inside the core's
 * bore. The flare is a convex hull between the two footprints: both are
 * Steiner offsets of the bore's outline, so their hull is exactly the ruled
 * frustum between them.
 */
function collarBase(
  wasm: ManifoldToplevel,
  track: <T extends { delete(): void }>(m: T) => T,
  collarOutline: ShapeOutline,
  rootOutline: ShapeOutline,
  depth: number,
  segments: number,
  minCornerSegments: number,
): Manifold {
  // The prism runs halfway up into the flare, inside it, so the two share no face: where they met flush at the
  // flare's foot, the union left zero-width slits along the outline's straight sides that came off the cap as
  // separate pieces at some column counts (issue #208). The solid is the same.
  const straightHeight = depth - JOINT_TRANSITION_HEIGHT / 2;
  const straight = track(outlinePrismSolid(wasm, collarOutline, straightHeight, -depth, segments, minCornerSegments));
  // Only the outlines' corner points (`corners`), as in `stackSolid`: the points along a straight side add nothing to
  // the hull and can fold a sheet of no thickness into its face.
  const bottomPts: [number, number, number][] = corners(outlinePolygon(collarOutline, segments, minCornerSegments)).map(([x, y]) => [x, y, -JOINT_TRANSITION_HEIGHT]);
  const topPts: [number, number, number][] = corners(outlinePolygon(rootOutline, segments, minCornerSegments)).map(([x, y]) => [x, y, 0]);
  const transition = track(wasm.Manifold.hull([...bottomPts, ...topPts]));
  return track(straight.add(transition));
}

/**
 * Columns for a cap collar's walls: a round one gets 2.5 degree facets, so a facet seam seen edge-on lies within the
 * wall's own outline (issue #200); other shapes keep 48 (see `buildTopCap`). Mutable only so a test can try other
 * counts: the mesh clean-up passes (weld.ts, flatFaces.ts) must hold for any of them (issue #208).
 */
export const collarSegments = { round: 144, other: 48 };

/** joints.ts's `OutlineStack` as one solid: the hull of each neighbouring pair of stations (a prism or a convex frustum), unioned. */
function stackSolid(wasm: ManifoldToplevel, track: <T extends { delete(): void }>(m: T) => T, stack: OutlineStack, columns: number, cornerSegments: number): Manifold {
  const pieces: Manifold[] = [];
  for (let i = 0; i + 1 < stack.length; i++) {
    const pts = [stack[i], stack[i + 1]].flatMap(({ outline, z }) => corners(outlinePolygon(outline, columns, cornerSegments)).map(([x, y]): [number, number, number] => [x, y, z]));
    pieces.push(track(wasm.Manifold.hull(pts)));
  }
  return track(wasm.Manifold.union(pieces));
}

/**
 * Issue #219: `poly` without the points in the middle of its straight sides. They add nothing to a hull, and with
 * many of them in one side face's plane the hull came out with sheets of no thickness folded into that face.
 */
function corners(poly: [number, number][]): [number, number][] {
  return poly.filter((p, i) => {
    const [a, b] = [poly[(i + poly.length - 1) % poly.length], poly[(i + 1) % poly.length]];
    const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
    return Math.abs(cross) > 1e-9 * Math.hypot(b[0] - a[0], b[1] - a[1]);
  });
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
 * Add the bayonet's or the snap's mating feature to an already-fused core
 * manifold, near its top rim (docs/design.md, Parts and printing). Both come
 * from a shared layout that design.ts only passes once joints.ts's
 * `resolveCapJoint` said the core can take the joint. Bayonet (issue #167):
 * the lugs from `bayonetLayout`, standing in the bore just under the rim.
 * Snap (issue #186): the ridge ring from `snapLayout` that a hook's barb
 * flexes past, then springs back under. Both are added, never cut: the wall
 * keeps its full thickness.
 */
function applyCoreJointCut(wasm: ManifoldToplevel, track: <T extends { delete(): void }>(m: T) => T, core: Manifold, cut: CoreJointCut, flange: FlangeSpec): Manifold {
  // Issue #167: the bayonet's lugs, standing in the bore under the rim,
  // from the shared layout (which already decided the core can take them --
  // see design.ts). Added, never cut: the wall keeps its full thickness.
  if (cut.joint === "bayonet") {
    return track(wasm.Manifold.union([core, ...cut.bayonet!.lugs.map((f) => track(revolvedFeature(wasm, f, cut.height)))]));
  }

  // snap (issues #168, #186): the ridge and the seat under the finger tips,
  // rings added inside the bore -- see joints.ts's `snapLayout`. Each ring is
  // its relief cut from its lip on its own, so the wall is never cut. The
  // rings take the wall's own columns: a lip with its own, finer facets
  // poked out through a coarse (draft) wall's chords behind the groove.
  const { height } = cut;
  const rim = (stack: OutlineStack): OutlineStack => stack.map(({ outline, z }) => ({ outline, z: z + height }));
  const solid = (stack: OutlineStack) => stackSolid(wasm, track, rim(stack), flange.columns, flange.minCornerSegments);
  const rings = cut.snap!.rings.map(({ lip, relief }) => track(solid(lip).subtract(solid(relief))));
  return track(wasm.Manifold.union([core, ...rings]));
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
 * every other through-cut here. Issue #129: no counterbore. Issue #239: a
 * 90 degree countersink on the winding face (the plate's top, `zTop`), its
 * cone carried on WELD_OVERLAP above that face and half a millimetre down
 * into the bore.
 */
function throughHoleCutter(wasm: ManifoldToplevel, hole: ThroughHole, holeRadius: number, flangeThickness: number, zTop: number, plateThickness: number): Manifold {
  const { Manifold } = wasm;
  const bore = Manifold.cylinder(flangeThickness + 2 * WELD_OVERLAP, holeRadius, holeRadius, 32).translate(hole.x, hole.y, -flangeThickness - WELD_OVERLAP);
  const sink = throughHoleCountersink(holeRadius, plateThickness);
  if (sink.depth <= 1e-6) return bore;
  // The same 45 degree cone, carried on half a millimetre down inside the bore (so its edge never lies on the bore's surface).
  const cone = Manifold.cylinder(sink.depth + WELD_OVERLAP + 0.5, holeRadius - 0.5, sink.radius + WELD_OVERLAP, 32).translate(hole.x, hole.y, zTop - sink.depth - 0.5);
  return Manifold.union([bore, cone]);
}

/** What `fuseFlange` needs to cut the clip mount plate's own peg holes into the flange's outer (wall-facing) face (issue #14, #106) -- mirrors `CoreJointCut`'s "one shared description, cut by whichever backend needs it" role. Omitted entirely when the plate has no anchors to cut for (see mountPlate.ts's `MountPlateLayout.anchors`). */
export interface MountPlateFlangeCut {
  anchors: AnchorPoint[];
  tolerance: number;
}

/** Issue #241: a rim slot's cut, its plan outline extruded `height` up from `zLo` (poking past both faces of the plate). */
function rimSlotCutter(wasm: ManifoldToplevel, slot: RimSlot, zLo: number, height: number): Manifold {
  const poly: [number, number][] = slot.outline.map((p) => [p.x, p.y]);
  return new wasm.CrossSection([poly], "NonZero").extrude(height).translate([0, 0, zLo]);
}

/** A manifold of one of innerEnd.ts's swept solids (the channel/clip cutters and the flange pads), meshed by the same shared `sweepMesh` the rings come with. */
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
  // Issue #229: the plate's top edge is chamfered too: what stays is the flange inside the frustum under the plate
  // top (edgeChamfer.ts's `chamferWedgeRows`, reaching below the flange) and the pads.
  const kept = track(rimHull(wasm, flange.outline, chamferWedgeRows(flange.margin, zPlate, -flange.thickness - 1), flange.columns, flange.minCornerSegments));
  return track(ring.intersect(track(kept.add(padSolid))));
}

type Track = <T extends { delete(): void }>(m: T) => T;
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
  const solid = track(wasm.Manifold.revolve([profile], FACE_REVOLVE_SEGMENTS, degrees));
  const turned = track(solid.rotate([0, 0, lowest]));
  return track(turned.translate([arc.centre.x, arc.centre.y, 0]));
}

function faceChannelCutter(wasm: ManifoldToplevel, track: Track, layout: FaceChannelLayout): Manifold {
  const ends = [...(layout.inner ? [layout.inner] : []), ...(layout.outer ? [layout.outer] : [])];
  const pieces = ends.flatMap((end) => faceCutArcs(end).map((arc) => faceArcCutter(wasm, track, arc, end, layout)));
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
        const cutter = track(screwMountCutter(wasm, slot, -flange.thickness));
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
        const cutter = track(throughHoleCutter(wasm, hole, layout.holeRadius, flange.thickness, plateTopZ(flange) ?? 0, Math.min(flange.plateThickness ?? flange.thickness, flange.thickness)));
        fused = track(fused.subtract(cutter));
        status = fused.status();
        if (status !== "NoError") {
          throw new Error(`Through-hole mount cut is not a valid manifold: ${status}`);
        }
      }
    }

    if (flange.skadis) {
      for (const notch of flange.skadis.notches) {
        const poly: [number, number][] = notch.map((p) => [p.x, p.y]);
        const cutter = track(new wasm.CrossSection([poly], "NonZero").extrude(flange.thickness + 2 * WELD_OVERLAP).translate([0, 0, -flange.thickness - WELD_OVERLAP]));
        fused = track(fused.subtract(cutter));
        status = fused.status();
        if (status !== "NoError") {
          throw new Error(`SKÅDIS notch cut is not a valid manifold: ${status}`);
        }
      }
    }

    if (flange.rimSlot) {
      fused = track(fused.subtract(track(rimSlotCutter(wasm, flange.rimSlot, -flange.thickness - WELD_OVERLAP, flange.thickness + 2 * WELD_OVERLAP))));
      status = fused.status();
      if (status !== "NoError") {
        throw new Error(`Rim slot cut is not a valid manifold: ${status}`);
      }
    }

    if (flange.skadisTclip) {
      const cuts = flange.skadisTclip.cutters.flat().map((cutter) => track(wasm.Manifold.hull(cutter.levels.flatMap((l) => l.poly.map((p): [number, number, number] => [p.x, p.y, l.z])))));
      fused = track(fused.subtract(track(Manifold.union(cuts))));
      status = fused.status();
      if (status !== "NoError") {
        throw new Error(`SKÅDIS T-clip cut is not a valid manifold: ${status}`);
      }
    }

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

    const outMesh = track(fused.refineToLength(FLAT_FACE_MAX_EDGE)).getMesh();
    const mesh = improveFlatFaces(
      weldShortEdges({
        positions: new Float32Array(outMesh.vertProperties),
        indices: new Uint32Array(outMesh.triVerts),
      }).mesh,
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
  /** Same outline/margin/boreOutline/columns as the bottom FlangeSpec -- the cap is sized to the flange (ticket: "sized to the flange"). */
  flange: FlangeSpec;
  /** The joint actually built: design.ts passes "press" when a bayonet falls back (issue #167). */
  joint: JointKind;
  tolerance: number;
  /** Issue #167: the twist lock's shared layout, present exactly when `joint` is "bayonet". */
  bayonet?: BayonetLayout;
  /** Issue #186: the snap clips' shared layout, present exactly when `joint` is "snap". */
  snap?: SnapLayout;
  /** Engraved label text (issue #12), already fit-checked by `label.ts`'s `resolveLabel` -- undefined means no label to cut. */
  label?: ResolvedLabel;
  /** Issue #241: the rim cable slot for the outer end (`Design.rimSlots.cap`), cut straight through the plate. Omitted: none. */
  rimSlot?: RimSlot;
}

/**
 * Build the top cap: a plate with a through-hole in its middle (issue #127) following the core's own
 * outline out to the flange's footprint (mirroring the bottom flange), with
 * a downward engagement collar for the chosen joint and a rim slot for the
 * outer cable end. Built entirely in a LOCAL frame (plate z=[0, CAP_THICKNESS],
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
    const { flange, joint, tolerance, label, rimSlot, bayonet, snap } = spec;
    // The plate: the same outer outline (and columns) as the bottom
    // flange's own ring. Issue #127: its middle is opened up below by the
    // through-hole (`holeOutline`), never by a blind pocket whose floor would
    // print as a bridge (the pre-#121 annulus over a solid collar plug).
    // Issues #229, #237: the outer edge is chamfered on both faces (edgeChamfer.ts's `chamferedRim`).
    const plate = track(rimHull(wasm, flange.outline, chamferedRim(flange.margin, 0, CAP_THICKNESS), flange.columns, flange.minCornerSegments));
    if (plate.status() !== "NoError") {
      throw new Error(`Top cap plate mesh is not a valid manifold: ${plate.status()}`);
    }

    const { collarOutline, holeOutline } = jointGeometry(flange.boreOutline, joint, tolerance);
    // Issue #200: columns on the collar's walls. The line-art renderer draws a
    // facet seam that is seen almost edge-on, beside the wall's side outline, as
    // a depth step: 7.5 degree facets (48) left dotted vertical lines on a round
    // collar, and facets under about 3 degrees put every seam in the outline.
    // Other shapes keep 48: their corner arcs get their own columns
    // (`minCornerSegments`), and a finer budget only adds triangles on the flats.
    const segments = collarOutline.cornerRadius >= collarOutline.apothem - 1e-6 ? collarSegments.round : collarSegments.other;

    // Issue #172: the collar is a straight tube run WELD_OVERLAP up into the
    // plate, which is solid under it since #127. It never flares out to the
    // bore, so the seated cap doesn't run into the core's rim.
    const straight = () => track(outlinePrismSolid(wasm, collarOutline, JOINT_ENGAGE_DEPTH + WELD_OVERLAP, -JOINT_ENGAGE_DEPTH, segments, flange.minCornerSegments));
    let collar: Manifold;
    if (joint === "bayonet") {
      // Issue #167: the L-slots cut into the straight tube.
      const slots = track(Manifold.union(bayonet!.cuts.map((f) => track(revolvedFeature(wasm, f, 0)))));
      collar = track(straight().subtract(slots));
    } else if (snap) {
      // snap: a collar with a barb ring at its tip (deepest point) and axial
      // relief slots at the outline's corners cutting it into one cantilever
      // finger per side -- see joints.ts's `snapLayout`. The barb follows the
      // collar's outline, sampled at the same columns, so its faces meet the
      // finger's along clean lines. The fingers' root flare stays inside the bore.
      const base = collarBase(wasm, track, collarOutline, snap.rootOutline, snap.depth, segments, flange.minCornerSegments);
      const barb = stackSolid(wasm, track, snap.barb, segments, flange.minCornerSegments);
      const withBarb = track(base.add(barb));
      // Already tracked (unionAtAngles tracks its own final reduce step).
      const slots = unionAtAngles(track, (angle) => radialBox(wasm, 0, snap.slotOuterRadius, SNAP_SLOT_WIDTH, -snap.depth - 0.5, 0.5, angle), snap.slotAnglesDeg);
      collar = track(withBarb.subtract(slots));
    } else {
      // Press, or a bayonet or snap the core can't take (joints.ts's `resolveCapJoint`).
      collar = straight();
    }

    let assembled = track(plate.add(collar));
    // Issue #127: a straight through-hole down the middle -- the collar is a
    // tube, and in the cap's print orientation (face down) the hole's walls
    // rise straight up from the bed with nothing spanning it.
    // The snap fingers reach deeper than JOINT_ENGAGE_DEPTH, so their hole comes with the layout.
    if (snap?.hole) {
      assembled = track(assembled.subtract(stackSolid(wasm, track, snap.hole, segments, flange.minCornerSegments)));
    } else if (holeOutline) {
      const hole = track(outlinePrismSolid(wasm, holeOutline, CAP_THICKNESS + JOINT_ENGAGE_DEPTH + 2, -JOINT_ENGAGE_DEPTH - 1, segments, flange.minCornerSegments));
      assembled = track(assembled.subtract(hole));
    }
    // Issue #241: the rim cable slot, straight through the plate.
    if (rimSlot) assembled = track(assembled.subtract(track(rimSlotCutter(wasm, rimSlot, -WELD_OVERLAP, CAP_THICKNESS + 2 * WELD_OVERLAP))));

    // The cutter gets its own original ID, so the faces it leaves behind
    // (the pockets' walls and floors) can be told apart in the result.
    let labelId: number | undefined;
    if (label) {
      const labelCutter = track(track(await buildLabelCutter(wasm, label)).asOriginal());
      labelId = labelCutter.originalID();
      assembled = track(assembled.subtract(labelCutter));
    }

    if (assembled.status() !== "NoError") {
      throw new Error(`Top cap mesh is not a valid manifold: ${assembled.status()}`);
    }

    // Issues #180, #193: the booleans leave needle-thin triangles, which the
    // line-art renderer draws as a dotted line: in the plate's flat faces
    // (flatFaces.ts) and, where curved surfaces cross, on the collar and the
    // plate rim (weld.ts). Welding drops triangles, so `origin` carries the
    // label's marks over; the flips keep each triangle's place in the list and
    // swap edges only inside one flat face, so the label's triangles stay the
    // label's.
    const outMesh = track(assembled.refineToLength(FLAT_FACE_MAX_EDGE)).getMesh();
    const raw: CoilMesh = { positions: new Float32Array(outMesh.vertProperties), indices: new Uint32Array(outMesh.triVerts) };
    const welded = weldShortEdges(raw);
    const mesh: CoilMesh = improveFlatFaces(welded.mesh);
    // Issue #229: the rim's chamfer, for the viewer to leave out of the drawing.
    mesh.rimTriangles = rimTriangles(mesh, flange.outline, flange.margin, [[0, CAP_THICKNESS]]);
    if (labelId !== undefined) {
      const isLabel = new Uint8Array(raw.indices.length / 3);
      const runIndex = outMesh.runIndex!;
      const runOriginalID = outMesh.runOriginalID!;
      for (let r = 0; r < runOriginalID.length; r++) {
        if (runOriginalID[r] !== labelId) continue;
        for (let t = runIndex[r] / 3; t < runIndex[r + 1] / 3; t++) isLabel[t] = 1;
      }
      const labelTriangles: number[] = [];
      welded.origin.forEach((old, t) => {
        if (isLabel[old]) labelTriangles.push(t);
      });
      mesh.labelTriangles = new Uint32Array(labelTriangles);
    }
    return mesh;
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

// --- Clip mount plate (issue #14, docs/mounts.md: the hidden openGrid placeholder) ------------------------
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

/**
 * Issue #229: the solid whose outline is `outline` offset outward by each row's `offset`, at the row's `z`: the
 * convex hull of the rows (edgeChamfer.ts), so its sides are the ruled surfaces between neighbouring rows. The
 * points in the middle of a straight side add nothing to a hull (see `corners`).
 */
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

/** The plain flange: the ring between its outline (out by its margin) and the bore. */
function outlineRingManifold(wasm: ManifoldToplevel, track: <T extends { delete(): void }>(m: T) => T, flange: FlangeSpec): Manifold {
  const ringMesh = buildOutlineRing(flange.outline, flange.margin, flange.boreOutline, -flange.thickness, 0, flange.columns, flange.minCornerSegments);
  const ring = track(new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: ringMesh.positions, triVerts: ringMesh.indices })));
  if (ring.status() !== "NoError") {
    throw new Error(`Flange mesh is not a valid manifold: ${ring.status()}`);
  }
  return ring;
}

/** A solid prism of `outline`'s own footprint, extruded from `zBase` up by `height`. */
function outlinePrismSolid(wasm: ManifoldToplevel, outline: ShapeOutline, height: number, zBase: number, columns: number, minCornerSegments: number): Manifold {
  const poly = outlinePolygon(outline, columns, minCornerSegments);
  return new wasm.CrossSection([poly], "NonZero").extrude(height).translate([0, 0, zBase]);
}

/** The openGrid placeholder connector (constants.ts's `OPENGRID_PLACEHOLDER_PEG_SIZE` TODO): a plain square peg in the same canonical local frame, base flush at Z=0, reaching to local -Z. Embedded into the panel by `MOUNT_PLATE_EMBED` (a coincident base face unions unreliably). */
function openGridConnectorSolid(wasm: ManifoldToplevel): Manifold {
  const s = OPENGRID_PLACEHOLDER_PEG_SIZE;
  const h = OPENGRID_PLACEHOLDER_PEG_REACH + MOUNT_PLATE_EMBED; // spans local Z=[-REACH, +EMBED] once centered and shifted below
  return wasm.Manifold.cube([s, s, h], true).translate([0, 0, (MOUNT_PLATE_EMBED - OPENGRID_PLACEHOLDER_PEG_REACH) / 2]);
}

/** One placeholder connector, placed at its own true (x, y) and rotated onto the layout's up/side axes -- see the file header. */
function mountPlateClipSolid(wasm: ManifoldToplevel, clip: ClipInstance, zBase: number): Manifold {
  return openGridConnectorSolid(wasm).rotate([0, 0, clip.rotationDeg]).translate([clip.x, clip.y, zBase]);
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
    const { layout, tolerance, columns, minCornerSegments, flangeThickness } = spec;
    const backZ = -flangeThickness - MOUNT_PLATE_THICKNESS; // the plate's own back (clip-bearing) face
    const frontZ = -flangeThickness; // the plate's own front (flange-mating) face

    let plate = track(outlinePrismSolid(wasm, layout.outline, MOUNT_PLATE_THICKNESS, backZ, columns, minCornerSegments));
    if (plate.status() !== "NoError") {
      throw new Error(`Mount plate panel mesh is not a valid manifold: ${plate.status()}`);
    }

    for (const clip of layout.clips) {
      plate = track(plate.add(track(mountPlateClipSolid(wasm, clip, backZ))));
    }
    for (const anchor of layout.anchors) {
      plate = track(plate.subtract(track(pinHoleCutter(wasm, anchor, tolerance, frontZ, -1))));
    }

    if (plate.status() !== "NoError") {
      throw new Error(`Mount plate mesh is not a valid manifold: ${plate.status()}`);
    }

    // Issue #219: where a clip's walls meet the panel's back face, its triangulation can pass a hair from a
    // clip's corner and leave edges far shorter than anything printable. Only a mesh with such edges changes.
    const outMesh = plate.getMesh();
    return weldShortEdges({ positions: new Float32Array(outMesh.vertProperties), indices: new Uint32Array(outMesh.triVerts) }).mesh;
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

/**
 * One SKÅDIS rim clip part (issue #207, skadisClips.ts): its (up, z) profile
 * extruded SKADIS_CLIP_WIDTH along the layout's side axis, centred on the
 * clip's own side, in the shared ASSEMBLY frame (seated on the board,
 * wrapping the rim). The extrusion runs along local Z; one affine map (a
 * proper rotation: up, z, side) carries it into place -- the STEP backend
 * builds the same prism from the same profile.
 */
export async function buildSkadisClip(layout: SkadisClipLayout, clip: RimClip): Promise<CoilMesh> {
  const wasm = await getWasm();
  const { up, side } = clipFrame(layout.axisDeg, clip.side);
  const s0 = clip.side - SKADIS_CLIP_WIDTH / 2;
  const prism = new wasm.CrossSection([clip.profile], "NonZero").extrude(SKADIS_CLIP_WIDTH);
  // Column-major: local x (up) -> up, local y (z) -> Z, local z (side) -> side, then the side offset.
  const placed = prism.transform([up.x, up.y, 0, 0, 0, 0, 1, 0, side.x, side.y, 0, 0, s0 * side.x, s0 * side.y, 0, 1]);
  try {
    if (placed.status() !== "NoError") throw new Error(`SKÅDIS clip is not a valid manifold: ${placed.status()}`);
    const outMesh = placed.getMesh();
    return { positions: new Float32Array(outMesh.vertProperties), indices: new Uint32Array(outMesh.triVerts) };
  } finally {
    prism.delete();
    placed.delete();
  }
}

/**
 * One SKÅDIS T-clip part (issues #213, #221, skadisTclips.ts): the union of its
 * convex pieces (the fin, the stem, the T bar), each the hull of its four
 * levels across the clip -- a prism with every edge chamfered -- seated and
 * turned, in the shared ASSEMBLY frame. The STEP backend lofts the same levels.
 */
export async function buildSkadisTclip(layout: SkadisTclipLayout, clip: Tclip): Promise<CoilMesh> {
  const wasm = await getWasm();
  const hulls = clip.pieces.map((piece) => wasm.Manifold.hull(tclipPieceLevels(layout.axisDeg, clip, piece).flat().map((p): [number, number, number] => [p.x, p.y, p.z])));
  const clipSolid = wasm.Manifold.union(hulls);
  try {
    if (clipSolid.status() !== "NoError") throw new Error(`SKÅDIS T-clip is not a valid manifold: ${clipSolid.status()}`);
    const outMesh = clipSolid.getMesh();
    return { positions: new Float32Array(outMesh.vertProperties), indices: new Uint32Array(outMesh.triVerts) };
  } finally {
    for (const h of hulls) h.delete();
    clipSolid.delete();
  }
}
