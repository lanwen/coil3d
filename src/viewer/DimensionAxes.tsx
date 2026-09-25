// Overall-dimension axes (issue #69, replacing #50's 2D SVG overlay): three
// measurement axes -- width, depth and height (the coil axis) -- drawn as
// real 3D scene objects along the edges of the assembled model's bounding
// box, a small gap outside it, so they rotate and zoom with the model in
// every preset and during orbit. The box is spun about the coil axis to sit
// flush with the flange's flats (see measureDimensionFrame).
//
// Layout (in that box's own frame, inside a group carrying the spin plus
// the view rotation CoilViewer applies to the part geometries): the two
// ground axes run along the two bottom box edges that meet at the bottom
// corner nearest the camera -- their common origin -- and the height axis
// stands at the far end of whichever of them reads further out to the side
// on screen. Every one of those edges lies on a box face turned toward the
// camera, so the model (inside the box) can never hide them, and none of
// them cuts across the model's silhouette. The corner is re-picked every
// frame, so orbiting round the back swaps the axes to the new front edges
// instead of leaving them behind the model. An axis seen nearly end-on is
// hidden rather than drawn misleadingly short.
//
// Rendering: the strokes (lines, tick bars, arrowheads) are flat,
// camera-facing black triangles sized in screen pixels, rebuilt as the
// render that draws them starts (so they always use the camera
// LineArtRenderer has just framed). They live on DIMENSION_LINE_LAYER, which LineArtRenderer
// draws after its edge pipeline but before FXAA: the edge detector never sees
// them (no smeared double outlines), yet they are antialiased like the model's
// lines. The cm labels are sprites (always facing the camera, always upright)
// on DIMENSION_LABEL_LAYER, drawn last, straight onto the canvas, so the
// canvas-rendered text isn't blurred by FXAA.

import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Part } from "../core";
import { DIMENSION_LABEL_LAYER, DIMENSION_LINE_LAYER } from "./lineArt/LineArtRenderer";
import { LABEL_FONT_PX, LABEL_PAD_Y_PX, labelTexture, makeLabelSprite, StrokeBuilder } from "./screenSpaceInk";

// Screen-space sizes, CSS px. The dimension line is drawn bolder than the
// model's own ~1-1.6px pen line (LineArtRenderer's MIN/MAX_LINE_WEIGHT).
const LINE_PX = 3;
const EXTENSION_PX = 1.2;
const TICK_PX = 12;
const ARROW_LENGTH_PX = 13;
const ARROW_HALF_WIDTH_PX = 4.5;
// Below this on-screen length an axis is hidden; a short one draws its
// arrowheads outside, on leaders this long past them.
const MIN_AXIS_PX = 6;
const SHORT_LEAD_PX = 6;
// |sin| of the on-screen angle below which a ground axis counts as running
// along the height axis.
const PARALLEL_SIN = 0.5;
const LABEL_GAP_PX = 5;
// The axes sit this far outside the box: a fraction of the footprint's size
// (not the height -- a tall, slim coil would push them far off to the side),
// floored so a tiny coil still gets clear air.
const GAP_FRACTION = 0.08;
const MIN_GAP_MM = 4;
// Room the camera fit reserves past the axes for their labels, as a fraction
// of the model's largest extent: the labels are a fixed size in pixels, and
// the frame's own size follows that extent.
const FRAME_LABEL_ROOM = 0.04;
// Projected length below this fraction of the true length: hidden.
const FORESHORTEN_MIN = 0.25;

export interface DimensionLabels {
  width: string;
  depth: string;
  height: string;
}

export interface DimensionAxesProps {
  /** The box to measure, in measureDimensionFrame's spun frame, mm. */
  box: THREE.Box3;
  /** Lowest local Z of any part (a mount plate may sit below the flange): the ground axes run below this. */
  groundZ: number;
  /** The spun frame to world: CoilViewer's view rotation times measureDimensionFrame's spin. */
  rotation: THREE.Matrix4 | null;
  labels: DimensionLabels;
}

type AxisId = keyof DimensionLabels;

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
 * angle instead (issue #79): a heavily-rounded triangle can have its true
 * minimal-area angle sit at a "corner-through-the-axis" orientation instead
 * of a flat-flush one (the two are only EXACTLY tied for a shape with a
 * rotational symmetry matching the box's own -- true for round/square, not
 * for a triangle's odd corner count) -- close enough in area that the
 * search's plain `<` picks whichever it meets first, not necessarily the
 * flat-flush one. CoilViewer passes the SAME angle `frontFacingRotation`
 * rotates the mesh by (negated), so the box stays flush with the identical
 * flat the standing view now faces, rather than an independently-found one.
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
      if (part.role === "mountPlate") continue;
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

function gapFor(box: THREE.Box3): number {
  const extent = box.getSize(new THREE.Vector3());
  return Math.max(MIN_GAP_MM, GAP_FRACTION * Math.max(extent.x, extent.y));
}

/**
 * Extra points (local frame, xyz triples) for the camera fit, so the axes
 * and their labels stay inside the frame: the box grown by room for the
 * axes plus a label beyond them.
 */
export function dimensionFramePoints(box: THREE.Box3, groundZ: number): Float32Array {
  const gap = gapFor(box);
  const extent = box.getSize(new THREE.Vector3());
  const room = gap + FRAME_LABEL_ROOM * Math.max(extent.x, extent.y, extent.z);
  const zs = [Math.min(groundZ, box.min.z) - room, box.max.z];
  const out: number[] = [];
  for (const x of [box.min.x - room, box.max.x + room]) for (const y of [box.min.y - room, box.max.y + room]) for (const z of zs) out.push(x, y, z);
  return new Float32Array(out);
}

export function DimensionAxes({ box, groundZ, rotation, labels }: DimensionAxesProps) {
  const group = useMemo(() => {
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    return g;
  }, []);

  const strokes = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.set(DIMENSION_LINE_LAYER);
    mesh.frustumCulled = false;
    return mesh;
  }, []);

  const sprites = useMemo(() => {
    const make = () => {
      const sprite = makeLabelSprite(DIMENSION_LABEL_LAYER);
      sprite.visible = false;
      return sprite;
    };
    return { width: make(), depth: make(), height: make() } as Record<AxisId, THREE.Sprite>;
  }, []);

  useEffect(() => {
    group.add(strokes, sprites.width, sprites.depth, sprites.height);
    return () => {
      group.remove(strokes, sprites.width, sprites.depth, sprites.height);
      strokes.geometry.dispose();
      (strokes.material as THREE.Material).dispose();
      for (const s of Object.values(sprites)) {
        s.material.map?.dispose();
        s.material.dispose();
      }
    };
  }, [group, strokes, sprites]);

  useEffect(() => {
    group.matrix.copy(rotation ?? new THREE.Matrix4());
    group.matrixWorldNeedsUpdate = true;
  }, [group, rotation]);

  // Label textures: rebuilt when the text changes, and once more when the
  // UI webfont finishes loading (the first draw may have used a fallback).
  const sizes = useMemo(() => new Map<AxisId, { w: number; h: number }>(), []);
  useEffect(() => {
    let cancelled = false;
    const draw = () => {
      if (cancelled) return;
      for (const id of Object.keys(sprites) as AxisId[]) {
        const { texture, widthPx, heightPx } = labelTexture(labels[id]);
        sprites[id].material.map?.dispose();
        sprites[id].material.map = texture;
        sprites[id].material.needsUpdate = true;
        sizes.set(id, { w: widthPx, h: heightPx });
      }
    };
    draw();
    document.fonts?.ready.then(draw);
    return () => {
      cancelled = true;
    };
  }, [labels, sprites, sizes]);

  // Everything view-dependent is rebuilt at the start of the render that
  // draws the strokes (scene.onBeforeRender runs before three uploads the
  // geometry; a mesh's own onBeforeRender would be too late for that).
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const inverse = new THREE.Matrix4();
    const update = (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => {
      inverse.copy(group.matrixWorld).invert();
      const size = renderer.getSize(new THREE.Vector2());
      const center = box.getCenter(new THREE.Vector3());
      // Toward the camera, in the local frame.
      const view = camera.getWorldDirection(new THREE.Vector3()).negate().transformDirection(inverse);
      let pixel: number; // mm per CSS px at the model
      if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
        const c = camera as THREE.OrthographicCamera;
        pixel = (c.top - c.bottom) / c.zoom / Math.max(1, size.y);
      } else {
        const c = camera as THREE.PerspectiveCamera;
        const camLocal = c.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverse);
        pixel = (2 * camLocal.distanceTo(center) * Math.tan(THREE.MathUtils.degToRad(c.fov) / 2)) / c.zoom / Math.max(1, size.y);
      }

      const gap = gapFor(box);
      const sx = view.x >= 0 ? 1 : -1;
      const sy = view.y >= 0 ? 1 : -1;
      const x = (s: number) => (s > 0 ? box.max.x : box.min.x);
      const y = (s: number) => (s > 0 ? box.max.y : box.min.y);
      const X = (s: number) => x(s) + s * gap;
      const Y = (s: number) => y(s) + s * gap;
      const zg = Math.min(groundZ, box.min.z) - gap;

      // On-screen position (CSS px, y up) relative to the box centre.
      const right = new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorld).transformDirection(inverse);
      const up = new THREE.Vector3(0, 1, 0).transformDirection(camera.matrixWorld).transformDirection(inverse);
      const toScreen = (p: THREE.Vector3) => {
        const d = p.clone().sub(center);
        return new THREE.Vector2(d.dot(right) / pixel, d.dot(up) / pixel);
      };

      // The height axis stands at the end of whichever ground axis reads
      // further out, sideways from the box centre, on screen (ties go right,
      // away from the toggles at the viewer's top left).
      const zDir = new THREE.Vector3(0, 0, 1);
      const zScreen = toScreen(center.clone().add(zDir)).normalize();
      const sideways = (p: THREE.Vector3) => {
        const s = toScreen(p);
        return s.x * zScreen.y - s.y * zScreen.x; // signed distance from the centre's vertical
      };
      const endOfWidth = new THREE.Vector3(X(-sx), Y(sy), zg);
      const endOfDepth = new THREE.Vector3(X(sx), Y(-sy), zg);
      const dw = sideways(endOfWidth);
      const dd = sideways(endOfDepth);
      // A ground axis that reads nearly parallel to the height on screen is
      // left out below; stand the height at the other axis's end.
      const alongHeight = (dir: THREE.Vector3) => {
        const d = toScreen(center.clone().add(dir));
        const len = d.length();
        return len > 1e-9 ? Math.abs(d.x * zScreen.y - d.y * zScreen.x) / len < PARALLEL_SIN : false;
      };
      const widthParallel = alongHeight(new THREE.Vector3(1, 0, 0));
      const depthParallel = alongHeight(new THREE.Vector3(0, 1, 0));
      const atWidthEnd =
        widthParallel !== depthParallel ? depthParallel : Math.abs(Math.abs(dw) - Math.abs(dd)) < 1 ? dw > dd : Math.abs(dw) > Math.abs(dd);
      const heightBase = atWidthEnd ? endOfWidth : endOfDepth;

      const b = new StrokeBuilder(view, pixel);
      const labelAt = new Map<AxisId, THREE.Vector3>();
      const origin = new THREE.Vector3(X(sx), Y(sy), zg);

      // Seen well enough to draw: not nearly end-on, and long enough on
      // screen for its two arrowheads.
      const shown = (from: THREE.Vector3, to: THREE.Vector3) => {
        const dir = to.clone().sub(from);
        const length = dir.length();
        const projected = new THREE.Vector3().crossVectors(dir.normalize(), view).length(); // |sin| of the angle to the view ray
        return projected >= FORESHORTEN_MIN && (length * projected) / pixel >= MIN_AXIS_PX;
      };

      const dimension = (id: AxisId, from: THREE.Vector3, to: THREE.Vector3) => {
        const dir = to.clone().sub(from).normalize();
        const onScreenPx = (from.distanceTo(to) * new THREE.Vector3().crossVectors(dir, view).length()) / pixel;
        if (onScreenPx >= 2 * ARROW_LENGTH_PX + 4) {
          // Arrowheads inside, pointing out at the tick bars.
          b.segment(from.clone().addScaledVector(dir, ARROW_LENGTH_PX * pixel * 0.8), to.clone().addScaledVector(dir, -ARROW_LENGTH_PX * pixel * 0.8), LINE_PX);
          b.arrow(from, dir.clone().negate(), ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
          b.arrow(to, dir, ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
        } else {
          // Too short for that (a slim coil's footprint): arrowheads outside,
          // pointing in, the drafting convention for a small span.
          const lead = (ARROW_LENGTH_PX + SHORT_LEAD_PX) * pixel;
          b.segment(from.clone().addScaledVector(dir, -lead), to.clone().addScaledVector(dir, lead), LINE_PX);
          b.arrow(from, dir, ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
          b.arrow(to, dir.clone().negate(), ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
        }
        const tick = b.perp(dir).multiplyScalar((TICK_PX / 2) * pixel);
        b.segment(from.clone().add(tick), from.clone().sub(tick), LINE_PX);
        b.segment(to.clone().add(tick), to.clone().sub(tick), LINE_PX);

        // Label beside the line's midpoint, on the side away from the model.
        const mid = from.clone().add(to).multiplyScalar(0.5);
        const n = b.perp(dir);
        const midScreen = toScreen(mid);
        const nScreen = toScreen(mid.clone().add(n)).sub(midScreen).normalize();
        if (nScreen.dot(midScreen) < 0) {
          n.negate();
          nScreen.negate();
        }
        const s = sizes.get(id) ?? { w: 60, h: LABEL_FONT_PX + 2 * LABEL_PAD_Y_PX };
        const reach = Math.abs(nScreen.x) * (s.w / 2) + Math.abs(nScreen.y) * (s.h / 2) + LABEL_GAP_PX + TICK_PX / 4;
        labelAt.set(id, mid.addScaledVector(n, reach * pixel));
      };

      // Width (local X) and depth (local Y) from the common origin corner;
      // height from the flange's underside to the top.
      const widthFar = new THREE.Vector3(x(-sx), Y(sy), zg);
      const widthNear = new THREE.Vector3(x(sx), Y(sy), zg);
      const depthFar = new THREE.Vector3(X(sx), y(-sy), zg);
      const depthNear = new THREE.Vector3(X(sx), y(sy), zg);
      const heightBottom = new THREE.Vector3(heightBase.x, heightBase.y, box.min.z);
      const heightTop = new THREE.Vector3(heightBase.x, heightBase.y, box.max.z);
      const H = shown(heightBottom, heightTop);
      // A ground axis reading parallel to the height on screen (a square's
      // depth, seen face-on from above) would pass for a second height:
      // left out while the height is drawn (the other ground axis still is).
      const W = shown(widthFar, widthNear) && !(H && widthParallel && !depthParallel);
      const D = shown(depthFar, depthNear) && !(H && depthParallel && !widthParallel);
      if (W) dimension("width", widthFar, widthNear);
      if (D) dimension("depth", depthFar, depthNear);
      if (H) dimension("height", heightBottom, heightTop);
      // Thin extension lines join the axes at the corners they share (an
      // end-on axis's corner coincides with its neighbour's on screen).
      if (W && (D || !atWidthEnd)) b.segment(widthNear, origin, EXTENSION_PX);
      if (D && (W || atWidthEnd)) b.segment(depthNear, origin, EXTENSION_PX);
      if (H) {
        b.segment(heightBase, heightBottom, EXTENSION_PX);
        if (atWidthEnd && W) b.segment(widthFar, heightBase, EXTENSION_PX);
        if (!atWidthEnd && D) b.segment(depthFar, heightBase, EXTENSION_PX);
      }

      const geometry = strokes.geometry;
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(b.out, 3));
      for (const id of Object.keys(sprites) as AxisId[]) {
        const sprite = sprites[id];
        const at = labelAt.get(id);
        sprite.visible = !!at;
        if (!at) continue;
        const s = sizes.get(id) ?? { w: 60, h: LABEL_FONT_PX + 2 * LABEL_PAD_Y_PX };
        sprite.position.copy(at);
        sprite.scale.set(s.w * pixel, s.h * pixel, 1);
        sprite.updateMatrix();
      }
    };
    const previous = scene.onBeforeRender;
    scene.onBeforeRender = function (this: THREE.Scene, ...args: Parameters<THREE.Scene["onBeforeRender"]>) {
      previous.apply(this, args);
      const [renderer, , camera] = args;
      if (camera.layers.isEnabled(DIMENSION_LINE_LAYER)) update(renderer, camera);
    };
    return () => {
      scene.onBeforeRender = previous;
    };
  }, [scene, strokes, sprites, group, box, groundZ, sizes]);

  return <primitive object={group} />;
}
