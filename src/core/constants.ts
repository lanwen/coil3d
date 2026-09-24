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

// The schematic wound-cable centerline (issue #4, wire.ts) gets the same
// draft/final split: a coarse, cheap sample while the user is still editing,
// and a dense one once input settles (and always for the on-screen final
// render -- the wire path is schematic, never exported, so there's no STEP
// analogue here). Density is arc-length-driven (samples per turn scale with
// how long a turn actually is), with a floor so a small, tightly-wound coil
// still gets enough samples per turn for a smooth curve.
export const FINAL_WIRE_MIN_SAMPLES_PER_TURN = 96;
export const FINAL_WIRE_MAX_ARC_LENGTH = 1; // mm per sample, at most
export const DRAFT_WIRE_MIN_SAMPLES_PER_TURN = 16;
export const DRAFT_WIRE_MAX_ARC_LENGTH = 4; // mm per sample, at most

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

// Top cap + joints (issue #9, docs/research.md §1 "Cap joint" & §4
// "Joints / tolerances"). The cap is a symmetric "top flange": same outer
// footprint as the bottom flange (FLANGE_MARGIN/FLANGE_THICKNESS), sitting
// above the wall's z=height the same way the flange sits below z=0. All
// three joints share one circular engagement collar centered on the coil
// axis, regardless of the core's own cross-section (round/sq/tri) -- a
// circular collar is simple, always manifold, and needs only one global
// tolerance (docs/research.md). For a non-round bore the collar contacts the
// bore's flat sides, not its corners: a normal, printable fit, not a defect.
export const CAP_THICKNESS = 3; // mm, mirrors FLANGE_THICKNESS
/** One global print tolerance the user can dial in, scaling every joint's fit. */
export const DEFAULT_TOLERANCE = 0.2; // mm
export const TOLERANCE_MIN = 0.05; // mm
export const TOLERANCE_MAX = 0.8; // mm
/** How far the cap's engagement collar reaches down into the core's bore. */
export const JOINT_ENGAGE_DEPTH = 7; // mm
/** Height of the frustum that flares the collar's top out from `collarRadius` to (the bore's own radius + WELD_OVERLAP), so it genuinely overlaps the plate's inner edge -- welds the collar to the plate as one solid instead of leaving two that merely touch. */
export const JOINT_TRANSITION_HEIGHT = 2; // mm
/** A real volumetric overlap (not just a coincident, razor-thin seam) between two independently-tessellated curved surfaces meeting at "the same" nominal radius, so their boolean union is robust rather than producing stray degenerate slivers. */
export const WELD_OVERLAP = 1; // mm
/** Fixed clearance between the collar's nominal OD and the bore's own inscribed (flat-side) radius, before `tolerance` -- keeps the collar clear of a non-round bore's corners too. */
export const JOINT_FIT_GAP = 0.3; // mm
/** Bore inscribed radius below which bayonet/snap core-side cuts are skipped (falls back to a plain press collar): too small to cut real features into a 3 mm wall without breaking through. */
export const JOINT_MIN_BORE_RADIUS = 4; // mm

export const BAYONET_LUG_COUNT = 3;
export const BAYONET_GAP = 0.4; // mm, fixed sliding clearance for the twist motion
export const BAYONET_LUG_HEIGHT = 1.2; // mm, radial protrusion of each lug past the collar
export const BAYONET_LUG_WIDTH = 5; // mm, tangential width of each lug and its entry slot
export const BAYONET_LEAD = 4; // mm, straight vertical entry depth before the twist-lock groove
export const BAYONET_GROOVE_HEIGHT = 2.2; // mm, axial height of the twist-lock groove

export const SNAP_HOOK_COUNT = 3;
export const SNAP_GAP = 0.3; // mm, fixed clearance so the fingers always enter freely
export const SNAP_BARB = 0.9; // mm, how far each hook's barb protrudes past the finger's nominal OD
export const SNAP_BARB_HEIGHT = 1.6; // mm, axial height of the barb band
export const SNAP_RIDGE_THICKNESS = 1.4; // mm, axial height of the core-side retaining ridge
export const SNAP_SLOT_WIDTH = 2; // mm, tangential width of the relief slot between fingers

/** Rim keyhole (top cap, outer cable end): the retaining slit is narrower than the hole so the cable grips after insertion. */
export const KEYHOLE_SLIT_FRACTION = 0.6;

// Print bed (issue #10, docs/research.md §1 "Print"/"bed size"). A generic
// 256x256x256 mm build volume (e.g. Bambu X1C/P1S, Prusa MK4) is a sensible
// default for "warn me if a part doesn't fit" -- most FDM printers this
// project targets are at or below this size.
export const DEFAULT_BED_SIZE = 256; // mm, each axis
export const BED_SIZE_MIN = 50; // mm
export const BED_SIZE_MAX = 1000; // mm
/** Gap left between adjacent parts' footprints when laying out the 3MF build plate (export/threeMf.ts, core/plate.ts). */
export const PLATE_GAP = 5; // mm
