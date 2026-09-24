// Inner-end fixing (issue #8, docs/research.md "Wire ends": "keyhole in the
// bottom flange rim at the groove start, with a recessed radial channel on
// the flange's inner face so layers don't wind over a bump", and §8 item 3:
// "the start of the winding is a bend-radius hotspot ... model it as a
// tangent ramp"). Pure geometry math only -- no manifold-3d, no replicad --
// shared by the mesh backend (manifold.ts), the STEP backend
// (step/build.ts) AND the wound-cable schematic's lead-in (wire.ts), the
// same "one shared layout, several consumers" principle as mount.ts's
// `layoutKeyholeMount`: all three must agree on exactly where the hole,
// slit and channel sit, or the printed part and the schematic drawing would
// silently disagree.
//
// Geometry: the keyhole (a round hole + a narrower retaining slit reaching
// the flange's TRUE outer edge, same shape as the top cap's own rim keyhole,
// see manifold.ts's `buildKeyholeCutter`) sits at the groove's own start
// angle (arc-length t=0 -- the SAME reference point the top cap's keyhole
// uses, and the point the wall's helix itself starts winding from, see
// wall.ts). The channel is a shallow trench from that keyhole to the wall's
// own outer surface at t=0 (the physical groove start), curving from
// "radial" (leaving the keyhole) to "tangential" (entering the groove) via
// one circular fillet arc -- the standard corner-fillet construction, with
// the "corner" at the groove-start point itself: the fillet's two tangent
// points sit AT distance `channelRadius` from the groove point, one back
// along the radial line (towards the keyhole) and one forward along the
// tangential line (into the winding direction), so the path never actually
// needs to visit the mathematical corner point to change direction smoothly
// -- exactly what "tangent ramp" describes.
//
// `edge` (the flange's true outer boundary at t=0) and `groove` (the wall's
// own outer surface at the same t=0, offset 0) sit on the SAME ray from that
// corner's own local center (shapes.ts's `pointAt`/`evalOutline`: same
// corner-arc param, only the radial offset term differs), so `edge - groove`
// is exactly `margin` along the outward normal -- which is what lets `D`
// below (the keyhole-to-groove distance) be computed directly, with no
// separate case for round vs. rounded-square/-triangle.

import { INNER_CHANNEL_ARC_SEGMENTS, INNER_CHANNEL_DEPTH_FACTOR, INNER_CHANNEL_MIN_SHELF, KEYHOLE_SLIT_FRACTION, SCREW_MOUNT_RECESS_DEPTH } from "./constants";
import { pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";

/** Ideal channel recess depth for the given wire diameter (issue #8): roughly a full cable diameter, so the wound cable's first turn lies flush -- see INNER_CHANNEL_DEPTH_FACTOR's own doc comment. */
export function idealChannelDepth(wireDiameter: number): number {
  return INNER_CHANNEL_DEPTH_FACTOR * wireDiameter;
}

/**
 * The channel's ACTUAL recess depth, given the flange's own (already
 * resolved) thickness: the ideal depth, capped to whatever the flange's
 * thickness leaves below a small shelf -- and, when there's also a
 * screw-keyhole mount pocket cut into the OTHER face (issue #13, a fixed
 * SCREW_MOUNT_RECESS_DEPTH reserved from the flange's outer/z=-thickness
 * side), below THAT recess too, so the two never meet in the middle.
 *
 * This deliberately never asks design.ts to grow the flange's own thickness
 * to fit the full ideal depth (an earlier version did): `design()`'s
 * flange thickness is capped at a small, already-well-tested set of values
 * (FLANGE_THICKNESS or, with a mount, MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT),
 * and pushing it materially higher was found to trip a latent manifold-3d
 * boolean-robustness bug in the mount's OWN (unrelated, pre-existing)
 * recess cut at several thickness values -- nothing to do with this
 * feature's own geometry (confirmed by reproducing the same stray-sliver
 * genus failure with the inner-end cutter fully disabled). Capping the
 * channel instead of growing the flange sidesteps that landmine entirely,
 * and is itself a perfectly reasonable reading of the ticket's own "bump
 * it OR warn" -- design.ts warns when the mount forces a shallower channel.
 */
export function resolveChannelDepth(wireDiameter: number, flangeThickness: number, hasMount: boolean): number {
  const ideal = idealChannelDepth(wireDiameter);
  const reserved = INNER_CHANNEL_MIN_SHELF + (hasMount ? SCREW_MOUNT_RECESS_DEPTH : 0);
  return Math.min(ideal, Math.max(0, flangeThickness - reserved));
}

export interface XY {
  x: number;
  y: number;
}

export interface InnerEndLayout {
  /** Keyhole hole centre, in the flange's local XY (mm) -- inset from `edge` by holeRadius + a mm of skin, same convention as the top cap's own keyhole. */
  hole: XY;
  /** The flange's true outer edge point at t=0, where the retaining slit opens (mm). */
  edge: XY;
  /** The wall's own outer surface at t=0, offset 0 -- where the physical groove begins (mm). */
  groove: XY;
  holeRadius: number;
  slitWidth: number;
  /** Width of the recessed channel trench, mm. */
  channelWidth: number;
  /**
   * Dense centreline samples of the channel, from the keyhole (`channelPath[0]`,
   * always `hole` itself) to a point tangent into the winding direction near
   * `groove` (`channelPath[channelPath.length - 1]`) -- shared verbatim by
   * the mesh/STEP channel cutters (a shallow recess) AND the wound-cable
   * schematic's lead-in (wire.ts), so all three can never drift apart.
   */
  channelPath: XY[];
  /** The fillet radius the channel was actually built with, mm: `min(bendRadius, D)`, where `D` is the keyhole-to-groove distance available inside the flange margin. Equal to the requested `bendRadius` only when the margin was roomy enough. */
  channelRadius: number;
  /**
   * A closed 2D polygon tracing the channel trench's own OUTLINE (not just
   * its centreline), already `channelWidth` wide, for each backend to
   * extrude ONCE (manifold-3d's `CrossSection.extrude`, replicad's
   * `makePolygon`+`Sketch.extrude`) -- see `layoutInnerEnd`'s own comment
   * for why this is computed analytically (offsetting the straight segment
   * and the circular fillet arc each by their own exact geometry) rather
   * than by numerically offsetting the discrete `channelPath` samples: a
   * naive per-sample offset was found to occasionally produce a
   * self-intersecting polygon (invalid for replicad/OCCT to extrude,
   * though manifold-3d's NonZero-fill CrossSection tolerated it) wherever
   * consecutive samples were closely spaced relative to the width.
   */
  channelRibbon: XY[];
  /** Set only when the flange margin can't even clear the keyhole from the groove-start point (D<=0): there's no room for ANY curve, so the channel falls back to an unrelieved sharp corner. A tighter-than-ideal (but still curved) fillet is the ordinary case and doesn't warn -- see the file header. */
  warning?: string;
}

/** mm of rim material deliberately left outside the keyhole (mirrors manifold.ts's `buildKeyholeCutter`). */
const SKIN = 1;

/**
 * Lay out the bottom-flange keyhole + inner channel. `outline`/`margin`
 * mirror manifold.ts's `FlangeSpec.outline`/`.margin` exactly (the wall's own
 * outline and the flange's margin beyond it), so every backend derives the
 * identical layout from identical inputs -- same convention as mount.ts's
 * `layoutKeyholeMount`.
 */
export function layoutInnerEnd(outline: ShapeOutline, margin: number, wireDiameter: number, tolerance: number, bendRadius: number): InnerEndLayout {
  const holeRadius = wireDiameter / 2 + tolerance;
  const slitWidth = wireDiameter * KEYHOLE_SLIT_FRACTION + tolerance;
  const channelWidth = wireDiameter + tolerance;

  const edgeP = pointAt(outline, 0, margin);
  const grooveP = pointAt(outline, 0, 0);
  const edge: XY = { x: edgeP.x, y: edgeP.y };
  const groove: XY = { x: grooveP.x, y: grooveP.y };
  // Outward normal, shared by `edge` and `groove` (see the file header).
  const nx = edgeP.nx;
  const ny = edgeP.ny;
  // Tangential (winding) direction: whichever way `t` actually increases at
  // t=0, found numerically so it works identically for shapes.ts's round
  // closed-form branch and its general corner-arc branch, without assuming a
  // fixed rotation of the normal (which corner-arc geometry doesn't keep,
  // see `evalOutline`'s own varying corner centres).
  const aheadP = pointAt(outline, 1e-4, 0);
  const rawTx = aheadP.x - grooveP.x;
  const rawTy = aheadP.y - grooveP.y;
  const tLen = Math.hypot(rawTx, rawTy) || 1;
  const tx = rawTx / tLen;
  const ty = rawTy / tLen;

  const hole: XY = { x: edge.x - nx * (holeRadius + SKIN), y: edge.y - ny * (holeRadius + SKIN) };

  // D: available radial distance between the keyhole and the groove-start
  // point, along their shared normal ray (may be negative). `edge = groove +
  // margin*n` and `hole = edge - (holeRadius+SKIN)*n`, so `hole - groove =
  // (margin - holeRadius - SKIN)*n` directly -- no trig needed.
  const rawD = margin - holeRadius - SKIN;
  const channelRadius = Math.max(0, Math.min(bendRadius, rawD));
  // A tighter-than-ideal fillet (channelRadius < bendRadius, D>0) is the
  // ordinary case -- the flange margin (a few mm, docs/research.md's
  // FLANGE_MARGIN) is almost always smaller than a real cable's own minimum
  // bend radius (multiplier * diameter, often tens of mm), so warning on
  // that alone would fire for nearly every design. Warn only on the genuine
  // "impossible" case the ticket describes: the keyhole itself doesn't even
  // clear the groove-start point (D<=0), so there is no room left for ANY
  // curve at all -- the channel falls back to an unrelieved sharp corner.
  const warning =
    rawD <= 1e-6
      ? `The ${margin.toFixed(1)} mm flange margin is too narrow for the inner-end keyhole and a curved lead-in at this ${wireDiameter.toFixed(1)} mm cable's diameter; the channel enters the groove through an unrelieved sharp corner instead of the ${bendRadius.toFixed(1)} mm minimum bend radius.`
      : undefined;
  const D = Math.max(0, rawD);

  // De-duplicate consecutive (near-)identical points, most notably wherever
  // D===R (channelRadius clamped by the flange margin rather than the
  // wire's own bend radius -- the common case, since a real cable's bend
  // radius is usually far bigger than the flange margin, see the warning's
  // own comment above): the straight segment's own endpoint and the arc's
  // own first sample then coincide exactly. A polygon with a zero-length
  // edge crashed replicad/OCCT's `makePolygon` outright (a raw
  // WebAssembly.Exception, not a catchable validation failure like the
  // sliver/invalid-BRep issues elsewhere in this file's history).
  const dedupe = (pts: Array<[number, number]>): Array<[number, number]> =>
    pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9);

  // Local frame: origin at `groove`, x-axis = outward normal (towards the
  // keyhole), y-axis = tangential (the winding direction). The keyhole sits
  // at local (D, 0) (see the D derivation above); the fillet's centre sits
  // at (channelRadius, channelRadius), tangent to the radial line (the local
  // x-axis) at (channelRadius, 0) and tangent to the tangential line (the
  // local y-axis) at (0, channelRadius) -- the standard corner fillet, with
  // the arc sweeping the SHORT way (through the corner-ward point, e.g. at
  // 225 degrees when channelRadius>0) rather than the long way around.
  const R = channelRadius;
  const arcAngle = (i: number) => -Math.PI / 2 - (i / INNER_CHANNEL_ARC_SEGMENTS) * (Math.PI / 2);
  const localPath = dedupe([
    [D, 0],
    [R, 0],
    ...Array.from({ length: INNER_CHANNEL_ARC_SEGMENTS + 1 }, (_, i): [number, number] => {
      const theta = arcAngle(i);
      return [R + R * Math.cos(theta), R + R * Math.sin(theta)];
    }),
  ]);

  // The ribbon (channel trench OUTLINE, channelWidth wide) is offset
  // ANALYTICALLY from the same two known primitives the centreline is built
  // from -- a straight segment (offset by a constant +-half in local y, its
  // own perpendicular) and a circular arc centred at (R,R) (offset by
  // +-half in the RADIAL direction from that SAME centre, i.e. at radii
  // R+half and max(0, R-half)) -- rather than by numerically offsetting the
  // discrete `channelPath` samples above: a naive per-sample offset was
  // found to occasionally produce a SELF-INTERSECTING polygon wherever
  // consecutive samples were closely spaced relative to the width (replicad/
  // OCCT then extrudes an invalid BRep from it; manifold-3d's NonZero-fill
  // CrossSection tolerated the same input). The two rails are built so they
  // agree exactly at the straight-to-arc junction (both evaluate to
  // (R, -+half) there), so the seam is C0-continuous with no gap or kink.
  const half = channelWidth / 2;
  const rOuter = R + half;
  const rInner = Math.max(0, R - half);
  const outerRail: Array<[number, number]> = [
    [D, -half],
    [R, -half],
    ...Array.from({ length: INNER_CHANNEL_ARC_SEGMENTS + 1 }, (_, i): [number, number] => {
      const theta = arcAngle(i);
      return [R + rOuter * Math.cos(theta), R + rOuter * Math.sin(theta)];
    }),
  ];
  const innerRail: Array<[number, number]> = [
    [D, half],
    [R, half],
    ...Array.from({ length: INNER_CHANNEL_ARC_SEGMENTS + 1 }, (_, i): [number, number] => {
      const theta = arcAngle(i);
      return [R + rInner * Math.cos(theta), R + rInner * Math.sin(theta)];
    }),
  ];
  const localRibbon = dedupe([...outerRail, ...innerRail.slice().reverse()]);

  const toGlobal = ([lx, ly]: [number, number]): XY => ({
    x: groove.x + nx * lx + tx * ly,
    y: groove.y + ny * lx + ty * ly,
  });
  const channelPath: XY[] = localPath.map(toGlobal);
  const channelRibbon: XY[] = localRibbon.map(toGlobal);

  return { hole, edge, groove, holeRadius, slitWidth, channelWidth, channelPath, channelRadius, channelRibbon, warning };
}
