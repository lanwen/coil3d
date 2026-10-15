export const WALL_THICKNESS = 3;
export const GROOVE_FLOOR_WALL = 1.5;
export const GROOVE_DEPTH_FACTOR = 0.4;
export const GROOVE_SLACK = 0.15;
export const GROOVE_LIP_ANGLE_DEG = 70;
export const RIDGE_LAND = 0.3;
export const MARGIN_BOTTOM = 0.2;
export const MARGIN_TOP_FACTOR = 0.3;
export const TAPER_TURNS = 0.15;
export const RUN_IN_TURNS = 0.1;

export const FLANGE_MARGIN = 1.5;
export const FLANGE_THICKNESS = 3;
export const EDGE_CHAMFER = 1;

export const MIN_BORE_RADIUS = 1;
export const MIN_BORE_CORNER_RADIUS = 0.5;
export const SHAPE_ROUNDING_EPS = 0.01;
export const DEFAULT_CORNER_RADIUS = 8;
export const DEFAULT_PILL_RADIUS = 20;

export const FINAL_COLUMNS = 96;
export const FINAL_ROWS_PER_PITCH = 16;
export const DRAFT_COLUMNS = 24;
export const DRAFT_ROWS_PER_PITCH = 3;

export const FINAL_MIN_CORNER_SEGMENTS_PER_90 = 16;
export const DRAFT_MIN_CORNER_SEGMENTS_PER_90 = 8;

export const FINAL_WIRE_MIN_SAMPLES_PER_TURN = 96;
export const FINAL_WIRE_MAX_ARC_LENGTH = 1;
export const DRAFT_WIRE_MIN_SAMPLES_PER_TURN = 16;
export const DRAFT_WIRE_MAX_ARC_LENGTH = 4;

export const MAX_WIRE_LENGTH = 15000;

export const SIZE_LO_FLOOR = 5;
export const SIZE_HI = 500;
export const HEIGHT_HI = 400;
export const LAYERS_HI = 40;

export const MIN_TURNS_PER_LAYER = 5;

export const CAP_THICKNESS = 3;
export const DEFAULT_TOLERANCE = 0.2;
export const TOLERANCE_MIN = 0.05;
export const TOLERANCE_MAX = 0.8;
export const JOINT_ENGAGE_DEPTH = 7;

export const CAP_COLLAR_WALL = 2;
export const JOINT_TRANSITION_HEIGHT = 2;

export const WELD_OVERLAP = 1;
export const JOINT_FIT_GAP = 0.3;
export const JOINT_MIN_BORE_RADIUS = 4;

export const BAYONET_LUG_COUNT = 3;
export const BAYONET_GAP = 0.4;
export const BAYONET_LUG_HEIGHT = 1;
export const BAYONET_LUG_WIDTH = 5;

export const BAYONET_LUG_MAX_DEG = 30;
export const BAYONET_LUG_TIP = 0.8;
export const BAYONET_LUG_DROP = 1.5;
export const BAYONET_MIN_WALL = 1.2;
export const BAYONET_MIN_LAND = 1.5;

export const SNAP_FINGER_LENGTH = 12;

export const SNAP_BARB = 1.1;
export const SNAP_BARB_CLEARANCE = 0.1;
export const SNAP_RIDGE_DEPTH = 1.1;
export const SNAP_RIDGE_THICKNESS = 1.4;

export const SNAP_LEAD_IN_ANGLE_DEG = 30;
export const SNAP_PRELOAD = 0.2;
export const SNAP_SEAT_GAP = 0.3;

export const SNAP_COLLAR_WALL = 1.2;
export const SNAP_SLOT_WIDTH = 2;

export const CABLE_BASE_CLIP_INTERFERENCE = 0.08;
export const CABLE_BASE_CLIP_OPENING_MIN = 0.75;
export const CABLE_BASE_CLIP_LAND = 0.3;

export const CABLE_CLIP_LENGTH_FACTOR = 1.5;
export const CABLE_CLIP_MIN_LENGTH = 5;
export const CABLE_CLIP_DEPTH_SLACK = 0.25;
export const CABLE_CLIP_ENTRY = 0.05;
export const CABLE_CLIP_WALL = 1.5;

export const CAP_LEAD_OUT_WALL_GAP = 0.3;
export const CAP_CABLE_DROP = 0.1;

export const RIM_SLOT_NECK = 1;
export const RIM_SLOT_WALL_GAP = 0.4;
export const RIM_SLOT_KEEP_OUT = 1;
export const RIM_SLOT_LABEL_KEEP_OUT = 1;
export const RIM_SLOT_SEAT_SEGMENTS = 32;
export const STRAP_SLOT_LENGTH = 14;
export const STRAP_SLOT_WIDTH = 2.5;
export const STRAP_SLOT_INNER_WALL = 1.5;
export const STRAP_SLOT_OUTER_WALL = 2;
export const STRAP_SLOT_PLATE_REACH = STRAP_SLOT_INNER_WALL + STRAP_SLOT_WIDTH + STRAP_SLOT_OUTER_WALL;
export const STRAP_SLOT_PLATE_MIN_SKIN = STRAP_SLOT_OUTER_WALL;
export const STRAP_SLOT_PLATE_OVERSHOOT = 1;
export const STRAP_SLOT_KEEP_OUT = RIM_SLOT_KEEP_OUT;
export const STRAP_SLOT_MIN_SEPARATION_FRACTION = 1 / 3;

export const CABLE_CLIPPED_TAIL_FACTOR = 3;
export const CABLE_CLIPPED_TAIL_MIN = 10;

export const CABLE_SWEEP_ARC_SEGMENTS = 16;
export const CABLE_SWEEP_STEP = 2.5;
export const CABLE_SWEEP_MAX_SAG = 0.08;

export const INNER_CHANNEL_DEPTH_FACTOR = 1.0;

export const INNER_CHANNEL_MIN_SHELF = 1.5;
export const INNER_CHANNEL_WALL_SKIN = 0.4;
export const INNER_CHANNEL_WALL_GUARD = 0.2;

export const FLANGE_PLATE_THICKNESS = FLANGE_THICKNESS;
export const FLANGE_PAD_WALL = 2.5;
export const FLANGE_PAD_COLLAR = 1;
export const FLANGE_PAD_COLLAR_COLUMNS = 96;

export const FLANGE_PAD_STEP = 5;
export const FLANGE_PAD_BLEND_RADIUS = 5;
export const FLANGE_PAD_BLEND_STEP = 2;
export const FLANGE_PAD_BLEND_BURY = 0.15;

export const FLANGE_PAD_EMBED = EDGE_CHAMFER + 0.25;
export const FLANGE_PAD_RISE = 0.5;

export const CABLE_BEND_BUDGET = 0.97;
export const CABLE_BEND_CHECK = 1.03;
export const CABLE_BRIDGE_STEP = 0.5;

export const CABLE_TAIL_FACTOR = 6;
export const CABLE_TAIL_MIN = 20;

export const DEFAULT_BED_SIZE = 256;
export const BED_SIZE_MIN = 50;
export const BED_SIZE_MAX = 1000;
export const PLATE_GAP = 5;

export const LABEL_MIN_HEIGHT = 5;
export const LABEL_MAX_STROKE = 1.8;
export const LABEL_STEM_PER_EM = 0.221;
export const LABEL_MAX_FONT_SIZE = LABEL_MAX_STROKE / LABEL_STEM_PER_EM;

export const LABEL_MARGIN = 2;
export const LABEL_DEPTH = 0.6;
export const LABEL_CURVE_SEGMENTS = 6;
export const LABEL_MAX_LENGTH = 40;

export const SCREW_MOUNT_HEAD_DIAMETER = 8;
export const SCREW_MOUNT_SHANK_DIAMETER = 4;
export const SCREW_MOUNT_HEAD_RADIUS = SCREW_MOUNT_HEAD_DIAMETER / 2;
export const SCREW_MOUNT_SHANK_RADIUS = SCREW_MOUNT_SHANK_DIAMETER / 2;
export const SCREW_MOUNT_SLOT_TRAVEL = 4;
export const SCREW_MOUNT_EDGE_MARGIN = 2;
export const SCREW_MOUNT_RECESS_DEPTH = 3;

export const SCREW_MOUNT_SLOT_DIAMETER = (SCREW_MOUNT_SHANK_DIAMETER + SCREW_MOUNT_HEAD_DIAMETER) / 2;
export const SCREW_MOUNT_SLOT_RADIUS = SCREW_MOUNT_SLOT_DIAMETER / 2;
export const SCREW_MOUNT_SLOT_DEPTH = 1;
export const SCREW_MOUNT_HEAD_HEIGHT = 2;
export const SCREW_MOUNT_UNDERCUT_DEPTH = SCREW_MOUNT_RECESS_DEPTH - SCREW_MOUNT_SLOT_DEPTH;
export const SCREW_MOUNT_LEVEL_OVERLAP = 0.05;

export const SCREW_MOUNT_MIN_SHELF = 2;
export const MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT = SCREW_MOUNT_RECESS_DEPTH + SCREW_MOUNT_MIN_SHELF;
export const SCREW_MOUNT_ANNULUS_WIDTH = SCREW_MOUNT_SLOT_TRAVEL + 2 * SCREW_MOUNT_HEAD_RADIUS + 2 * SCREW_MOUNT_EDGE_MARGIN;

export const SCREW_MOUNT_TWO_SLOT_FLANGE_THRESHOLD = 90;
export const SCREW_MOUNT_TWO_SLOT_ANGLE_DEG = 25;
export const SCREW_MOUNT_AXIS_SEARCH_MAX_DEG = 60;
export const KEYHOLE_ROTATION_OPTIONS = [0, 45] as const;

export const THROUGH_HOLE_DIAMETER_MIN = 2.5;
export const THROUGH_HOLE_DIAMETER_MAX = 8;
export const DEFAULT_THROUGH_HOLE_DIAMETER = 4.5;

export const THROUGH_MOUNT_EDGE_MARGIN = 2;
export const THROUGH_MOUNT_RIM_MARGIN = THROUGH_MOUNT_EDGE_MARGIN + EDGE_CHAMFER;
export const THROUGH_MOUNT_CORNER_NUDGE_DEG = 20;
export const THROUGH_MOUNT_SLIDE_STEP = 0.25;
export const THROUGH_MOUNT_COUNTERSINK_LAND = 1;
export const THROUGH_MOUNT_PAD_CLEARANCE = 0.5;
export const THROUGH_MOUNT_ROUND_HOLE_COUNTS = [4, 3] as const;

export const MOUNT_PLATE_THICKNESS = 3;
export const MOUNT_PLATE_EDGE_MARGIN = 3;

export const OPENGRID_PITCH = 28;

export const MOUNT_PLATE_MAX_PER_SIDE = 4;
export const MOUNT_PLATE_MIN_CLIPS = 2;

export const SKADIS_SLOT_WIDTH = 5;
export const SKADIS_SLOT_LENGTH = 15;

export const SKADIS_SLOT_WIDTH_MIN = 4.8;
export const SKADIS_SLOT_LENGTH_MIN = 14.8;

export const SKADIS_LATTICE_STEP = 20;
export const SKADIS_BOARD_THICKNESS = 5;
export const SKADIS_BOARD_THICKNESS_MAX = 5.2;

export const SKADIS_CLIP_WIDTH = 4.4;

export const SKADIS_STANDOFF = 3;
export const SKADIS_STEM_HEIGHT = 5;
export const SKADIS_TONGUE_LENGTH = 6;
export const SKADIS_TONGUE_THICKNESS = 3;

export const SKADIS_TONGUE_GAP = 0.3;
export const SKADIS_JAW_OVERLAP = 5;
export const SKADIS_LIP_THICKNESS = 2.5;
export const SKADIS_BIGHT_THICKNESS = 3;

export const SKADIS_CLIP_CHAMFER = 0.5;

export const SKADIS_NOTCH_DEPTH = 1;
export const SKADIS_NOTCH_MIN_CROSSING_DEG = 15;
export const SKADIS_ENVELOPE_CLEARANCE = 1;

export const SKADIS_LATCH_ARM_THICKNESS = 1.6;
export const SKADIS_LATCH_SLIT = 2.9;
export const SKADIS_LATCH_MAST_THICKNESS = 3;
export const SKADIS_LATCH_ARM_REACH = 21;
export const SKADIS_LATCH_ROOT = 3;
export const SKADIS_LATCH_END_GAP = 0.8;
export const SKADIS_LATCH_TOOTH_DEPTH = 2.5;
export const SKADIS_LATCH_TOOTH_LENGTH = 4;
export const SKADIS_LATCH_LIFT = 1;
export const SKADIS_LATCH_FACE_DEG = 25;

export const SKADIS_HEAVY_CABLE_KG = 0.5;
export const CABLE_DENSITY_G_PER_MM3 = 1.8e-3;

export const SKADIS_TCLIP_WIDTH = 4;
export const SKADIS_TCLIP_STEM = 2;

export const SKADIS_TCLIP_BAR_LENGTH = 12.2;
export const SKADIS_TCLIP_BAR_THICKNESS = 3;

export const SKADIS_TCLIP_HANDLE_LENGTH = 18;
export const SKADIS_TCLIP_HANDLE_THICKNESS = 5;

export const SKADIS_TCLIP_FIN_HEIGHT = 12;
export const SKADIS_TCLIP_FIN_TOP_GAP = 1;
export const SKADIS_TCLIP_REACH_MARGIN = 8;

export const SKADIS_TCLIP_RECESS_DEPTH = 2;
export const SKADIS_TCLIP_FLOOR_WALL = 1.5;

export const SKADIS_TCLIP_CLAMPED_BOARD_THICKNESS = 5.2;
export const SKADIS_TCLIP_SLOT_CLEARANCE = 0.1;

export const SKADIS_TCLIP_CHAMFER = 0.6;
export const SKADIS_TCLIP_STEM_CHAMFER = 0.5;
export const SKADIS_TCLIP_NOTCH_WIDTH = 1.2;
export const SKADIS_TCLIP_NOTCH_DEPTH = 3;
export const SKADIS_TCLIP_NOTCH_FLOOR = 2;
export const SKADIS_TCLIP_NOTCH_LEAD = 0.4;

export const SKADIS_TCLIP_RAMP = 0.7;
export const SKADIS_TCLIP_RAMP_LENGTH = 1.2;

export const SKADIS_TCLIP_LEAD_IN = 0.5;

export const MIN_FLANGE_THICKNESS_FOR_TCLIP = SKADIS_TCLIP_RECESS_DEPTH + 3;

export const OPENGRID_PLACEHOLDER_PEG_SIZE = 14;
export const OPENGRID_PLACEHOLDER_PEG_REACH = 5;

export const MOUNT_PLATE_PEG_SIZE = 3;
export const MOUNT_PLATE_PEG_CORNER = 0.5;
export const MOUNT_PLATE_PEG_LEAD_IN = 0.4;

export const MOUNT_PLATE_PEG_LENGTH = 4.5;
export const MOUNT_PLATE_PEG_RADIUS = Math.hypot(MOUNT_PLATE_PEG_SIZE / 2, MOUNT_PLATE_PEG_SIZE / 2 - MOUNT_PLATE_PEG_CORNER);
export const MOUNT_PLATE_PEG_HOLE_DEPTH = 2.4;

export const MOUNT_PLATE_EMBED = 0.5;

export const MOUNT_PLATE_ANCHOR_MIN_SHELF = 1.5;
export const MIN_FLANGE_THICKNESS_FOR_PLATE = MOUNT_PLATE_PEG_HOLE_DEPTH + MOUNT_PLATE_ANCHOR_MIN_SHELF;

export const DEFAULT_BASE = "off" as const;
export const CENTRE_CONNECTOR_PASSAGE = 22.4;

export const FACE_ROOF = 1.2;
export const FACE_WEB = 1.2;
export const FACE_MIN_THICKNESS = 2;
export const FACE_SEAT_CLEARANCE = 0.5;
export const FACE_EASE_LENGTH = 6;
export const FACE_RING_OVERLAP = 0.5;
export const FACE_CUT_OVERSHOOT = 1;
export const FACE_REVOLVE_SEGMENTS = 120;
export const FACE_DOME_SEGMENTS = 14;
export const FACE_TAIL_HANG = 20;
export const FACE_BEND_MARGIN = 2;
export const FACE_ARC_JOINT_OVERLAP = 0.3;
export const FACE_MIN_CROSSING = 0.4;
export const FACE_MARCH_STEP = 0.5;
export const FACE_ARC_STEP = 1;
export const FACE_SEAT_SPAN = 2;
export const FACE_FUNNEL_FIT_STEPS = 6;
export const FACE_BRIDGE_NOTE_WIDTH = 8;
export const FACE_BRIDGE_LIMIT = 8.5;
export const FACE_HOLE_CORNER_MIN = 0.5;
export const FACE_WIDTH_STEPS = 4;
export const FACE_GROOVE_LEAD = 4;
export const FACE_LIP_OPEN = 2 * FACE_EASE_LENGTH;
export const FACE_LIP_RAMP = 0.6;
export const FACE_LEAD_MARGIN = 0.05;
export const FACE_LEAD_HOLD = 0.5;
export const FACE_LEAD_INNER = 0.15;
export const FACE_LEAD_SHRINK = 2;
export const FACE_LEAD_TILT = 0.6;
export const FACE_LEAD_COLUMN_STEP = 0.5;
export const FACE_LEAD_COLUMN_REACH = 4;
export const FACE_STEP_CUT_CLEARANCE = 0.03;
export const FACE_STEP_DIP_INSET = 0.05;
export const FACE_STEP_DIP_STEPS = 3;
export const FACE_STEP_DIP_SEGMENTS = 8;
export const FACE_DIP_STEPS = 6;
export const FACE_DIP_PROBE_STEP = 0.05;
export const FACE_DIP_MIN_WEB = 0.05;
export const FACE_DIP_RUN_OUT = 0.6;
export const FACE_DIP_BITE = 1;
export const FACE_DIP_OUTSET = 0.05;
export const FACE_DIP_SKEW = 0.5;
export const FACE_DIP_PAST = 0.25;
export const FACE_FILLET_STEPS = 8;
export const FACE_FILLET_ROOM = 0.2;
export const FACE_FILLET_MIN = 0.05;

export const RAMP_TURNS_MIN = 0.1;
export const RAMP_TURNS_STEP = 0.05;
export const RAMP_TURNS_MAX = 0.8;
export const RAMP_BULGE_SPANS = [0.15, 0.3, 0.6];

export const CROSSING_MIN_LAYERS = 2;
export const LEAD_OUT_TURNS_MAX = 4;
export const CLIMB_TURNS_STEP = 0.15;
export const CLIMB_OFFSET_SPAN = 0.2;
export const CLIMB_BULGE_SPANS = [CLIMB_OFFSET_SPAN, 0.15, 0.1, 0.07, 0.05];

export const RAMP_CLEAR_SLACK = 0.1;
