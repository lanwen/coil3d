import * as THREE from "three";

export type BarPresetId = "front" | "iso" | "wallRoom" | "mountSide" | "printLayout";
export type FaceId = "cap" | "base";
export type FacePresetId = "capTop" | "baseBottom";
export type PresetId = BarPresetId | FacePresetId;

interface ViewPreset<Id extends PresetId = PresetId> {
  id: Id;
  label: string;
  direction: THREE.Vector3;
  upHint: THREE.Vector3;
}

const ISO_DIR = new THREE.Vector3(1, -1, 0.9).normalize();

export const VIEW_PRESETS: ViewPreset<BarPresetId>[] = [
  { id: "front", label: "Front", direction: new THREE.Vector3(0, -1, 0), upHint: new THREE.Vector3(0, 0, 1) },
  { id: "iso", label: "Iso", direction: ISO_DIR, upHint: new THREE.Vector3(0, 0, 1) },
  { id: "wallRoom", label: "Wall mount", direction: ISO_DIR, upHint: new THREE.Vector3(0, 0, 1) },
  { id: "mountSide", label: "Mount side", direction: ISO_DIR, upHint: new THREE.Vector3(0, 0, 1) },
  { id: "printLayout", label: "Print layout", direction: ISO_DIR, upHint: new THREE.Vector3(0, 0, 1) },
];

const FACE_PRESETS: ViewPreset<FacePresetId>[] = [
  { id: "capTop", label: "Cap", direction: new THREE.Vector3(0, 0, 1), upHint: new THREE.Vector3(0, 1, 0) },
  { id: "baseBottom", label: "Base", direction: new THREE.Vector3(0, 0, -1), upHint: new THREE.Vector3(0, 1, 0) },
];

export const FACE_PRESET_ID: Record<FaceId, FacePresetId> = { cap: "capTop", base: "baseBottom" };

const byId = new Map<PresetId, ViewPreset>([...VIEW_PRESETS, ...FACE_PRESETS].map((p) => [p.id, p]));

export function getPreset(id: PresetId): ViewPreset {
  const preset = byId.get(id);
  if (!preset) throw new Error(`unknown view preset: ${id}`);
  return preset;
}

const quaternionCache = new Map<PresetId, THREE.Quaternion>();

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

export function directionAndUpOf(quaternion: THREE.Quaternion): { direction: THREE.Vector3; up: THREE.Vector3 } {
  return {
    direction: new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize(),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize(),
  };
}
