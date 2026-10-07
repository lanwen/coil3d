import * as THREE from "three";
import type { CoilMesh, Part, WireLayerPath } from "../core";
import { getPreset } from "../viewer/lineArt/presets";
import { WALL_MOUNT_VIEW_ROTATION, WALL_VIEW_ROTATION, withMountAxisCorrection } from "../viewer/wallRotations";

export function wallRoomRotation(mountAxisDeg: number | undefined): THREE.Matrix4 {
  return withMountAxisCorrection(WALL_VIEW_ROTATION, mountAxisDeg);
}

export function wallMountRotation(mountAxisDeg: number | undefined): THREE.Matrix4 {
  return withMountAxisCorrection(WALL_MOUNT_VIEW_ROTATION, mountAxisDeg);
}

export function wallSideRotation(mountAxisDeg: number | undefined): THREE.Matrix4 {
  const { direction, upHint } = getPreset("iso");
  const camera = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), upHint);
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const back = new THREE.Vector3();
  camera.extractBasis(right, up, back);
  const alongBoardToIntoScreen = back.clone().negate();
  const coilAxisToScreenRight = right;
  return withMountAxisCorrection(new THREE.Matrix4().makeBasis(alongBoardToIntoScreen, up, coilAxisToScreenRight), mountAxisDeg);
}

export function rotateParts(parts: Part[], rotation: THREE.Matrix4): Part[] {
  return parts.map((part) => {
    const src = part.mesh.positions;
    const out = new Float32Array(src.length);
    const v = new THREE.Vector3();
    for (let i = 0; i < src.length; i += 3) {
      v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(rotation);
      out[i] = v.x;
      out[i + 1] = v.y;
      out[i + 2] = v.z;
    }
    return { ...part, mesh: { positions: out, indices: part.mesh.indices } as CoilMesh };
  });
}

export function rotatePoint(point: THREE.Vector3, rotation: THREE.Matrix4): THREE.Vector3 {
  return point.clone().applyMatrix4(rotation);
}

export function rotateWirePaths(paths: WireLayerPath[], rotation: THREE.Matrix4): WireLayerPath[] {
  const v = new THREE.Vector3();
  return paths.map((path) => {
    const out = new Float32Array(path.points.length);
    for (let i = 0; i < out.length; i += 3) {
      v.set(path.points[i], path.points[i + 1], path.points[i + 2]).applyMatrix4(rotation);
      out[i] = v.x;
      out[i + 1] = v.y;
      out[i + 2] = v.z;
    }
    return { ...path, points: out };
  });
}
