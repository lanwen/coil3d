// The headless coil core. This is the ONLY module the UI and renderer may
// import from -- its public interface is exactly parseHash/toHash,
// design(spec, resolution?) and exportDesign(design, fmt). No React, no
// three.js.
//
// design() itself never touches a Worker or the DOM -- it's plain,
// synchronous-under-the-hood business logic wrapped in a Promise. Running it
// off the main thread is an orchestration-layer concern (issue #7,
// src/geometry/), not this module's: the UI decides when to call it in a
// Worker and at which `resolution` ("draft" while editing, "final" once
// input settles and always for exports).
//
// exportDesign is async: "stl" resolves immediately, but "step" lazy-loads
// replicad (OpenCascade WASM), in a Web Worker in the browser (see
// core/step/index.ts), and only rejects/throws after failed validation.
// Supporting types and presets are exported too, so the UI can construct a
// well-typed CoilSpec; they carry no behaviour of their own.

export type {
  CoilMesh,
  CoilSpec,
  CoreSizeLock,
  Design,
  Diagnosis,
  ExportFormat,
  JointKind,
  LayerResult,
  Lock,
  Objective,
  Part,
  PartRole,
  PrintSpec,
  Resolution,
  RigidTransform,
  ShapeKind,
  ShapeSpec,
  Solution,
  TopCapMode,
  WireLayerPath,
  WireSpec,
  WireTypeId,
  WireTypePreset,
} from "./types";
export { DEFAULT_CUSTOM_BEND_MULTIPLIER, WIRE_TYPE_PRESETS } from "./types";
export { BED_SIZE_MAX, BED_SIZE_MIN, DEFAULT_BED_SIZE, DEFAULT_CORNER_RADIUS, DEFAULT_TOLERANCE, LABEL_MAX_LENGTH, TOLERANCE_MAX, TOLERANCE_MIN } from "./constants";
export { SHAPES } from "./shapes";
export type { ShapePlugin } from "./shapes";
export { parseHash, toHash, DEFAULT_SPEC, DEFAULT_SHOW_WIRE } from "./hash";
export type { ParsedHash } from "./hash";
export { design } from "./design";
export { exportDesign } from "./export";
