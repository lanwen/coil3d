import * as THREE from "three";

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

const LOCAL_X_TO_WORLD = WORLD_Y;
const LOCAL_WALL_UP_TO_WORLD = WORLD_Z;
const LOCAL_COIL_AXIS_TO_WORLD = WORLD_X;
const WALL_REMAP = new THREE.Matrix4().makeBasis(LOCAL_X_TO_WORLD, LOCAL_WALL_UP_TO_WORLD, LOCAL_COIL_AXIS_TO_WORLD);

const CAMERA_TILT_CORRECTION_RAD = -0.42285392613294076;
export const WALL_VIEW_ROTATION = new THREE.Matrix4().makeRotationX(CAMERA_TILT_CORRECTION_RAD).multiply(WALL_REMAP);

const LOCAL_X_TO_CAMERA_RIGHT = new THREE.Vector3(-Math.SQRT1_2, -Math.SQRT1_2, 0);
const LOCAL_WALL_UP_TO_CAMERA_UP = new THREE.Vector3(-0.37964208654863807, 0.37964208654863807, 0.84364908121919568);
const LOCAL_COIL_AXIS_TO_CAMERA_FORWARD = new THREE.Vector3(-0.59654998627189371, 0.59654998627189371, -0.53689498764470434);
export const WALL_MOUNT_VIEW_ROTATION = new THREE.Matrix4().makeBasis(LOCAL_X_TO_CAMERA_RIGHT, LOCAL_WALL_UP_TO_CAMERA_UP, LOCAL_COIL_AXIS_TO_CAMERA_FORWARD);

export function withMountAxisCorrection(base: THREE.Matrix4, mountAxisDeg: number | undefined): THREE.Matrix4 {
  if (!mountAxisDeg) return base.clone();
  const mountAxisRad = (mountAxisDeg * Math.PI) / 180;
  const correction = new THREE.Matrix4().makeRotationZ(mountAxisRad);
  return base.clone().multiply(correction);
}
