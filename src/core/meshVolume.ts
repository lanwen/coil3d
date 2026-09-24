// Volume of a closed, consistently-oriented triangle mesh, by the
// divergence theorem (sum of signed tetrahedron volumes from the origin).
// Used to validate a STEP solid's volume against the mesh it was derived
// from (S2 RESULT.md: "every export must check solid count and volume").

import type { CoilMesh } from "./types";

export function meshVolume(mesh: CoilMesh): number {
  const { positions: v, indices: t } = mesh;
  let volume = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const c = t[i + 2] * 3;
    const ax = v[a];
    const ay = v[a + 1];
    const az = v[a + 2];
    const bx = v[b];
    const by = v[b + 1];
    const bz = v[b + 2];
    const cx = v[c];
    const cy = v[c + 1];
    const cz = v[c + 2];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(volume);
}
