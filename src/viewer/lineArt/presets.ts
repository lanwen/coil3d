// Preset camera views (issue #15): front/side/top match a standard assembly
// manual's orthogonal views; iso is the existing 3/4 "assembly manual" look
// LineArtRenderer always used before this ticket. Each preset is just a unit
// "direction" (from the orbit target toward the camera) plus an "up hint"
// used to resolve roll -- pure data, no THREE.Camera involved, so it can be
// slerped (see presetQuaternion) without touching any live camera object.

import * as THREE from "three";

export type PresetId = "front" | "side" | "top" | "iso" | "wallRoom" | "wallMount";

export interface ViewPreset {
  id: PresetId;
  label: string;
  /** Unit vector from the orbit target to the camera. */
  direction: THREE.Vector3;
  /** Resolves roll for `direction`; must not be parallel to it (top's own
   * direction is the world-up axis, so it needs a different hint). */
  upHint: THREE.Vector3;
}

// The pre-#15 fixed view (docs/research.md §10b): the coil stands on its
// flange (z up), seen from about 32 degrees above so the open top end and
// the bore show.
const ISO_DIR = new THREE.Vector3(1, -1, 0.9).normalize();

export const VIEW_PRESETS: ViewPreset[] = [
  { id: "front", label: "Front", direction: new THREE.Vector3(0, -1, 0), upHint: new THREE.Vector3(0, 0, 1) },
  { id: "side", label: "Side", direction: new THREE.Vector3(1, 0, 0), upHint: new THREE.Vector3(0, 0, 1) },
  { id: "top", label: "Top", direction: new THREE.Vector3(0, 0, 1), upHint: new THREE.Vector3(0, 1, 0) },
  { id: "iso", label: "Iso", direction: ISO_DIR, upHint: new THREE.Vector3(0, 0, 1) },
  // Wall-mount views (issue #13): CoilViewer.tsx rotates the GEOMETRY itself
  // into its as-mounted orientation for these two (not the camera -- see its
  // own WALL_VIEW_ROTATION/WALL_MOUNT_VIEW_ROTATION comments), built assuming
  // the camera is sitting exactly at this fixed iso direction/up -- so both
  // wall presets reuse it verbatim rather than defining their own. Selecting
  // one from this bar just slerps the camera back to iso (a no-op if it's
  // already there) while CoilViewer swaps in the rotated geometry.
  { id: "wallRoom", label: "Wall mount (room side)", direction: ISO_DIR, upHint: new THREE.Vector3(0, 0, 1) },
  { id: "wallMount", label: "Wall mount (mount side)", direction: ISO_DIR, upHint: new THREE.Vector3(0, 0, 1) },
];

const byId = new Map(VIEW_PRESETS.map((p) => [p.id, p]));

export function getPreset(id: PresetId): ViewPreset {
  const preset = byId.get(id);
  if (!preset) throw new Error(`unknown view preset: ${id}`);
  return preset;
}

// Cached per id (the presets are fixed data, so this is computed once and
// reused for every slerp -- see LineArtRenderer's preset transition).
const quaternionCache = new Map<PresetId, THREE.Quaternion>();

/**
 * The orientation a camera would have looking from `preset.direction`
 * (a unit vector, from the orbit target toward the camera) at the origin,
 * with `preset.upHint` resolving roll. `THREE.Matrix4.lookAt` only needs
 * `upHint` to not be parallel to `direction`; it orthogonalizes the rest,
 * so the resulting quaternion's own local +Y IS the camera's real up.
 */
export function presetQuaternion(id: PresetId): THREE.Quaternion {
  let quaternion = quaternionCache.get(id);
  if (!quaternion) {
    const preset = getPreset(id);
    const matrix = new THREE.Matrix4().lookAt(preset.direction, new THREE.Vector3(0, 0, 0), preset.upHint);
    quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
    quaternionCache.set(id, quaternion);
  }
  return quaternion;
}

/** A camera orientation's view direction (target -> camera) and up, both derived from a quaternion (local +Z and +Y respectively -- see presetQuaternion). */
export function directionAndUpOf(quaternion: THREE.Quaternion): { direction: THREE.Vector3; up: THREE.Vector3 } {
  return {
    direction: new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize(),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize(),
  };
}
