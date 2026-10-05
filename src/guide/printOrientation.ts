import type { CoilMesh, Part, RigidTransform } from "../core";

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
  return { positions: out, indices: mesh.indices, rimTriangles: mesh.rimTriangles, fadeTriangles: mesh.fadeTriangles };
}

export function partInPrintPose(part: Part): Part {
  return {
    name: part.name,
    role: "core",
    mesh: applyPrintTransform(part.mesh, part.printTransform),
    printTransform: { rotateX: 0, translate: [0, 0, 0] },
  };
}
