import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { AxisId, DimensionAxesGeometry } from "./dimensionGeometry";
import { DIMENSION_LABEL_LAYER, DIMENSION_LINE_LAYER, MODEL_DEPTH_UNIFORM } from "./lineArt/LineArtRenderer";
import { LABEL_FONT_PX, LABEL_PAD_Y_PX, labelTexture, makeLabelSprite, pixelSizeAt, StrokeBuilder } from "./screenSpaceInk";

const LINE_PX = 3;
const EXTENSION_PX = 1.2;
const ORIGIN_DOT_PX = 7;
const TICK_PX = 12;
const ARROW_LENGTH_PX = 13;
const ARROW_HALF_WIDTH_PX = 4.5;
const MIN_ON_SCREEN_AXIS_PX = 6;
const SHORT_LEAD_PX = 6;
const MIN_SIN_OF_ANGLE_TO_VIEW_RAY = 0.25;
const HIDDEN_DEPTH_BIAS = 1e-5;
const ANCHOR_OCCLUSION_BIAS = 1e-4;
const LABEL_COLLISION_MARGIN_PX = 4;
const LABEL_COLLISION_ITERATIONS = 6;
const MAX_LABEL_SLIDE_IN_AXIS_LENGTHS = 3;
const INSIDE_ARROWS_MARGIN_PX = 4;
const FALLBACK_LABEL_WIDTH_PX = 60;

interface LabelSize {
  w: number;
  h: number;
}

interface CanvasRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type DimensionLabels = Record<AxisId, string>;

export interface DimensionAxesProps {
  axes: DimensionAxesGeometry;
  rotation: THREE.Matrix4;
  labels: DimensionLabels;
  roundGroundLabel: boolean;
}

export const OCCLUSION_PROBE_TS = [0.3, 0.7] as const;

export interface DimensionAxesProbe {
  mvp: number[];
  canvas: { width: number; height: number };
  box: { min: number[]; max: number[] };
  gap: number;
  origin: number[];
  arms: { id: AxisId; from: number[]; to: number[]; occludedAt: boolean[]; labelRect: CanvasRect | null }[];
}

declare global {
  interface Window {
    __dimensionAxes?: DimensionAxesProbe;
  }
}

export function DimensionAxes({ axes, rotation, labels, roundGroundLabel }: DimensionAxesProps) {
  const group = useMemo(() => {
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    return g;
  }, []);

  const strokes = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
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

  const sizes = useMemo(() => new Map<AxisId, LabelSize>(), []);
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

  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  useEffect(() => {
    const { origin, arms } = axes;
    const inverse = new THREE.Matrix4();
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
      const view = camera.getWorldDirection(new THREE.Vector3()).negate().transformDirection(inverse);
      const pixelAt = (p: THREE.Vector3) => pixelSizeAt(camera, p.clone().applyMatrix4(group.matrixWorld), size.y);
      const cameraWorldPos = camera.getWorldPosition(new THREE.Vector3());
      const worldOf = (p: THREE.Vector3) => p.clone().applyMatrix4(group.matrixWorld);

      const ink: number[] = [];
      const drawn: { id: AxisId; from: number[]; to: number[]; occludedAt: boolean[] }[] = [];
      const mvp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(group.matrixWorld);
      const toCanvas = (p: THREE.Vector3) => {
        const ndc = p.clone().applyMatrix4(mvp);
        return [((ndc.x + 1) / 2) * size.x, ((1 - ndc.y) / 2) * size.y];
      };

      const groundCandidates: { id: "width" | "depth"; mid: THREE.Vector3; dir: THREE.Vector3; pixel: number; length: number; occluded: boolean; s: LabelSize }[] = [];
      const labelRects = new Map<AxisId, CanvasRect | null>();
      const place = (id: AxisId, mid: THREE.Vector3, pixel: number, s: LabelSize, visible: boolean) => {
        const sprite = sprites[id];
        sprite.visible = visible;
        sprite.position.copy(mid);
        sprite.scale.set(s.w * pixel, s.h * pixel, 1);
        sprite.updateMatrix();
        if (!visible) {
          labelRects.set(id, null);
          return;
        }
        const [cx, cy] = toCanvas(mid);
        labelRects.set(id, { left: cx - s.w / 2, top: cy - s.h / 2, right: cx + s.w / 2, bottom: cy + s.h / 2 });
      };

      for (const { id, from, to } of arms) {
        const mid = from.clone().add(to).multiplyScalar(0.5);
        const pixel = pixelAt(mid);
        const b = new StrokeBuilder(view, pixel);
        const dir = to.clone().sub(from);
        const length = dir.length();
        dir.normalize();
        const sinOfAngleToViewRay = new THREE.Vector3().crossVectors(dir, view).length();
        const onScreenPx = (length * sinOfAngleToViewRay) / pixel;
        if (sinOfAngleToViewRay < MIN_SIN_OF_ANGLE_TO_VIEW_RAY || onScreenPx < MIN_ON_SCREEN_AXIS_PX) {
          sprites[id].visible = false;
          labelRects.set(id, null);
          continue;
        }

        const hasRoomForArrowsInside = onScreenPx >= 2 * ARROW_LENGTH_PX + INSIDE_ARROWS_MARGIN_PX;
        if (hasRoomForArrowsInside) {
          b.segment(from.clone().addScaledVector(dir, ARROW_LENGTH_PX * pixel * 0.8), to.clone().addScaledVector(dir, -ARROW_LENGTH_PX * pixel * 0.8), LINE_PX);
          b.arrow(from, dir.clone().negate(), ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
          b.arrow(to, dir, ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
        } else {
          const lead = (ARROW_LENGTH_PX + SHORT_LEAD_PX) * pixel;
          b.segment(from.clone().addScaledVector(dir, -lead), to.clone().addScaledVector(dir, lead), LINE_PX);
          b.arrow(from, dir, ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
          b.arrow(to, dir.clone().negate(), ARROW_LENGTH_PX, ARROW_HALF_WIDTH_PX);
        }
        const tick = b.perp(dir).multiplyScalar((TICK_PX / 2) * pixel);
        b.segment(from.clone().add(tick), from.clone().sub(tick), LINE_PX);
        b.segment(to.clone().add(tick), to.clone().sub(tick), LINE_PX);
        b.segment(from, origin, EXTENSION_PX);

        const s = sizes.get(id) ?? { w: FALLBACK_LABEL_WIDTH_PX, h: LABEL_FONT_PX + 2 * LABEL_PAD_Y_PX };
        const isOccluded = occluded(worldOf(mid), cameraWorldPos);
        if (id === "height") place(id, mid, pixel, s, !isOccluded);
        else groundCandidates.push({ id, mid, dir: dir.clone(), pixel, length, occluded: isOccluded, s });
        const occludedAt = OCCLUSION_PROBE_TS.map((t) => occluded(worldOf(from.clone().lerp(to, t)), cameraWorldPos));
        drawn.push({ id, from: toCanvas(from), to: toCanvas(to), occludedAt });
        ink.push(...b.out);
      }

      if (groundCandidates.length === 1) {
        const c = groundCandidates[0];
        place(c.id, c.mid, c.pixel, c.s, !c.occluded);
      } else if (groundCandidates.length === 2) {
        const [wArm, dArm] = groundCandidates;
        if (roundGroundLabel) {
          place(wArm.id, wArm.mid, wArm.pixel, wArm.s, !wArm.occluded);
          place(dArm.id, dArm.mid, dArm.pixel, dArm.s, wArm.occluded && !dArm.occluded);
        } else {
          let dMid = dArm.mid.clone();
          let dPixel = dArm.pixel;
          const maxOffset = dArm.length * MAX_LABEL_SLIDE_IN_AXIS_LENGTHS;
          let offset = 0;
          if (!wArm.occluded && !dArm.occluded) {
            const rectOf = (mid: THREE.Vector3, s: LabelSize) => {
              const [cx, cy] = toCanvas(mid);
              return { left: cx - s.w / 2, right: cx + s.w / 2, top: cy - s.h / 2, bottom: cy + s.h / 2 };
            };
            for (let i = 0; i < LABEL_COLLISION_ITERATIONS && offset < maxOffset; i++) {
              const wRect = rectOf(wArm.mid, wArm.s);
              const dRect = rectOf(dMid, dArm.s);
              const overlapX = Math.min(wRect.right, dRect.right) - Math.max(wRect.left, dRect.left);
              const overlapY = Math.min(wRect.bottom, dRect.bottom) - Math.max(wRect.top, dRect.top);
              if (overlapX <= 0 || overlapY <= 0) break;
              const push: [number, number] =
                overlapX < overlapY
                  ? [Math.sign((dRect.left + dRect.right) / 2 - (wRect.left + wRect.right) / 2 || 1) * (overlapX + LABEL_COLLISION_MARGIN_PX), 0]
                  : [0, Math.sign((dRect.top + dRect.bottom) / 2 - (wRect.top + wRect.bottom) / 2 || 1) * (overlapY + LABEL_COLLISION_MARGIN_PX)];
              const probeDelta = Math.max(dPixel, 1e-6) * 10;
              const [cx0, cy0] = toCanvas(dMid);
              const [cx1, cy1] = toCanvas(dMid.clone().addScaledVector(dArm.dir, probeDelta));
              const rate: [number, number] = [(cx1 - cx0) / probeDelta, (cy1 - cy0) / probeDelta];
              const rateSq = rate[0] * rate[0] + rate[1] * rate[1];
              if (rateSq < 1e-9) break;
              const step = Math.abs((push[0] * rate[0] + push[1] * rate[1]) / rateSq);
              if (step < 1e-6) break;
              dMid = dMid.addScaledVector(dArm.dir, step);
              dPixel = pixelAt(dMid);
              offset += step;
            }
          }
          place(wArm.id, wArm.mid, wArm.pixel, wArm.s, !wArm.occluded);
          place(dArm.id, dMid, dPixel, dArm.s, !dArm.occluded);
        }
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
        arms: drawn.map((d) => ({ ...d, labelRect: labelRects.get(d.id) ?? null })),
      };
    };
    const previous = scene.onBeforeRender;
    scene.onBeforeRender = function (this: THREE.Scene, ...args: Parameters<THREE.Scene["onBeforeRender"]>) {
      previous.apply(this, args);
      const [renderer, , camera] = args;
      if (camera.layers.isEnabled(DIMENSION_LINE_LAYER)) update(renderer, camera);
    };
    invalidate();
    return () => {
      scene.onBeforeRender = previous;
      delete window.__dimensionAxes;
    };
  }, [scene, invalidate, strokes, sprites, group, axes, sizes, raycaster, labels, roundGroundLabel]);

  return <primitive object={group} />;
}
