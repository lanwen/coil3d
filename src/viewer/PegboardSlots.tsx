
import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { PegboardSection } from "../core";
import { DIMENSION_LINE_LAYER, MODEL_DEPTH_UNIFORM } from "./lineArt/LineArtRenderer";

const OUTLINE_WIDTH_MM = 0.8;
const ARC_SEGMENTS = 16;
const HIDDEN_DEPTH_BIAS = 1e-5;

function stadium(r: number, h: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const angle = (Math.PI * i) / ARC_SEGMENTS;
    pts.push([r * Math.cos(angle), h + r * Math.sin(angle)]);
  }
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const angle = Math.PI + (Math.PI * i) / ARC_SEGMENTS;
    pts.push([r * Math.cos(angle), -h + r * Math.sin(angle)]);
  }
  return pts;
}

export function pegboardSlotPositions(board: PegboardSection, face: "front" | "back"): Float32Array {
  const a = (board.axisDeg * Math.PI) / 180;
  const up = { x: Math.sin(a), y: Math.cos(a) };
  const side = { x: Math.cos(a), y: -Math.sin(a) };
  const z = face === "front" ? board.frontZ : board.frontZ - board.thickness;
  const r = board.slotWidth / 2;
  const h = board.slotLength / 2 - r;
  const inner = stadium(r - OUTLINE_WIDTH_MM / 2, h);
  const outer = stadium(r + OUTLINE_WIDTH_MM / 2, h);
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
