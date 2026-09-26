// Build-plate math shared by the per-part bed-fit warnings (design.ts), the
// STL exporter (export.ts) and the 3MF plate layout (threeMf.ts) -- issue
// #10, docs/research.md §1 "Print"/"bed size", "Out of scope": "Automatic
// part splitting or plate arrangement beyond placing parts side by side;
// the bed size only triggers a warning."
//
// `printBBox` reads each part in ITS OWN print orientation (printTransform,
// types.ts) -- the same transform already used for STL export (transform.ts)
// -- so "does this part fit the bed" and "where does it sit on the plate"
// both agree with what actually prints.

import { PLATE_GAP } from "./constants";
import { applyRigidTransform } from "./transform";
import type { CoilMesh, Part, PrintSpec, RigidTransform } from "./types";

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
 * `part.printTransform` with its Z translation corrected so the part's own
 * min Z lands at EXACTLY 0 -- i.e. the transform that actually rests the
 * part on the bed, as opposed to `printTransform` alone (issue #10 review:
 * PR #31 originally used `printTransform` as-is for both STL and 3MF and
 * assumed that was enough; it isn't).
 *
 * `printTransform` only orients each part (rotate + a fixed translate baked
 * in at design() time, types.ts) -- it does not promise the result's min Z
 * is 0. That happens to hold for the top cap (its print-orientation flip is
 * derived from `solution.height`, which cancels out), but NOT for the core:
 * the core's own mesh has its bottom flange a few mm below the wall's own
 * z=0 origin (FLANGE_THICKNESS, constants.ts), and the core's
 * `printTransform` is the identity, so using it as-is would sit the core a
 * few mm below the plate.
 *
 * Every exporter that places a part on a real bed (STL: export.ts, 3MF:
 * threeMf.ts) must go through THIS function rather than re-deriving its own
 * Z offset, so they can't independently drift on what "resting on the bed"
 * means.
 */
export function bedRestingTransform(part: Part): RigidTransform {
  const box = printBBox(part);
  const [tx, ty, tz] = part.printTransform.translate;
  return { rotateX: part.printTransform.rotateX, translate: [tx, ty, tz - box.minZ] };
}

/**
 * Per-part [dx, dy] offsets (mm) to ADD to each part's own
 * (already bed-resting, see `bedRestingTransform`) translation: places every
 * part's already-print-oriented footprint side by side along X with a fixed
 * gap, and centers the whole row on the bed. X/Y sizing reads `printBBox`
 * (unaffected by `bedRestingTransform`'s Z-only correction) -- Z itself is
 * `bedRestingTransform`'s concern, not this function's.
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

export interface PartPlacement {
  part: Part;
  /** `bedRestingTransform` composed with `layoutParts`' own X/Y offset: the exact transform that places this part on the shared plate. */
  transform: RigidTransform;
}

/**
 * Every part's final print-bed transform (issue #78): `bedRestingTransform`
 * (each part resting on its own min Z) composed with `layoutParts`' X/Y
 * offset (laid out side by side on `bed`). The ONE function both the 3MF
 * writer (threeMf.ts) and the viewer's print-layout view call, so "where a
 * part sits" can never independently drift between the export and the
 * on-screen preview (issue #78 AC: "3MF placement and view placement
 * agree").
 */
export function printPlacements(parts: Part[], bed: PrintSpec): PartPlacement[] {
  const offsets = layoutParts(parts, bed);
  return parts.map((part, i) => {
    const [ox, oy] = offsets[i];
    const resting = bedRestingTransform(part);
    return {
      part,
      transform: { rotateX: resting.rotateX, translate: [resting.translate[0] + ox, resting.translate[1] + oy, resting.translate[2]] },
    };
  });
}
