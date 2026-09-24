import { useEffect, useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { CoilMesh } from "../core";
import { LineArtRenderer } from "./lineArt/LineArtRenderer";

// Normals are split where faces meet at more than this angle, so the edge
// shader sees a hard jump at every real crease (rims, the flange, each groove
// ridge) and nothing on smooth curves. The groove arc turns about 17 degrees
// per mesh row, safely below it; the ridges and rims turn 45-110 degrees.
const CREASE_ANGLE = (30 * Math.PI) / 180;

/**
 * The IKEA line-art look (issue #3, docs/research.md §5 & §10b): the mesh is
 * never shaded directly. `LineArtRenderer` takes over the render loop and
 * draws white fill and black lines from a normal+depth pass (via
 * `scene.overrideMaterial`), so this mesh's own material is never seen.
 */
export function CoilViewer({ mesh }: { mesh: CoilMesh }) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  const geometry = useMemo(() => {
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    indexed.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const creased = toCreasedNormals(indexed, CREASE_ANGLE);
    indexed.dispose();
    return creased;
  }, [mesh]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <Canvas
      data-testid="coil-viewer"
      orthographic
      flat
      frameloop="demand"
      camera={{ up: [0, 0, 1] }}
      gl={{ alpha: true, antialias: false }}
      style={{ width: "100%", height: "100%", background: "transparent" }}
    >
      <mesh geometry={geometry} />
      <LineArtRenderer geometry={geometry} controlsRef={controlsRef} />
      <OrbitControls ref={controlsRef} makeDefault enableDamping={false} />
    </Canvas>
  );
}
