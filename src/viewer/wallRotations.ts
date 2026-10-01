// Wall-view rotation matrices (issue #40): CoilViewer.tsx's interactive
// wall-mount presets (issue #13) and guide/wallView.ts's printable-guide
// wall step (issue #17) both need to rotate a design's local frame into
// "as mounted on the wall" in EXACTLY the same way -- any drift between two
// separately-maintained copies would show the guide's wall step in a
// different orientation from the viewer's. This module is the one
// definition; both import it rather than keeping their own copy.
//
// Both matrices below depend ONLY on `LineArtRenderer.tsx`'s fixed camera
// direction (`presets.ts`'s `ISO_DIR`/`UP`), never on any particular design
// -- that's what makes it safe for a one-shot, static renderer (the guide)
// to reuse a rotation derived for an interactive one (CoilViewer).

import * as THREE from "three";

// Wall-mount preset (issue #13 AC: "the viewer can show the wall
// orientation, bottom flange against the wall, top cap facing the room").
// The core's own axis is Z (wall.ts: the bottom flange sits at z=-thickness,
// the open/top-cap end at z=height); this remaps it onto world X, laying the
// coil on its side the way it hangs in real life -- axis horizontal,
// pointing out of the wall (docs/design.md, Orientation) -- rather
// than the default standing-on-its-flange preview.
//
// The remaining two axes are NOT an arbitrary choice: mount.ts's WALL_UP
// (local +Y in the flange plane -- where the keyhole slots' own "up" is
// defined, see that file's header) must land on the axis the LineArtRenderer
// camera actually renders as vertical on screen. That renderer's camera uses
// a FIXED, oblique view direction (LineArtRenderer.tsx's VIEW_DIR) with
// `up = world +Z` (its UP constant) -- with an oblique view direction, only
// a difference along the camera's OWN up vector (which `lookAt`/Gram-Schmidt
// derives FROM world +Z) is guaranteed to render with zero horizontal
// component; a difference along any other world axis leaks into the
// screen's horizontal axis too (exactly the bug this rotation fixes: an
// earlier version sent local Y to world Y, which -- combined with this
// camera's tilt -- rendered two slots meant to sit side by side as stacked
// on top of each other instead). So: local Y (mount.ts's WALL_UP) -> world Z
// (this renderer's vertical), and local X (left/right between 2 slots) ->
// world Y, which is what's left over.
//
// Callers must rotate the GEOMETRY itself, not a wrapping group:
// LineArtRenderer frames the camera from `geometry`'s own LOCAL vertex
// positions (see LineArtRenderer.tsx's reframe effect), with no knowledge
// of a parent transform, so a group-level rotation would frame the
// UNrotated shape while rendering the rotated one. The schematic wire
// geometries (issue #4) must be rotated the identical way, so the wire
// never visually separates from its coil when the preset is toggled.
const WALL_REMAP = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 1, 0), // local +X (left/right between 2 slots) -> world +Y
  new THREE.Vector3(0, 0, 1), // local +Y (mount.ts's WALL_UP) -> world +Z (this renderer's vertical)
  new THREE.Vector3(1, 0, 0), // local +Z (the coil's own axis) -> world +X (sticking out of the wall)
);
// A world-X-only difference (see WALL_REMAP above) has zero horizontal
// screen component, but its OWN vertical screen component isn't maximised
// at world Z's own extreme: this renderer's oblique VIEW_DIR/UP tilt the
// projected "up" a further ~24.2 degrees around that depth axis (derived
// from VIEW_DIR=(1,-1,0.9)/UP=(0,0,1): the camera's own up vector,
// (right x forward), points partway into world Y too, not purely Z). Left
// uncorrected, mount.ts's WALL_UP (theta=0, "top centre") lands about a
// quarter-turn off the ellipse's own visual apex once the flange is
// rotated face-on-ish, so two slots meant to sit level and side by side
// instead read as one clear (near the apex) and one barely-visible, deep
// in the foreshortened silhouette (issue #13 PR review). This extra spin
// about the SAME depth axis (world X) cancels that, independent of the
// model: it only depends on this renderer's own fixed camera, not on any
// particular design.
export const WALL_VIEW_ROTATION = new THREE.Matrix4().makeRotationX(-0.42285392613294076).multiply(WALL_REMAP);

// Wall-MOUNT-face preset (issue #13 PR review, round 2): "a screenshot
// looking straight at the bottom flange's wall-facing face (camera behind
// the wall looking into the room, i.e. what the wall 'sees')". The
// room-side preset above (WALL_VIEW_ROTATION) is a world-axis PERMUTATION
// plus a single-axis spin fix-up -- good enough to lay the coil on its
// side, but it only ROUGHLY points the coil's axis at this renderer's
// camera (a permuted world axis, not the camera's actual view direction),
// so a circle perpendicular to that axis still renders as a foreshortened
// ellipse, not a true circle -- fine for "is it horizontal", not precise
// enough for "are these two slots screen-symmetric".
//
// This preset instead builds the rotation directly from the camera's own
// basis, so the flange face renders perfectly face-on (an undistorted
// circle) with no separate spin correction needed:
//   - local +Z (the coil's axis, flange -> open end) -> `forward`, the
//     camera's actual view direction (normalize(-VIEW_DIR)) -- so the axis
//     points straight INTO the screen, exactly the "camera behind the wall
//     looking into the room" ask, with the flange (at the LEAST local Z)
//     nearest the camera and the rest of the coil receding away from it.
//   - local +Y (mount.ts's WALL_UP) -> `realUp`, the camera's own up vector
//     (cross(right, forward), the same construction LineArtRenderer's
//     `lookAt`/Gram-Schmidt does from VIEW_DIR/UP) -- lands exactly on
//     screen-vertical, with no residual tilt to correct for.
//   - local +X -> cross(realUp, forward) (the remaining right-handed axis,
//     Y x Z = X), which numerically comes out to -(sqrt(2)/2, sqrt(2)/2, 0).
// Recomputing this by hand isn't needed to change it: this whole basis only
// depends on LineArtRenderer's fixed VIEW_DIR/UP, not on any particular
// design, so it's derived once and hardcoded (see the issue #13 PR body for
// the derivation script) the same way WALL_VIEW_ROTATION's spin angle is.
export const WALL_MOUNT_VIEW_ROTATION = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(-Math.SQRT1_2, -Math.SQRT1_2, 0), // local +X
  new THREE.Vector3(-0.37964208654863807, 0.37964208654863807, 0.84364908121919568), // local +Y (WALL_UP) -> camera's realUp
  new THREE.Vector3(-0.59654998627189371, 0.59654998627189371, -0.53689498764470434), // local +Z (coil axis) -> camera's forward
);

/**
 * Both wall presets rotate the design's LOCAL frame (local +Y = WALL_UP is
 * literal vertical there) onto the camera. But mount.ts's own `MountLayout.
 * axisDeg` isn't always 0: a shape with no genuine mirror axis at literal
 * local +Y (a triangle, at this construction's fixed corner angles -- see
 * that field's own doc comment) still hangs level, just with a DIFFERENT
 * axis vertical instead. Showing the design's unrotated local frame as-is
 * would render that case with the mount's own true hanging axis tilted away
 * from screen-vertical -- not wrong geometry, but a misleading picture of
 * how it actually hangs (and, for the mount-side preset specifically, the
 * two slots would render off the vertical centreline instead of mirrored
 * about it). Pre-rotating the LOCAL geometry about local Z (the coil's own
 * axis -- a rotation that, being about local Z, leaves either caller's own
 * exploded-view lift axis unaffected) by the STANDARD-math-convention angle
 * `+axisDeg` (which, because `bestAxisDeg`'s own theta convention runs the
 * OPPOSITE way from a standard CCW angle -- see `standardAngleRad`'s
 * `90 - thetaDeg` -- is exactly what SUBTRACTS `axisDeg` from every point's
 * own theta, moving the mount's true axis from theta=`axisDeg` to theta=0)
 * before either wall preset's own transform cancels that out, so the screen
 * always shows the axis that's ACTUALLY vertical once mounted.
 */
export function withMountAxisCorrection(base: THREE.Matrix4, mountAxisDeg: number | undefined): THREE.Matrix4 {
  if (!mountAxisDeg) return base.clone();
  const correction = new THREE.Matrix4().makeRotationZ((mountAxisDeg * Math.PI) / 180);
  return base.clone().multiply(correction);
}
