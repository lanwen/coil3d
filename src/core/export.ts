// The core's single export entry point. `stl` is synchronous under the
// hood but returned as a Promise for a uniform async interface; `step`
// genuinely is async (it lazy-loads replicad, in a Worker in the browser —
// see step/index.ts — so the ~5 MB WASM is never fetched on initial load).
//
// STL, one part vs. several (issue #9): a single-part design (no top cap)
// still downloads one plain .stl, unchanged from before this ticket. Once
// there's more than one part, this zips one .stl per part (each already in
// ITS OWN print-bed orientation, via `applyRigidTransform`) into one
// download rather than adding a per-part download button for every part --
// simpler for callers (one button, one file either way; see App.tsx) and
// keeps the new UI surface small for the parallel controls/CSS rewrite
// (#28) to restyle. Consumers tell the two apart by extension/part count
// (`design.parts.length`), matching how the UI already names the STEP file.
//
// Every part is placed with `plate.ts`'s `bedRestingTransform`, not
// `part.printTransform` directly (issue #10 review: a plain `printTransform`
// does not promise the part's min Z is 0 -- see that function's doc
// comment) -- 3mf.ts uses the exact same function, so STL and 3MF can never
// independently drift on what "resting on the bed" means.
//
// `3mf` (issue #10) is the one-file-for-everything alternative to the STL
// zip: one object + one plate-placed build item per part, all in one
// download. See threeMf.ts.

import { bedRestingTransform } from "./plate";
import { applyRigidTransform } from "./transform";
import { writeBinaryStl } from "./stl";
import { write3mf } from "./threeMf";
import { writeZip } from "./zip";
import type { Design, ExportFormat } from "./types";

export async function exportDesign(design: Design, format: ExportFormat): Promise<Uint8Array<ArrayBuffer>> {
  if (format === "stl") {
    if (design.parts.length === 1) {
      const part = design.parts[0];
      return writeBinaryStl(applyRigidTransform(part.mesh, bedRestingTransform(part)), part.name);
    }
    return writeZip(
      design.parts.map((part) => ({
        name: `${part.name}.stl`,
        data: writeBinaryStl(applyRigidTransform(part.mesh, bedRestingTransform(part)), part.name),
      })),
    ) as Uint8Array<ArrayBuffer>;
  }
  if (format === "3mf") {
    return write3mf(design);
  }
  if (format === "step") {
    const { exportStep } = await import("./step");
    return exportStep(design);
  }
  throw new Error(`Unsupported export format: ${format satisfies never}`);
}
