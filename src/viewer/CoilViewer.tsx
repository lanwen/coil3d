import { useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { CoilMesh } from "../core";
import { LineArtRenderer } from "./lineArt/LineArtRenderer";

/**
 * The IKEA line-art look (issue #3, docs/research.md §5 & §10b): the geometry
 * itself is never drawn to screen directly. `LineArtRenderer` takes over the
 * render loop and draws white fill + black outlines from a normal+depth pass
 * instead, so this material is only ever seen by that pass's
 * `scene.overrideMaterial` swap — its own appearance doesn't matter.
 */
function CoilMeshView({ geometry }: { geometry: THREE.BufferGeometry }) {
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#d8d8d8" side={THREE.DoubleSide} />
    </mesh>
  );
}

export function CoilViewer({ mesh }: { mesh: CoilMesh }) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    return geo;
  }, [mesh]);

  return (
    <Canvas
      data-testid="coil-viewer"
      orthographic
      camera={{ position: [80, 80, 120], near: 0.01, far: 10000, zoom: 1 }}
      gl={{ alpha: true, antialias: false }}
      style={{ width: "100%", height: "100%", background: "transparent" }}
    >
      <CoilMeshView geometry={geometry} />
      <LineArtRenderer geometry={geometry} controlsRef={controlsRef} />
      <OrbitControls ref={controlsRef} makeDefault enableDamping={false} />
    </Canvas>
  );
}
