import type { CoilMesh } from "./types";

const STL_HEADER_BYTES = 80;
const STL_TRIANGLE_COUNT_BYTES = 4;
const STL_TRIANGLES_OFFSET = STL_HEADER_BYTES + STL_TRIANGLE_COUNT_BYTES;
const STL_TRIANGLE_BYTES = 50;

export function writeBinaryStl(mesh: CoilMesh, name = "coil3d"): Uint8Array<ArrayBuffer> {
  const { positions: v, indices: t } = mesh;
  const triCount = t.length / 3;
  const buf = new ArrayBuffer(STL_TRIANGLES_OFFSET + triCount * STL_TRIANGLE_BYTES);
  const dv = new DataView(buf);

  const header = new TextEncoder().encode(name.padEnd(STL_HEADER_BYTES, "\0").slice(0, STL_HEADER_BYTES));
  new Uint8Array(buf, 0, STL_HEADER_BYTES).set(header);
  dv.setUint32(STL_HEADER_BYTES, triCount, true);

  let off = STL_TRIANGLES_OFFSET;
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
    off += STL_TRIANGLE_BYTES;
  }

  return new Uint8Array(buf);
}
