// Overall-dimension axes (issue #69, replacing #50's 2D SVG overlay): three
// measurement axes -- width (local X), depth (local Y) and height (the coil
// axis, local Z) -- drawn as real 3D scene objects along the edges of the
// assembled model's bounding box, a small gap outside it, so they rotate
// and zoom with the model in every preset and during orbit.
//
// Layout (all in the model's own local frame, inside a group carrying the
// same view rotation CoilViewer applies to the part geometries): the two
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

// Screen-space sizes, CSS px. The dimension line is drawn bolder than the
// model's own ~1-1.6px pen line (LineArtRenderer's MIN/MAX_LINE_WEIGHT).
const LINE_PX = 3;
const EXTENSION_PX = 1.2;
const TICK_PX = 12;
const ARROW_LENGTH_PX = 13;
const ARROW_HALF_WIDTH_PX = 4.5;
const LABEL_FONT_PX = 15;
// Below this on-screen length an axis is hidden; a short one draws its
// arrowheads outside, on leaders this long past them.
const MIN_AXIS_PX = 6;
const SHORT_LEAD_PX = 6;
const LABEL_PAD_X_PX = 5;
const LABEL_PAD_Y_PX = 3;
const LABEL_GAP_PX = 5;
// Label textures are drawn at this multiple of CSS px (x devicePixelRatio)
// so they stay crisp.
const LABEL_SUPERSAMPLE = 2;
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
  /** The box to measure (see measureDimensionFrame), local frame, mm. */
  box: THREE.Box3;
  /** Lowest local Z of any part (a mount plate may sit below the flange): the ground axes run below this. */
  groundZ: number;
  /** The view rotation CoilViewer applies to every part geometry, or null. */
  rotation: THREE.Matrix4 | null;
  labels: DimensionLabels;
}

type AxisId = keyof DimensionLabels;

/**
 * The box the dimension axes measure, in the parts' local frame: the
 * assembled core + cap (a mount plate sits under the flange's footprint and
 * only lowers `groundZ`, where the ground axes run). Upright and on the
 * model's own X/Y -- so a square flange, which the presets see corner-on,
 * measures corner to corner: the room it takes along the drawn lines.
 */
export function measureDimensionFrame(parts: Part[]): { box: THREE.Box3; groundZ: number } {
  const box = new THREE.Box3();
  let groundZ = Infinity;
  const p = new THREE.Vector3();
  for (const part of parts) {
    const pos = part.mesh.positions;
    for (let i = 0; i < pos.length; i += 3) {
      groundZ = Math.min(groundZ, pos[i + 2]);
      if (part.role !== "mountPlate") box.expandByPoint(p.set(pos[i], pos[i + 1], pos[i + 2]));
    }
  }
  return { box, groundZ };
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

function labelTexture(text: string): { texture: THREE.CanvasTexture; widthPx: number; heightPx: number } {
  const scale = LABEL_SUPERSAMPLE * (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const font = `bold ${LABEL_FONT_PX}px ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  const widthPx = Math.ceil(ctx.measureText(text).width) + 2 * LABEL_PAD_X_PX;
  const heightPx = LABEL_FONT_PX + 2 * LABEL_PAD_Y_PX;
  canvas.width = Math.ceil(widthPx * scale);
  canvas.height = Math.ceil(heightPx * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.font = font;
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, widthPx / 2, heightPx / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, widthPx, heightPx };
}

/** Appends camera-facing triangles to `out` (flat xyz triples). */
class StrokeBuilder {
  out: number[] = [];
  constructor(
    private view: THREE.Vector3, // unit, local frame, toward the camera
    private pixel: number, // world mm per CSS px
  ) {}

  /** Unit screen-perpendicular to a segment direction (in the view plane). */
  perp(dir: THREE.Vector3): THREE.Vector3 {
    const p = new THREE.Vector3().crossVectors(dir, this.view);
    return p.lengthSq() > 1e-12 ? p.normalize() : p;
  }

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
    this.out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }

  segment(a: THREE.Vector3, b: THREE.Vector3, widthPx: number) {
    const dir = b.clone().sub(a);
    if (dir.lengthSq() < 1e-12) return;
    const n = this.perp(dir.normalize()).multiplyScalar((widthPx / 2) * this.pixel);
    // Square caps (extend half a width) so joined segments meet cleanly.
    const ext = dir.clone().multiplyScalar((widthPx / 2) * this.pixel);
    const a0 = a.clone().sub(ext);
    const b0 = b.clone().add(ext);
    const p1 = a0.clone().add(n);
    const p2 = a0.clone().sub(n);
    const p3 = b0.clone().add(n);
    const p4 = b0.clone().sub(n);
    this.tri(p1, p2, p3);
    this.tri(p3, p2, p4);
  }

  /** Filled arrowhead with its tip at `tip`, pointing along `dir` (unit). */
  arrow(tip: THREE.Vector3, dir: THREE.Vector3) {
    const back = tip.clone().addScaledVector(dir, -ARROW_LENGTH_PX * this.pixel);
    const n = this.perp(dir).multiplyScalar(ARROW_HALF_WIDTH_PX * this.pixel);
    this.tri(tip, back.clone().add(n), back.clone().sub(n));
  }
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
      const material = new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true });
      const sprite = new THREE.Sprite(material);
      sprite.layers.set(DIMENSION_LABEL_LAYER);
      sprite.frustumCulled = false;
      sprite.renderOrder = 1;
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
      const atWidthEnd = Math.abs(Math.abs(dw) - Math.abs(dd)) < 1 ? dw > dd : Math.abs(dw) > Math.abs(dd);
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
          b.arrow(from, dir.clone().negate());
          b.arrow(to, dir);
        } else {
          // Too short for that (a slim coil's footprint): arrowheads outside,
          // pointing in, the drafting convention for a small span.
          const lead = (ARROW_LENGTH_PX + SHORT_LEAD_PX) * pixel;
          b.segment(from.clone().addScaledVector(dir, -lead), to.clone().addScaledVector(dir, lead), LINE_PX);
          b.arrow(from, dir);
          b.arrow(to, dir.clone().negate());
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
      const W = shown(widthFar, widthNear);
      const D = shown(depthFar, depthNear);
      const H = shown(heightBottom, heightTop);
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
