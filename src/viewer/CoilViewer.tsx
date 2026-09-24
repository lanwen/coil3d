import { useEffect, useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { CoilMesh } from "../core";

// Plain shaded viewer (the IKEA line-art look is a later ticket -
// docs/research.md §5, §10b). This only turns the core's flat mesh arrays
// into a three.js BufferGeometry.
function CoilMeshView({ mesh }: { mesh: CoilMesh }) {
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geo.computeVertexNormals();
    return geo;
  }, [mesh]);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#d8d8d8" roughness={0.6} metalness={0.05} />
    </mesh>
  );
}

/** Frames the camera on the mesh's bounding box: coil size varies a lot
 * (a 30mm USB core vs. a 400mm Schuko cord), so a fixed camera position
 * would clip or dwarf the model. */
function FitCamera({ mesh }: { mesh: CoilMesh }) {
  const { camera, controls } = useThree();

  useEffect(() => {
    const p = mesh.positions;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i];
      const y = p[i + 1];
      const z = p[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    const radius = Math.max(1, new THREE.Vector3(maxX - minX, maxY - minY, maxZ - minZ).length() / 2);
    const distance = radius * 2.6;

    camera.position.set(center.x + distance * 0.55, center.y + distance * 0.45, center.z + distance * 0.7);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.near = Math.max(0.1, distance * 0.02);
      camera.far = distance * 20;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(center);

    const orbit = controls as { target?: THREE.Vector3; update?: () => void } | null;
    if (orbit?.target) {
      orbit.target.copy(center);
      orbit.update?.();
    }
  }, [mesh, camera, controls]);

  return null;
}

export function CoilViewer({ mesh }: { mesh: CoilMesh }) {
  return (
    <Canvas
      data-testid="coil-viewer"
      camera={{ position: [80, 80, 120], fov: 40 }}
      style={{ width: "100%", height: "100%", background: "#f4f4f4" }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[100, 150, 100]} intensity={1.1} />
      <directionalLight position={[-80, -60, -60]} intensity={0.3} />
      <CoilMeshView mesh={mesh} />
      <FitCamera mesh={mesh} />
      <OrbitControls makeDefault />
    </Canvas>
  );
}
