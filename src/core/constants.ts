// Fixed print/solver parameters (docs/design.md, Capacity math). Not user-facing
// spec fields in this ticket; later tickets may promote some of these.

/** Core wall thickness; links the locked outer/inner size (docs/design.md, Decisions). A thick cable's deeper groove makes the wall thicker (wall.ts's `wallThickness`). */
export const WALL_THICKNESS = 3; // mm
/** Wall left under the groove floor, mm: the wall is at least the groove depth plus this. */
export const GROOVE_FLOOR_WALL = 1.5; // mm
/** Groove depth = factor * wire diameter: at 0.4 the cable's centre sits 0.1 d proud of the ridges between turns (docs/design.md, Geometry: Groove). */
export const GROOVE_DEPTH_FACTOR = 0.4;
/** The groove circle's radius is the cable's radius plus this, mm. */
export const GROOVE_SLACK = 0.15; // mm
/** The groove's lower flank leaves the ridge at most this steep, in degrees from the axis (a straight chamfer into the groove circle): a deep groove's circle would meet the ridge almost flat, in a near knife-edge corner. */
export const GROOVE_LIP_ANGLE = 70;
/** Flat land on top of each ridge between turns, along the axis, mm: the pitch is the groove's width at the surface plus this, so ridges never come to a knife edge. */
export const RIDGE_LAND = 0.3; // mm
/** Height of the groove's lower edge above the flange face at layer 1's start, mm: small, so the first turn sits on the face (its bottom about 0.3 mm above it). */
export const MARGIN_BOTTOM = 0.2; // mm
/** The top of the wound cable stays this fraction of the cable's radius below the core's top face (so the drawn cable never grazes it). */
export const MARGIN_TOP_FACTOR = 0.3;
/** The groove fades out over this many turns at its top end. */
export const TAPER_TURNS = 0.15;
/** The groove runs on this many turns before layer 1's start, level with it, fading out, so it has its full depth where the first turn starts. */
export const RUN_IN_TURNS = 0.1;
/** Flange outer radius = solved envelope radius + this margin. */
export const FLANGE_MARGIN = 4; // mm
export const FLANGE_THICKNESS = 3; // mm
/** Issue #229: the 45 degree chamfer on the outer perimeter edges of the flange and the cap, on both faces (edgeChamfer.ts). Leaves a 1 mm vertical land on the thinnest, 3 mm plate. */
export const EDGE_CHAMFER = 1; // mm
export const MIN_BORE_RADIUS = 1; // mm, guards against a wall thicker than the core
/** Bore corner radius floor for non-round shapes : offsetting a corner inward by the wall thickness can drive it to <=0, which folds the outline. */
export const MIN_BORE_CORNER_RADIUS = 0.5; // mm
/** Non-round shapes (#6): a hairline hand-back from a fully-degenerate (zero-length straight side) corner radius, so the corner-fillet solid builder (STEP) never sees an exactly-round rounded polygon. Imperceptible at print resolution. */
export const SHAPE_ROUNDING_EPS = 0.01; // mm
/** Default corner radius offered for a new sq/tri shape before any bend-limit clamping (docs/design.md, Shapes). */
export const DEFAULT_CORNER_RADIUS = 8; // mm

// Two mesh resolutions (issue #7, docs/design.md, Geometry): a coarse
// "draft" while the user is still editing, tuned to roughly a 16k-triangle
// preview (25-33 ms in Node), and a "final" for the settled view, STL, 3MF
// and STEP, tuned to roughly 170k triangles (~240 ms). Both use
// the same `buildWall`/`fuseFlange` code path -- only these counts differ --
// so draft and final can never geometrically drift apart.
export const FINAL_COLUMNS = 96; // mesh columns around the circumference
export const FINAL_ROWS_PER_PITCH = 16; // mesh rows per helical pitch (plus one on each corner of the groove profile, wall.ts)
export const DRAFT_COLUMNS = 24;
export const DRAFT_ROWS_PER_PITCH = 3;

// Corner-arc tessellation floor (issue #85, "rounded corners look
// faceted/broken"): a plain arc-length-uniform column split (the ONLY
// scheme before this) gives a rounded square/triangle's corner arcs far
// fewer columns than their straight sides -- the corner is a much smaller
// share of the perimeter -- which reads as visibly kinked/faceted up close,
// especially at DRAFT_COLUMNS. `shapes.ts`'s `outlineColumnParams` floors
// each corner's own segment count to at least this many per 90 degrees of
// sweep (scaled up for a triangle's 120-degree corners). FINAL matches the
// ticket's own acceptance criterion ("e.g. >= 16 per 90 degree corner");
// DRAFT is half that -- still far smoother than the ~2-3 segments a plain
// proportional split gave it at DRAFT_COLUMNS, but cheaper, mirroring how
// DRAFT_ROWS_PER_PITCH is already a fraction of FINAL_ROWS_PER_PITCH rather
// than matching it outright. Round is unaffected either way (no corner arc
// of its own -- see `outlineColumnParams`).
export const FINAL_MIN_CORNER_SEGMENTS_PER_90 = 16;
export const DRAFT_MIN_CORNER_SEGMENTS_PER_90 = 8;

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

/** Cords longer than this are not supported (docs/design.md, Decisions). */
export const MAX_WIRE_LENGTH = 15000; // mm

// Solver search bounds.
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

// Top cap + joints (issue #9, docs/design.md, Parts and printing and
// Tolerances). The cap is a symmetric "top flange": same outer
// footprint as the bottom flange (FLANGE_MARGIN/FLANGE_THICKNESS), sitting
// above the wall's z=height the same way the flange sits below z=0. All
// three joints share one circular engagement collar centered on the coil
// axis, regardless of the core's own cross-section (round/sq/tri) -- a
// circular collar is simple, always manifold, and needs only one global
// tolerance. For a non-round bore the collar contacts the
// bore's flat sides, not its corners: a normal, printable fit, not a defect.
export const CAP_THICKNESS = 3; // mm, mirrors FLANGE_THICKNESS
/** One global print tolerance the user can dial in, scaling every joint's fit. */
export const DEFAULT_TOLERANCE = 0.2; // mm
export const TOLERANCE_MIN = 0.05; // mm
export const TOLERANCE_MAX = 0.8; // mm
/** How far the cap's engagement collar reaches down into the core's bore. */
export const JOINT_ENGAGE_DEPTH = 7; // mm
/** Issue #127: the cap's collar is a tube this thick, with the hole through its middle running straight through the cap -- no floor, ledge or roof over it that would print as a bridge. */
export const CAP_COLLAR_WALL = 2; // mm
/** Height of the snap fingers' root flare, which widens the collar where it meets the plate (joints.ts's `snapLayout`). The press and bayonet collars are straight (issue #172). */
export const JOINT_TRANSITION_HEIGHT = 2; // mm
/** A real volumetric overlap (not just a coincident, razor-thin seam) between two independently-tessellated curved surfaces meeting at "the same" nominal radius, so their boolean union is robust rather than producing stray degenerate slivers. */
export const WELD_OVERLAP = 1; // mm
/** Fixed clearance between the collar's nominal OD and the bore's own inscribed (flat-side) radius, before `tolerance` -- keeps the collar clear of a non-round bore's corners too. */
export const JOINT_FIT_GAP = 0.3; // mm
/** Bore inscribed radius below which bayonet/snap core-side cuts are skipped (falls back to a plain press collar): too small to cut real features into a 3 mm wall without breaking through. Bayonet: see joints.ts's `bayonetLayout`. */
export const JOINT_MIN_BORE_RADIUS = 4; // mm

// Bayonet (twist lock, issue #167, round cores only): BAYONET_LUG_COUNT
// lugs stand in the core's bore just under the rim; the cap's collar has an
// L-slot for each, so the cap drops on turned counter-clockwise, then turns
// clockwise (seen from above) by 180/BAYONET_LUG_COUNT degrees to a hard
// stop. See joints.ts's `bayonetLayout` for the profiles.
export const BAYONET_LUG_COUNT = 3;
export const BAYONET_GAP = 0.4; // mm, fixed sliding clearance for the twist motion (plus the user's tolerance)
export const BAYONET_LUG_HEIGHT = 1; // mm, how far each lug reaches into the collar (the hold)
export const BAYONET_LUG_WIDTH = 5; // mm, tangential width of each lug at the collar, before the angle cap below
/** Widest a lug may get, degrees -- keeps the lugs, the slots and the walls between them fitting round a small collar. */
export const BAYONET_LUG_MAX_DEG = 30;
export const BAYONET_LUG_TIP = 0.8; // mm, axial height of the lug's vertical tip face; under it the lug runs back to the bore wall at 45 degrees
/** How far under the rim each lug's flat top sits, mm: the collar keeps this much (less the gap) solid ring above its grooves. */
export const BAYONET_LUG_DROP = 1.5; // mm
/** Least collar wall left behind the L-slots, mm (the collar's centre hole shrinks to keep it). */
export const BAYONET_MIN_WALL = 1.2; // mm
/** Least collar wall between one groove's end stop and the next entry slot, mm. Narrower: fall back to press fit. */
export const BAYONET_MIN_LAND = 1.5; // mm

// Snap clips (issues #168, #186, joints.ts's `snapLayout`): the cap's collar
// is split into fingers, one per side of the bore's outline (slots at its
// corners), each with a barb that clicks under a ridge standing in the
// core's bore. The barbs stay inside the bore, so nothing is cut into the
// core's wall.
/**
 * How far the snap fingers reach down into the bore, mm. Longer than
 * JOINT_ENGAGE_DEPTH: a finger's bending strain at full deflection goes with
 * 1/length^2, so 12 mm keeps it near 1.8% for 0.8 mm of engagement, under
 * PLA's yield (about 2-3%, less across layer lines).
 */
export const SNAP_FINGER_LENGTH = 12; // mm
export const SNAP_BARB = 1.1; // mm, how far each finger's barb protrudes past the finger's nominal OD
/** Least gap between a barb's tip and the bore wall, mm, on top of the user's tolerance. */
export const SNAP_BARB_CLEARANCE = 0.1; // mm
/** How far the core's retaining ridge stands into the bore, mm. The barb then overlaps it by SNAP_RIDGE_DEPTH - SNAP_BARB_CLEARANCE - tolerance (1.0 - tolerance), and the finger clears it by SNAP_BARB + SNAP_BARB_CLEARANCE - SNAP_RIDGE_DEPTH + tolerance (0.1 + tolerance, the same gap as the barb's tip from the bore). */
export const SNAP_RIDGE_DEPTH = 1.1; // mm
export const SNAP_RIDGE_THICKNESS = 1.4; // mm, axial height of the core-side retaining ridge
/** The barb's lead-in face (toward the finger's tip) leans this far from the axis, degrees: shallower than the 45-degree back face, so the cap goes on with about half the force it takes to pull it off. It faces up in the cap's print orientation, so it needs no support. */
export const SNAP_LEAD_IN_ANGLE = 30; // degrees
/** The seated barb's back face sits this far (axially, so also radially on the 45-degree faces) into the ridge's underside, mm: the fingers stay that much bent, pulling the cap down onto the rim and centring it, so it has no play. At most half the engagement. */
export const SNAP_PRELOAD = 0.2; // mm
/**
 * The seat under the finger tips (it narrows the bore to the cap's hole, a
 * flat top over a 45-degree chamfer): its top is this far below the tips, mm.
 * The cap still seats on the rim, and a wider gap shows as a slit that the
 * line art draws as a dashed line. Tips that print a layer long just rest on
 * the seat.
 */
export const SNAP_SEAT_GAP = 0.3; // mm
/** Issue #186: the snap fingers' wall, mm: three 0.4 mm extrusion widths. Thinner than CAP_COLLAR_WALL, so the cap's inner step is smaller and the fingers bend more easily. */
export const SNAP_COLLAR_WALL = 1.2; // mm
export const SNAP_SLOT_WIDTH = 2; // mm, tangential width of the relief slot between fingers

// Cable fix points (issues #117, #241, src/core/innerEnd.ts): the inner end is
// held by a snap-in clip in the base that lies ALONG the cable -- a round bore
// of diameter d + tolerance whose opening is narrower than the cable, so the
// cable presses in and then leaves the part along its own tangent. The outer
// end is pressed into a rim slot in the cap (or the base).
/**
 * The base flange clip's interference: how much narrower than the cable
 * (as a fraction of its diameter) the opening is. The lips are stubs on a
 * thick wall, so in PLA they do not flex and the cable itself has to give:
 * 8% of a 3 mm cable is 0.24 mm, which a cable jacket takes under finger
 * pressure, where the old 0.75 * (d + tolerance) opening (0.6 mm at 3 mm,
 * 20%) did not press in at all.
 */
export const CABLE_BASE_CLIP_INTERFERENCE = 0.08;
/** The narrowest the base clip's opening may get, as a fraction of its bore diameter: the lip underside's overhang is acos of this (41 degrees), inside the 45 degree no-support limit. Only a large tolerance reaches it. */
export const CABLE_BASE_CLIP_OPENING_MIN = 0.75;
/** The base clip's lips keep this much vertical wall above the edge where the opening meets the bore (so the lip tip is not a knife edge); above it the mouth flares out at 45 degrees to the face, a lead-in funnel, mm. */
export const CABLE_BASE_CLIP_LAND = 0.3;
/** Length of the gripping lips along the cable, as a multiple of the wire diameter (at least CABLE_CLIP_MIN_LENGTH). Short, so the cable is easy to press in and the lips sit only near the rim. */
export const CABLE_CLIP_LENGTH_FACTOR = 1.5;
export const CABLE_CLIP_MIN_LENGTH = 5; // mm
/** The flange clip's lips may start where the cable is still this far above its final channel depth (the very end of its drop), mm -- lets the clip sit a few mm further from the rim than "strictly after the drop", saving flange margin. */
export const CABLE_CLIP_DEPTH_SLACK = 0.25; // mm
/** The lips start and end square (the cable presses in from above, so it needs no lead-in chamfer, and a square lip end reads cleanly in the line art); this hairline ramp only keeps two cross-sections from sharing one station. */
export const CABLE_CLIP_ENTRY = 0.05; // mm
/** Part material kept on each side of the clip's bore (the lips' own root), mm: the flange clip ends this far (plus the bore radius) short of the rim. */
export const CABLE_CLIP_WALL = 1; // mm
/** Cap end: with the last layer ending at the top, the outer end runs up to the cap at least this far clear of the wall, mm (its centre a radius plus this out). */
export const CAP_LEAD_OUT_WALL_GAP = 0.3; // mm
/** Cap end: the cable runs this far below the cap plate's underside (its top would otherwise sit exactly on that face, which the line art draws as a dashed seam). */
export const CAP_CABLE_DROP = 0.1; // mm
// Rim cable slots (issue #241, innerEnd.ts's `layoutRimSlot`): a keyhole cut straight through the base flange and the
// top cap at the rim. The neck is narrower than the cable by CABLE_BASE_CLIP_INTERFERENCE, like the base clip.
/** Length of the rim slot's neck, from where it leaves the seat to the foot of the rim chamfer, mm (then a 45 degree lead-in to the rim). */
export const RIM_SLOT_NECK = 1; // mm
/** The base rim slot keeps this much plain plate between its seat and the collar pad under the wall, mm. */
export const RIM_SLOT_COLLAR_GAP = 0.4; // mm
/** The base rim slot keeps this much flange between itself and the inner-end channel, the mount's cuts and the pads, mm. */
export const RIM_SLOT_KEEP_OUT = 1; // mm
/** The cap rim slot keeps this much plate between itself and the engraved label, mm. */
export const RIM_SLOT_LABEL_KEEP_OUT = 1; // mm
/** Facets round a whole circle of the rim slot's seat. */
export const RIM_SLOT_SEAT_SEGMENTS = 32;
/** A clipped cable end's free tail past the rim, as a multiple of the wire diameter (at least CABLE_CLIPPED_TAIL_MIN). */
export const CABLE_CLIPPED_TAIL_FACTOR = 3;
export const CABLE_CLIPPED_TAIL_MIN = 10; // mm
/** Samples on each arc of a channel/clip cross-section. */
export const CABLE_SWEEP_ARC_SEGMENTS = 16;
/** Spacing of the channel/clip cross-sections along the cable, mm. */
export const CABLE_SWEEP_STEP = 2.5; // mm

// Inner-end fixing (issues #8, #115, #117, docs/design.md, Cable ends): a recessed channel on the bottom flange's inner (winding-side,
// z=0) face, swept along the cable from the wall's own groove start (a
// tangential chord since issue #115), with the cable clip near the rim.
/** Channel depth (to the cable's bottom) = this factor * wire diameter -- deep enough that the wound cable's first turn lies flush with the surrounding flange face (unlike the wall's own groove, which only needs GROOVE_DEPTH_FACTOR: later turns there nest into the groove's OWN profile, but here later turns pass straight over a flat annulus, so no bump can be tolerated). */
export const INNER_CHANNEL_DEPTH_FACTOR = 1.0;
/** Flange material required BELOW the channel's own recess (cut from the inner/z=0 face) -- mirrors SCREW_MOUNT_MIN_SHELF's role for the keyhole pocket (issue #122: the two sit on separate pads, so they only stack if their footprints ever overlap, see design.ts). */
export const INNER_CHANNEL_MIN_SHELF = 1.5; // mm
/** Flange material left between the channel's side and the wall's own outer surface, mm -- so the cable lies in a full-width trench instead of one the wall half-covers. */
export const INNER_CHANNEL_WALL_SKIN = 0.4; // mm
/** The channel cutter is clipped this far outside the wall's own outline (never cutting the wall), mm: less than INNER_CHANNEL_WALL_SKIN, so the clip never flattens the round channel's wall-side flank, but never exactly on the wall's surface either. */
export const INNER_CHANNEL_WALL_GUARD = 0.2; // mm

// Issue #122: the bottom flange is a thin plate (the wall-facing face flat),
// thick only on pads under the wall, the inner-end channel and each mount
// cut -- see flangePads.ts.
/** The plate's own thickness away from every pad: the flange's structural minimum. */
export const FLANGE_PLATE_THICKNESS = FLANGE_THICKNESS;
/** Material a pad keeps beyond the cut it carries, at the face, mm (more than SCREW_MOUNT_EDGE_MARGIN / THROUGH_MOUNT_EDGE_MARGIN / CABLE_CLIP_WALL, so a pad at a tight margin always runs out over the rim instead of grazing it). */
export const FLANGE_PAD_WALL = 2.5; // mm
/** The collar under the wall reaches this far past the wall's outline at the face, mm. */
export const FLANGE_PAD_COLLAR = 1; // mm
/** Samples round the collar's outline (a keep-out for the relief cut, not a visible surface finish -- it lies FLANGE_PAD_COLLAR outside the wall -- so this stays well below the mesh's own column count, keeping the STEP boolean cheap). */
export const FLANGE_PAD_COLLAR_COLUMNS = 96;
/** Spacing of the channel pad's cross-sections along the cable, mm. */
export const FLANGE_PAD_STEP = 5; // mm
/** Issue #133: the channel pad blends into the collar (both sides, flangePads.ts) with a concave curve in plan, of this radius at the chamfer's foot (on the plate), mm -- and as much more at the face as the chamfer is wide, so it stays a smooth curve all the way down. */
export const FLANGE_PAD_BLEND_RADIUS = 5; // mm
/** Spacing of the channel pad's cross-sections through those blends, mm. */
export const FLANGE_PAD_BLEND_STEP = 2; // mm
/** Where a blend meets the collar, the pad's edge runs this far inside the collar's, mm: never on it (no coincident faces), and close enough that the two meet at a hair of an angle, not a crease. */
export const FLANGE_PAD_BLEND_BURY = 0.15; // mm
/** Pads reach this far into the plate below its top face, mm (so no pad face lies on the plate's own). Issue #229: the plate top's rim chamfer is EDGE_CHAMFER deep, and a pad at the rim must reach below it, or its underside would hang over the chamfer's cut. Strictly below it: with the underside exactly on the line where the chamfer meets the rim face, a pad running out over the rim left a zero-length edge there (fuzz case 1097). */
export const FLANGE_PAD_EMBED = EDGE_CHAMFER + 0.25; // mm
/** Pads reach this far above the inner face, mm (so the relief cut never has a face on it). */
export const FLANGE_PAD_RISE = 0.5; // mm

// Issue #115: the whole drawn cable -- inner-end lead-in, layers, layer
// transitions, outer end -- stays within the cable's minimum bend radius
// (MBR = bend multiplier * diameter). The lead-in is laid out analytically
// against a slightly tighter budget; the transitions and the cap lead-out
// are searched (lengthened until they pass) against the check factor, a
// hair above 1 because a wound layer on a core sized exactly at the bend
// limit already bends at 1/MBR, and any blend leaving it adds a little.
/** Curvature budget for the inner-end lead-in, as a fraction of 1/MBR. */
export const CABLE_BEND_BUDGET = 0.97;
/** Largest curvature (times MBR) a layer transition or cap lead-out may reach, measured on its own samples. */
export const CABLE_BEND_CHECK = 1.03;
/** Sample spacing along the lead-in, transitions and outer end, mm. */
export const CABLE_BRIDGE_STEP = 0.5; // mm
/** Cap off: the free straight tail the cable leaves the last turn along, as a multiple of the wire diameter (at least CABLE_TAIL_MIN). */
export const CABLE_TAIL_FACTOR = 6;
export const CABLE_TAIL_MIN = 20; // mm

// Print bed (issue #10, docs/design.md, Parts and printing). A generic
// 256x256x256 mm build volume (e.g. Bambu X1C/P1S, Prusa MK4) is a sensible
// default for "warn me if a part doesn't fit" -- most FDM printers this
// project targets are at or below this size.
export const DEFAULT_BED_SIZE = 256; // mm, each axis
export const BED_SIZE_MIN = 50; // mm
export const BED_SIZE_MAX = 1000; // mm
/** Gap left between adjacent parts' footprints when laying out the 3MF build plate (export/threeMf.ts, core/plate.ts). */
export const PLATE_GAP = 5; // mm

// Top cap label (issue #12, docs/design.md, Decisions: label text on the
// top cap face, only when it fits). Engraved, not raised -- see
// label.ts's file header for why the print orientation forces that choice.
/** Minimum legible ink height for the label text (ticket: "e.g. >= 5mm"); below this the label is hidden and a warning is emitted instead. Text whose ink is short for its font size (lowercase without ascenders, a lone "-") can't reach it under `LABEL_MAX_FONT_SIZE`; it is fitted at that font size instead (label.ts's `fitLabel`). */
export const LABEL_MIN_HEIGHT = 5; // mm
/** Widest letter stroke the engraving may have (issue #176). The cap prints room face down, so each letter's floor prints as a bridge as wide as its stroke; 1.8 mm keeps a margin under the 2 mm bridge rule. */
export const LABEL_MAX_STROKE = 1.8; // mm
/** Vertical stem width of the bundled Archivo Black, per unit of font size: the ink width of its "I" glyph, 221 of 1000 units per em (opentype.js `font.getPath("I", 0, 0, 1).getBoundingBox()`, x2 - x1). */
export const LABEL_STEM_PER_EM = 0.221;
/** Largest label font size (mm): the one whose stems are `LABEL_MAX_STROKE` wide, about 5.6 mm tall capitals. The fit search (label.ts's `fitLabel`) still shrinks below this when the annulus is tight. */
export const LABEL_MAX_FONT_SIZE = LABEL_MAX_STROKE / LABEL_STEM_PER_EM; // mm
/** Clearance kept between the label's text band and both the bore hole and the plate's outer rim. */
export const LABEL_MARGIN = 2; // mm
/** Engraved recess depth, comfortably less than CAP_THICKNESS so the pocket never breaks through to the collar side. */
export const LABEL_DEPTH = 0.6; // mm
/** Straight-line segments per glyph Bezier curve when flattening opentype paths (label.ts's `pathToLoops`) -- plenty of fidelity at FDM/engraving scale. */
export const LABEL_CURVE_SEGMENTS = 6;
/** Longest label text accepted from the UI/hash -- generous for a one-line cap label, small enough to keep the hash short. */
export const LABEL_MAX_LENGTH = 40;

// Screw-keyhole wall mount (issue #13, docs/mounts.md, Screw mounts): a
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
/** Minimum flange material left around the cut, to the wall's own outer (winding) surface and to the flange's own outer edge -- issue #71 PR review: bumped from 1mm to a hard 2mm floor, verified by vitest (test/mount.test.ts's clearance checks) against the ACTUAL resolved geometry, not just this constant's own value. */
export const SCREW_MOUNT_EDGE_MARGIN = 2; // mm
/** Depth of the pocket, cut inward from the flange's outer (wall-facing) face -- the TOTAL of the two depth levels below (issue #71 re-shapes this SAME budget into "a shallow slot in front of a deeper undercut", it does not cut any deeper into the flange than the original single-level pocket did). */
export const SCREW_MOUNT_RECESS_DEPTH = 3; // mm
/**
 * Issue #71 ("verify the keyhole actually catches the screw"): the ORIGINAL
 * single-depth pocket cut the head-entry circle, the channel and the
 * shank-rest circle all to the SAME depth and width -- cosmetically a
 * keyhole shape, but the channel was only shank-width, so the screw's HEAD
 * (which must travel from the head-entry hole to the shank's resting point)
 * could never actually get there: an 8mm head cannot pass through a 4mm-wide
 * channel at any single depth. A real keyhole hanger instead undercuts BEHIND
 * a narrow surface opening: a shallow, narrow "slot" (this level) that the
 * SHANK rides in, right at the wall-facing surface, in front of a deeper,
 * wider "undercut" chamber (below) that the HEAD actually travels through,
 * hidden behind that narrow opening. The slot sits nearer the flange's outer
 * (wall-facing, bed-touching-when-printed) face -- printed bottom-up, the
 * void only ever WIDENS as printing continues past the slot into the
 * undercut, never narrows, so this needs no support/teardrop treatment
 * beyond the existing "plain bridging pocket" the outer shelf already relies
 * on (see SCREW_MOUNT_MIN_SHELF) -- a widening void just means less material
 * to print, not an unsupported overhang.
 *
 * Narrower than the head, wider than the shank (AC: "slot width between the
 * shank and head diameters") -- exactly midway between the two, still
 * comfortably clear of either.
 */
export const SCREW_MOUNT_SLOT_DIAMETER = (SCREW_MOUNT_SHANK_DIAMETER + SCREW_MOUNT_HEAD_DIAMETER) / 2; // 6 mm
export const SCREW_MOUNT_SLOT_RADIUS = SCREW_MOUNT_SLOT_DIAMETER / 2;
/** Depth (from the flange's own outer face) of the shallow, narrow slot level above -- see its own doc comment. */
export const SCREW_MOUNT_SLOT_DEPTH = 1; // mm
/**
 * Typical pan/truss wood-screw head height (issue #71 AC: the undercut
 * pocket's own depth must be "≥ head height", so the head is genuinely
 * captured there, not just wedged at the mouth of a too-shallow chamber).
 */
export const SCREW_MOUNT_HEAD_HEIGHT = 2; // mm
/**
 * Depth of the wider undercut chamber directly BEHIND the slot (from
 * `SCREW_MOUNT_SLOT_DEPTH` to `SCREW_MOUNT_RECESS_DEPTH`) -- at least
 * `SCREW_MOUNT_HEAD_HEIGHT`, wide enough (`SCREW_MOUNT_HEAD_RADIUS`, see
 * `screwMountCutter`) that the screw head can actually slide all the way
 * from the head-entry hole to the shank's resting point, fully captured
 * there once seated (issue #71 AC: "an undercut pocket wider than the slot,
 * behind it").
 */
export const SCREW_MOUNT_UNDERCUT_DEPTH = SCREW_MOUNT_RECESS_DEPTH - SCREW_MOUNT_SLOT_DEPTH; // 2 mm
/**
 * A hairline volumetric overlap between the two depth levels above, so
 * manifold.ts's own manifold-3d union of them is a genuine 3D overlap
 * rather than an exact, coincident abutment -- found empirically (a fine
 * flange-thickness sweep, test/geometry.test.ts's issue #41 coverage, hit an
 * occasional stray-sliver genus failure at one specific thickness where the
 * two levels would otherwise meet EXACTLY on one shared plane): the SAME
 * class of floating-point robustness issue WELD_OVERLAP/MOUNT_PLATE_EMBED
 * already work around elsewhere in this file/codebase. Only manifold-3d
 * needs this -- step/build.ts's replicad/OCCT equivalent uses an exact
 * abutment (unchanged), since OCCT's exact-geometry kernel doesn't share
 * this fragility (confirmed: the STEP backend's own thickness-sweep
 * coverage, test/step.test.ts, never needed an equivalent workaround).
 */
export const SCREW_MOUNT_LEVEL_OVERLAP = 0.05; // mm
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
 *
 * Both ends use `SCREW_MOUNT_HEAD_RADIUS` (issue #71): the shank-rest end's
 * own SURFACE slot is narrower (`SCREW_MOUNT_SLOT_RADIUS`), but its
 * undercut chamber -- directly behind that same XY position, see
 * `SCREW_MOUNT_UNDERCUT_DEPTH` -- is head-width, so the widest the cut
 * actually reaches at EITHER end, across its full depth, is the head radius.
 */
export const SCREW_MOUNT_ANNULUS_WIDTH = SCREW_MOUNT_SLOT_TRAVEL + 2 * SCREW_MOUNT_HEAD_RADIUS + 2 * SCREW_MOUNT_EDGE_MARGIN;
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
/**
 * Issue #71: "allow rotating the keyhole slot direction ... so users can
 * hang it differently, the mount axis and the hanging stay level". 0 is the
 * original, unrotated (cost-minimizing) behaviour; 45 asks `bestAxisDeg` to
 * instead prefer whichever REACHABLE axis (still within
 * `SCREW_MOUNT_AXIS_SEARCH_MAX_DEG` of TRUE vertical -- this bound is never
 * shifted by the rotation request, only used as a tie-break/target inside
 * it) sits closest to 45 degrees off vertical, landing the slot(s) on a
 * DIFFERENT one of the shape's own natural mirror axes.
 *
 * 90 is deliberately NOT offered (issue #71 PR review): at 90 degrees off
 * vertical the channel -- built parallel to WALL_UP, see mount.ts's file
 * header -- would run perfectly HORIZONTAL once actually hung level (that
 * axis vertical), so gravity has zero component along its own length
 * (cos(90 deg) = 0): nothing would stop the screw sliding either way in the
 * slot, i.e. the coil would NOT reliably stay hung. `SCREW_MOUNT_AXIS_
 * SEARCH_MAX_DEG` (60 degrees, cos(60 deg) = 0.5) is already this project's
 * own accepted outer bound for how far off vertical the mount ever tilts
 * (including the pre-#71 automatic triangle case), so a requested rotation
 * can never be honoured past it either -- 90 would just silently clamp to
 * 60, which is more confusing to expose as its own labelled option than to
 * leave out.
 */
export const KEYHOLE_ROTATION_OPTIONS = [0, 45] as const;

// Through-hole wall mount (issue #70, docs/mounts.md, Screw mounts): plain,
// constant-radius screw-shank holes cut straight through the bottom
// flange's full thickness -- a permanent, non-sliding alternative to the
// screw-keyhole mount (see src/core/mount.ts's `layoutThroughHoleMount`).
// Unlike the keyhole mount's fixed screw size, the hole diameter is a real
// user parameter (AC: "sized for common wood screws (a parameter)").
// Issue #129: no counterbore and no pad any more -- the screw head bears
// directly on the flange's own winding-side face, and the flange around
// each hole is just the ordinary plate thickness (flange.ts, flangePads.ts).
export const THROUGH_HOLE_DIAMETER_MIN = 2.5; // mm
export const THROUGH_HOLE_DIAMETER_MAX = 8; // mm
export const DEFAULT_THROUGH_HOLE_DIAMETER = 4.5; // mm: shank clearance for a common wood screw (e.g. a #8)
/** Minimum flange material left around each hole, to the wall's own outer (winding) surface and to the flange's own outer edge (mirrors SCREW_MOUNT_EDGE_MARGIN) -- a hard 2mm floor, verified by vitest against the ACTUAL resolved geometry. */
export const THROUGH_MOUNT_EDGE_MARGIN = 2; // mm
/** Issue #229: the screw head's bearing ring keeps to the flat top of the plate, so the hole sits this far in from the flange's outer edge: the edge margin, past the rim's chamfer. */
export const THROUGH_MOUNT_RIM_MARGIN = THROUGH_MOUNT_EDGE_MARGIN + EDGE_CHAMFER; // mm
/** Minimum clearance kept between a through-hole and the wound cable's outer envelope, so the hole is genuinely reachable with a screwdriver from outside the winding (issue #70 AC). */
export const THROUGH_MOUNT_ENVELOPE_MARGIN = 2; // mm
/** Issue #139: the screw head (the hole plus its THROUGH_MOUNT_EDGE_MARGIN bearing ring) keeps at least this much plain plate between it and any flange pad's footprint, mm. */
export const THROUGH_MOUNT_PAD_CLEARANCE = 0.5; // mm
/** Evenly-spaced hole counts tried on a round flange, widest first (issue #70 AC: "evenly spaced (3 or 4) on round"). */
export const THROUGH_MOUNT_ROUND_HOLE_COUNTS = [4, 3] as const;

// Clip mount plate (issue #14, docs/mounts.md, openGrid): a SEPARATE part that glues (on two printed pegs) onto the bottom
// flange's outer (wall-facing) face -- see mountPlate.ts. Its own footprint
// is a uniform inward offset of the flange's outline (offsetOutline, always
// strictly inside it -- AC "the plate must fit inside the flange outline").
export const MOUNT_PLATE_THICKNESS = 3; // mm, the flat panel itself
/** How far inside the flange's own outer edge the plate's footprint sits. */
export const MOUNT_PLATE_EDGE_MARGIN = 3; // mm

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

// SKÅDIS board facts (issue #106, docs/mounts.md, SKÅDIS, with sources).
// IKEA publishes no spec; these are community measurements, cross-checked
// across several independent generators/libraries:
// - Slot: one VERTICAL stadium slot per position, nominally 5 x 15 mm
//   (Pegboardly "SKÅDIS Sizes & Dimensions"); measured as tight as
//   4.8 x 14.8 mm (jbazant/esp8266-binary-clock skadis.scad).
// - Lattice: two 40 x 40 mm grids offset by (20, 20) mm -- i.e. columns
//   every 20 mm, each column's slots every 40 mm, neighbouring columns
//   shifted 20 mm vertically (same .scad: X spacing 20, Y spacing 40).
//   Slot centres are
//   (20a, 20b) mm with a + b even. Two positions 40 mm apart in the same row
//   or column are on the SAME grid (not staggered against each other).
// - Board thickness: about 5 mm; 5.1 mm in florianfesti/boxes'
//   SkadisSettings and the .scad above, some boards 4.0-4.8 mm, black
//   boards up to 5.2 mm (Printables/MakerWorld hook listings).
// - Slot edges: rounded over by about 1 mm on both faces (the Skadis T-Nuts
//   listing, Printables 228663).
export const SKADIS_SLOT_WIDTH = 5; // mm, nominal
export const SKADIS_SLOT_LENGTH = 15; // mm, nominal, end to end (full-radius ends)
/** The tightest measured slot (see above): the clip's clearance is designed against this, so it also fits a nominal 5 x 15 slot. */
export const SKADIS_SLOT_WIDTH_MIN = 4.8; // mm
export const SKADIS_SLOT_LENGTH_MIN = 14.8; // mm
/** Lattice step between neighbouring columns (and the vertical shift between them). */
export const SKADIS_LATTICE_STEP = 20; // mm
export const SKADIS_BOARD_THICKNESS = 5; // mm, nominal
/** The thickest board the clips' tongues still hook behind (painted boards). */
export const SKADIS_BOARD_THICKNESS_MAX = 5.2; // mm

/**
 * SKÅDIS rim clips (issue #207, docs/mounts.md): separate clips, each one flat
 * profile in the (up, z) plane extruded SKADIS_CLIP_WIDTH along the side
 * axis, printed lying on that face so every load runs along the layers. A
 * clip hooks one board slot (a stem through it and a tongue behind the
 * board) and wraps the flange rim in a notch (a U: the outer jaw between the
 * flange and the board, the bight round the rim, the lip on the winding
 * side), gripping the flange's plain plate (issue #222: no pad under it). The top clip(s) carry the anti-lift latch. skadisClips.ts lays them
 * out; test/skadisFit.test.ts checks them against a board built from the
 * facts above.
 */
/** Across the slot: the tightest 4.8 mm slot less 0.2 mm a side. */
export const SKADIS_CLIP_WIDTH = 4.4; // mm
/** The gap between the flange's outer face and the board's front face, which the outer jaws fill. */
export const SKADIS_STANDOFF = 3; // mm
/** The stem through the slot, along up. Stem + tongue (11 mm) pass the tightest slot's 11.9 mm of full width. */
export const SKADIS_STEM_HEIGHT = 5; // mm
/** How far the tongue reaches below the stem, behind the board: about 4.6 mm past the slot's end once seated. */
export const SKADIS_TONGUE_LENGTH = 6; // mm
export const SKADIS_TONGUE_THICKNESS = 3; // mm
/** The tongue's retaining face sits this far behind the thickest board. */
export const SKADIS_TONGUE_GAP = 0.3; // mm
/** How far the jaws reach in from the notch floor, onto both faces of the flange. */
export const SKADIS_JAW_OVERLAP = 5; // mm
export const SKADIS_LIP_THICKNESS = 2.5; // mm
/** The bight round the rim, along up. */
export const SKADIS_BIGHT_THICKNESS = 3; // mm
/** Issue #222: the clip's outer corners are cut 45 degrees at this leg, so they aren't sharp to handle (the hook faces, latch, jaw faces and slot-fit sizes are left as they are). */
export const SKADIS_CLIP_CHAMFER = 0.5; // mm
/** The notch in the rim at each clip: at least this deep, with a flat floor the bight seats on. */
export const SKADIS_NOTCH_DEPTH = 1; // mm
/** Issue #219: the rim crosses each notch's side walls at least this steeply (degrees), so no sliver of rim is left beside a notch. */
export const SKADIS_NOTCH_MIN_CROSSING_DEG = 15;
/** The lip keeps this far from the wound cable's outer surface. */
export const SKADIS_ENVELOPE_CLEARANCE = 1; // mm
/** The latch (top clips): an arm on the board face, a slit, and a rigid mast behind it. The arm flexes in the clip's own plane, so along the layers. */
export const SKADIS_LATCH_ARM_THICKNESS = 1.6; // mm
export const SKADIS_LATCH_SLIT = 2.9; // mm, the room the arm flexes into
export const SKADIS_LATCH_MAST_THICKNESS = 3; // mm
/** From the tooth's centre to the arm's root: long enough to keep the bending strain under 1.5 % (3·t·δ / 2a²). */
export const SKADIS_LATCH_ARM_REACH = 21; // mm
export const SKADIS_LATCH_ROOT = 3; // mm
/** The gap between the stem's top and the arm's free end. */
export const SKADIS_LATCH_END_GAP = 0.8; // mm
/** How far the tooth reaches into the slot: well past the slot's 1 mm edge round-over. */
export const SKADIS_LATCH_TOOTH_DEPTH = 2.5; // mm
export const SKADIS_LATCH_TOOTH_LENGTH = 4; // mm
/** Seated, the tooth's top sits this far below the top of the slot's full-width part (tightest slot): the most the coil can lift. */
export const SKADIS_LATCH_LIFT = 1; // mm
/** The tooth's upper face leans this far from the board normal, so a firm lift cams the arm out (about 10 to 20 N, an estimate that depends on friction): a detent you can still undo. */
export const SKADIS_LATCH_FACE_DEG = 25; // degrees
/** A second top clip above this estimated cable weight: about a third of the 1.5 to 2 kg per hook that printed SKÅDIS hooks are reported to hold. */
export const SKADIS_HEAVY_CABLE_KG = 0.5; // kg
/** For the cable weight estimate: copper and PVC average about 1.8 g/cm³ over the cable's cross-section. */
export const CABLE_DENSITY = 1.8e-3; // g/mm³

/**
 * SKÅDIS T-clips (issues #213, #221, docs/mounts.md): a twist lock adapted from
 * the Skadis T-Clip System by Line Arc Line (Printables 256896, CC BY 4.0),
 * re-implemented with our own dimensions. Each clip is a flat "I" (a fin
 * handle, a stem, a T bar), SKADIS_TCLIP_WIDTH thick and printed lying on its
 * face. It goes through a slot in a floor across the bottom of the bore and
 * through the board's slot with its bars upright, then turns a quarter turn:
 * the T bar spans the slot behind the board, and the fin bears on the
 * floor, so the core is clamped flat to the board. skadisTclips.ts lays
 * them out.
 */
/** The clip's thickness: 4 mm, so the 2 x 4 mm stem can turn inside even the tightest 4.8 mm slot. */
export const SKADIS_TCLIP_WIDTH = 4; // mm
/** The stem, across its width (along the bars). */
export const SKADIS_TCLIP_STEM = 2; // mm
/** The T bar behind the board: 12.2 mm passes the tightest slot's 12.65 mm of full width for a 4 mm bar, and overlaps the board 3.7 mm a side once turned. */
export const SKADIS_TCLIP_BAR_LENGTH = 12.2; // mm
export const SKADIS_TCLIP_BAR_THICKNESS = 3; // mm
/** The fin handle, across: long enough to grip and to bear on the floor either side of its slot. */
export const SKADIS_TCLIP_HANDLE_LENGTH = 18; // mm
/** The fin's least height above its recess's floor. */
export const SKADIS_TCLIP_HANDLE_THICKNESS = 5; // mm
/** The fin's greatest height above the recess's floor (issue #221: tall enough to pinch from the top of a deep core). */
export const SKADIS_TCLIP_FIN_MAX = 60; // mm
/** The fin's top stays this far below the wall's top, or below the cap's collar when there is a cap. */
export const SKADIS_TCLIP_FIN_TOP_GAP = 1; // mm
/** A bore narrower than this has no room for a hand, so the fins rise to its top. */
export const SKADIS_TCLIP_HAND_WIDTH = 50; // mm
/** A fin top deeper than this below the core's top is hard to pinch: noted. */
export const SKADIS_TCLIP_REACH_DEPTH = 65; // mm
/** A fin's axis stays this far inside the cap's hole, so a fingertip reaches its top. */
export const SKADIS_TCLIP_REACH_MARGIN = 8; // mm
/** The fin turns in a recess this deep in the floor's top face, which stops it at upright and at a quarter turn. */
export const SKADIS_TCLIP_RECESS_DEPTH = 2; // mm
/** The floor's wall round each recess: a clip's axis keeps the recess's sweep plus this from the bore's wall. */
export const SKADIS_TCLIP_FLOOR_WALL = 1.5; // mm
/** The clamp: the gap between the fin's and the T bar's bearing faces is the floor under the recess plus this (the thickest, painted board: tight on it, about 0.4 mm of play on an unpainted 4.82 mm board). */
export const SKADIS_TCLIP_BOARD = 5.2; // mm
/** The floor's slot: the board's nominal slot plus this all round, so the T bar passes and the stem turns. */
export const SKADIS_TCLIP_SLOT_CLEARANCE = 0.1; // mm
/** Issue #221, after the original's soft edges: every edge of the clip is chamfered this much (0.5 mm on the stem, so it turns with room to spare). */
export const SKADIS_TCLIP_CHAMFER = 0.6; // mm
export const SKADIS_TCLIP_STEM_CHAMFER = 0.5; // mm
/** Issue #221, after the original's "hook ramps": the T bar's bearing face falls this much over SKADIS_TCLIP_RAMP_LENGTH at each end, so the bar rides over the slot's edge as it turns instead of catching. */
export const SKADIS_TCLIP_RAMP = 0.7; // mm
export const SKADIS_TCLIP_RAMP_LENGTH = 1.2; // mm
/** Issue #221, after the original's 45 degree seat: a 45 degree lead-in this wide round the recess's and the slot's mouths. */
export const SKADIS_TCLIP_LEAD_IN = 0.5; // mm
/** The floor under the recess: the flange is at least this thick with T-clips. */
export const MIN_FLANGE_THICKNESS_FOR_TCLIP = SKADIS_TCLIP_RECESS_DEPTH + 3; // mm

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

/**
 * Plate-to-flange joint (issues #106, #132): the plate prints back-face up
 * and the core prints flange-down, so neither mating face can carry a
 * protrusion without supports. Both get matching blind round holes instead,
 * aligned on two separately printed pegs (their own parts), then glued.
 *
 * The peg is a low-poly prism: a square with its corners chamfered at 45
 * degrees (an octagon whose 8 corners all lie on one circle,
 * `MOUNT_PLATE_PEG_RADIUS`), with a 45 degree lead-in on both ends. It
 * prints lying on one of its wide flats: the layers then run along the peg,
 * so the joint's shear load (across the peg) never splits a layer line, and
 * every other face is at 45 degrees or steeper -- no supports. The round
 * hole grips the octagon's corners, so the peg goes in at any rotation.
 */
export const MOUNT_PLATE_PEG_SIZE = 3; // mm, across the wide flats
export const MOUNT_PLATE_PEG_CORNER = 0.5; // mm, cut off each side at every corner (the 45 degree flats)
export const MOUNT_PLATE_PEG_LEAD_IN = 0.4; // mm, 45 degree chamfer on both ends
/** Both holes' depth less a little, so the faces close. */
export const MOUNT_PLATE_PEG_LENGTH = 4.5; // mm
/** The circle every corner of the peg's octagon lies on. */
export const MOUNT_PLATE_PEG_RADIUS = Math.hypot(MOUNT_PLATE_PEG_SIZE / 2, MOUNT_PLATE_PEG_SIZE / 2 - MOUNT_PLATE_PEG_CORNER); // ~1.80 mm
export const MOUNT_PLATE_PEG_HOLE_DEPTH = 2.4; // mm, in the flange and in the 3 mm plate alike

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
/** design.ts bumps FLANGE_THICKNESS up to (at least) this, and warns, whenever mount is "skadis"/"opengrid" -- mirrors MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT. */
export const MIN_FLANGE_THICKNESS_FOR_PLATE = MOUNT_PLATE_PEG_HOLE_DEPTH + MOUNT_PLATE_ANCHOR_MIN_SHELF;
