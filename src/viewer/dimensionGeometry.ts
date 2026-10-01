// Where the overall-dimension axes go (issue #93; drawn by DimensionAxes.tsx).
// Pure geometry, no React, no camera: the axes are fixed in the model's own
// frame and rotate, pan and zoom rigidly with it.
//
// The frame is the assembled model's bounding box, spun about the coil axis
// to sit flush with the flange's flats (measureDimensionFrame). The axes
// start from ONE origin, a bottom corner of that box pushed a small gap out
// from it: the corner furthest left on screen in the default Iso view (its
// front-left-bottom corner). It is chosen once per design and view pose,
// never per frame. From it the width runs along the box's X edge, the depth
// along its Y edge and the height up its vertical edge, each offset outward
// by the same gap and spanning exactly the box's extent on that axis.

import * as THREE from "three";
import type { Part } from "../core";

export type AxisId = "width" | "depth" | "height";

export interface DimensionArm {
  id: AxisId;
  /** The measured span's two ends (where the tick bars go), in the box's frame, mm. */
  from: THREE.Vector3;
  to: THREE.Vector3;
}

export interface DimensionAxesGeometry {
  /** The box measured, in its own (spun) frame, mm. */
  box: THREE.Box3;
  /** How far outside the box the axes run, mm. */
  gap: number;
  /** Where the three axes' lines meet: the chosen bottom corner, `gap` out from the box on every axis. */
  origin: THREE.Vector3;
  /** Width, depth and height, in that order. */
  arms: DimensionArm[];
}

// The axes sit this far outside the box: a fraction of the footprint's size
// (not the height -- a tall, slim coil would push them far off to the side),
// floored so a tiny coil still gets clear air.
const GAP_FRACTION = 0.08;
const MIN_GAP_MM = 4;
// Room the camera fit reserves around the axes for their ticks and labels,
// as a fraction of the model's largest extent: those are a fixed size in
// pixels, and the frame's own size follows that extent.
const FRAME_LABEL_ROOM = 0.06;
// Room out past the height axis's top for the viewer's toggles, as a
// fraction of the footprint's size (see dimensionFramePoints).
const CONTROLS_ROOM = 0.12;

/** Convex hull of 2D points (Andrew's monotone chain). */
function hull2d(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: [number, number][]) => {
    const out: [number, number][] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  return half(pts).concat(half([...pts].reverse()));
}

// Spin steps tried for the flush footprint, and how much smaller than the
// unspun box a spun one must be to count (a round flange's box is the same
// at every angle: it stays on the model's own X/Y).
const SPIN_STEPS = 360;
const SPIN_MIN_GAIN = 0.01;

/**
 * The frame the dimension axes measure in: the assembled core + cap's box (a
 * mount plate under the flange only lowers `groundZ`, where the ground axes
 * run), in the parts' local frame spun about the coil axis by `spin` so the
 * box sits flush against the flange's flat sides -- the smallest-area
 * footprint rectangle. A square flange then measures across its flats (the
 * result panel's flange width) on both axes, and a triangle its flat base
 * and base-to-apex height, instead of the corner-to-corner extents an
 * unspun box would give.
 *
 * `forcedSpinRad`, when given, skips that area search and uses this exact
 * angle instead (issue #79): a heavily-rounded triangle's minimal-area angle
 * can sit at a "corner-through-the-axis" orientation instead of a flat-flush
 * one. CoilViewer passes the SAME angle `frontFacingRotation` rotates the
 * mesh by (negated), so the box stays flush with the flat the standing view
 * faces.
 */
export function measureDimensionFrame(parts: Part[], forcedSpinRad?: number): { box: THREE.Box3; groundZ: number; spin: THREE.Matrix4 } {
  let groundZ = Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const footprint: [number, number][] = [];
  for (const part of parts) {
    const pos = part.mesh.positions;
    for (let i = 0; i < pos.length; i += 3) {
      groundZ = Math.min(groundZ, pos[i + 2]);
      if (part.role === "mountPlate" || part.role === "peg" || part.role === "mountClip") continue;
      minZ = Math.min(minZ, pos[i + 2]);
      maxZ = Math.max(maxZ, pos[i + 2]);
      footprint.push([pos[i], pos[i + 1]]);
    }
  }
  const outline = hull2d(footprint);
  // The footprint's bounds in a frame turned by `angle` about Z.
  const boundsAt = (angle: number) => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of outline) {
      const u = c * x + s * y;
      const v = -s * x + c * y;
      x0 = Math.min(x0, u);
      x1 = Math.max(x1, u);
      y0 = Math.min(y0, v);
      y1 = Math.max(y1, v);
    }
    return { angle, x0, x1, y0, y1, area: (x1 - x0) * (y1 - y0) };
  };
  const unspun = boundsAt(0);
  let best = unspun;
  if (forcedSpinRad !== undefined) {
    best = boundsAt(forcedSpinRad);
  } else {
    for (let i = 1; i < SPIN_STEPS; i++) {
      const b = boundsAt((i / SPIN_STEPS) * Math.PI);
      if (b.area < best.area && b.area < unspun.area * (1 - SPIN_MIN_GAIN)) best = b;
    }
  }
  return {
    box: new THREE.Box3(new THREE.Vector3(best.x0, best.y0, minZ), new THREE.Vector3(best.x1, best.y1, maxZ)),
    groundZ,
    // Frame -> local: a point at (u, v) in the spun frame is at angle + its own angle in local.
    spin: new THREE.Matrix4().makeRotationZ(best.angle),
  };
}

/**
 * The three axes for `box` (see the file header). `groundZ` is the lowest
 * point of any part (a mount plate may hang below the box): the ground axes
 * run a gap below it. `isoRight` and `isoToward` are the default Iso view's
 * screen-right and toward-the-camera directions in the box's frame; they
 * only pick the origin corner (the leftmost bottom corner on screen, the
 * nearer one on a tie).
 */
export function dimensionAxesGeometry(box: THREE.Box3, groundZ: number, isoRight: THREE.Vector3, isoToward: THREE.Vector3): DimensionAxesGeometry {
  const size = box.getSize(new THREE.Vector3());
  const gap = Math.max(MIN_GAP_MM, GAP_FRACTION * Math.max(size.x, size.y));
  const zg = Math.min(groundZ, box.min.z) - gap;
  const eps = 1e-6 * size.length();
  let pick = { sx: -1, sy: -1, left: Infinity, near: -Infinity };
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const p = new THREE.Vector3(sx < 0 ? box.min.x : box.max.x, sy < 0 ? box.min.y : box.max.y, box.min.z);
      const left = p.dot(isoRight);
      const near = p.dot(isoToward);
      if (left < pick.left - eps || (left < pick.left + eps && near > pick.near)) pick = { sx, sy, left, near };
    }
  }
  const { sx, sy } = pick;
  const [xNear, xFar] = sx < 0 ? [box.min.x, box.max.x] : [box.max.x, box.min.x];
  const [yNear, yFar] = sy < 0 ? [box.min.y, box.max.y] : [box.max.y, box.min.y];
  const ox = xNear + sx * gap;
  const oy = yNear + sy * gap;
  return {
    box: box.clone(),
    gap,
    origin: new THREE.Vector3(ox, oy, zg),
    arms: [
      { id: "width", from: new THREE.Vector3(xNear, oy, zg), to: new THREE.Vector3(xFar, oy, zg) },
      { id: "depth", from: new THREE.Vector3(ox, yNear, zg), to: new THREE.Vector3(ox, yFar, zg) },
      { id: "height", from: new THREE.Vector3(ox, oy, box.min.z), to: new THREE.Vector3(ox, oy, box.max.z) },
    ],
  };
}

/**
 * Extra points (the box's frame, xyz triples) for the camera fit, so the
 * axes, their tick bars and labels stay inside the frame from any
 * direction: room around each axis's ends and the origin, along each axis.
 * Plus more room out past the height axis's top: the viewer's toggles sit
 * over the canvas's top left, which is where that top lands in Front (the
 * origin is the left corner) on a wide model; the room nudges it clear.
 */
export function dimensionFramePoints({ box, origin, arms }: DimensionAxesGeometry): Float32Array {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const room = FRAME_LABEL_ROOM * Math.max(size.x, size.y, size.z);
  const out: number[] = [];
  for (const p of [origin, ...arms.flatMap((a) => [a.from, a.to])])
    for (const d of [-room, room]) out.push(p.x + d, p.y, p.z, p.x, p.y + d, p.z, p.x, p.y, p.z + d);
  const controls = CONTROLS_ROOM * Math.max(size.x, size.y);
  out.push(origin.x + Math.sign(origin.x - center.x) * controls, origin.y + Math.sign(origin.y - center.y) * controls, box.max.z);
  return new Float32Array(out);
}
