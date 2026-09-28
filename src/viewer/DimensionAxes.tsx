// Overall-dimension axes (issue #69, replacing #50's 2D SVG overlay; made
// rigid by issue #93): width, depth and height drawn as 3D scene objects
// along the edges of the assembled model's bounding box, a small gap outside
// it. Where they go is fixed in the model's own frame (dimensionGeometry.ts:
// one bottom corner, the three box edges from it), so they rotate, pan and
// zoom rigidly with the model in every preset and during a free orbit.
// Nothing about their placement depends on the camera.
//
// Rendering: the strokes (lines, tick bars, arrowheads) are flat,
// camera-facing black triangles around those fixed centrelines, sized in
// screen pixels and rebuilt as the render that draws them starts (only
// their thickness follows the camera). They live on DIMENSION_LINE_LAYER,
// which LineArtRenderer draws after its edge pipeline but before FXAA, with
// no depth test: the edge detector never sees them, they are antialiased
// like the model's lines, and a fragment behind the model (checked against
// the model's own depth) is discarded rather than drawn -- issue #97: a
// part of an axis the model hides draws nothing, not grey. The cm labels
// are sprites (always facing the camera, always upright) centred on each
// axis's midpoint, on DIMENSION_LABEL_LAYER, drawn last, straight onto the
// canvas, so the canvas-rendered text isn't blurred by FXAA; a label whose
// midpoint anchor is itself occluded (checked by raycasting the real scene
// geometry, since a sprite has no fragment-shader depth test of its own) is
// hidden the same way (issue #97). An axis seen nearly end-on is hidden
// rather than drawn misleadingly short.

import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { AxisId, DimensionAxesGeometry } from "./dimensionGeometry";
import { DIMENSION_LABEL_LAYER, DIMENSION_LINE_LAYER, MODEL_DEPTH_UNIFORM } from "./lineArt/LineArtRenderer";
import { LABEL_FONT_PX, LABEL_PAD_Y_PX, labelTexture, makeLabelSprite, pixelSizeAt, StrokeBuilder } from "./screenSpaceInk";

// Screen-space sizes, CSS px. The dimension line is drawn bolder than the
// model's own ~1-1.6px pen line (LineArtRenderer's MIN/MAX_LINE_WEIGHT).
const LINE_PX = 3;
const EXTENSION_PX = 1.2;
// The dot marking the axes' shared origin.
const ORIGIN_DOT_PX = 7;
const TICK_PX = 12;
const ARROW_LENGTH_PX = 13;
const ARROW_HALF_WIDTH_PX = 4.5;
// Below this on-screen length an axis is hidden; a short one draws its
// arrowheads outside, on leaders this long past them.
const MIN_AXIS_PX = 6;
const SHORT_LEAD_PX = 6;
// |sin| of the angle to the view ray below which an axis counts as end-on: hidden.
const FORESHORTEN_MIN = 0.25;
// A fragment counts as hidden once the model's own depth is nearer than
// this much past it; keeps a line lying flush on the model's own surface
// from flickering discarded (issue #93's original bias, reused for #97's
// discard test).
const HIDDEN_DEPTH_BIAS = 1e-5;
// Same idea for the CPU-side raycast that decides a label's anchor is
// occluded (issue #97): the ray's far limit is pulled in by this fraction of
// its own length, so a point sitting exactly on the model's surface (e.g. a
// flush flange) doesn't falsely self-occlude.
const ANCHOR_OCCLUSION_BIAS = 1e-4;

export type DimensionLabels = Record<AxisId, string>;

export interface DimensionAxesProps {
  /** Where the axes go, in the measured box's own frame (dimensionAxesGeometry). */
  axes: DimensionAxesGeometry;
  /** That frame to world: CoilViewer's view rotation times measureDimensionFrame's spin. */
  rotation: THREE.Matrix4;
  labels: DimensionLabels;
}

// The `t` fractions along each drawn arm (from -> to) that the probe reports
// occlusion for -- issue #97/#93: e2e/dimensions.spec.ts's own rigidity test
// samples ink at exactly these two points, and skips the assertion at
// whichever ones the model itself occludes (a real orbit can swing a corner
// of the model in front of part of an axis). Exported so the test imports
// the same two numbers instead of duplicating them.
export const OCCLUSION_PROBE_TS = [0.3, 0.7] as const;

/** Test-only (e2e/dimensions.spec.ts): the last drawn frame, so a test can
 * check the axes against the box it measured under the live camera. */
export interface DimensionAxesProbe {
  /** Column-major: box frame -> clip space. */
  mvp: number[];
  canvas: { width: number; height: number };
  box: { min: number[]; max: number[] };
  gap: number;
  origin: number[];
  /** Each drawn axis's span in canvas CSS px (y down), plus whether the
   * model occludes it at each of `OCCLUSION_PROBE_TS` (same order). */
  arms: { id: AxisId; from: number[]; to: number[]; occludedAt: boolean[] }[];
}

declare global {
  interface Window {
    __dimensionAxes?: DimensionAxesProbe;
  }
}

export function DimensionAxes({ axes, rotation, labels }: DimensionAxesProps) {
  const group = useMemo(() => {
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    return g;
  }, []);

  const strokes = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    // Black, or nothing at all where the model is nearer the camera than
    // the line (issue #97: was grey; discarded instead, so the axis simply
    // doesn't draw there and whatever the model itself drew underneath shows).
    const material = new THREE.ShaderMaterial({
      uniforms: { tDepth: MODEL_DEPTH_UNIFORM, resolution: { value: new THREE.Vector2(1, 1) } },
      vertexShader: "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `
        uniform sampler2D tDepth;
        uniform vec2 resolution;
        void main() {
          float model = texture2D(tDepth, gl_FragCoord.xy / resolution).x;
          if (gl_FragCoord.z > model + ${HIDDEN_DEPTH_BIAS.toExponential()}) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        }`,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
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
    group.matrix.copy(rotation);
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

  // The strokes' screen-sized thickness is rebuilt at the start of the
  // render that draws them (scene.onBeforeRender runs before three uploads
  // the geometry; a mesh's own onBeforeRender would be too late for that).
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  // Issue #97: a sprite has no fragment-shader depth test of its own (it's
  // drawn depthTest: false, straight onto the canvas -- see makeLabelSprite),
  // so whether a label's anchor is behind the model is decided on the CPU
  // instead, by raycasting the real rendered geometry. One instance, reused
  // every frame; its default layer (0) already excludes this component's own
  // strokes/sprites (DIMENSION_LINE_LAYER/DIMENSION_LABEL_LAYER), so it only
  // ever hits the model itself.
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  useEffect(() => {
    const { origin, arms } = axes;
    const inverse = new THREE.Matrix4();
    // True if `worldPoint` has the model between it and `cameraWorldPos` --
    // see ANCHOR_OCCLUSION_BIAS for why the ray's far limit is pulled in
    // slightly rather than stopping exactly at the point.
    const occluded = (worldPoint: THREE.Vector3, cameraWorldPos: THREE.Vector3): boolean => {
      const toPoint = worldPoint.clone().sub(cameraWorldPos);
      const distance = toPoint.length();
      if (distance < 1e-9) return false;
      raycaster.set(cameraWorldPos, toPoint.divideScalar(distance));
      raycaster.near = 0;
      raycaster.far = distance * (1 - ANCHOR_OCCLUSION_BIAS);
      return raycaster.intersectObject(scene, true).length > 0;
    };
    const update = (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => {
      inverse.copy(group.matrixWorld).invert();
      const size = renderer.getSize(new THREE.Vector2());
      const target = renderer.getRenderTarget();
      (strokes.material as THREE.ShaderMaterial).uniforms.resolution.value.set(target?.width ?? 1, target?.height ?? 1);
      // Toward the camera, in the box's frame, and mm per CSS px at a point
      // (in perspective each axis gets its own, so its ink and label keep
      // their pixel size wherever it is).
      const view = camera.getWorldDirection(new THREE.Vector3()).negate().transformDirection(inverse);
      const pixelAt = (p: THREE.Vector3) => pixelSizeAt(camera, p.clone().applyMatrix4(group.matrixWorld), size.y);
      const cameraWorldPos = camera.getWorldPosition(new THREE.Vector3());
      const worldOf = (p: THREE.Vector3) => p.clone().applyMatrix4(group.matrixWorld);

      const ink: number[] = [];
      const drawn: DimensionAxesProbe["arms"] = [];
      const mvp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(group.matrixWorld);
      const toCanvas = (p: THREE.Vector3) => {
        const ndc = p.clone().applyMatrix4(mvp);
        return [((ndc.x + 1) / 2) * size.x, ((1 - ndc.y) / 2) * size.y];
      };

      for (const { id, from, to } of arms) {
        const mid = from.clone().add(to).multiplyScalar(0.5);
        const pixel = pixelAt(mid);
        const b = new StrokeBuilder(view, pixel);
        const dir = to.clone().sub(from);
        const length = dir.length();
        dir.normalize();
        const sin = new THREE.Vector3().crossVectors(dir, view).length(); // of the angle to the view ray
        const onScreenPx = (length * sin) / pixel;
        const sprite = sprites[id];
        // Nearly end-on: the whole axis is hidden (not just its label), same
        // as before #97 -- unrelated to occlusion, so this doesn't touch the
        // ink-discard shader at all.
        if (sin < FORESHORTEN_MIN || onScreenPx < MIN_AXIS_PX) {
          sprite.visible = false;
          continue;
        }

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
        // A thin extension line joins the span's near end to the shared origin.
        b.segment(from, origin, EXTENSION_PX);

        // The ink itself is drawn regardless (the shader discards whichever
        // fragments the model hides); only the LABEL is hidden outright when
        // its anchor -- the axis's own midpoint -- is occluded (issue #97:
        // "never float over the model").
        const s = sizes.get(id) ?? { w: 60, h: LABEL_FONT_PX + 2 * LABEL_PAD_Y_PX };
        sprite.visible = !occluded(worldOf(mid), cameraWorldPos);
        sprite.position.copy(mid);
        sprite.scale.set(s.w * pixel, s.h * pixel, 1);
        sprite.updateMatrix();
        const occludedAt = OCCLUSION_PROBE_TS.map((t) => occluded(worldOf(from.clone().lerp(to, t)), cameraWorldPos));
        drawn.push({ id, from: toCanvas(from), to: toCanvas(to), occludedAt });
        ink.push(...b.out);
      }
      const dot = new StrokeBuilder(view, pixelAt(origin));
      dot.dot(origin, ORIGIN_DOT_PX / 2);
      ink.push(...dot.out);
      strokes.geometry.setAttribute("position", new THREE.Float32BufferAttribute(ink, 3));

      window.__dimensionAxes = {
        mvp: mvp.toArray(),
        canvas: { width: size.x, height: size.y },
        box: { min: axes.box.min.toArray(), max: axes.box.max.toArray() },
        gap: axes.gap,
        origin: origin.toArray(),
        arms: drawn,
      };
    };
    const previous = scene.onBeforeRender;
    scene.onBeforeRender = function (this: THREE.Scene, ...args: Parameters<THREE.Scene["onBeforeRender"]>) {
      previous.apply(this, args);
      const [renderer, , camera] = args;
      if (camera.layers.isEnabled(DIMENSION_LINE_LAYER)) update(renderer, camera);
    };
    // (The canvas renders on demand: one more frame, so new axes are drawn
    // even when the frame for the change that brought them has already run.)
    invalidate();
    return () => {
      scene.onBeforeRender = previous;
      delete window.__dimensionAxes;
    };
  }, [scene, invalidate, strokes, sprites, group, axes, sizes, raycaster]);

  return <primitive object={group} />;
}
