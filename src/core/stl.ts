// Binary STL writer. Format: 80-byte header, u32 triangle count, then per
// triangle: 3x f32 normal, 3x (3x f32 vertex), u16 attribute byte count.

import type { CoilMesh } from "./types";

export function writeBinaryStl(mesh: CoilMesh, name = "scroll3d"): Uint8Array<ArrayBuffer> {
  const { positions: v, indices: t } = mesh;
  const triCount = t.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);

  const header = new TextEncoder().encode(name.padEnd(80, "\0").slice(0, 80));
  new Uint8Array(buf, 0, 80).set(header);
  dv.setUint32(80, triCount, true);

  let off = 84;
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

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const wx = cx - ax;
    const wy = cy - ay;
    const wz = cz - az;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    dv.setFloat32(off, nx, true);
    dv.setFloat32(off + 4, ny, true);
    dv.setFloat32(off + 8, nz, true);
    dv.setFloat32(off + 12, ax, true);
    dv.setFloat32(off + 16, ay, true);
    dv.setFloat32(off + 20, az, true);
    dv.setFloat32(off + 24, bx, true);
    dv.setFloat32(off + 28, by, true);
    dv.setFloat32(off + 32, bz, true);
    dv.setFloat32(off + 36, cx, true);
    dv.setFloat32(off + 40, cy, true);
    dv.setFloat32(off + 44, cz, true);
    dv.setUint16(off + 48, 0, true);
    off += 50;
  }

  return new Uint8Array(buf);
}
