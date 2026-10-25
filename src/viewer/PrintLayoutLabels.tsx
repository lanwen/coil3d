
import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { DIMENSION_LABEL_LAYER, DIMENSION_LINE_LAYER } from "./lineArt/LineArtRenderer";
import { labelTexture, LABEL_FONT_PX, LABEL_PAD_Y_PX, makeLabelSprite, pixelSizeAt, StrokeBuilder } from "./screenSpaceInk";

const LEADER_PX = 1.5;
const LABEL_GAP_PX = 5;
const MIN_ROW_MARGIN_MM = 8;
const ROW_MARGIN_FRACTION = 0.1;
const UNMEASURED_LABEL_WIDTH_PX = 60;

interface PrintLayoutLabelInfo {
  name: string;
  box: THREE.Box3;
}

interface PrintLayoutLabelsProps {
  parts: PrintLayoutLabelInfo[];
  bounds: THREE.Box3;
}

export function PrintLayoutLabels({ parts, bounds }: PrintLayoutLabelsProps) {
  const strokes = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.set(DIMENSION_LINE_LAYER);
    mesh.frustumCulled = false;
    return mesh;
  }, []);

  const sprites = useMemo(() => parts.map((p) => ({ name: p.name, box: p.box, sprite: makeLabelSprite(DIMENSION_LABEL_LAYER) })), [parts]);

  const scene = useThree((s) => s.scene);

  useEffect(() => {
    scene.add(strokes);
    for (const s of sprites) scene.add(s.sprite);
    return () => {
      scene.remove(strokes);
      strokes.geometry.dispose();
      (strokes.material as THREE.Material).dispose();
      for (const s of sprites) {
        scene.remove(s.sprite);
        s.sprite.material.map?.dispose();
        s.sprite.material.dispose();
      }
    };
  }, [scene, strokes, sprites]);

  const sizes = useMemo(() => new Map<string, { w: number; h: number }>(), [sprites]);
  useEffect(() => {
    let cancelled = false;
    const draw = () => {
      if (cancelled) return;
      for (const s of sprites) {
        const { texture, widthPx, heightPx } = labelTexture(s.name);
        s.sprite.material.map?.dispose();
        s.sprite.material.map = texture;
        s.sprite.material.needsUpdate = true;
        sizes.set(s.name, { w: widthPx, h: heightPx });
      }
    };
    draw();
    document.fonts?.ready.then(draw);
    return () => {
      cancelled = true;
    };
  }, [sprites, sizes]);

  useEffect(() => {
    const update = (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => {
      const size = renderer.getSize(new THREE.Vector2());
      const view = camera.getWorldDirection(new THREE.Vector3()).negate();
      const center = bounds.getCenter(new THREE.Vector3());
      const pixel = pixelSizeAt(camera, center, size.y);

      const sy = view.y >= 0 ? -1 : 1;
      const margin = Math.max(MIN_ROW_MARGIN_MM, ROW_MARGIN_FRACTION * bounds.getSize(new THREE.Vector3()).y);
      const rowY = sy > 0 ? bounds.max.y + margin : bounds.min.y - margin;

      const b = new StrokeBuilder(view, pixel);
      for (const { name, box, sprite } of sprites) {
        const partCenterX = (box.min.x + box.max.x) / 2;
        const partY = sy > 0 ? box.max.y : box.min.y;
        const z = box.max.z;
        const leaderStart = new THREE.Vector3(partCenterX, partY, z);
        const labelAt = new THREE.Vector3(partCenterX, rowY, z);
        b.segment(leaderStart, labelAt, LEADER_PX);

        const s = sizes.get(name) ?? { w: UNMEASURED_LABEL_WIDTH_PX, h: LABEL_FONT_PX + 2 * LABEL_PAD_Y_PX };
        const push = (s.h / 2 + LABEL_GAP_PX) * pixel;
        labelAt.y += sy * push;
        sprite.position.copy(labelAt);
        sprite.scale.set(s.w * pixel, s.h * pixel, 1);
        sprite.updateMatrix();
      }
      const geometry = strokes.geometry;
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(b.out, 3));
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
  }, [scene, strokes, sprites, sizes, bounds]);

  return null;
}
