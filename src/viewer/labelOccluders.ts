import * as THREE from "three";

const PART_MATERIAL = new THREE.MeshBasicMaterial();
const CABLE_MATERIAL = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

export function labelOccluders(partGeometries: THREE.BufferGeometry[], cableStandIn: THREE.BufferGeometry | null): THREE.Mesh[] {
  const meshes = partGeometries.map((geometry) => new THREE.Mesh(geometry, PART_MATERIAL));
  if (cableStandIn) meshes.push(new THREE.Mesh(cableStandIn, CABLE_MATERIAL));
  return meshes;
}
