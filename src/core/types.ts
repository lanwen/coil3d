// Public types for the headless coil core. See docs/research.md for the
// full domain model. Issue #5 implemented the full lock/free solver for a
// round core; issue #6 adds the rounded-square and rounded-triangle shape
// plugins (see ShapeKind/ShapeSpec below and shapes.ts).

import type { WallSpec } from "./wall";
import type { FlangeSpec } from "./manifold";
import type { CapClipLayout } from "./innerEnd";

export type { ShapeKind } from "./shapes";

/**
 * What the user controls about the core's cross-section. Round has no extra
 * params (it's always fully round); sq/tri carry a corner radius, namespaced
 * in the hash as `sq.rc`/`tri.rc` (docs/research.md §7, §2 "Shape plugins").
 * The solver clamps `cornerRadius` into the bend-limit-derived range each
 * time it solves (solve.ts); this field is the user's un-clamped request.
 */
export type ShapeSpec = { kind: "round" } | { kind: "sq"; cornerRadius: number } | { kind: "tri"; cornerRadius: number };

/** Top-cap override (issue #9): `auto` follows `Solution.capsAuto` (on when layers > 1). */
export type TopCapMode = "auto" | "on" | "off";

/** Permanent, glue-friendly cap joints (issue #9, docs/research.md §1 "Cap joint"). */
export type JointKind = "press" | "bayonet" | "snap";

export type WireTypeId = "usb" | "flex" | "stiff" | "custom";

export interface WireTypePreset {
  id: WireTypeId;
  label: string;
  /** Minimum-bend-radius multiplier: MBR = multiplier * wireDiameter. */
  bendMultiplier: number;
}

/** docs/research.md §1: USB/audio 4x, flexible cord 4x, stiff/solid 10x. */
export const WIRE_TYPE_PRESETS: Record<Exclude<WireTypeId, "custom">, WireTypePreset> = {
  usb: { id: "usb", label: "USB / audio cable", bendMultiplier: 4 },
  flex: { id: "flex", label: "Flexible cord", bendMultiplier: 4 },
  stiff: { id: "stiff", label: "Stiff / solid cord", bendMultiplier: 10 },
};

export const DEFAULT_CUSTOM_BEND_MULTIPLIER = 4;

export interface WireSpec {
  /** Total cable length to store, mm. Above 15 m is rejected (docs/research.md §1). */
  length: number;
  /** Cable outer diameter, mm. */
  diameter: number;
  type: WireTypeId;
  /** Only read when type === "custom". */
  customBendMultiplier?: number;
}

export function bendMultiplierOf(wire: WireSpec): number {
  if (wire.type === "custom") return wire.customBendMultiplier ?? DEFAULT_CUSTOM_BEND_MULTIPLIER;
  return WIRE_TYPE_PRESETS[wire.type].bendMultiplier;
}

/** locked=false means "solve for me". */
export type Lock<T> = { locked: true; value: T } | { locked: false };

/**
 * The core tube's radial size is one shared degree of freedom, expressed
 * either as the outer (winding surface) size or the inner (bore) size; a
 * fixed wall thickness (not itself lockable) links them (docs/research.md §1).
 */
export type CoreSizeLock = { locked: true; dimension: "outer" | "inner"; value: number } | { locked: false };

export type Objective = "minVolume" | "aspectRatio";

/**
 * The printer's build volume (issue #10, docs/research.md §1 "Print" /
 * user story 45: "I want to enter my printer's bed size, so that I'm
 * warned when a part doesn't fit"). This is part of `CoilSpec` -- not a
 * view-only setting like `showWire` -- because it changes real `design()`
 * output (the per-part fit warnings) and `exportDesign()` output (the 3MF
 * plate layout), and `exportDesign` only ever takes a `Design`, not extra
 * arguments, so the bed size has to already be inside the spec it was
 * solved from.
 */
export interface PrintSpec {
  bedX: number;
  bedY: number;
  bedZ: number;
}

/**
 * Wall mount (issue #13/#14/#70, docs/research.md "Mounting"): `"keyhole"`
 * recesses a screw-keyhole slot into the bottom flange's outer (wall-facing)
 * face. `"through"` (issue #70) instead cuts plain, counterbored
 * screw-shank holes straight through the flange (near the corners for
 * sq/tri, evenly spaced for round), for a permanent, non-sliding screw
 * mount. `"skadis"`/`"opengrid"` (issue #14) instead produce a SEPARATE
 * named "mount plate" part with pegboard clips, which glues or snaps onto
 * that same flange face (see `PlateJoint`, mountPlate.ts) -- the core keeps
 * printing flat with no clip features of its own. `"none"` is the default.
 */
export type MountKind = "none" | "keyhole" | "through" | "skadis" | "opengrid";

/** Issue #71: the screw-keyhole mount's own placement axis, shifted away from literal vertical in fixed steps (mount.ts's `bestAxisDeg`/`KEYHOLE_ROTATION_OPTIONS`; 90 is deliberately not offered -- see that constant's own doc comment, a horizontal channel can't retain the coil). Ignored when `mount !== "keyhole"`. */
export type KeyholeRotation = 0 | 45;

/**
 * How the clip mount plate (issue #14, `mount: "skadis" | "opengrid"`)
 * attaches to the flange. `"glue"`: matching blind holes in the plate and
 * the flange, aligned with two short pieces of 1.75 mm filament, then glued.
 * `"snap"` (issue #14's printable snap tabs) is kept only so old links still
 * parse: tabs on the plate's front face can't print without supports, so
 * design() builds the glue joint for it too, with a warning (issue #106).
 */
export type PlateJoint = "glue" | "snap";

/** What the user controls. */
export interface CoilSpec {
  wire: WireSpec;
  shape: ShapeSpec;
  /** 0 = worst case (stacked, h=d), 1 = ideal (orthocyclic, h=d*sqrt(3)/2). */
  windingQuality: number;
  coreSize: CoreSizeLock;
  height: Lock<number>;
  layers: Lock<number>;
  /** Used only when exactly two of {coreSize, height, layers} are free. */
  objective: Objective;
  /** Top-cap override (issue #9): defaults to "auto" (on when layers > 1). */
  topCap: TopCapMode;
  /** Cap joint (issue #9): press-fit, bayonet/twist-lock or snap clips, all permanent and glue-friendly. */
  joint: JointKind;
  /** One global print tolerance (mm) that scales every joint's fit (docs/research.md §4 "Joints / tolerances"). */
  tolerance: number;
  /** The printer's bed size (issue #10); drives per-part fit warnings and the 3MF plate layout. */
  print: PrintSpec;
  /**
   * Engraved label text on the top cap's room-facing face (issue #12,
   * docs/research.md §1 "Extras"). Undefined/empty means no label. Ignored
   * (with a warning, see label.ts's `resolveLabel`) when there is no top
   * cap; hidden (with a different warning) when it doesn't fit the annulus
   * at a legible height.
   */
  label?: string;
  /** Wall mount (issue #13/#14/#70): recesses a screw-keyhole slot into the core's bottom flange, cuts plain through-holes ("through", issue #70), or (skadis/opengrid) adds a separate clip mount-plate part. */
  mount: MountKind;
  /** How the clip mount plate attaches to the flange (issue #14); ignored when `mount` isn't "skadis"/"opengrid". */
  plateJoint: PlateJoint;
  /** Issue #71: the keyhole mount's own placement rotation; ignored when `mount !== "keyhole"`. Defaults to 0 when omitted. */
  keyholeRotation?: KeyholeRotation;
  /** Issue #70: through-hole diameter (screw-shank clearance), mm; ignored when `mount !== "through"`. Defaults to `DEFAULT_THROUGH_HOLE_DIAMETER` when omitted. */
  throughHoleDiameter?: number;
}

export interface LayerResult {
  layer: number;
  turns: number;
  /** Wire centerline radial offset from the core's outer surface, mm. */
  offset: number;
  perimeter: number;
  length: number;
}

export interface Diagnosis {
  freeCount: 0 | 1 | 2 | 3;
  freeVariables: Array<"coreSize" | "height" | "layers">;
  status: "ok" | "over-constrained" | "under-constrained" | "infeasible";
  message: string;
}

/**
 * A flange's real outer extent (issue #63), mm: see `Solution.flangeExtent`.
 * Round has no corners (`acrossFlats === acrossCorners`, a true diameter);
 * square/triangle differ, so the wider of the two is the one that actually
 * has to clear a bed/enclosure.
 */
export interface FlangeExtent {
  /** Distance across two opposite flat sides (the narrower extent for a non-round shape). */
  acrossFlats: number;
  /** Distance across two opposite rounded corners (the wider extent for a non-round shape). */
  acrossCorners: number;
}

/** The solver's output: resolved geometry, capacity numbers and diagnosis. */
export interface Solution {
  diagnosis: Diagnosis;
  /** Set when freeCount is 2 or 3 (an objective was needed to pick a candidate). */
  objectiveUsed?: Objective;
  outerSize: number;
  /**
   * Resolved corner radius, mm: `outerSize / 2` for round (always fully
   * rounded); for sq/tri, the user's requested `shape.cornerRadius` clamped
   * into `cornerRadiusRange` (docs/research.md §2 "cornerRadiusRange").
   */
  cornerRadius: number;
  /** [bend-limit floor, outerSize/2]. When the floor exceeds the ceiling, the shape is forced fully round regardless of the request -- see the "became round" warning in solve.ts. */
  cornerRadiusRange: [number, number];
  innerBore: number;
  height: number;
  layers: number;
  layerResults: LayerResult[];
  totalWoundLength: number;
  totalWireLength: number;
  targetWireLength: number;
  lengthDeltaPct: number;
  /** Capacity range across winding-quality bounds, at the resolved geometry. */
  capacityRange: [number, number];
  envelopeDiameter: number;
  /**
   * The solver's own target flange size (issue #50 heritage): the wound
   * envelope plus a flat `FLANGE_MARGIN`, used only as the FLOOR the real
   * flange margin is solved up to (design.ts's `baseMargin`) -- never the
   * real flange's own outer extent (issue #63: for a non-round shape this
   * consistently under-reported the true across-corners size, since the
   * flange margin design.ts actually resolves also has to satisfy the
   * mount's own requirements, and this envelope-derived number never saw
   * that). See `flangeExtent` for the real, built extent.
   */
  flangeSize: number;
  /**
   * The core's REAL overall assembled height (issue #63): from the bottom
   * flange's own underside up to the top cap's own top face (or the wall's
   * own top rim, when there's no cap) -- matching `Design.parts`' meshes
   * within floating-point noise, unlike `height` (the core WALL's own
   * winding height only: it starts at the flange's top face and excludes
   * both the flange's thickness below it and any top cap above it, see
   * that field's own doc comment via design.ts's z=[-thickness,height]
   * convention). Set once `design()` has resolved the real flange
   * thickness and whether a cap is attached (both mount- and
   * layer-count-dependent, so `solve()` alone can't compute this --
   * see design.ts); left undefined on `alternates`, whose geometry
   * `design()` never actually builds.
   */
  overallHeight?: number;
  /**
   * The core's REAL flange outer extent (issue #63), matching the flange
   * mesh's own outline (the resolved shape outline offset OUTWARD by the
   * real flange margin `design()` resolves -- including whatever a mount
   * bumps it up to -- see design.ts's `margin`), computed from that exact
   * same analytic offset outline (shapes.ts's `inscribedRadius`/
   * `circumscribedRadius`), never from re-meshing: cheap enough to always
   * compute, and exact by construction (the flange mesh is built from this
   * very outline, see wall.ts's `buildOutlineRing`). For a round flange
   * both fields are equal (a true diameter in every direction, see
   * shapes.ts's `circumscribedRadius`, which reduces to `inscribedRadius`
   * when `cornerRadius === apothem`); for square/triangle, `acrossFlats` is
   * the narrower, flat-side-midpoint extent and `acrossCorners` the wider,
   * corner-arc extent -- together they bound whatever direction the
   * viewer's own width/depth dimension axes (`DimensionAxes.tsx`,
   * measured along the model's own X/Y) read off the SAME flange.
   * Undefined on `alternates` (see `overallHeight`).
   */
  flangeExtent?: FlangeExtent;
  /** True iff layers > 1 -- the AUTOMATIC recommendation, independent of `CoilSpec.topCap`'s override. */
  capsAuto: boolean;
  /** The RESOLVED decision (issue #9): `capsAuto` unless `CoilSpec.topCap` overrides it to "on"/"off". This is what actually controls whether `Design.parts` includes a topCap part. */
  topCapEnabled: boolean;
  minOuterSizeForBend: number;
  /**
   * Minimum outer size at which the resolved shape stays visibly distinct
   * from round (issue #54): equals `minOuterSizeForBend` for round (no
   * further constraint beyond the bend limit). For sq/tri, the bend-limited
   * corner radius alone (independent of the user's own `shape.cornerRadius`
   * request) erodes the straight sides as size shrinks; below this value
   * they'd fall under "each flat >= max(2 * wireDiameter, 15% of the
   * outline's own perimeter)" -- meaningfully long enough to look like a
   * square/triangle rather than a circle. The solver never resolves a
   * smaller outer size than this for sq/tri: a locked size below it is
   * silently raised (with a warning), and a free size never searches below
   * it. Surfaced here (not just as a warning string) so the UI can clamp the
   * size control's own minimum instead of letting the user pick a value the
   * solver will just override.
   */
  minOuterSizeForShape: number;
  /**
   * Sibling candidates shown side by side (2-3 total including this one),
   * when freeCount is 2 or 3 -- e.g. the other objective's pick (freeCount
   * 2), or fixed-layer-count picks such as layers=1/layers=2 (freeCount 3).
   * Empty when freeCount is 0 or 1 (the solution is deterministic). Every
   * entry here already satisfies the same capacity-covers-target invariant
   * as the primary solution; entries never carry their own `alternates`.
   */
  alternates: Solution[];
}

/** A triangle mesh as flat typed arrays (three.js / manifold-3d friendly). */
export interface CoilMesh {
  /** xyz per vertex. */
  positions: Float32Array;
  /** 3 indices per triangle. */
  indices: Uint32Array;
}

/**
 * The schematic wound-cable centerline for one layer (issue #4): a dense
 * sample of the same helix the solver sized (orthocyclic offset, pitch and
 * a half-pitch phase shift per layer), for the viewer to loft into a tube.
 * This is schematic, not a printable part -- it is never exported.
 */
export interface WireLayerPath {
  /** 1-indexed, matches `LayerResult.layer` / `Solution.layerResults`. */
  layer: number;
  turns: number;
  /** Wire centerline points (x, y, z, mm), 3 floats per sample, dense enough for a smooth tube. */
  points: Float32Array;
}

export type PartRole = "core" | "topCap" | "mountPlate";

/**
 * A rigid transform (rotation about X, then translation) applied to a
 * part's mesh to get it into ITS OWN print-bed orientation (issue #9): the
 * core is already built flat on the bed (bottom flange down, matching both
 * its assembled AND print position, docs/research.md "flat on the bed, core
 * upright"), so its transform is the identity. The top cap, however, is
 * built in the shared ASSEMBLY frame -- sitting on top of the core with its
 * joint boss/lugs/hooks pointing DOWN into the core's bore -- which would
 * need supports if printed as-is; its transform flips it upside-down (so
 * the joint features point up, unsupported) and lands it on the bed.
 */
export interface RigidTransform {
  /** Rotation about the X axis, radians (0 or Math.PI in practice). */
  rotateX: number;
  /** Translation applied AFTER rotation, mm. */
  translate: [number, number, number];
}

/**
 * A named, printable part of the design (issue #9: "the design gets a
 * separate top cap"). Every part's `mesh` is manifold and shares ONE
 * coordinate frame -- the assembled scene (the core's own build frame,
 * flange at the bottom, cap's underside meeting the core's top at
 * z=solution.height) -- so the viewer can draw every part together with no
 * per-part repositioning, and the exploded view is just a Z translation of
 * the non-core parts. Only `printTransform` differs per part.
 */
export interface Part {
  name: string;
  role: PartRole;
  mesh: CoilMesh;
  printTransform: RigidTransform;
}

/** A section of SKÅDIS board, placed where the clip mount plate hangs on it (issue #106, `Design.pegboard`). */
export interface PegboardSection {
  /** Slot centres, in the flange plane (the same (x, y) frame as every part's mesh). */
  slots: Array<{ x: number; y: number }>;
  slotWidth: number;
  /** End to end, along the slot's own axis. */
  slotLength: number;
  thickness: number;
  /** The board's front face (against the plate's back face), in the assembly frame's z; the board extends toward more-negative z by `thickness`. */
  frontZ: number;
  /** Every slot runs along up = (sin, cos) of this angle (the plate layout's `axisDeg`, the same as `Design.mountAxisDeg`). */
  axisDeg: number;
}

/** The solved coil, ready to render or export. */
export interface Design {
  spec: CoilSpec;
  solution: Solution;
  /** Non-fatal notices about the solved design (solver + geometry). */
  warnings: string[];
  /** Every printable part (issue #9): always includes the core (wall +
   * integral bottom flange); a topCap part is appended when
   * `solution.topCapEnabled`. */
  parts: Part[];
  /** Trivial derived convenience: `parts.find(p => p.role === "core").mesh`.
   * Kept because most existing analysis (volume/manifoldness checks, the
   * golden-numbers regression) only ever cared about the core body; new
   * code that needs every part should use `parts` directly. */
  mesh: CoilMesh;
  /** The resolution every part's mesh was built at (issue #7). The
   * orchestration layer gates exports on `resolution === "final"` -- exports
   * must always use the final resolution, never a still-in-progress draft. */
  resolution: Resolution;
  /** The schematic wound-cable path per layer (issue #4), one entry per
   * layer with turns > 0. Empty layers (turns === 0) are omitted. */
  wirePaths: WireLayerPath[];
  /** The exact wall and flange parameters used to build the core part, kept
   * so the STEP exporter can fit its B-spline from the same grid (see
   * `step/build.ts` and `wall.ts`'s `createWallProfile`). Not for UI use. */
  wallSpec: WallSpec;
  flangeSpec: FlangeSpec;
  /**
   * The `bestAxisDeg` theta the wall mount's own features are actually
   * centred/mirrored on: the screw-keyhole mount's slot(s) (issue #13), or
   * (issue #14) the clip mount plate's column layout (undefined when
   * `spec.mount` is `"none"`, or the mount didn't fit at all). Not always 0
   * -- see mount.ts's `MountLayout` doc comment: a shape without a genuine
   * mirror axis at literal vertical (a triangle) still hangs level, just
   * with THIS axis vertical instead of local +Y. The viewer's wall presets
   * rotate by this to actually show that real hung orientation, rather
   * than the design's own local frame.
   */
  mountAxisDeg?: number;
  /**
   * Issue #106: the SKÅDIS board section the clip mount plate hangs on,
   * with the clips seated in their slots (slot centres in the flange plane,
   * the board's front face against the plate's back face) -- for drawing
   * the slot grid against the clips. Undefined unless `spec.mount` is
   * `"skadis"` and a plate was built.
   */
  pegboard?: PegboardSection;
  /**
   * The inner-end lead-in (issues #8, #115, #117): from the cable's free
   * end past the bottom flange's rim, through the clip and the recessed
   * channel (level), along the straight tangential chord and its gentle
   * rise out of the channel, to layer 1's own first sample (`wirePaths[0]`)
   * -- xyz per sample. Empty when layer 1 has no turns.
   */
  innerEndLeadIn: Float32Array;
  /** Issue #117: the inner end's clip in the bottom flange -- the cable centre where its gripping lips start (`from`) and end (`to`, nearer the rim). */
  innerEndClip: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number } };
  /**
   * The cable's run from the chronological end of each wound layer to the
   * start of the next (issues #68, #115): `layerTransitions[i]` joins
   * `wirePaths[i]` to `wirePaths[i + 1]`, so `wirePaths.length - 1` entries,
   * each sharing its first/last sample and tangent with the layers it joins.
   * Empty when fewer than 2 layers have turns.
   */
  layerTransitions: Float32Array[];
  /**
   * The outer end (issues #68, #115), from the last wound layer's own end:
   * with the top cap on, the run up to just under the cap, on through the
   * cap's clip (`capClip`) and out past the rim; with it off, a straight
   * free tail along the last turn's tangent. Empty when no layer has any
   * turns.
   */
  outerEndLeadOut: Float32Array;
  /**
   * The whole drawn cable as ONE continuous polyline (issue #115):
   * `innerEndLeadIn`, then each of `wirePaths` with the `layerTransitions`
   * between them, then `outerEndLeadOut`, joined end to end (each join's
   * shared sample kept once). G1 throughout, and its curvature stays within
   * 1/(minimum bend radius). Empty when no layer has any turns.
   */
  cablePath: Float32Array;
  /**
   * The top cap's cable clip (issue #117, innerEnd.ts's `layoutCapClip`):
   * laid out where the cable's cap lead-out ends. Undefined when the top cap
   * is off. Not for UI use (the STEP backend builds the same clip from it).
   */
  capClip?: CapClipLayout;
}

export type ExportFormat = "stl" | "step" | "3mf";

/**
 * Mesh detail level (issue #7): `"draft"` is fast and coarse, for instant
 * feedback while editing; `"final"` is the tuned-for-FDM resolution used
 * once input settles, and always for exports. `design()` defaults to
 * `"final"` so every existing caller (tests, exports) is unaffected.
 */
export type Resolution = "draft" | "final";
