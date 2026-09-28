// Front-facing presentation rotation (issue #79): for a square or triangle
// core, the "Front" preset's camera direction is fixed (presets.ts's own
// `front`, world -Y) -- shapes.ts's own construction (`evalOutline`: corner
// `i` at standard angle `2*pi*i/n`, corner 0 on local +X) puts a CORNER, not
// a flat side, toward that fixed direction for both n=4 (square: corners on
// the axes, flats on the diagonals) and n=3 (triangle: neither a corner nor
// a flat lands on -Y). Seen corner-on, the model's own diamond-oriented
// footprint no longer lines up with `dimensionGeometry.ts`'s own flush-to-flats
// box (`measureDimensionFrame`'s `spin`, computed independent of any view),
// so the "front" camera reads that box on a DIAGONAL -- both ground axes
// stay visible at once, one of them reading past the model's own silhouette
// (issue #79's screenshot) instead of the single across-flats width a
// classic front elevation shows.
//
// The fix rotates the PRESENTED geometry about the coil axis (the same
// pattern `wallRotations.ts` uses for the wall-mount pose) so a flat side
// faces the fixed "Front" camera instead -- never the camera direction or
// the shape's own real (unrotated) build frame, which mount.ts's keyhole
// layout, the flange bore, etc. all still depend on. Doing it this way (not
// a per-shape camera direction) means Iso -- built from the SAME rotated
// presentation -- automatically reads "45 degrees off that flat" as the
// issue asks, with no separate bookkeeping, and the dimension axes (whose
// own box is rotated by the identical matrix, see CoilViewer.tsx's
// `dimensionMatrix`) end up flush with the ACTUAL on-screen silhouette
// again, restoring the single-span reading front already gives round.
//
// Round has no flats to face (shapes.ts: `cornerRadius === apothem`
// everywhere), so it's left un-rotated -- any angle looks identical.

import * as THREE from "three";
import type { ShapeKind } from "../core";
import { SHAPES } from "../core";

/**
 * The minimal-magnitude Z rotation (degrees) that moves the nearest flat
 * side's own midpoint (shapes.ts: side `i` sits at standard angle
 * `(i + 0.5) * (360 / corners)`) onto standard angle 270 -- world -Y, the
 * point of the footprint nearest the fixed "Front" camera (presets.ts:
 * direction `(0, -1, 0)`, i.e. the camera sits on -Y looking toward +Y).
 */
export function frontFlatRotationDeg(corners: number): number {
  const step = 360 / corners;
  const raw = 270 - step / 2; // a side sits at this angle (mod step) before rotation
  const delta = ((raw % step) + step) % step; // into [0, step)
  return delta > step / 2 ? delta - step : delta; // into (-step/2, step/2]
}

/** The presentation rotation for the "standing" view (Front/Iso), or `null`
 * for round/undefined (nothing to face). */
export function frontFacingRotation(shapeKind: ShapeKind | undefined): THREE.Matrix4 | null {
  if (!shapeKind || shapeKind === "round") return null;
  const degrees = frontFlatRotationDeg(SHAPES[shapeKind].corners);
  return new THREE.Matrix4().makeRotationZ((degrees * Math.PI) / 180);
}

/**
 * The angle (radians) to force into `dimensionGeometry.ts`'s own
 * `measureDimensionFrame(parts, forcedSpinRad)`, so its box stays flush with
 * the EXACT SAME flat `frontFacingRotation` just rotated to face the
 * camera -- not a separately, independently re-derived one.
 *
 * `measureDimensionFrame`'s own area search picks whichever angle it MEASURES
 * as smallest, which for a heavily-rounded, odd-cornered shape (a triangle)
 * is not always the flat-flush orientation this file targets -- a
 * "corner-through-the-axis" pose can measure a hair smaller (see this
 * function's own git history/PR for the worked example), so search and
 * rotation can silently disagree on which pose is "flush". Passing this
 * value instead removes the ambiguity: with the box's own spin at `-delta`
 * and the mesh's own rotation at `delta` (this file's `frontFacingRotation`),
 * the two exactly cancel (`R(delta) * R(-delta) = I`), so the box ends up
 * defined directly in WORLD coordinates -- and, by construction of `delta`
 * (chosen so this same flat's own world angle is exactly 270, `-Y`, the
 * fixed "Front" camera direction), that is guaranteed flush with it.
 */
export function frontFacingDimensionSpin(shapeKind: ShapeKind | undefined): number | undefined {
  if (!shapeKind || shapeKind === "round") return undefined;
  const degrees = frontFlatRotationDeg(SHAPES[shapeKind].corners);
  return (-degrees * Math.PI) / 180;
}
