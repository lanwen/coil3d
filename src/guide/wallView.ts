// The screw-keyhole mount's real hung orientation (issue #17 review: "the
// coil's axis points out of the wall, the bottom flange sits flat against
// the wall, and the top cap faces the room" -- docs/design.md, Orientation, mount.ts's
// `WALL_UP`). The two fixed rotation matrices and the mountAxisDeg
// correction are the SAME ones CoilViewer.tsx's wall-mount presets use
// (issue #13); both now import the one shared definition from
// `../viewer/wallRotations` (issue #40) instead of each keeping its own
// copy, so the guide's wall step can never drift out of sync with the
// viewer's.
//
// The guide bakes the rotation directly into each part's OWN vertex
// positions (`rotateParts` below) rather than a wrapping transform, exactly
// like CoilViewer.tsx does and for the identical reason: the camera fit is
// computed from the geometry's own local vertex positions (`projection.ts`'s
// `computeGuideFit`, mirroring `LineArtRenderer.tsx`'s `computeFit`), which
// has no notion of a parent transform.

import * as THREE from "three";
import type { CoilMesh, Part } from "../core";
import { getPreset } from "../viewer/lineArt/presets";
import { WALL_MOUNT_VIEW_ROTATION, WALL_VIEW_ROTATION, withMountAxisCorrection } from "../viewer/wallRotations";

export function wallRoomRotation(mountAxisDeg: number | undefined): THREE.Matrix4 {
  return withMountAxisCorrection(WALL_VIEW_ROTATION, mountAxisDeg);
}

export function wallMountRotation(mountAxisDeg: number | undefined): THREE.Matrix4 {
  return withMountAxisCorrection(WALL_MOUNT_VIEW_ROTATION, mountAxisDeg);
}

/**
 * The coil seen from the side, as it hangs: up stays up, the coil's axis runs
 * left to right (the wall on the left, the room on the right) and the
 * camera looks along the board's width. Built from the guide camera's own
 * basis (the same one `wallMountRotation` is derived from), so it can't drift
 * from what `GuideFigure` renders.
 */
export function wallSideRotation(mountAxisDeg: number | undefined): THREE.Matrix4 {
  const { direction, upHint } = getPreset("iso");
  const camera = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), upHint);
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const back = new THREE.Vector3();
  camera.extractBasis(right, up, back);
  // local +X (along the board) -> into the screen, +Y (up) -> screen up, +Z (the axis) -> screen right.
  return withMountAxisCorrection(new THREE.Matrix4().makeBasis(back.clone().negate(), up, right), mountAxisDeg);
}

/** `parts`, with every vertex transformed by `rotation` -- the guide's own version of CoilViewer.tsx's "rotate the geometry, not a wrapping group" (its own comment explains why: the camera fit reads local vertex positions directly). */
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

/** A single world point transformed by `rotation` -- for placing a schematic anchor (the approximate screw position) in the SAME rotated frame `rotateParts` puts the mesh in. */
export function rotatePoint(point: THREE.Vector3, rotation: THREE.Matrix4): THREE.Vector3 {
  return point.clone().applyMatrix4(rotation);
}
