// Shared screen-space-sized ink (issue #69's DimensionAxes.tsx originally
// owned this outright; issue #78 PR review split it out so the print-layout
// view's own part-name callouts can draw in the EXACT same size/weight --
// "the same size and weight as the dimension-axis labels" -- instead of a
// second, independently-tuned label style). Both `labelTexture` (canvas-
// drawn text, always upright, always facing the camera -- a THREE.Sprite)
// and `StrokeBuilder` (flat, camera-facing triangles for lines, sized in
// screen pixels) are pure geometry/canvas builders: no React, no scene
// membership of their own. Callers place the resulting texture on a Sprite
// and the stroke triangles on a Mesh, both on whichever DIMENSION_*_LAYER
// suits them (see LineArtRenderer's own file header for what those layers
// mean to its render loop).

import * as THREE from "three";

// CSS px. Matches DimensionAxes' own cm labels exactly (issue #78 PR
// review: print-layout part-name labels must read the same size/weight).
export const LABEL_FONT_PX = 15;
export const LABEL_PAD_X_PX = 5;
export const LABEL_PAD_Y_PX = 3;
// Label textures are drawn at this multiple of CSS px (x devicePixelRatio)
// so they stay crisp.
export const LABEL_SUPERSAMPLE = 2;

/** A white rounded-rect-free label texture (bold text, black on white,
 * matching DimensionAxes' own `labelTexture`) -- always upright and
 * camera-facing once placed on a `THREE.Sprite`. */
export function labelTexture(text: string): { texture: THREE.CanvasTexture; widthPx: number; heightPx: number } {
  const scale = LABEL_SUPERSAMPLE * (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const font = `bold ${LABEL_FONT_PX}px ${typeof document !== "undefined" ? getComputedStyle(document.body).fontFamily || "sans-serif" : "sans-serif"}`;
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

/** A `THREE.Sprite` ready to carry a `labelTexture` result -- always
 * upright, always facing the camera, drawn on `layer` (typically
 * `DIMENSION_LABEL_LAYER`, straight onto the canvas after FXAA so the
 * canvas-rendered text isn't blurred -- see LineArtRenderer). */
export function makeLabelSprite(layer: number): THREE.Sprite {
  const material = new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.layers.set(layer);
  sprite.frustumCulled = false;
  sprite.renderOrder = 1;
  return sprite;
}

/** Appends camera-facing flat triangles to `out` (flat xyz triples), sized
 * in screen pixels (`pixel` = world mm per CSS px at the model). */
export class StrokeBuilder {
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

  /** Filled disc facing the camera, centred on `at`. */
  dot(at: THREE.Vector3, radiusPx: number) {
    const u = this.perp(new THREE.Vector3().crossVectors(this.view, new THREE.Vector3(1, 0, 0)).lengthSq() > 1e-6 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
    const v = new THREE.Vector3().crossVectors(this.view, u);
    const r = radiusPx * this.pixel;
    const steps = 16;
    const rim = (i: number) => at.clone().addScaledVector(u, r * Math.cos((2 * Math.PI * i) / steps)).addScaledVector(v, r * Math.sin((2 * Math.PI * i) / steps));
    for (let i = 0; i < steps; i++) this.tri(at, rim(i), rim(i + 1));
  }

  /** Filled arrowhead with its tip at `tip`, pointing along `dir` (unit). */
  arrow(tip: THREE.Vector3, dir: THREE.Vector3, lengthPx: number, halfWidthPx: number) {
    const back = tip.clone().addScaledVector(dir, -lengthPx * this.pixel);
    const n = this.perp(dir).multiplyScalar(halfWidthPx * this.pixel);
    this.tri(tip, back.clone().add(n), back.clone().sub(n));
  }
}

/** World mm per CSS px at `target` (the same conversion DimensionAxes'
 * own per-frame update does), for either projection. */
export function pixelSizeAt(camera: THREE.Camera, target: THREE.Vector3, canvasHeightPx: number): number {
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const c = camera as THREE.OrthographicCamera;
    return (c.top - c.bottom) / c.zoom / Math.max(1, canvasHeightPx);
  }
  const c = camera as THREE.PerspectiveCamera;
  const distance = c.getWorldPosition(new THREE.Vector3()).distanceTo(target);
  return (2 * distance * Math.tan(THREE.MathUtils.degToRad(c.fov) / 2)) / c.zoom / Math.max(1, canvasHeightPx);
}
