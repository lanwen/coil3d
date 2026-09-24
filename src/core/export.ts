// The core's single export entry point. `stl` is synchronous under the
// hood but returned as a Promise for a uniform async interface; `step`
// genuinely is async (it lazy-loads replicad, in a Worker in the browser —
// see step/index.ts — so the ~5 MB WASM is never fetched on initial load).

import { writeBinaryStl } from "./stl";
import type { Design, ExportFormat } from "./types";

export async function exportDesign(design: Design, format: ExportFormat): Promise<Uint8Array<ArrayBuffer>> {
  if (format === "stl") return writeBinaryStl(design.mesh);
  if (format === "step") {
    const { exportStep } = await import("./step");
    return exportStep(design);
  }
  throw new Error(`Unsupported export format: ${format satisfies never}`);
}
