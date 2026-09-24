// The screw-keyhole mount's real hung orientation (issue #17 review: "the
// coil's axis points out of the wall, the bottom flange sits flat against
// the wall, and the top cap faces the room" -- docs/research.md, mount.ts's
// `WALL_UP`). Mirrors `CoilViewer.tsx`'s own `WALL_REMAP`/
// `WALL_VIEW_ROTATION`/`WALL_MOUNT_VIEW_ROTATION` verbatim, rather than
// importing them: those constants depend ONLY on `LineArtRenderer.tsx`'s
// fixed camera direction (`presets.ts`'s `ISO_DIR`), never on a particular
// design, so duplicating them here is exact and safe -- unlike CoilScene.tsx
// (see its own file header), this ticket doesn't need CoilViewer.tsx's
// live, per-design rotation selection, just these two fixed matrices.
//
// The guide bakes the rotation directly into each part's OWN vertex
// positions (`rotateParts` below) rather than a wrapping transform, exactly
// like CoilViewer.tsx does and for the identical reason: the camera fit is
// computed from the geometry's own local vertex positions (`projection.ts`'s
// `computeGuideFit`, mirroring `LineArtRenderer.tsx`'s `computeFit`), which
// has no notion of a parent transform.

import * as THREE from "three";
import type { CoilMesh, Part } from "../core";

const WALL_REMAP = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 1, 0), // local +X (left/right between 2 slots) -> world +Y
  new THREE.Vector3(0, 0, 1), // local +Y (mount.ts's WALL_UP) -> world +Z (this renderer's vertical)
  new THREE.Vector3(1, 0, 0), // local +Z (the coil's own axis) -> world +X (sticking out of the wall)
);
// The renderer's oblique camera (VIEW_DIR=(1,-1,0.9)/UP=(0,0,1)) tilts the
// projected "up" ~24.2 degrees around the depth axis (world X); this spin
// correction cancels that so WALL_UP (mount.ts) lands on the screen's own
// vertical -- see CoilViewer.tsx's identical constant for the full derivation.
const WALL_VIEW_ROTATION = new THREE.Matrix4().makeRotationX(-0.42285392613294076).multiply(WALL_REMAP);

// Wall-MOUNT-face view: camera behind the wall looking into the room, built
// directly from the renderer's fixed camera basis so the flange face renders
// face-on (an undistorted circle) -- see CoilViewer.tsx's identical constant.
const WALL_MOUNT_VIEW_ROTATION = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(-Math.SQRT1_2, -Math.SQRT1_2, 0), // local +X
  new THREE.Vector3(-0.37964208654863807, 0.37964208654863807, 0.84364908121919568), // local +Y (WALL_UP) -> camera's realUp
  new THREE.Vector3(-0.59654998627189371, 0.59654998627189371, -0.53689498764470434), // local +Z (coil axis) -> camera's forward
);

/**
 * A design whose mount doesn't hang level on local +Y (a triangle -- see
 * `Design.mountAxisDeg`'s own doc comment) needs the SAME correction
 * CoilViewer.tsx applies: pre-rotate about local Z by `mountAxisDeg` before
 * either wall transform, so the screen always shows the axis that's
 * ACTUALLY vertical once mounted.
 */
function withAxisCorrection(base: THREE.Matrix4, mountAxisDeg: number | undefined): THREE.Matrix4 {
  if (!mountAxisDeg) return base.clone();
  const correction = new THREE.Matrix4().makeRotationZ((mountAxisDeg * Math.PI) / 180);
  return base.clone().multiply(correction);
}

export function wallRoomRotation(mountAxisDeg: number | undefined): THREE.Matrix4 {
  return withAxisCorrection(WALL_VIEW_ROTATION, mountAxisDeg);
}

export function wallMountRotation(mountAxisDeg: number | undefined): THREE.Matrix4 {
  return withAxisCorrection(WALL_MOUNT_VIEW_ROTATION, mountAxisDeg);
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
