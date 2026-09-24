// A part's own print-bed orientation, for the guide's "print the parts" step
// (issue #17). `Part.printTransform` (a public `RigidTransform`, core/types.ts)
// is exactly what the STL exporter applies before writing a part to disk
// (src/core/transform.ts's `applyRigidTransform`) -- but that module is a
// core INTERNAL (not re-exported by src/core/index.ts), so the UI may not
// import it (architecture rule: "the UI and renderer use only [the core's]
// interface"). `RigidTransform`/`CoilMesh` themselves ARE public types, and
// applying one is a trivial, self-contained transform -- reimplementing it
// here (rather than reaching into src/core/transform.ts) keeps the guide on
// the public seam, the same way CoilViewer/CoilScene independently compute
// their own vertex-level bounds (zExtent) instead of importing a core helper.

import type { CoilMesh, Part, RigidTransform } from "../core";

function applyPrintTransform(mesh: CoilMesh, t: RigidTransform): CoilMesh {
  const { positions } = mesh;
  const cos = Math.cos(t.rotateX);
  const sin = Math.sin(t.rotateX);
  const [dx, dy, dz] = t.translate;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    out[i] = x + dx;
    out[i + 1] = y * cos - z * sin + dy;
    out[i + 2] = y * sin + z * cos + dz;
  }
  return { positions: out, indices: mesh.indices };
}

/** `part`, transformed into its own print-bed pose, as a standalone part ready to hand to `GuideFigure` on its own (no siblings, no explode). */
export function partInPrintPose(part: Part): Part {
  return {
    name: part.name,
    role: "core", // standalone in its own figure -- never lifted by CoilScene's exploded-view logic
    mesh: applyPrintTransform(part.mesh, part.printTransform),
    printTransform: { rotateX: 0, translate: [0, 0, 0] },
  };
}
