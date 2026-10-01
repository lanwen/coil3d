// The SKÅDIS slot grid drawn against the rim clips (issues #106, #207): one
// thin grey stadium outline per slot of `Design.pegboard`, lying in the
// board's BACK plane for the mount-side view (the face that camera sees,
// from behind the wall -- each clip pokes through its own slot and its
// barbs lap over the slot's edge) or its FRONT plane for the room-side
// wall view (the board the coil hangs on). Drawn on DIMENSION_LINE_LAYER like the dimension
// axes (outside the line-art edge pass, so it's never outlined itself), and
// discarded wherever the model is nearer the camera -- the barbs hide the
// outline where they hook behind the board, the plate and flange (further
// away) never do.

import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { PegboardSection } from "../core";
import { DIMENSION_LINE_LAYER, MODEL_DEPTH_UNIFORM } from "./lineArt/LineArtRenderer";

/** Outline width, mm (drawn in the model's own units, so it scales with zoom like the model's features). */
const OUTLINE_WIDTH = 0.8;
const ARC_SEGMENTS = 16;
const HIDDEN_DEPTH_BIAS = 1e-5;

/** One slot's centreline: a stadium of half-width `r` and straight half-length `h`, around the origin, in (side, up). */
function stadium(r: number, h: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const a = (Math.PI * i) / ARC_SEGMENTS; // top arc, right to left
    pts.push([r * Math.cos(a), h + r * Math.sin(a)]);
  }
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const a = Math.PI + (Math.PI * i) / ARC_SEGMENTS; // bottom arc, left to right
    pts.push([r * Math.cos(a), -h + r * Math.sin(a)]);
  }
  return pts;
}

/** Flat triangles for every slot's outline, in the design's assembly frame (the board's back plane). */
export function pegboardSlotPositions(board: PegboardSection, face: "front" | "back"): Float32Array {
  const a = (board.axisDeg * Math.PI) / 180;
  const up = { x: Math.sin(a), y: Math.cos(a) };
  const side = { x: Math.cos(a), y: -Math.sin(a) };
  const z = face === "front" ? board.frontZ : board.frontZ - board.thickness;
  const r = board.slotWidth / 2;
  const h = board.slotLength / 2 - r;
  const inner = stadium(r - OUTLINE_WIDTH / 2, h);
  const outer = stadium(r + OUTLINE_WIDTH / 2, h);
  const out: number[] = [];
  for (const c of board.slots) {
    const at = ([s, u]: [number, number]) => [c.x + s * side.x + u * up.x, c.y + s * side.y + u * up.y, z];
    for (let i = 0; i < inner.length; i++) {
      const j = (i + 1) % inner.length;
      const [i0, i1, o0, o1] = [at(inner[i]), at(inner[j]), at(outer[i]), at(outer[j])];
      out.push(...i0, ...o0, ...o1, ...i0, ...o1, ...i1);
    }
  }
  return new Float32Array(out);
}

export function PegboardSlots({ board, rotation, face }: { board: PegboardSection; rotation: THREE.Matrix4 | null; face: "front" | "back" }) {
  const invalidate = useThree((state) => state.invalidate);
  const mesh = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.ShaderMaterial({
      uniforms: { tDepth: MODEL_DEPTH_UNIFORM, resolution: { value: new THREE.Vector2(1, 1) } },
      vertexShader: "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `
        uniform sampler2D tDepth;
        uniform vec2 resolution;
        void main() {
          float model = texture2D(tDepth, gl_FragCoord.xy / resolution).x;
          if (gl_FragCoord.z > model + ${HIDDEN_DEPTH_BIAS.toExponential()}) discard;
          gl_FragColor = vec4(0.4, 0.4, 0.4, 1.0);
        }`,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    const m = new THREE.Mesh(geometry, material);
    m.layers.set(DIMENSION_LINE_LAYER);
    m.frustumCulled = false;
    m.onBeforeRender = (renderer) => {
      const target = renderer.getRenderTarget();
      material.uniforms.resolution.value.set(target?.width ?? 1, target?.height ?? 1);
    };
    return m;
  }, []);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
    [mesh],
  );

  useEffect(() => {
    const positions = pegboardSlotPositions(board, face);
    const attr = new THREE.BufferAttribute(positions, 3);
    if (rotation) attr.applyMatrix4(rotation);
    mesh.geometry.setAttribute("position", attr);
    mesh.geometry.computeBoundingSphere();
    invalidate();
  }, [mesh, board, rotation, face, invalidate]);

  return <primitive object={mesh} />;
}
