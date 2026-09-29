// Projects a 3D point (in the same local mesh frame `GuideFigure` draws) to
// a fraction (0..1, origin top-left, CSS convention) of a figure's own
// frame -- so an SVG arrow/callout overlay can be positioned FROM the
// geometry and stay attached to it, per issue #17 review ("SVG overlays
// positioned from projected 3D points").
//
// Reuses `presets.ts`'s camera direction/up data (issue #15) -- never its
// own guess at "what iso looks like" -- and mirrors `LineArtRenderer.tsx`'s
// own fit convention (bounding-sphere-relative bounds, `halfHeight =
// extent/(2*fill)`) closely enough that a figure rendered at a given
// preset/fill and a point projected through `computeGuideFit`/`projectToFigure`
// at that SAME preset/fill always agree. It does NOT read a live camera or
// canvas: `GuideFigure`'s `LineArtRenderer` computes its OWN camera from the
// same geometry/preset/fill/aspect for the actual render, and because both
// computations are pure functions of the same four inputs, they can never
// visually disagree -- there is no live object to share between a React
// component (this module, called during render) and a canvas that mounts
// separately.
//
// `aspect` is fixed (`FIGURE_ASPECT`, guide.css's `.guide-figure`'s own
// `aspect-ratio`) rather than measured, precisely so this can run at plain
// render time, before any canvas has ever laid out -- see FIGURE_ASPECT's
// own comment.

import * as THREE from "three";
import type { CoilMesh, Part } from "../core";
import { getPreset, type PresetId } from "../viewer/lineArt/presets";

/** `.guide-figure`'s own `aspect-ratio` (guide.css) -- kept as ONE constant
 * both sides read, so the CSS box `GuideFigure`'s canvas actually fills and
 * this module's `aspect` parameter can never drift apart. A guide figure is
 * intentionally wider than tall (unlike the interactive viewer's own
 * roughly-square default): the printed page is portrait, so a wide, short
 * figure leaves more of each page for the next step. */
export const FIGURE_ASPECT = 4 / 3;

export interface GuideFit {
  /** World-to-camera-local rotation (orthonormal: inverse === transpose, matching `LineArtRenderer.tsx`'s own `computeFit`). */
  inverse: THREE.Matrix4;
  center: THREE.Vector3;
  halfHeight: number;
  aspect: number;
}

function creaselessPositions(parts: Part[]): Float32Array {
  const chunks = parts.map((p) => p.mesh.positions);
  const merged = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.length;
  }
  return merged;
}

/**
 * The camera fit `GuideFigure` renders `parts` at for a given `preset`/
 * `fill`, in a form this module's `projectToFigure` can use -- see the file
 * header for why this is a small, independent reimplementation of
 * `LineArtRenderer.tsx`'s own `computeFit`, not an import of it (that
 * function needs a live `THREE.BufferGeometry` mid-render; this needs to run
 * from plain `Part[]` at ordinary render time). `exploded` parts should
 * already be at their exploded Z (see `explodedPosition` below) before
 * calling this, exactly like `CoilScene`'s own framing geometry.
 */
export function computeGuideFit(parts: Part[], preset: PresetId, fill: number, aspect: number = FIGURE_ASPECT): GuideFit | null {
  const preset_ = getPreset(preset);
  const positions = creaselessPositions(parts);
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
  const inverse = rotation.clone().transpose(); // orthonormal: inverse === transpose

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

/** `point` (in the SAME local mesh frame `parts` used to build `fit`), as an {x,y} fraction of the figure's frame (0..1, origin top-left). May land outside [0,1] for a point off-frame -- callers that need it visible should keep it within the model's own silhouette. */
export function projectToFigure(fit: GuideFit, point: THREE.Vector3): { x: number; y: number } {
  const flat = point.clone().sub(fit.center).applyMatrix4(fit.inverse);
  const halfWidth = fit.halfHeight * fit.aspect;
  return { x: (flat.x / halfWidth + 1) / 2, y: (1 - flat.y / fit.halfHeight) / 2 };
}

/** The on-screen radius (as a fraction of the figure's height) a circle of world-space `radius`, centered at `center`, would project to at `fit` -- e.g. for drawing a rotation arrow that hugs the coil's actual silhouette regardless of design size. Exact for an orthographic camera (issue #17: the guide never uses perspective): distances perpendicular to the view direction scale uniformly by `1/(2*fit.halfHeight)`. */
export function projectRadius(fit: GuideFit, radius: number): number {
  return radius / (2 * fit.halfHeight);
}

/** The Z-extent of a mesh, mm (mirrors CoilScene's own `zExtent`, used here to place a point at a part's own top/bottom rim without reaching into core internals). */
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

/**
 * `parts` with every non-core part shifted along Z by its own exploded
 * offset (Z-extent + a fixed gap) when `exploded` -- the SAME convention
 * `CoilScene`'s `exploded` prop uses (`EXPLODE_GAP`), reimplemented here so
 * this module can compute a fit/projection for an exploded figure BEFORE
 * (and independently of) the canvas that actually renders it. Only affects
 * `computeGuideFit`'s bounding math and callers' own projected anchor
 * points; `GuideFigure`'s own `exploded` prop still does the actual drawing.
 */
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

/** The mesh's own bounding box (mirrors `plate.ts`'s `meshBBox`, reimplemented here rather than imported -- that module is a core INTERNAL, and the UI may only use the core's public interface). */
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

/** The union bounding box of every part's mesh (public `CoilMesh` data only). */
export function partsBounds(parts: Part[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const part of parts) box.union(meshBounds(part.mesh));
  return box;
}

/**
 * A schematic anchor point for a rim feature (a keyhole, the groove's
 * start) that the guide has no exact coordinates for -- `Design.wallSpec`/
 * `flangeSpec` are core internals, documented "not for UI use"
 * (core/types.ts), so this never reads them. Such a feature sits (or, for
 * the rim keyholes before issue #115, sat -- the guide now reads those from
 * the public cable path's own ends instead) at arc-length t=0, which is
 * the local +X direction (`sign=1`) or -X (`sign=-1`) -- so the mesh's own
 * vertex furthest along that axis, within a thin Z band at `heightFrac` of
 * the mesh's own height, sits AT or right next to the real feature: close
 * enough for a schematic callout circle or wall contact point, built
 * entirely from public vertex data. */
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
