// Public types for the headless coil core. See docs/research.md for the
// full domain model; this tracer-bullet slice only covers a round core,
// single layer (issue #2).

/** What the user controls. Round core only in this slice. */
export interface CoilSpec {
  /** Total cable length to store, mm. */
  wireLength: number;
  /** Cable outer diameter, mm. */
  wireDiameter: number;
  /** Core outer diameter (the winding surface), mm. */
  coreSize: number;
}

/** A triangle mesh as flat typed arrays (three.js / manifold-3d friendly). */
export interface CoilMesh {
  /** xyz per vertex. */
  positions: Float32Array;
  /** 3 indices per triangle. */
  indices: Uint32Array;
}

/** The solved coil, ready to render or export. */
export interface Design {
  spec: CoilSpec;
  /** Number of complete turns the single layer holds. */
  turns: number;
  /** Cable length actually wound onto the core, mm. */
  woundLength: number;
  /** Cable left over after the last complete turn, mm. */
  leftoverTail: number;
  /** Solved core height, mm. */
  height: number;
  /** Helical pitch (wireDiameter + clearance), mm. */
  pitch: number;
  /** Circumference at the wire's centerline, mm. */
  perimeter: number;
  outerRadius: number;
  boreRadius: number;
  /** Non-fatal notices about the solved design (e.g. degenerate inputs). */
  warnings: string[];
  mesh: CoilMesh;
}

export type ExportFormat = "stl";
