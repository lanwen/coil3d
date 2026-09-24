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

// Top cap label (issue #12, docs/research.md §1 "Extras": embossed label
// text on the top cap face, only when it fits). Engraved, not raised -- see
// label.ts's file header for why the print orientation forces that choice.
/** Minimum legible ink height for the label text (ticket: "e.g. >= 5mm"); below this the label is hidden and a warning is emitted instead. */
export const LABEL_MIN_HEIGHT = 5; // mm
/** Cosmetic ceiling so a big cap doesn't get an oversized label; the fit search (label.ts's `fitLabel`) still shrinks below this when the annulus is tight. */
export const LABEL_MAX_HEIGHT = 14; // mm
/** Clearance kept between the label's text band and both the bore hole and the plate's outer rim. */
export const LABEL_MARGIN = 2; // mm
/** Engraved recess depth, comfortably less than CAP_THICKNESS so the pocket never breaks through to the collar side. */
export const LABEL_DEPTH = 0.6; // mm
/** Straight-line segments per glyph Bezier curve when flattening opentype paths (label.ts's `pathToLoops`) -- plenty of fidelity at FDM/engraving scale. */
export const LABEL_CURVE_SEGMENTS = 6;
/** Longest label text accepted from the UI/hash -- generous for a one-line cap label, small enough to keep the hash short. */
export const LABEL_MAX_LENGTH = 40;

// Screw-keyhole wall mount (issue #13, docs/research.md "Mounting"): a
// recessed pocket cut into the bottom flange's OUTER (wall-facing) face --
// see src/core/mount.ts for the shared layout math and the PR description
// for why this is a plain (bridging) pocket rather than a teardrop/coned
// ceiling. Sized for a common wood screw: head ~8 mm, shank ~4 mm.
export const SCREW_MOUNT_HEAD_DIAMETER = 8; // mm: screw-head clearance
export const SCREW_MOUNT_SHANK_DIAMETER = 4; // mm: screw-shank clearance
export const SCREW_MOUNT_HEAD_RADIUS = SCREW_MOUNT_HEAD_DIAMETER / 2;
export const SCREW_MOUNT_SHANK_RADIUS = SCREW_MOUNT_SHANK_DIAMETER / 2;
/** Centre-to-centre distance from the head opening to the shank's resting point. */
export const SCREW_MOUNT_SLOT_TRAVEL = 4; // mm
/** Minimum flange material left around the cut, to the bore and to the flange's own outer edge. */
export const SCREW_MOUNT_EDGE_MARGIN = 1; // mm
/** Depth of the pocket, cut inward from the flange's outer (wall-facing) face. */
export const SCREW_MOUNT_RECESS_DEPTH = 3; // mm
/** Minimum flange material left ABOVE the recess: the load-bearing "roof" the screw head presses against once hung. */
export const SCREW_MOUNT_MIN_SHELF = 2; // mm
/** design.ts bumps FLANGE_THICKNESS up to this (and warns) whenever mount === "keyhole". */
export const MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT = SCREW_MOUNT_RECESS_DEPTH + SCREW_MOUNT_MIN_SHELF; // 5 mm
/**
 * The pure radial-annulus width (wall thickness + margin) the slot itself
 * needs, at whichever exact angle it ends up placed at (mount.ts's
 * `radiusAtAngle`-based, per-shape placement -- issue #13 PR review: an
 * earlier, angle-agnostic version of this budget used `circumscribedRadius`
 * unconditionally, sizing the flange for a corner even when the slot doesn't
 * actually sit at one, which for a non-round shape can be so pessimistic the
 * mount never fits at all). This is shape-independent -- design.ts combines
 * it with the shape's own exact bulge at the chosen angle to get the actual
 * margin bump, via mount.ts's `requiredFlangeMargin`.
 */
export const SCREW_MOUNT_ANNULUS_WIDTH = SCREW_MOUNT_SLOT_TRAVEL + SCREW_MOUNT_HEAD_RADIUS + SCREW_MOUNT_SHANK_RADIUS + 2 * SCREW_MOUNT_EDGE_MARGIN;
/** Above this flange diameter, 2 slots are used (side by side) instead of 1, for a more stable, non-twisting hang. */
export const SCREW_MOUNT_TWO_SLOT_FLANGE_THRESHOLD = 90; // mm
/** Half-angle (from the chosen axis) between the 2 slots on a large flange. */
export const SCREW_MOUNT_TWO_SLOT_ANGLE = 25; // degrees
/**
 * How far from true vertical (WALL_UP, mount.ts) the mount will tilt its
 * placement axis to land on a cheaper (less-bulging) direction -- e.g. a
 * flat side's own midpoint instead of a sharp corner. The PR review's own
 * suggested range for the 2-slot case ("+-30-45 degrees from vertical").
 */
export const SCREW_MOUNT_AXIS_SEARCH_MAX_DEG = 60;

// Clip mount plate (issue #14, docs/research.md §10b "SKÅDIS clip" +
// PR research): a SEPARATE part that glues or snaps onto the bottom
// flange's outer (wall-facing) face -- see mountPlate.ts. Its own footprint
// is a uniform inward offset of the flange's outline (offsetOutline, always
// strictly inside it -- AC "the plate must fit inside the flange outline").
export const MOUNT_PLATE_THICKNESS = 3; // mm, the flat panel itself
/** How far inside the flange's own outer edge the plate's footprint sits. */
export const MOUNT_PLATE_EDGE_MARGIN = 3; // mm

/** SKÅDIS pegboard hole grid pitch, both directions (docs/research.md §10b, from skapa: "on a 40x40mm grid"). */
export const SKADIS_PITCH = 40; // mm
/**
 * openGrid's own grid pitch -- verified against openGrid's own docs
 * (opengrid.world/guides/board: "The board system uses a 28x28mm grid
 * pattern"; github.com/openGrid-3D/openGrid-docs, same wording, "Gridfinity
 * Compatibility: 3 openGrid units = 84mm = 2 Gridfinity units"). This is the
 * one openGrid number this ticket implements with confidence; the snap/
 * connector's own engagement geometry is NOT published as text/CAD dimensions
 * anywhere in openGrid's docs (only as STL/STEP downloads), so it is left as
 * a placeholder -- see mountPlate.ts's `buildOpenGridConnectorProfile` TODO.
 */
export const OPENGRID_PITCH = 28; // mm

/** Softens the grid search: at most this many clip positions on either side of center, per axis, so an oversized flange doesn't grow an absurd clip count. */
export const MOUNT_PLATE_MAX_PER_SIDE = 4;
/** At least this many clip columns must fit for the plate to be worth printing (issue #14 AC: "warn if the flange is too small for at least 2 clips"). */
export const MOUNT_PLATE_MIN_CLIPS = 2;

// SKÅDIS clip hook (docs/research.md §10b): a 2D polygon in mm, reimplemented
// (not copied) from the skapa-derived measurements research.md records as "a
// good starting point" -- itself flagged there as needing a real-board
// check (docs/research.md §11 "Values still to verify"). Interpreted here in
// a LOCAL (up, reach) plane: `up` runs along the plate's own vertical
// (mount.ts's WALL_UP-aligned) axis -- the hook's own internal footprint
// along the slot -- and `reach` is protrusion distance from the plate's back
// (clip-bearing) face, outward into the board. Extruded along the third,
// `side` axis by SKADIS_CLIP_WIDTH, then mirrored about its own local
// up=0 to make one symmetric, double-flanked hook per grid position
// (research.md: "extruded 12mm and mirrored").
export const SKADIS_CLIP_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0.95, 0],
  [2.45, 0],
  [2.45, 3.7],
  [3.05, 4.3],
  [3.05, 5.9],
  [2.45, 6.5],
  [0.95, 6.5],
];
/**
 * The same profile with its top corner (the short flat "ceiling" between
 * [2.45,6.5] and [0.95,6.5]) chamfered away into one continuous 45 degree
 * taper -- used for every row except the topmost one (issue #14 AC: "chamfer
 * the lower rows at 45", research.md: "rows after the first get a 45
 * chamfer so they print without supports"). The topmost row's own tip stays
 * fully exposed once printed (nothing else of the plate sits above it), so
 * it alone can keep the small flat bridge; every row below it has this
 * flat step chamfered away so nothing depends on a short unsupported bridge
 * printing cleanly.
 */
export const SKADIS_CLIP_PROFILE_CHAMFERED: ReadonlyArray<readonly [number, number]> = [
  [0.95, 0],
  [2.45, 0],
  [2.45, 3.7],
  [3.05, 4.3],
  [3.05, 5.9],
  [0.95, 6.5],
];
export const SKADIS_CLIP_WIDTH = 12; // mm, extrusion width along `side` (research.md: "extruded 12mm")

/**
 * openGrid connector placeholder (issue #14): a simple push-fit peg sized
 * to loosely engage a 28mm grid square opening, standing in for openGrid's
 * own (unverified -- see OPENGRID_PITCH's comment) snap geometry. Clearly a
 * TODO, not the real openGrid connector: swap this for the actual snap
 * geometry once it's verified against openGrid's own CAD files or a real
 * board.
 */
export const OPENGRID_PLACEHOLDER_PEG_SIZE = 14; // mm square, comfortably inside a 28mm cell
export const OPENGRID_PLACEHOLDER_PEG_REACH = 5; // mm, protrusion from the plate's back face

/** Alignment pegs (glue joint, issue #14 AC: "small alignment pegs into shallow holes in the flange"). */
export const MOUNT_PLATE_PEG_RADIUS = 2; // mm
export const MOUNT_PLATE_PEG_HEIGHT = 2; // mm, protrusion from the plate's front (flange-facing) face
export const MOUNT_PLATE_PEG_HOLE_CLEARANCE = 0.15; // mm, added to the peg radius for the flange's blind hole
export const MOUNT_PLATE_PEG_HOLE_DEPTH = 2.4; // mm, slightly deeper than the peg so it always bottoms out on the flat, not the peg tip

/** Simple printable snap tabs (snap joint, issue #14 AC: "simple printable snap tabs"): a cantilever finger with a barb, mirroring joints.ts's SNAP_* numbers but for a flat mating face rather than a radial collar. */
export const MOUNT_PLATE_SNAP_TAB_WIDTH = 6; // mm, tangential width of the finger
export const MOUNT_PLATE_SNAP_TAB_THICKNESS = 1.6; // mm, finger thickness before the barb
export const MOUNT_PLATE_SNAP_TAB_REACH = 3; // mm, how far the finger protrudes from the plate's front face
export const MOUNT_PLATE_SNAP_BARB = 0.6; // mm, how far the barb protrudes past the finger's own face on each side
export const MOUNT_PLATE_SNAP_GAP = 0.25; // mm, flex clearance so the finger always enters freely
export const MOUNT_PLATE_SNAP_POCKET_DEPTH = 3.4; // mm, depth of the flange's blind pocket -- deeper than MOUNT_PLATE_SNAP_TAB_REACH so the finger seats on the barb, never bottoms out on its own tip; still comfortably less than MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT, so it never breaks through
/** Axial band, right at the pocket's mouth, narrow enough to clear only the finger's own shaft (not its wider barb) -- the retaining "ridge" the barb springs behind once inserted. */
export const MOUNT_PLATE_SNAP_RIDGE_BAND = 1; // mm

/**
 * How far every clip/peg/tab/cutter genuinely EMBEDS past the flat face it
 * attaches to or cuts into (the plate's back/front face, or the flange's
 * outer face) -- mirrors WELD_OVERLAP's own reasoning (manifold.ts's
 * `collarBase` doc comment) but for a FLAT face rather than a curved one:
 * empirically (issue #14 PR), a feature whose own flat base sits EXACTLY
 * coincident with the target's own flat face -- rather than genuinely
 * piercing past it -- is a razor-thin, non-manifold seam that boolean CSG
 * resolves unreliably at small feature sizes (silently leaves the cut
 * un-cut, or the glued-on solid un-fused, as a separate, disconnected
 * "ghost" piece with inverted orientation -- caught by a `decompose()`
 * connected-component count in this feature's own tests, not by
 * `status()`/`genus()` alone, which both still read as if nothing were
 * wrong). Every clip/peg/tab/cutter below is built EMBED past its own
 * attaching face, never flush with it.
 */
export const MOUNT_PLATE_EMBED = 0.5; // mm

/** Minimum flange material left ABOVE an anchor cut (mirrors SCREW_MOUNT_MIN_SHELF): the load-bearing "roof" between the cut and the wound-cable side. */
export const MOUNT_PLATE_ANCHOR_MIN_SHELF = 1.5; // mm
/** design.ts bumps FLANGE_THICKNESS up to (at least) these, and warns, whenever mount is "skadis"/"opengrid" -- mirrors MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT. */
export const MIN_FLANGE_THICKNESS_FOR_GLUE_PLATE = MOUNT_PLATE_PEG_HOLE_DEPTH + MOUNT_PLATE_ANCHOR_MIN_SHELF;
export const MIN_FLANGE_THICKNESS_FOR_SNAP_PLATE = MOUNT_PLATE_SNAP_POCKET_DEPTH + MOUNT_PLATE_ANCHOR_MIN_SHELF;
