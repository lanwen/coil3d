// The headless coil core. This is the ONLY module the UI and renderer may
// import from — its public interface is exactly parseHash/toHash,
// design(spec) and exportDesign(design, fmt). No React, no three.js.

export type { CoilSpec, CoilMesh, Design, ExportFormat } from "./types";
export { parseHash, toHash, DEFAULT_SPEC } from "./hash";
export type { ParsedHash } from "./hash";
export { design } from "./design";
export { exportDesign } from "./stl";
