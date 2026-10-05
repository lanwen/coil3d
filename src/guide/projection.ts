import * as THREE from "three";
import type { CoilMesh, Part } from "../core";
import { getPreset, type PresetId } from "../viewer/lineArt/presets";

export const FIGURE_ASPECT = 4 / 3;

export interface GuideFit {
  inverse: THREE.Matrix4;
  center: THREE.Vector3;
  halfHeight: number;
  aspect: number;
}

function mergedPositions(parts: Part[]): Float32Array {
  const chunks = parts.map((p) => p.mesh.positions);
  const merged = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.length;
  }
  return merged;
}

export function computeGuideFit(parts: Part[], preset: PresetId, fill: number, aspect: number = FIGURE_ASPECT): GuideFit | null {
  const preset_ = getPreset(preset);
  const positions = mergedPositions(parts);
  if (positions.length === 0) return null;

  const sphere = new THREE.Sphere();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    v.set(positions[i], positions[i + 1], positions[i + 2]);
    box.expandByPoint(v);
  }
  box.getBoundingSphere(sphere);
  if (sphere.radius <= 0) return null;

  const rotation = new THREE.Matrix4().lookAt(preset_.direction, new THREE.Vector3(0, 0, 0), preset_.upHint);
  const inverse = rotation.clone().transpose();

  const bounds = new THREE.Box2();
  for (let i = 0; i < positions.length; i += 3) {
    v.set(positions[i], positions[i + 1], positions[i + 2]).sub(sphere.center).applyMatrix4(inverse);
    bounds.expandByPoint(new THREE.Vector2(v.x, v.y));
  }
  const mid = bounds.getCenter(new THREE.Vector2());
  const extent = bounds.getSize(new THREE.Vector2());
  const shift = new THREE.Vector3(mid.x, mid.y, 0).applyMatrix4(rotation);
  const halfHeight = Math.max(extent.y / 2, extent.x / 2 / aspect) / fill;

  return { inverse, center: sphere.center.clone().add(shift), halfHeight, aspect };
}

export function projectToFigure(fit: GuideFit, point: THREE.Vector3): { x: number; y: number } {
  const flat = point.clone().sub(fit.center).applyMatrix4(fit.inverse);
  const halfWidth = fit.halfHeight * fit.aspect;
  return { x: (flat.x / halfWidth + 1) / 2, y: (1 - flat.y / fit.halfHeight) / 2 };
}

export function projectRadius(fit: GuideFit, radius: number): number {
  return radius / (2 * fit.halfHeight);
}

export function meshZRange(mesh: CoilMesh): { minZ: number; maxZ: number } {
  let minZ = Infinity;
  let maxZ = -Infinity;
  const pos = mesh.positions;
  for (let i = 2; i < pos.length; i += 3) {
    if (pos[i] < minZ) minZ = pos[i];
    if (pos[i] > maxZ) maxZ = pos[i];
  }
  return { minZ, maxZ };
}

export function explodedParts(parts: Part[], exploded: boolean, explodeGap: number): Part[] {
  if (!exploded) return parts;
  return parts.map((part) => {
    if (part.role === "core") return part;
    const { minZ, maxZ } = meshZRange(part.mesh);
    const offset = Math.max(0, maxZ - minZ) + explodeGap;
    const positions = new Float32Array(part.mesh.positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = part.mesh.positions[i];
      positions[i + 1] = part.mesh.positions[i + 1];
      positions[i + 2] = part.mesh.positions[i + 2] + offset;
    }
    return { ...part, mesh: { positions, indices: part.mesh.indices } };
  });
}

export function meshBounds(mesh: CoilMesh): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const pos = mesh.positions;
  for (let i = 0; i < pos.length; i += 3) {
    v.set(pos[i], pos[i + 1], pos[i + 2]);
    box.expandByPoint(v);
  }
  return box;
}

export function partsBounds(parts: Part[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const part of parts) box.union(meshBounds(part.mesh));
  return box;
}

export function approxRimPoint(mesh: CoilMesh, heightFrac: number, sign: 1 | -1 = 1): THREE.Vector3 {
  const box = meshBounds(mesh);
  const targetZ = box.min.z + heightFrac * (box.max.z - box.min.z);
  const band = Math.max(0.5, (box.max.z - box.min.z) * 0.03);
  const pos = mesh.positions;
  let best: THREE.Vector3 | null = null;
  let bestX = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const z = pos[i + 2];
    if (Math.abs(z - targetZ) > band) continue;
    const x = sign * pos[i];
    if (x > bestX) {
      bestX = x;
      best = new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]);
    }
  }
  return best ?? new THREE.Vector3(sign * box.max.x, 0, targetZ);
}
