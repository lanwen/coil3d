// Public types for the headless coil core. See docs/research.md for the
// full domain model. Issue #5 implemented the full lock/free solver for a
// round core; issue #6 adds the rounded-square and rounded-triangle shape
// plugins (see ShapeKind/ShapeSpec below and shapes.ts).

import type { WallSpec } from "./wall";
import type { FlangeSpec } from "./manifold";

export type { ShapeKind } from "./shapes";

/**
 * What the user controls about the core's cross-section. Round has no extra
 * params (it's always fully round); sq/tri carry a corner radius, namespaced
 * in the hash as `sq.rc`/`tri.rc` (docs/research.md §7, §2 "Shape plugins").
 * The solver clamps `cornerRadius` into the bend-limit-derived range each
 * time it solves (solve.ts); this field is the user's un-clamped request.
 */
export type ShapeSpec = { kind: "round" } | { kind: "sq"; cornerRadius: number } | { kind: "tri"; cornerRadius: number };

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
  flangeSize: number;
  capsAuto: boolean;
  minOuterSizeForBend: number;
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

/** The solved coil, ready to render or export. */
export interface Design {
  spec: CoilSpec;
  solution: Solution;
  /** Non-fatal notices about the solved design (solver + geometry). */
  warnings: string[];
  mesh: CoilMesh;
  /** The resolution `mesh` was built at (issue #7). The orchestration layer
   * gates exports on `resolution === "final"` -- exports must always use the
   * final resolution, never a still-in-progress draft. */
  resolution: Resolution;
  /** The schematic wound-cable path per layer (issue #4), one entry per
   * layer with turns > 0. Empty layers (turns === 0) are omitted. */
  wirePaths: WireLayerPath[];
  /** The exact wall and flange parameters used to build `mesh`, kept so the
   * STEP exporter can fit its B-spline from the same grid (see
   * `step/build.ts` and `wall.ts`'s `createWallProfile`). Not for UI use. */
  wallSpec: WallSpec;
  flangeSpec: FlangeSpec;
}

export type ExportFormat = "stl" | "step";

/**
 * Mesh detail level (issue #7): `"draft"` is fast and coarse, for instant
 * feedback while editing; `"final"` is the tuned-for-FDM resolution used
 * once input settles, and always for exports. `design()` defaults to
 * `"final"` so every existing caller (tests, exports) is unaffected.
 */
export type Resolution = "draft" | "final";
