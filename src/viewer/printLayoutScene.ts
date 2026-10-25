
import * as THREE from "three";
import { printPlacements, type CoilMesh, type Part, type PrintSpec, type RigidTransform } from "../core";

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

interface PrintLayoutPart {
  part: Part;
  mesh: CoilMesh;
  box: THREE.Box3;
  transform: RigidTransform;
}

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

const BED_THICKNESS_MM = 1;

export function buildBedGeometry(bed: PrintSpec): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(bed.bedX, bed.bedY, BED_THICKNESS_MM);
  geometry.translate(bed.bedX / 2, bed.bedY / 2, -BED_THICKNESS_MM / 2);
  return geometry;
}
