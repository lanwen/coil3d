// Preset camera views: issue #15 originally shipped front/side/top/iso plus
// two wall-mount presets; issue #49 trimmed the interactive viewer's own
// preset bar down to just Front, Iso and Wall mount (the room-side hung
// view -- see `ViewControls`), dropping side/top and the mount-side
// ("what the wall sees") wall preset entirely from that surface. The
// assembly guide never used side/top/wallMount either (it only ever reads
// "iso" here, see `Guide.tsx`/`GuideFigure`), and its OWN mount-side inset
// (`guide/wallView.ts`) builds its rotation directly from
// `wallRotations.ts`'s `WALL_MOUNT_VIEW_ROTATION`, entirely independent of
// this module -- so removing the interactive viewer's mount-side preset
// here doesn't touch it. Each remaining preset is just a unit "direction"
// (from the orbit target toward the camera) plus an "up hint" used to
// resolve roll -- pure data, no THREE.Camera involved, so it can be slerped
// (see presetQuaternion) without touching any live camera object.

import * as THREE from "three";

export type PresetId = "front" | "iso" | "wallRoom" | "mountSide" | "printLayout";

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
  { id: "iso", label: "Iso", direction: ISO_DIR, upHint: new THREE.Vector3(0, 0, 1) },
  // Wall mount (issue #13, trimmed to just this one hung/room-side view by
  // issue #49): CoilViewer.tsx rotates the GEOMETRY itself into its
  // as-mounted orientation (not the camera -- see WALL_VIEW_ROTATION's own
  // comment), built assuming the camera is sitting exactly at this fixed
  // iso direction/up -- so this reuses it verbatim rather than defining its
  // own. Selecting it from the bar just slerps the camera back to iso (a
  // no-op if it's already there) while CoilViewer swaps in the rotated
  // geometry.
  { id: "wallRoom", label: "Wall mount", direction: ISO_DIR, upHint: new THREE.Vector3(0, 0, 1) },
  // Print layout (issue #78): every part swaps to its own print-bed pose,
  // laid out flat on a drawn bed rectangle -- CoilViewer's own `viewMode`
  // (see that file's `buildPrintLayout`), not a rotation of the assembled
  // model, so this reuses the plain iso direction/up exactly like wallRoom
  // does, rather than a dedicated top-down camera (which would need its own
  // `upHint`, since `presetQuaternion`'s `lookAt` can't resolve roll from a
  // hint parallel to a purely-vertical direction -- see this file's own
  // header on the removed "top" preset).
  // Mount side (issue #106): the wall's own view of the clip mount plate,
  // face-on, with the SKÅDIS slot grid drawn in -- only offered while a
  // SKÅDIS plate exists (ViewControls' `showMountSide`). Like wallRoom, a
  // geometry rotation in CoilViewer (wallRotations.ts's
  // WALL_MOUNT_VIEW_ROTATION, derived for this same fixed iso camera).
  { id: "mountSide", label: "Mount side", direction: ISO_DIR, upHint: new THREE.Vector3(0, 0, 1) },
  { id: "printLayout", label: "Print layout", direction: ISO_DIR, upHint: new THREE.Vector3(0, 0, 1) },
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
