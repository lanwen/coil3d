// Print-layout view (issue #78): "every part in its print orientation ...
// laid out on a drawn bed outline". Every part's placement comes from the
// core's own `printPlacements` (plate.ts's `bedRestingTransform` +
// `layoutParts`) -- the SAME function the 3MF writer (threeMf.ts) calls --
// so this view and the exported plate can never disagree about where a part
// actually sits (issue #78 AC). Pure geometry building, no React: CoilViewer.tsx
// creases each returned mesh with its own `buildCreasedGeometry` (shared with
// the assembled view) and disposes everything this module hands back. Part
// NAME labels are a separate concern (PrintLayoutLabels.tsx, issue #78 PR
// review), which reads this module's own `box` per part.

import * as THREE from "three";
import { printPlacements, type CoilMesh, type Part, type PrintSpec, type RigidTransform } from "../core";

/**
 * `RigidTransform` applied directly to vertex positions (rotate about X,
 * then translate) -- the same trivial math `core/transform.ts`'s
 * `applyRigidTransform` does. Reimplemented here, not imported, because that
 * module is a core INTERNAL the UI may not reach into (architecture rule:
 * "the UI and renderer use only [the core's public] interface" -- see
 * `src/guide/printOrientation.ts`'s own copy, which this mirrors); only
 * `plate.ts`'s actual placement math (`printPlacements`, non-trivial enough
 * that reimplementing it risks drifting from the 3MF export) is worth a
 * shared, exported function.
 */
function applyPrintTransform(mesh: CoilMesh, t: RigidTransform): CoilMesh {
  const { positions } = mesh;
  const cos = Math.cos(t.rotateX);
  const sin = Math.sin(t.rotateX);
  const cz = Math.cos(t.rotateZ ?? 0);
  const sz = Math.sin(t.rotateZ ?? 0);
  const [dx, dy, dz] = t.translate;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x0 = positions[i];
    const y0 = positions[i + 1];
    const z = positions[i + 2];
    const x = x0 * cz - y0 * sz;
    const y = x0 * sz + y0 * cz;
    out[i] = x + dx;
    out[i + 1] = y * cos - z * sin + dy;
    out[i + 2] = y * sin + z * cos + dz;
  }
  // Issue #229: the rim's chamfer stays out of the drawing in the printed pose too.
  return { positions: out, indices: mesh.indices, rimTriangles: mesh.rimTriangles };
}

export interface PrintLayoutPart {
  part: Part;
  /** Print-placed mesh (world = bed mm), ready for `buildCreasedGeometry`. */
  mesh: CoilMesh;
  /** This part's own footprint + height box, world/bed mm -- PrintLayoutLabels' own callout anchor. */
  box: THREE.Box3;
  /** The exact `printPlacements` transform this part was placed with -- mirrored as accessible text by CoilViewer (like DimensionAxes' own hidden list) so e2e coverage can confirm it against the 3MF export's own item transform, without re-deriving it from pixels (issue #78 AC: "view and 3MF agree"). */
  transform: RigidTransform;
}

/** Every part in its exact print-bed placement (issue #78), plus the whole
 * layout's own bounds (bed footprint union part heights) for framing and
 * for PrintLayoutLabels' own shared callout row. */
export function buildPrintLayout(parts: Part[], bed: PrintSpec): { parts: PrintLayoutPart[]; bounds: THREE.Box3 } {
  const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(bed.bedX, bed.bedY, 0));

  const placed = printPlacements(parts, bed).map(({ part, transform }) => {
    const mesh = applyPrintTransform(part.mesh, transform);
    const { positions } = mesh;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]);
      maxX = Math.max(maxX, positions[i]);
      minY = Math.min(minY, positions[i + 1]);
      maxY = Math.max(maxY, positions[i + 1]);
      maxZ = Math.max(maxZ, positions[i + 2]);
    }
    bounds.expandByPoint(new THREE.Vector3(minX, minY, 0));
    bounds.expandByPoint(new THREE.Vector3(maxX, maxY, maxZ));
    const box = new THREE.Box3(new THREE.Vector3(minX, minY, 0), new THREE.Vector3(maxX, maxY, maxZ));
    return { part, mesh, box, transform };
  });

  return { parts: placed, bounds };
}

// A thin drawn slab, never printed/exported -- just the "drawn bed outline"
// the AC asks for, sized to the configured bed and level with every part's
// own resting Z (0, see `printPlacements`/`bedRestingTransform`).
const BED_THICKNESS = 1; // mm

/** A flat rectangle the size of the configured print bed, top face at z=0. */
export function buildBedGeometry(bed: PrintSpec): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(bed.bedX, bed.bedY, BED_THICKNESS);
  geometry.translate(bed.bedX / 2, bed.bedY / 2, -BED_THICKNESS / 2);
  return geometry;
}
