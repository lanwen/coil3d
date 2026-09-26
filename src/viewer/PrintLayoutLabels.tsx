// Part-name callouts for the print-layout view (issue #78 PR review): small
// labels -- the SAME size/weight as DimensionAxes' own cm labels (15px bold,
// see screenSpaceInk.ts) -- placed OUTSIDE every part's own footprint, never
// on top of any part's geometry, with a thin leader line back to the part
// they name.
//
// Placement: `layoutParts` (core/plate.ts) arranges every part side by side
// along X, each part's own Y independently centered on the bed -- so EVERY
// part's footprint shares roughly the same Y band, differing only in X. A
// label pushed out in +Y from its OWN part, by less than the bed's deepest
// part, could still land on top of a DEEPER neighbour. Anchoring every
// label to one shared row just past `bounds` (the whole laid-out scene's own
// union box, already computed by `buildPrintLayout`) instead of just past
// its own part's footprint guarantees it clears every part, not only its
// own -- a straight, mostly-horizontal leader line (in world space) from
// each part's own back-top edge out to that shared row, at that part's own
// height, so the line is just as simple to read as a museum placard's.
//
// Rendering mirrors DimensionAxes.tsx exactly (same screenSpaceInk.ts
// building blocks, same scene.onBeforeRender-driven per-frame rebuild so
// labels stay pixel-sized under zoom/orbit, same DIMENSION_LINE_LAYER for
// the leader lines and DIMENSION_LABEL_LAYER for the sprites) -- a
// dedicated, dynamically-sized (one entry per part, not DimensionAxes' fixed
// three) sibling rather than a shared component, since the two have
// different-shaped props (a map of axis id -> label vs. a list of parts).

import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { DIMENSION_LABEL_LAYER, DIMENSION_LINE_LAYER } from "./lineArt/LineArtRenderer";
import { labelTexture, LABEL_FONT_PX, LABEL_PAD_Y_PX, makeLabelSprite, pixelSizeAt, StrokeBuilder } from "./screenSpaceInk";

const LEADER_PX = 1.5; // thin -- deliberately lighter than DimensionAxes' own 3px dimension lines
const LABEL_GAP_PX = 5; // gap between the leader line's end and the label's own edge

export interface PrintLayoutLabelInfo {
  name: string;
  /** This part's own footprint + height box, world/bed mm. */
  box: THREE.Box3;
}

export interface PrintLayoutLabelsProps {
  parts: PrintLayoutLabelInfo[];
  /** The whole laid-out scene's own bounds (every part, union'd) -- the shared row every label clears. */
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

  // Label textures: built once per part (names are static for a given
  // design), redrawn once more when the UI webfont finishes loading (the
  // first draw may have used a fallback), matching DimensionAxes' own.
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

      // The shared row every label clears (see file header): past the
      // WHOLE layout's own Y extent, on whichever side (+Y or -Y) the
      // camera is currently looking FROM (so the row reads on the near
      // side, not hidden behind the models from this angle).
      const sy = view.y >= 0 ? -1 : 1;
      const margin = Math.max(8, 0.1 * bounds.getSize(new THREE.Vector3()).y);
      const rowY = sy > 0 ? bounds.max.y + margin : bounds.min.y - margin;

      const b = new StrokeBuilder(view, pixel);
      for (const { name, box, sprite } of sprites) {
        const partCenterX = (box.min.x + box.max.x) / 2;
        const partY = sy > 0 ? box.max.y : box.min.y;
        const z = box.max.z;
        const leaderStart = new THREE.Vector3(partCenterX, partY, z);
        const labelAt = new THREE.Vector3(partCenterX, rowY, z);
        b.segment(leaderStart, labelAt, LEADER_PX);

        const s = sizes.get(name) ?? { w: 60, h: LABEL_FONT_PX + 2 * LABEL_PAD_Y_PX };
        // Push the sprite's own centre a bit further out so its NEAR edge
        // (not its centre) sits at the leader's own end, with a small gap.
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
