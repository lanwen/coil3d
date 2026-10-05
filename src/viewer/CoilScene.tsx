import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { CoilMesh, Part, WireLayerPath } from "../core";
import { LineArtRenderer, markFaceKinds, type Projection } from "./lineArt/LineArtRenderer";
import type { PresetId } from "./lineArt/presets";
import { buildWireGeometries, needsEnvelope } from "./wireGeometry";

const CREASE_ANGLE = (30 * Math.PI) / 180;

export const EXPLODE_GAP = 20;

export interface CoilSceneProps {
  parts: Part[];
  wirePaths?: WireLayerPath[];
  wireDiameter?: number;
  showWire?: boolean;
  exploded?: boolean;
  preset?: PresetId;
  fill?: number;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}

function zExtent(mesh: CoilMesh): number {
  let minZ = Infinity;
  let maxZ = -Infinity;
  const pos = mesh.positions;
  for (let i = 2; i < pos.length; i += 3) {
    if (pos[i] < minZ) minZ = pos[i];
    if (pos[i] > maxZ) maxZ = pos[i];
  }
  return Math.max(0, maxZ - minZ);
}

function buildCreasedGeometry(mesh: CoilMesh): THREE.BufferGeometry {
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  indexed.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const creased = toCreasedNormals(indexed, CREASE_ANGLE);
  indexed.dispose();
  markFaceKinds(creased, mesh);
  return creased;
}

function ExplodedPart({ geometry, offset, exploded }: { geometry: THREE.BufferGeometry; offset: number; exploded: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [exploded, invalidate]);
  useFrame(() => {
    const group = groupRef.current;
    if (group) group.position.z = exploded ? offset : 0;
  });
  return (
    <group ref={groupRef}>
      <mesh geometry={geometry} />
    </group>
  );
}

export function CoilScene({ parts, wirePaths, wireDiameter, showWire = true, exploded = false, preset = "iso", fill, controlsRef }: CoilSceneProps) {
  const partGeometries = useMemo(() => parts.map((part) => ({ part, geometry: buildCreasedGeometry(part.mesh) })), [parts]);
  useEffect(() => () => partGeometries.forEach(({ geometry }) => geometry.dispose()), [partGeometries]);

  const explodeOffsets = useMemo(() => new Map(parts.filter((p) => p.role !== "core").map((p) => [p.name, zExtent(p.mesh) + EXPLODE_GAP])), [parts]);

  const canvasHeight = useThree((s) => s.size.height);
  const envelope = useMemo(() => needsEnvelope(wirePaths ?? [], (wireDiameter ?? 0) / 2, canvasHeight), [wirePaths, wireDiameter, canvasHeight]);
  const wireGeometries = useMemo(() => {
    if (!showWire || !wirePaths?.length || !wireDiameter) return [];
    return buildWireGeometries(wirePaths, wireDiameter / 2, envelope);
  }, [showWire, wirePaths, wireDiameter, envelope]);
  useEffect(() => () => wireGeometries.forEach((g) => g.dispose()), [wireGeometries]);

  const framingGeometry = useMemo(() => {
    const chunks = parts.map((part) => {
      const offset = exploded ? (explodeOffsets.get(part.name) ?? 0) : 0;
      if (offset === 0) return part.mesh.positions;
      const shifted = new Float32Array(part.mesh.positions.length);
      for (let i = 0; i < shifted.length; i += 3) {
        shifted[i] = part.mesh.positions[i];
        shifted[i + 1] = part.mesh.positions[i + 1];
        shifted[i + 2] = part.mesh.positions[i + 2] + offset;
      }
      return shifted;
    });
    const merged = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      merged.set(c, at);
      at += c.length;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(merged, 3));
    return geometry;
  }, [parts, explodeOffsets, exploded]);
  useEffect(() => () => framingGeometry.dispose(), [framingGeometry]);

  const projection: Projection = "ortho";

  return (
    <>
      {partGeometries.map(({ part, geometry }) =>
        part.role === "core" ? (
          <mesh key={part.name} geometry={geometry} />
        ) : (
          <ExplodedPart key={part.name} geometry={geometry} offset={explodeOffsets.get(part.name) ?? 0} exploded={exploded} />
        ),
      )}
      {wireGeometries.map((g, i) => (
        <mesh key={i} geometry={g} />
      ))}
      <LineArtRenderer geometry={framingGeometry} controlsRef={controlsRef} projection={projection} preset={preset} fill={fill} reducedMotion />
    </>
  );
}
