import type { CoilMesh, RigidTransform } from "./types";

export function applyRigidTransform(mesh: CoilMesh, t: RigidTransform): CoilMesh {
  const { positions } = mesh;
  const cosX = Math.cos(t.rotateX);
  const sinX = Math.sin(t.rotateX);
  const cosZ = Math.cos(t.rotateZ ?? 0);
  const sinZ = Math.sin(t.rotateZ ?? 0);
  const [dx, dy, dz] = t.translate;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x0 = positions[i];
    const y0 = positions[i + 1];
    const z = positions[i + 2];
    const x = x0 * cosZ - y0 * sinZ;
    const y = x0 * sinZ + y0 * cosZ;
    out[i] = x + dx;
    out[i + 1] = y * cosX - z * sinX + dy;
    out[i + 2] = y * sinX + z * cosX + dz;
  }
  return { positions: out, indices: mesh.indices };
}
