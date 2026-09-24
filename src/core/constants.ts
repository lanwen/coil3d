// Fixed print/solver parameters (docs/research.md §2, §3). Not user-facing
// spec fields in this ticket; later tickets may promote some of these.

/** Core wall thickness; links the locked outer/inner size (docs/research.md §1). */
export const WALL_THICKNESS = 3; // mm
/** Added to the wire diameter for the winding pitch. */
export const CLEARANCE = 0.3; // mm
/** Groove depth = factor * wire diameter (docs/research.md §4 "Groove design"). */
export const GROOVE_DEPTH_FACTOR = 0.3;
/** Core height margin, top & bottom, outside the winding zone. */
export const MARGIN = 3; // mm
/** The groove fades out over this many turns at each end. */
export const TAPER_TURNS = 0.5;
/** Flange outer radius = solved envelope radius + this margin. */
export const FLANGE_MARGIN = 4; // mm
export const FLANGE_THICKNESS = 3; // mm
export const MIN_BORE_RADIUS = 1; // mm, guards against a wall thicker than the core
/** Bore corner radius floor for non-round shapes (spikes/s1-grooved-wall/geom.ts's `boreMinCornerR`): offsetting a corner inward by the wall thickness can drive it to <=0, which folds the outline. */
export const MIN_BORE_CORNER_RADIUS = 0.5; // mm
/** Non-round shapes (#6): a hairline hand-back from a fully-degenerate (zero-length straight side) corner radius, so the corner-fillet solid builder (STEP) never sees an exactly-round rounded polygon. Imperceptible at print resolution. */
export const SHAPE_ROUNDING_EPS = 0.01; // mm
/** Default corner radius offered for a new sq/tri shape before any bend-limit clamping (docs/research.md §2 "shape params"). */
export const DEFAULT_CORNER_RADIUS = 8; // mm

// Two mesh resolutions (issue #7, docs/research.md §10a/§10b): a coarse
// "draft" while the user is still editing, tuned to roughly the S1 spike's
// ~16k-triangle preview (25-33 ms), and a "final" for the settled view, STL,
// 3MF and STEP, tuned to the spike's ~170k-triangle final (~240 ms). Both use
// the same `buildWall`/`fuseFlange` code path -- only these counts differ --
// so draft and final can never geometrically drift apart.
export const FINAL_COLUMNS = 96; // mesh columns around the circumference
export const FINAL_ROWS_PER_PITCH = 8; // mesh rows per helical pitch
export const DRAFT_COLUMNS = 24;
export const DRAFT_ROWS_PER_PITCH = 3;

/** Cords longer than this are not supported (docs/research.md §1). */
export const MAX_WIRE_LENGTH = 15000; // mm

// Solver search bounds (spikes/s5-solver/src/solver/solve.ts).
export const SIZE_LO_FLOOR = 5; // mm
export const SIZE_HI = 500; // mm
export const HEIGHT_HI = 400; // mm, practical upper bound
export const LAYERS_HI = 40;

/**
 * Sensible minimum turns per layer for the `minVolume` objective (issue #23):
 * nobody would wind a coil with only 1-2 turns per layer stacked six layers
 * deep just to minimize a bounding-cylinder volume estimate. Candidates with
 * fewer turns per layer than this are heavily (not absolutely) penalized in
 * `envelopeVolumeFor` (solve.ts), so they still get picked when there is no
 * better-shaped alternative that covers the target length.
 */
export const MIN_TURNS_PER_LAYER = 5;
