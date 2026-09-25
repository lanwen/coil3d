// Shared joint-geometry numbers (issue #9, docs/research.md §1 "Cap joint" &
// §4 "Joints / tolerances"): both the mesh backend (manifold.ts, via
// manifold-3d primitives) and the STEP backend (step/build.ts, via
// replicad/OCCT primitives) derive their joint dimensions from this ONE
// function, so the two backends can never drift apart on fit -- mirroring
// how wallSpec/flangeSpec keep the mesh and STEP walls from drifting.
//
// All three joints share the SAME engagement-radius arithmetic (fit gap +
// per-kind clearance) regardless of the core's own cross-section
// (round/sq/tri), but the collar's own OUTLINE follows the bore's true shape
// (issue #55), not a plain circle: `collarRadius`/`boreRadius` below are the
// FLAT-SIDE (apothem) values, used to size that outline consistently for
// every shape (round degenerates to its old plain-circle collar for free,
// see shapes.ts's own "round is n=4, cornerRadius=apothem" convention).
//
// Why this matters: a plain circular collar sized off the bore's inscribed
// (flat-side) radius clears a non-round bore's CORNERS by a large, uneven
// margin -- fine for the engagement fit itself (docs/research.md called this
// "not a defect"), but fatal for `collarBase`'s own weld step, which flares
// the collar's top out to overlap the plate's inner (bore) edge: a circle at
// `boreRadius + WELD_OVERLAP` only reaches the plate's hole boundary near
// each flat side's own midpoint, leaving the corners of a sq/tri bore's hole
// edge completely untouched. The result was two individually-valid manifolds
// (`status() === "NoError")` each) that were never actually ONE part --
// `decompose().length === 2`, a floating collar the mesh viewer showed as a
// disconnected disc (issue #55's repro). Shape-following `collarOutline`/
// `weldOutline` below fix this at the source: both are the bore's own
// outline (Steiner-offset, shapes.ts), so the weld top always coincides with
// -- and fully overlaps -- the plate's hole edge at EVERY angle, flats and
// corners alike, for any shape.

import { JOINT_FIT_GAP, BAYONET_GAP, SNAP_GAP, SHAPE_ROUNDING_EPS, WELD_OVERLAP } from "./constants";
import { inscribedRadius, offsetOutline } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { JointKind } from "./types";

export interface JointGeometry {
  /** The bore's own inscribed (flat-side) radius, mm -- the collar's absolute ceiling. */
  boreRadius: number;
  /** The engagement collar's nominal radius before the per-kind fit clearance: the bore's inscribed radius, minus a fixed gap so a non-round bore's corners are never touched. */
  jointRadius: number;
  /** The collar/finger OD actually used (its flat-side/apothem value), after `tolerance` and (for bayonet/snap) the extra sliding/flex clearance those joints need. */
  collarRadius: number;
  /**
   * The engagement collar's own footprint (issue #55): the bore's outline,
   * offset inward so its apothem equals `collarRadius` -- a uniform gap from
   * the bore's true wall at every angle (flat sides AND corners), not just a
   * circle inscribed at the flats. Round reduces to a plain circle of radius
   * `collarRadius` for free (see shapes.ts's `offsetOutline`). The corner
   * radius is floored a hairline above 0 (`SHAPE_ROUNDING_EPS`, matching
   * solve.ts's own "never quite fully round" floor), never left negative --
   * an inward offset larger than the bore's own corner radius would
   * otherwise invert the outline (shapes.ts's `offsetOutline` doc comment).
   */
  collarOutline: ShapeOutline;
  /**
   * The collar's weld footprint at the plate's own bore edge (issue #55):
   * `boreOutline` offset OUTWARD by `WELD_OVERLAP`, so the collar's flared
   * top genuinely overlaps the plate's inner (bore) surface at every angle
   * -- guaranteeing one connected, printable part regardless of shape.
   */
  weldOutline: ShapeOutline;
}

export function jointGeometry(boreOutline: ShapeOutline, kind: JointKind, tolerance: number): JointGeometry {
  const boreRadius = inscribedRadius(boreOutline, 0);
  const jointRadius = Math.max(2, boreRadius - JOINT_FIT_GAP);
  const collarRadius =
    kind === "press"
      ? Math.max(1, jointRadius - tolerance)
      : kind === "bayonet"
        ? Math.max(1, jointRadius - BAYONET_GAP - tolerance)
        : Math.max(1, jointRadius - SNAP_GAP - tolerance);
  const collarOutline: ShapeOutline = {
    n: boreOutline.n,
    apothem: collarRadius,
    cornerRadius: Math.max(SHAPE_ROUNDING_EPS, boreOutline.cornerRadius - (boreRadius - collarRadius)),
  };
  const weldOutline = offsetOutline(boreOutline, WELD_OVERLAP);
  return { boreRadius, jointRadius, collarRadius, collarOutline, weldOutline };
}
