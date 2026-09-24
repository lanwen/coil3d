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
export const COLUMNS = 96; // mesh columns around the circumference
export const ROWS_PER_PITCH = 8; // mesh rows per helical pitch

/** Cords longer than this are not supported (docs/research.md §1). */
export const MAX_WIRE_LENGTH = 15000; // mm

// Solver search bounds (spikes/s5-solver/src/solver/solve.ts).
export const SIZE_LO_FLOOR = 5; // mm
export const SIZE_HI = 500; // mm
export const HEIGHT_HI = 400; // mm, practical upper bound
export const LAYERS_HI = 40;
