// The headless coil core. This is the ONLY module the UI and renderer may
// import from -- its public interface is exactly parseHash/toHash,
// design(spec) and exportDesign(design, fmt). No React, no three.js.
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
  LayerResult,
  Lock,
  Objective,
  ShapeKind,
  Solution,
  WireSpec,
  WireTypeId,
  WireTypePreset,
} from "./types";
export { DEFAULT_CUSTOM_BEND_MULTIPLIER, WIRE_TYPE_PRESETS } from "./types";
export { parseHash, toHash, DEFAULT_SPEC } from "./hash";
export type { ParsedHash } from "./hash";
export { design } from "./design";
export { exportDesign } from "./export";
