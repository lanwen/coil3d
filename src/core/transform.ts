// Applies a Part's printTransform (issue #9) to its mesh: a rotation about
// X (0 or Math.PI in practice -- flips a part upside-down for printing),
// then a translation. Used only by the STL exporter (export.ts); the STEP
// exporter and the viewer both use parts' meshes as-is, in the shared
// assembly frame -- see types.ts's RigidTransform.

import type { CoilMesh, RigidTransform } from "./types";

export function applyRigidTransform(mesh: CoilMesh, t: RigidTransform): CoilMesh {
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
