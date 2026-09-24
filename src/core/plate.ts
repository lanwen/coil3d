// Build-plate math shared by the per-part bed-fit warnings (design.ts) and
// the 3MF plate layout (threeMf.ts) -- issue #10, docs/research.md §1
// "Print"/"bed size", "Out of scope": "Automatic part splitting or plate
// arrangement beyond placing parts side by side; the bed size only
// triggers a warning."
//
// `printBBox` reads each part in ITS OWN print orientation (printTransform,
// types.ts) -- the same transform already used for STL export (transform.ts)
// -- so "does this part fit the bed" and "where does it sit on the plate"
// both agree with what actually prints.

import { PLATE_GAP } from "./constants";
import { applyRigidTransform } from "./transform";
import type { CoilMesh, Part, PrintSpec } from "./types";

export interface BBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export function meshBBox(mesh: CoilMesh): BBox {
  const { positions } = mesh;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/** A part's bounding box AFTER its own `printTransform` -- what actually sits on the bed, footprint and height alike. */
export function printBBox(part: Part): BBox {
  return meshBBox(applyRigidTransform(part.mesh, part.printTransform));
}

/**
 * Per-part [dx, dy] offsets (mm) to ADD to each part's own
 * `printTransform.translate`: places every part's already-print-oriented
 * footprint side by side along X with a fixed gap, and centers the whole
 * row on the bed. Z is never touched here -- resting on the bed (z=0) is
 * entirely `printTransform`'s concern (types.ts).
 */
export function layoutParts(parts: Part[], bed: PrintSpec): Array<[number, number]> {
  const boxes = parts.map(printBBox);
  const widths = boxes.map((b) => b.maxX - b.minX);
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + PLATE_GAP * Math.max(0, parts.length - 1);

  let cursor = -totalWidth / 2;
  return boxes.map((b, i) => {
    const dx = cursor - b.minX + bed.bedX / 2;
    const dy = -(b.minY + b.maxY) / 2 + bed.bedY / 2;
    cursor += widths[i] + PLATE_GAP;
    return [dx, dy];
  });
}
